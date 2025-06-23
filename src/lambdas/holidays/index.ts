import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

// Initialize AWS SDK clients and utilities
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const logger = new Logger({ serviceName: 'holidays-function' });
const tracer = new Tracer({ serviceName: 'holidays-function' });
const metrics = new Metrics({ namespace: 'AlmanacAPI', serviceName: 'holidays-function' });

interface HolidayQueryParams {
  country: string;
  year: string;
  region?: string;
}

interface Holiday {
  date: string;
  name: string;
  type: 'national' | 'regional';
  regions: string[];
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logger.info('Received request', { event });
  
  // Add custom metric
  metrics.addMetric('HolidaysRequests', MetricUnit.Count, 1);

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
      ? filterByRegion(holidays, params.region)
      : holidays;

    // Add success metric
    metrics.addMetric('HolidaysSuccess', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
      body: JSON.stringify({
        country: params.country,
        year: params.year,
        region: params.region,
        holidays: filteredHolidays,
        count: filteredHolidays.length,
      }),
    };
  } catch (error) {
    logger.error('Error processing request', { error });
    
    // Add error metric
    metrics.addMetric('HolidaysErrors', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    return {
      statusCode: error instanceof ValidationError ? 400 : 500,
      headers: {
        'Content-Type': 'application/json',
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

  const country = params.country.toUpperCase();
  const year = parseInt(params.year, 10);

  if (!isValidCountryCode(country)) {
    throw new ValidationError('Invalid country code');
  }

  if (isNaN(year) || year < 2020 || year > 2030) {
    throw new ValidationError('Year must be between 2020 and 2030');
  }

  return {
    country,
    year: year.toString(),
    region: params.region?.toUpperCase(),
  };
}

async function queryHolidays(params: HolidayQueryParams): Promise<Holiday[]> {
  const command = new QueryCommand({
    TableName: process.env.HOLIDAYS_TABLE,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: '#year = :year',
    ExpressionAttributeNames: {
      '#year': 'year',
    },
    ExpressionAttributeValues: {
      ':pk': `COUNTRY#${params.country}`,
      ':year': parseInt(params.year, 10),
    },
  });

  const response = await docClient.send(command);
  
  return (response.Items || []).map(item => ({
    date: item.date,
    name: item.name,
    type: item.type,
    regions: item.regions || [],
  }));
}

function filterByRegion(holidays: Holiday[], region: string): Holiday[] {
  return holidays.filter(holiday => 
    holiday.regions.includes('ALL') || holiday.regions.includes(region)
  );
}

function isValidCountryCode(code: string): boolean {
  // Initial supported countries
  const validCodes = ['AU', 'UK', 'GB', 'DE'];
  return validCodes.includes(code);
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}