# Phase 2: API Development

## Overview

Phase 2 implements the core API functionality with enhanced Lambda functions and a fully-featured API Gateway setup. This phase includes strict TypeScript typing, comprehensive error handling, and production-ready API configurations.

## Phase 2.1: Lambda Function Enhancements

### Improvements Made:

1. **Strict TypeScript Types**
   - Created shared type definitions in `src/common/types.ts`
   - Full typing for API Gateway events and responses
   - Domain-specific types for holidays, timezones, and business days

2. **Enhanced Error Handling**
   - Custom error classes (ValidationError, NotFoundError)
   - Structured error responses with request IDs
   - Proper HTTP status code mapping

3. **Improved Logging**
   - AWS Lambda Powertools integration
   - Structured JSON logging
   - Request/response correlation with request IDs
   - Performance metrics and tracing

4. **Shared Utilities**
   - Common validation functions
   - Date manipulation helpers
   - Response formatting utilities
   - Query parameter parsing

### Lambda Functions:

1. **Holidays Function** (`/holidays`)
   - Query parameters: country (required), year (required), month, type
   - Returns holiday data from DynamoDB
   - Supports filtering by holiday type

2. **Business Days Function** (`/business-days`)
   - Calculates business days between two dates
   - Excludes weekends and holidays
   - Optional weekend inclusion

3. **Timezone Function** (`/timezones`)
   - Query by timezone ID, country, or city
   - Returns UTC offsets and DST information
   - Includes timezone abbreviations

## Phase 2.2: API Gateway Configuration

### Features Implemented:

1. **REST API Setup**
   - Regional endpoint type
   - CORS enabled for all origins
   - Request/response logging
   - X-Ray tracing enabled

2. **API Key Management**
   - Default API key created
   - Usage plan with quotas:
     - 100 requests/second rate limit
     - 200 requests/second burst limit
     - 10,000 requests/day quota

3. **Request Validation**
   - Query parameter validation
   - Required vs optional parameters
   - Pattern validation for country codes

4. **Security Features**
   - WAF integration (production only)
   - Rate limiting rules
   - Common attack protection
   - API key requirement (except health endpoint)

5. **Monitoring**
   - CloudWatch dashboard
   - Request/error metrics
   - Latency tracking
   - Custom metrics from Lambda

### API Endpoints:

#### 1. Health Check
```
GET /health
```
- No authentication required
- Returns API health status

#### 2. Holidays
```
GET /holidays?country=AU&year=2024&month=12&type=public
```
- Returns holidays for specified criteria
- Cached for 1 hour

#### 3. Business Days
```
GET /business-days?startDate=2024-01-01&endDate=2024-01-31&country=AU
```
- Calculates business days between dates
- Excludes holidays and weekends

#### 4. Timezones
```
GET /timezones?country=AU
GET /timezones?timezone=Australia/Sydney
GET /timezones?city=Sydney
```
- Query timezone information
- Multiple query options

## Deployment Instructions

### Prerequisites
1. Phase 0 and Phase 1 already deployed
2. AWS CLI configured
3. CDK v2 installed

### Deploy API Gateway

```bash
# Build the project
npm run build

# Deploy API Gateway stack
cdk deploy AlmanacAPI-APIGateway-dev

# Note the outputs:
# - API URL
# - API Key ID
```

### Retrieve API Key

```bash
# Get the API key value
API_KEY_ID=<from-stack-output>
aws apigateway get-api-key \
  --api-key $API_KEY_ID \
  --include-value \
  --region ap-south-1 \
  --query 'value' \
  --output text
```

### Test the API

```bash
# Run the test script
./scripts/test-api.sh dev

# Or test manually
API_KEY=<your-api-key>
API_URL=<from-stack-output>

# Test holidays endpoint
curl -H "X-API-Key: $API_KEY" \
  "${API_URL}holidays?country=AU&year=2024"
```

## API Response Format

### Success Response
```json
{
  "data": {
    "country": "AU",
    "year": "2024",
    "holidays": [
      {
        "date": "2024-01-01",
        "name": "New Year's Day",
        "type": "public",
        "country": "AU",
        "country_name": "Australia",
        "day_of_week": "Monday",
        "is_weekend": false
      }
    ]
  },
  "metadata": {
    "requestId": "abc123-def456",
    "timestamp": "2024-01-15T10:30:00Z",
    "count": 1
  }
}
```

### Error Response
```json
{
  "error": "ValidationError",
  "message": "Invalid country code: XX",
  "requestId": "abc123-def456",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

## Monitoring and Troubleshooting

### CloudWatch Logs
- API Gateway logs: `/aws/apigateway/almanac-api-dev`
- Lambda logs: `/aws/lambda/almanac-api-dev-*`

### Metrics to Monitor
1. API Gateway:
   - 4XX/5XX error rates
   - Request count
   - Latency (average and p99)

2. Lambda Functions:
   - Invocation count
   - Error count
   - Duration
   - Concurrent executions

### Common Issues

1. **403 Forbidden**
   - Missing or invalid API key
   - Check X-API-Key header

2. **400 Bad Request**
   - Missing required parameters
   - Invalid parameter values
   - Check error message for details

3. **429 Too Many Requests**
   - Rate limit exceeded
   - Check X-RateLimit-* headers

4. **500 Internal Server Error**
   - Lambda function error
   - Check CloudWatch logs
   - Verify DynamoDB data exists

## Security Considerations

1. **API Keys**
   - Store securely (use AWS Secrets Manager)
   - Rotate regularly
   - Don't commit to code

2. **CORS**
   - Currently allows all origins
   - Restrict in production

3. **WAF Rules** (Production)
   - IP rate limiting
   - Common attack patterns blocked
   - Geographic restrictions (if needed)

4. **Data Validation**
   - Input sanitization in Lambda
   - Query parameter validation in API Gateway
   - DynamoDB query injection prevention

## Cost Optimization

1. **Caching**
   - 1-hour cache headers reduce Lambda invocations
   - Consider CloudFront for global caching

2. **Lambda Configuration**
   - Right-sized memory (512MB)
   - ARM architecture for cost savings
   - Reserved concurrency limits

3. **API Gateway**
   - Usage plans prevent abuse
   - Consider REST vs HTTP API based on features

## Next Steps

After Phase 2 is complete:
1. Phase 0.5: Add Cognito authentication
2. Phase 3: Implement caching layer (DAX, CloudFront)
3. Phase 4: Comprehensive monitoring
4. Phase 5: Security hardening

## Testing Checklist

- [ ] Health endpoint accessible without auth
- [ ] API key required for data endpoints
- [ ] All query parameters validated
- [ ] Error responses properly formatted
- [ ] Rate limiting working
- [ ] CORS headers present
- [ ] Caching headers set
- [ ] Request IDs in responses
- [ ] CloudWatch logs capturing requests
- [ ] Metrics visible in dashboard