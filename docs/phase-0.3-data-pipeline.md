# Phase 0.3: Data Pipeline Implementation

## Overview

Phase 0.3 implements a robust data pipeline for ingesting, validating, and storing holiday and timezone data. The pipeline uses AWS Glue for ETL, Step Functions for orchestration, and Lambda functions for validation.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Raw Bucket    │────▶│  Glue Crawler   │────▶│   Glue ETL Job  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Lambda Quality  │◀────│ Lambda Validate │◀────│ Staging Bucket  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                                                │
         ▼                                                ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SNS Approval   │────▶│ Step Functions  │────▶│ Validated Bucket│
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
                                                 ┌─────────────────┐
                                                 │  DynamoDB Tables│
                                                 └─────────────────┘
```

## Components

### 1. **Glue Crawlers**
- **Holiday Crawler**: Discovers schema from raw holiday data
- **Timezone Crawler**: Discovers schema from IANA timezone data
- Both run on schedule or can be triggered manually

### 2. **Glue ETL Jobs**
- **holiday_etl.py**: Processes holiday data for AU, UK, DE
  - Validates date formats
  - Enriches with additional fields (year, month, day_of_week)
  - Handles different holiday types (public, bank, observance)
  
- **timezone_etl.py**: Processes timezone information
  - Calculates UTC offsets
  - Identifies DST rules
  - Maps cities to timezones

### 3. **Lambda Functions**
- **Data Validation Lambda**: 
  - Schema validation
  - Data type checking
  - Required field validation
  - Returns quality score

- **Data Quality Lambda**:
  - Calculates quality metrics (completeness, uniqueness, accuracy)
  - Publishes metrics to CloudWatch
  - Determines if manual approval needed

### 4. **Step Functions Workflow**
The orchestration includes:
1. Parallel execution of holiday and timezone pipelines
2. Data validation after ETL
3. Quality checks with 98% threshold
4. Manual approval via SNS for data below threshold
5. Automatic approval for high-quality data

### 5. **Data Storage**
- **S3 Buckets**:
  - Raw: Original data from external sources
  - Staging: Validated but not approved data
  - Validated: Production-ready data
  - Archive: Historical data with lifecycle policies

- **DynamoDB Tables**:
  - Holidays: Partitioned by country, sorted by date
  - Timezones: Partitioned by country, sorted by timezone ID

## Deployment Instructions

### Prerequisites
1. AWS CLI configured with appropriate credentials
2. CDK bootstrapped in ap-south-1 region
3. Phase 0 stack already deployed

### Step 1: Deploy Glue Scripts
```bash
cd /root/Almanac-API
./scripts/deploy-glue-scripts.sh dev
```

### Step 2: Deploy Data Pipeline Stack
```bash
npm run build
cdk deploy AlmanacAPI-DataPipeline-dev
```

### Step 3: Test the Pipeline
```bash
./scripts/test-data-pipeline.sh dev
```

## Data Schema

### Holiday Data Schema
```json
{
  "PK": "COUNTRY#AU",
  "SK": "DATE#2024-01-01",
  "date": "2024-01-01",
  "name": "New Year's Day",
  "type": "public",
  "country": "AU",
  "country_name": "Australia",
  "year": 2024,
  "month": 1,
  "day": 1,
  "day_of_week": "Monday",
  "is_weekend": false,
  "is_fixed": true
}
```

### Timezone Data Schema
```json
{
  "PK": "COUNTRY#AU",
  "SK": "TIMEZONE#Australia/Sydney",
  "timezone": "Australia/Sydney",
  "timezone_name": "Australia/Sydney",
  "timezone_abbr": "AEDT",
  "country": "AU",
  "country_name": "Australia",
  "city": "Sydney",
  "state": "NSW",
  "utc_offset": 39600,
  "utc_offset_hours": 11,
  "dst_offset": 3600,
  "has_dst": true,
  "is_dst_active": true
}
```

## Monitoring and Troubleshooting

### CloudWatch Dashboards
The pipeline creates metrics for:
- ETL job success/failure rates
- Data quality scores
- Processing times
- Record counts

### Common Issues

1. **Glue Job Failures**
   - Check CloudWatch logs in `/aws/glue/`
   - Verify S3 bucket permissions
   - Ensure Python dependencies are available

2. **Step Functions Timeout**
   - Default timeout is 6 hours
   - Check for stuck manual approval tasks
   - Verify SNS topic subscriptions

3. **Data Quality Below Threshold**
   - Review validation Lambda logs
   - Check source data format
   - Verify transformation logic

### Manual Data Upload
To manually add data:
```bash
# Upload to raw bucket
aws s3 cp holidays.json s3://almanac-api-dev-raw-{account}/holidays/2024/

# Trigger pipeline
aws stepfunctions start-execution \
  --state-machine-arn {pipeline-arn} \
  --name manual-run-$(date +%s)
```

## Testing

### Unit Tests
```bash
npm test -- test/data-pipeline-stack.test.ts
```

### Integration Tests
The test script verifies:
- Pipeline execution
- Data transformation
- DynamoDB population
- Lambda function responses

## Security Considerations

1. **IAM Roles**: Least privilege access for each component
2. **Encryption**: All S3 buckets use SSE-S3
3. **VPC**: Glue jobs can run in VPC if needed
4. **Audit**: CloudTrail logs all data modifications

## Cost Optimization

1. **Glue**: Using 2 DPUs (minimum) for cost efficiency
2. **Step Functions**: Express workflows for high-volume
3. **S3**: Lifecycle policies move old data to Glacier
4. **DynamoDB**: On-demand billing for variable workloads

## Next Steps

After Phase 0.3 is complete:
1. Phase 2.2: Configure API Gateway
2. Phase 0.5: Add Cognito authentication
3. Phase 3: Implement caching layer
4. Phase 4: Add comprehensive monitoring