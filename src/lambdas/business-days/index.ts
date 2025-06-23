import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const logger = new Logger({ serviceName: 'business-days-function' });
const tracer = new Tracer({ serviceName: 'business-days-function' });
const metrics = new Metrics({ namespace: 'AlmanacAPI', serviceName: 'business-days-function' });

interface BusinessDaysRequest {
  startDate: string;
  days: number;
  country: string;
  region?: string;
  includeWeekends?: boolean;
}

interface Holiday {
  date: string;
  regions: string[];
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logger.info('Received request', { event });
  metrics.addMetric('BusinessDaysRequests', MetricUnit.Count, 1);

  try {
    // Parse and validate request body
    const request = validateRequest(event.body);
    
    // Calculate date range for holiday lookup
    const dateRange = calculateDateRange(request.startDate, request.days);
    
    // Fetch holidays for the date range
    const holidays = await fetchHolidays(
      request.country,
      dateRange.startYear,
      dateRange.endYear,
      request.region
    );
    
    // Calculate business days
    const result = calculateBusinessDays(request, holidays);
    
    metrics.addMetric('BusinessDaysSuccess', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300', // Cache for 5 minutes
      },
      body: JSON.stringify({
        startDate: request.startDate,
        endDate: result.endDate,
        businessDays: request.days,
        totalDays: result.totalDays,
        weekendDays: result.weekendDays,
        holidays: result.holidays,
        country: request.country,
        region: request.region,
      }),
    };
  } catch (error) {
    logger.error('Error processing request', { error });
    metrics.addMetric('BusinessDaysErrors', MetricUnit.Count, 1);
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

function validateRequest(body: string | null): BusinessDaysRequest {
  if (!body) {
    throw new ValidationError('Request body is required');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ValidationError('Invalid JSON in request body');
  }

  if (!parsed.startDate || !parsed.days || !parsed.country) {
    throw new ValidationError('Missing required fields: startDate, days, country');
  }

  const startDate = new Date(parsed.startDate);
  if (isNaN(startDate.getTime())) {
    throw new ValidationError('Invalid startDate format');
  }

  const days = parseInt(parsed.days, 10);
  if (isNaN(days) || days < -365 || days > 365) {
    throw new ValidationError('Days must be between -365 and 365');
  }

  const country = parsed.country.toUpperCase();
  if (!isValidCountryCode(country)) {
    throw new ValidationError('Invalid country code');
  }

  return {
    startDate: parsed.startDate,
    days,
    country,
    region: parsed.region?.toUpperCase(),
    includeWeekends: parsed.includeWeekends ?? false,
  };
}

function calculateDateRange(startDate: string, days: number) {
  const start = new Date(startDate);
  const end = new Date(startDate);
  
  // Add buffer for weekends and holidays
  const bufferDays = Math.abs(days) * 2;
  if (days > 0) {
    end.setDate(end.getDate() + days + bufferDays);
  } else {
    start.setDate(start.getDate() + days - bufferDays);
  }

  return {
    startYear: start.getFullYear(),
    endYear: end.getFullYear(),
  };
}

async function fetchHolidays(
  country: string,
  startYear: number,
  endYear: number,
  region?: string
): Promise<Map<string, Holiday>> {
  const holidayMap = new Map<string, Holiday>();
  
  for (let year = startYear; year <= endYear; year++) {
    const command = new QueryCommand({
      TableName: process.env.HOLIDAYS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: '#year = :year',
      ExpressionAttributeNames: {
        '#year': 'year',
      },
      ExpressionAttributeValues: {
        ':pk': `COUNTRY#${country}`,
        ':year': year,
      },
    });

    const response = await docClient.send(command);
    
    (response.Items || []).forEach(item => {
      if (!region || item.regions.includes('ALL') || item.regions.includes(region)) {
        holidayMap.set(item.date, {
          date: item.date,
          regions: item.regions,
        });
      }
    });
  }
  
  return holidayMap;
}

function calculateBusinessDays(
  request: BusinessDaysRequest,
  holidays: Map<string, Holiday>
) {
  const { startDate, days, includeWeekends } = request;
  let currentDate = new Date(startDate);
  let remainingDays = Math.abs(days);
  const direction = days > 0 ? 1 : -1;
  let weekendCount = 0;
  let holidayCount = 0;
  const encounteredHolidays: string[] = [];

  while (remainingDays > 0) {
    currentDate.setDate(currentDate.getDate() + direction);
    const dateStr = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();
    
    // Check if it's a weekend
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    if (isWeekend && !includeWeekends) {
      weekendCount++;
      continue;
    }
    
    // Check if it's a holiday
    if (holidays.has(dateStr)) {
      holidayCount++;
      encounteredHolidays.push(dateStr);
      continue;
    }
    
    remainingDays--;
  }

  const totalDays = Math.abs(
    Math.floor((currentDate.getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24))
  );

  return {
    endDate: currentDate.toISOString().split('T')[0],
    totalDays,
    weekendDays: weekendCount,
    holidays: encounteredHolidays,
  };
}

function isValidCountryCode(code: string): boolean {
  const validCodes = ['AU', 'UK', 'GB', 'DE'];
  return validCodes.includes(code);
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}