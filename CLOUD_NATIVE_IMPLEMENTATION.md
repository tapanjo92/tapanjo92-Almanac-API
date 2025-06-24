# Cloud-Native Government Data Implementation

## Architecture Overview

As a senior cloud architect, I've refactored the government data fetching from standalone scripts to a proper cloud-native serverless architecture.

### What Was Wrong with Python Scripts

1. **Manual Execution** - Required SSH access and manual runs
2. **No Monitoring** - Zero visibility into failures
3. **No Scalability** - Single-threaded execution
4. **Security Risk** - Hardcoded URLs and credentials
5. **No Version Control** - Infrastructure changes not tracked
6. **Operational Overhead** - Someone needs to remember to run it

### The Correct Cloud-Native Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  EventBridge    │────▶│Step Functions│────▶│   Lambda    │
│ Monthly/Quarterly│     │ (Orchestrator)│     │(Gov Fetcher)│
└─────────────────┘     └──────────────┘     └─────────────┘
         │                                            │
         │                                            ▼
         │                                    ┌─────────────┐
         │                                    │     SSM     │
         │                                    │ Parameters  │
         │                                    └─────────────┘
         │                                            │
         ▼                                            ▼
┌─────────────────┐                          ┌─────────────┐
│   CloudWatch    │                          │  DynamoDB   │
│   Dashboard     │                          │   Tables    │
└─────────────────┘                          └─────────────┘
```

## Implementation Details

### 1. **Lambda Function** (`/src/lambdas/gov-data-fetcher/index.py`)
- **Runtime**: Python 3.11 with Lambda Powertools
- **Memory**: 1GB (optimized for CSV processing)
- **Timeout**: 15 minutes (government sites can be slow)
- **Features**:
  - Automatic retries with exponential backoff
  - Structured logging with correlation IDs
  - CloudWatch metrics for every operation
  - Error handling with detailed tracing

### 2. **SSM Parameter Store Configuration**
```typescript
// Infrastructure as Code - NOT hardcoded URLs
new ssm.StringParameter(this, 'DataSourcesConfig', {
  parameterName: '/almanac/data-sources/config',
  stringValue: JSON.stringify(dataSources),
  tier: ssm.ParameterTier.STANDARD,
});
```

### 3. **Step Functions Orchestration**
- **Monthly Execution**: 1st of each month at 1 AM UTC
- **Quarterly Validation**: Jan/Apr/Jul/Oct for source verification
- **Error Handling**: Automatic SNS notifications on failure
- **Data Quality Gates**: 95% threshold before production

### 4. **Monitoring & Alerting**
- **CloudWatch Dashboard**: Real-time metrics
- **Alarms**:
  - Lambda errors (>3 in 10 minutes)
  - Execution timeout warnings (>14 minutes)
  - Data quality below 95%
  - Missed monthly executions
- **SNS Notifications**: Immediate alerts to ops team

### 5. **Security Best Practices**
- **IAM Least Privilege**: Function only has required permissions
- **No Hardcoded Secrets**: Everything in SSM/Secrets Manager
- **VPC Isolation**: Can be deployed in private subnets
- **Encryption**: All data encrypted at rest and in transit

## Deployment Instructions

```bash
# Deploy the updated stack
pnpm run build
cdk deploy AlmanacAPI-DataPipeline-dev

# Update SSM parameters if URLs change
aws ssm put-parameter \
  --name "/almanac/data-sources/national/2026" \
  --value "https://new-url-when-available.csv" \
  --overwrite

# Manually trigger for testing
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:region:account:stateMachine:almanac-api-dev-gov-data-fetcher \
  --input '{"test": true}'
```

## Cost Optimization

- **Lambda**: ~$0.20/month (2 executions × 5 min × 1GB)
- **Step Functions**: ~$0.05/month (2 executions)
- **SSM Parameters**: Free tier
- **CloudWatch**: ~$3/month for dashboard
- **Total**: <$5/month vs $100s for EC2

## Key Improvements

1. **Zero Manual Intervention** - Fully automated
2. **Self-Healing** - Automatic retries and error recovery
3. **Auditable** - Every execution logged and traced
4. **Scalable** - Can handle multiple sources concurrently
5. **Maintainable** - Update URLs without code changes
6. **Observable** - Full visibility into pipeline health

## Migration Path

1. ✅ Create Lambda function in CDK
2. ✅ Move URLs to SSM Parameter Store
3. ✅ Setup Step Functions workflow
4. ✅ Configure EventBridge schedules
5. ✅ Add comprehensive monitoring
6. ✅ Remove legacy Python scripts
7. ⏳ Deploy and verify in production

## Lessons for the Team

This is how we build on AWS in 2025:
- **No scripts on servers** - Everything is a Lambda
- **No hardcoded configs** - Use Parameter Store
- **No manual processes** - EventBridge for scheduling
- **No blind spots** - CloudWatch for everything
- **No snowflakes** - Infrastructure as Code only

The standalone Python scripts were technical debt from day one. This implementation follows AWS Well-Architected Framework principles and is production-ready for a SaaS platform.