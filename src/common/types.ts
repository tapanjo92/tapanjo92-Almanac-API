export interface APIGatewayProxyEventV2 {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  body?: string;
  pathParameters?: { [key: string]: string };
  isBase64Encoded: boolean;
}

export interface APIGatewayProxyResultV2<T = any> {
  statusCode: number;
  headers?: { [key: string]: string };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface HolidayRecord {
  PK: string;
  SK: string;
  date: string;
  name: string;
  type: 'public' | 'bank' | 'observance';
  country: string;
  country_name: string;
  year: number;
  month: number;
  day: number;
  day_of_week: string;
  is_weekend: boolean;
  is_fixed: boolean;
  counties?: string[];
  regions?: string[];
}

export interface TimezoneRecord {
  PK: string;
  SK: string;
  timezone: string;
  timezone_name: string;
  timezone_abbr: string;
  country: string;
  country_name: string;
  city: string;
  state?: string;
  utc_offset: number;
  utc_offset_hours: number;
  dst_offset: number;
  has_dst: boolean;
  is_dst_active: boolean;
}

export interface ErrorResponse {
  error: string;
  message: string;
  requestId: string;
  timestamp: string;
}

export interface SuccessResponse<T> {
  data: T;
  metadata: {
    requestId: string;
    timestamp: string;
    count?: number;
  };
}

export type Holiday = Omit<HolidayRecord, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK'>;
export type Timezone = Omit<TimezoneRecord, 'PK' | 'SK'>;

export interface HolidayQueryParams {
  country: string;
  year?: number;
  month?: number;
  type?: 'public' | 'bank' | 'observance';
}

export interface BusinessDaysParams {
  startDate: string;
  endDate: string;
  country: string;
  includeWeekends?: boolean;
}

export interface TimezoneQueryParams {
  timezone?: string;
  country?: string;
  city?: string;
}