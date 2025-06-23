import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const logger = new Logger({ serviceName: 'timezone-function' });
const tracer = new Tracer({ serviceName: 'timezone-function' });
const metrics = new Metrics({ namespace: 'AlmanacAPI', serviceName: 'timezone-function' });

interface TimezoneQuery {
  lat: number;
  lng: number;
}

interface TimezoneResult {
  timezone: string;
  offset: string;
  dst: boolean;
  location?: string;
}

// Simplified in-memory timezone lookup (replace with proper library)
const TIMEZONE_BOUNDARIES = [
  { minLat: -90, maxLat: -30, minLng: 110, maxLng: 180, timezone: 'Australia/Sydney', offset: '+10:00', dst: true },
  { minLat: 48, maxLat: 60, minLng: -10, maxLng: 2, timezone: 'Europe/London', offset: '+00:00', dst: true },
  { minLat: 47, maxLat: 55, minLng: 5, maxLng: 15, timezone: 'Europe/Berlin', offset: '+01:00', dst: true },
  { minLat: 8, maxLat: 37, minLng: 68, maxLng: 97, timezone: 'Asia/Kolkata', offset: '+05:30', dst: false },
];

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logger.info('Received request', { event });
  metrics.addMetric('TimezoneRequests', MetricUnit.Count, 1);

  try {
    // Validate query parameters
    const query = validateQueryParams(event.queryStringParameters);
    
    // Create cache key
    const cacheKey = createCacheKey(query.lat, query.lng);
    
    // Try to get from cache (DynamoDB)
    let result = await getFromCache(cacheKey);
    
    if (!result) {
      // Perform lookup
      result = await lookupTimezone(query);
      
      // Cache the result
      await cacheResult(cacheKey, result, query);
      
      metrics.addMetric('TimezoneCacheMiss', MetricUnit.Count, 1);
    } else {
      metrics.addMetric('TimezoneCacheHit', MetricUnit.Count, 1);
    }
    
    metrics.addMetric('TimezoneSuccess', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      },
      body: JSON.stringify({
        latitude: query.lat,
        longitude: query.lng,
        ...result,
      }),
    };
  } catch (error) {
    logger.error('Error processing request', { error });
    metrics.addMetric('TimezoneErrors', MetricUnit.Count, 1);
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

function validateQueryParams(params: any): TimezoneQuery {
  if (!params?.lat || !params?.lng) {
    throw new ValidationError('Missing required parameters: lat and lng');
  }

  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);

  if (isNaN(lat) || lat < -90 || lat > 90) {
    throw new ValidationError('Latitude must be between -90 and 90');
  }

  if (isNaN(lng) || lng < -180 || lng > 180) {
    throw new ValidationError('Longitude must be between -180 and 180');
  }

  return { lat, lng };
}

function createCacheKey(lat: number, lng: number): string {
  // Round to 2 decimal places for caching
  const roundedLat = Math.round(lat * 100) / 100;
  const roundedLng = Math.round(lng * 100) / 100;
  return `LAT#${roundedLat}#LNG#${roundedLng}`;
}

async function getFromCache(cacheKey: string): Promise<TimezoneResult | null> {
  try {
    const command = new GetCommand({
      TableName: process.env.TIMEZONES_TABLE,
      Key: {
        PK: cacheKey,
        SK: 'TIMEZONE',
      },
    });

    const response = await docClient.send(command);
    
    if (response.Item) {
      return {
        timezone: response.Item.timezone,
        offset: response.Item.offset,
        dst: response.Item.dst,
        location: response.Item.location,
      };
    }
  } catch (error) {
    logger.warn('Cache lookup failed', { error, cacheKey });
  }
  
  return null;
}

async function lookupTimezone(query: TimezoneQuery): Promise<TimezoneResult> {
  // First try in-memory lookup
  const inMemoryResult = lookupInMemory(query);
  
  if (inMemoryResult) {
    return inMemoryResult;
  }
  
  // If feature flag is enabled, fall back to external API
  if (process.env.USE_FALLBACK_API === 'true') {
    return await lookupFromExternalApi(query);
  }
  
  throw new Error('Unable to determine timezone for coordinates');
}

function lookupInMemory(query: TimezoneQuery): TimezoneResult | null {
  for (const boundary of TIMEZONE_BOUNDARIES) {
    if (
      query.lat >= boundary.minLat &&
      query.lat <= boundary.maxLat &&
      query.lng >= boundary.minLng &&
      query.lng <= boundary.maxLng
    ) {
      return {
        timezone: boundary.timezone,
        offset: boundary.offset,
        dst: boundary.dst,
      };
    }
  }
  
  return null;
}

async function lookupFromExternalApi(query: TimezoneQuery): Promise<TimezoneResult> {
  // Placeholder for external API call
  // In production, this would call Amazon Location Service or similar
  logger.info('Falling back to external API', { query });
  
  // Simulate API response
  return {
    timezone: 'UTC',
    offset: '+00:00',
    dst: false,
    location: 'Unknown',
  };
}

async function cacheResult(
  cacheKey: string,
  result: TimezoneResult,
  query: TimezoneQuery
): Promise<void> {
  try {
    const command = new PutCommand({
      TableName: process.env.TIMEZONES_TABLE,
      Item: {
        PK: cacheKey,
        SK: 'TIMEZONE',
        ...result,
        lat: query.lat,
        lng: query.lng,
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
      },
    });

    await docClient.send(command);
  } catch (error) {
    logger.warn('Failed to cache result', { error, cacheKey });
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}