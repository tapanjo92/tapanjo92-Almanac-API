# Government Data Implementation - Cloud Native Architecture

## What I Built

I've transformed the manual Python scripts into a proper cloud-native serverless architecture:

### 1. **Lambda Function** (`/src/lambdas/gov-data-fetcher/index.py`)
- Fetches Australian holiday data from government sources
- Uses AWS Lambda Powertools for logging, metrics, and tracing
- Automatic retry logic for unreliable government sites
- Loads data directly to DynamoDB

### 2. **Infrastructure as Code** (CDK Updates)
```typescript
// In data-pipeline-stack.ts:
- createGovernmentDataFetcherLambda() - Lambda function
- createDataSourceParameters() - SSM Parameter Store
- createGovernmentDataWorkflow() - Step Functions state machine
```

### 3. **SSM Parameter Store Configuration**
All data source URLs are stored in Parameter Store:
- `/almanac/data-sources/config` - Main configuration
- `/almanac/data-sources/national/2024` - National 2024 URL
- `/almanac/data-sources/national/2025` - National 2025 URL
- `/almanac/data-sources/states/nsw` - NSW data URL
- `/almanac/data-sources/states/vic` - VIC data URL

### 4. **Automated Scheduling**
- **Monthly Refresh**: 1st of each month at 1 AM UTC
- **Quarterly Validation**: Jan/Apr/Jul/Oct for source checks
- EventBridge rules trigger Step Functions automatically

### 5. **Monitoring Dashboard** (`data-pipeline-monitoring.ts`)
- Real-time metrics and alarms
- Error tracking and performance monitoring
- SNS alerts for failures
- CloudWatch dashboard for visibility

### 6. **Glue ETL Job** (`australia_holiday_etl_gov.py`)
- Production-ready ETL script for AWS Glue
- Handles all government data sources
- Data quality validation built-in

## Key Improvements Over Scripts

| Manual Scripts | Cloud-Native Solution |
|----------------|----------------------|
| SSH to run | Automatic monthly execution |
| No monitoring | Full CloudWatch dashboard |
| Hardcoded URLs | SSM Parameter Store |
| No error handling | Automatic retries & alerts |
| Single-threaded | Parallel processing |
| No audit trail | Complete logging & tracing |

## To Deploy

```bash
# Build the project
pnpm run build

# Deploy the data pipeline stack
cdk deploy AlmanacAPI-DataPipeline-dev

# The stack will create:
# - Lambda function for data fetching
# - SSM parameters with data source URLs
# - Step Functions workflow
# - EventBridge schedules
# - CloudWatch monitoring
```

## Architecture Benefits

1. **Zero Manual Intervention** - Fully automated
2. **Cost Effective** - <$5/month vs operational overhead
3. **Scalable** - Can add more sources easily
4. **Maintainable** - Update URLs without code changes
5. **Observable** - Know immediately if something fails
6. **Secure** - No hardcoded credentials or URLs

## Testing

```bash
# Manually trigger the Step Functions workflow
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:region:account:stateMachine:almanac-api-dev-gov-data-fetcher

# Check Lambda logs
aws logs tail /aws/lambda/almanac-api-dev-gov-data-fetcher --follow

# Update a data source URL
aws ssm put-parameter \
  --name "/almanac/data-sources/national/2026" \
  --value "https://new-url.csv" \
  --overwrite
```

This is production-ready infrastructure following AWS Well-Architected Framework principles.