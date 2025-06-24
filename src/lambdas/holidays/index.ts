import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { HolidayRecord, Holiday } from '../../common/types';
import { validateCountryCode, validateYear, ValidationError } from '../../common/utils';
import { CachedDynamoDBClient } from '../../common/dax-client';
import { dataAccessService } from '../../common/data-access';

const logger = new Logger({ serviceName: 'holidays-function' });
const tracer = new Tracer({ serviceName: 'holidays-function' });
const metrics = new Metrics({ namespace: 'AlmanacAPI', serviceName: 'holidays-function' });

const HOLIDAYS_TABLE = process.env.HOLIDAYS_TABLE;

if (!HOLIDAYS_TABLE) {
  throw new Error('HOLIDAYS_TABLE environment variable is not set');
}

// Initialize DAX-enabled client
const cachedClient = new CachedDynamoDBClient(HOLIDAYS_TABLE);

interface HolidayQueryParams {
  country: string;
  year: string;
  month?: string;
  type?: 'public' | 'bank' | 'observance';
  region?: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  logger.info('Received request', { 
    path: event.path,
    queryStringParameters: event.queryStringParameters,
    requestContext: event.requestContext,
  });
  
  // Extract auth context
  const authContext = (event.requestContext as any).authorizer || {};
  const cognitoSub = authContext.cognitoSub;
  const tier = authContext.tier || 'free';
  const apiKey = authContext.apiKey;
  
  // Add custom metric
  metrics.addMetric('HolidaysRequests', MetricUnit.Count, 1);
  metrics.addMetric(`HolidaysRequests_${tier}`, MetricUnit.Count, 1);

  try {
    // Validate query parameters
    const params = validateQueryParams(event.queryStringParameters);
    
    // Create segment for tracing
    const segment = tracer.getSegment();
    const subsegment = segment?.addNewSubsegment('DynamoDB Query');
    
    // Query DynamoDB
    const holidays = await queryHolidays(params);
    
    subsegment?.close();
    
    // Filter by region if specified
    const filteredHolidays = params.region 
      ? filterHolidaysByRegion(holidays, params.region)
      : holidays;
    
    const responseTime = Date.now() - startTime;
    const responseBody = JSON.stringify({
      country: params.country,
      year: params.year,
      holidays: filteredHolidays,
      count: filteredHolidays.length,
    });
    
    // Track usage if user is authenticated
    if (cognitoSub) {
      await dataAccessService.trackUsage(
        cognitoSub,
        '/holidays',
        'GET',
        200,
        responseTime,
        Buffer.byteLength(responseBody),
        tier,
        apiKey
      ).catch(err => logger.error('Failed to track usage', { error: err }));
    }

    // Add success metric
    metrics.addMetric('HolidaysSuccess', MetricUnit.Count, 1);
    metrics.addMetric('HolidaysResponseTime', MetricUnit.Milliseconds, responseTime);
    metrics.publishStoredMetrics();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        'X-Response-Time': `${responseTime}ms`,
      },
      body: responseBody,
    };
  } catch (error) {
    logger.error('Error processing request', { error });
    
    const statusCode = error instanceof ValidationError ? 400 : 500;
    const responseTime = Date.now() - startTime;
    
    // Track usage even for errors
    if (cognitoSub) {
      await dataAccessService.trackUsage(
        cognitoSub,
        '/holidays',
        'GET',
        statusCode,
        responseTime,
        0,
        tier,
        apiKey
      ).catch(err => logger.error('Failed to track usage', { error: err }));
    }
    
    // Add error metric
    metrics.addMetric('HolidaysErrors', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    return {
      statusCode,
      headers: {
        'Content-Type': 'application/json',
        'X-Response-Time': `${responseTime}ms`,
      },
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    };
  }
};

function validateQueryParams(params: any): HolidayQueryParams {
  if (!params?.country || !params?.year) {
    throw new ValidationError('Missing required parameters: country and year');
  }

  const country = validateCountryCode(params.country);
  const year = validateYear(parseInt(params.year, 10));
  const month = params.month ? parseInt(params.month, 10) : undefined;

  if (month && (month < 1 || month > 12)) {
    throw new ValidationError('Month must be between 1 and 12');
  }

  // Validate region if provided
  const region = params.region ? validateRegion(params.region, country) : undefined;

  return {
    country,
    year: year.toString(),
    month: month?.toString(),
    type: params.type,
    region,
  };
}

async function queryHolidays(params: HolidayQueryParams): Promise<Holiday[]> {
  const queryParams: any = {
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `COUNTRY#${params.country}#${params.year}`,
    },
    ScanIndexForward: true, // Sort by date ascending
  };

  // Add month filter if provided
  if (params.month) {
    queryParams.KeyConditionExpression += ' AND begins_with(SK, :sk)';
    queryParams.ExpressionAttributeValues[':sk'] = `HOLIDAY#${params.year}-${String(params.month).padStart(2, '0')}`;
  }

  // Add type filter if provided
  if (params.type) {
    queryParams.FilterExpression = '#type = :type';
    queryParams.ExpressionAttributeNames = { '#type': 'type' };
    queryParams.ExpressionAttributeValues[':type'] = params.type;
  }

  const response = await cachedClient.query(queryParams);
  
  return (response.Items as HolidayRecord[] || []).map(item => ({
    date: item.date,
    name: item.name,
    type: item.type,
    country: item.country,
    country_name: item.country_name,
    year: item.year,
    month: item.month,
    day: item.day,
    day_of_week: item.day_of_week,
    is_weekend: item.is_weekend,
    is_fixed: item.is_fixed,
    counties: item.counties,
    regions: item.regions,
  }));
}

function validateRegion(region: string, country: string): string {
  const upperRegion = region.toUpperCase();
  
  // Australian state/territory codes
  const australianRegions = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
  
  if (country === 'AU') {
    if (!australianRegions.includes(upperRegion)) {
      throw new ValidationError(`Invalid region '${region}' for Australia. Valid regions: ${australianRegions.join(', ')}`);
    }
  }
  
  // Add validation for other countries as needed
  // For now, just return the uppercase region
  return upperRegion;
}

function filterHolidaysByRegion(holidays: Holiday[], region: string): Holiday[] {
  return holidays.filter(holiday => {
    // If no regions specified or regions include 'ALL', it applies to all regions
    if (!holiday.regions || holiday.regions.includes('ALL')) {
      return true;
    }
    // Otherwise, check if the holiday applies to the specified region
    return holiday.regions.includes(region);
  });
}

