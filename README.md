# Almanac API - Phase 0 Infrastructure

Global Holidays & Time-Zones API built on AWS Serverless architecture.

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 20.x or later
- PNPM: `npm install -g pnpm`
- AWS CDK CLI: `pnpm add -g aws-cdk`
- AWS Account with appropriate permissions

## Installation

```bash
pnpm install
```

## Deployment

### Bootstrap CDK (first time only)
```bash
cdk bootstrap aws://ACCOUNT-ID/ap-south-1
```

### Deploy Phase 0 Infrastructure
```bash
# Deploy to development environment
pnpm run deploy:dev

# Deploy to production environment
pnpm run deploy:prod
```

### Other Commands
```bash
# Synthesize CloudFormation template
pnpm run synth

# Show differences between deployed stack and local code
pnpm run diff

# Run tests
pnpm test

# Destroy all stacks
pnpm run destroy
```

## Phase 0 Infrastructure Components

### DynamoDB Tables
- **Holidays Table**: Stores holiday data with global secondary index for year-based queries
- **Timezones Table**: Stores timezone lookup data

### S3 Buckets
- **Raw Bucket**: Incoming data from external sources
- **Staging Bucket**: Data undergoing validation
- **Validated Bucket**: Production-ready data
- **Archive Bucket**: Historical data storage
- **Glue Scripts Bucket**: ETL job scripts

### Other Resources
- Glue Database for data catalog
- IAM Roles for Lambda, Glue, and Step Functions
- SNS Topic for approval workflow
- CloudWatch Log Groups

## Architecture

Single-region deployment in `ap-south-1` (Mumbai) with:
- Serverless-first approach using DynamoDB, Lambda, and API Gateway
- Event-driven data pipeline using Step Functions and Glue
- Pay-per-request pricing model for cost optimization

## Next Steps

After Phase 0 deployment:
1. Run validation tests to ensure infrastructure is correctly provisioned
2. Deploy sample data for testing
3. Proceed to Phase 1: Core Infrastructure (Lambda functions, API Gateway)

## Configuration

Environment-specific configuration is managed in `lib/config.ts`. The following environments are supported:
- `dev`: Development environment
- `prod`: Production environment

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test -- --watch
```

## Troubleshooting

1. **CDK Bootstrap Error**: Ensure you've run `cdk bootstrap` for your account/region
2. **Permission Errors**: Verify your AWS credentials have sufficient permissions
3. **Deployment Failures**: Check CloudFormation console for detailed error messages