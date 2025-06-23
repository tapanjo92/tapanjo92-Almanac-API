import { APIGatewayProxyResultV2, ErrorResponse, SuccessResponse } from './types';

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(message: string, data?: any): void {
    console.log(JSON.stringify({
      level: 'INFO',
      context: this.context,
      message,
      data,
      timestamp: new Date().toISOString(),
    }));
  }

  error(message: string, error?: any): void {
    console.error(JSON.stringify({
      level: 'ERROR',
      context: this.context,
      message,
      error: error?.message || error,
      stack: error?.stack,
      timestamp: new Date().toISOString(),
    }));
  }

  warn(message: string, data?: any): void {
    console.warn(JSON.stringify({
      level: 'WARN',
      context: this.context,
      message,
      data,
      timestamp: new Date().toISOString(),
    }));
  }
}

export function createSuccessResponse<T>(
  data: T,
  requestId: string,
  count?: number
): APIGatewayProxyResultV2<SuccessResponse<T>> {
  const response: SuccessResponse<T> = {
    data,
    metadata: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  };

  if (count !== undefined) {
    response.metadata.count = count;
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
      'Cache-Control': 'public, max-age=3600', // 1 hour cache
    },
    body: JSON.stringify(response),
  };
}

export function createErrorResponse(
  statusCode: number,
  error: string,
  message: string,
  requestId: string
): APIGatewayProxyResultV2<ErrorResponse> {
  const response: ErrorResponse = {
    error,
    message,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
    },
    body: JSON.stringify(response),
  };
}

export function validateDate(dateString: string): Date {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateString}`);
  }
  return date;
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday or Saturday
}

export function getCountryName(countryCode: string): string {
  const countryMap: { [key: string]: string } = {
    'AU': 'Australia',
    'UK': 'United Kingdom',
    'GB': 'United Kingdom',
    'DE': 'Germany',
    'US': 'United States',
    'CA': 'Canada',
    'NZ': 'New Zealand',
    'FR': 'France',
    'IT': 'Italy',
    'ES': 'Spain',
  };
  return countryMap[countryCode.toUpperCase()] || countryCode;
}

export function parseQueryStringParameters(params?: { [key: string]: string }): any {
  if (!params) return {};
  
  const parsed: any = {};
  for (const [key, value] of Object.entries(params)) {
    // Handle boolean values
    if (value === 'true') parsed[key] = true;
    else if (value === 'false') parsed[key] = false;
    // Handle numeric values
    else if (!isNaN(Number(value))) parsed[key] = Number(value);
    // Keep as string
    else parsed[key] = value;
  }
  
  return parsed;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function validateCountryCode(country: string): string {
  const validCountries = ['AU', 'UK', 'GB', 'DE', 'US', 'CA', 'NZ', 'FR', 'IT', 'ES'];
  const upperCountry = country.toUpperCase();
  
  // Handle UK/GB conversion
  if (upperCountry === 'GB') return 'UK';
  
  if (!validCountries.includes(upperCountry)) {
    throw new ValidationError(`Invalid country code: ${country}. Supported countries: ${validCountries.join(', ')}`);
  }
  
  return upperCountry;
}

export function validateYear(year: number): number {
  const currentYear = new Date().getFullYear();
  if (year < currentYear - 10 || year > currentYear + 10) {
    throw new ValidationError(`Year must be between ${currentYear - 10} and ${currentYear + 10}`);
  }
  return year;
}

export function validateMonth(month: number): number {
  if (month < 1 || month > 12) {
    throw new ValidationError('Month must be between 1 and 12');
  }
  return month;
}