# Phase 3 Deployment Guide

## Overview

Phase 3 implements the data layer and caching infrastructure for the Almanac API, including:
- User usage tracking tables
- API key management
- DAX cluster for sub-10ms caching
- CloudFront global distribution

## Architecture Decision: Post-Deployment Configuration

Due to AWS CDK limitations with circular dependencies, Phase 3 resources cannot directly update Lambda functions from Phase 1. Instead, we use a post-deployment script approach.

### Why Post-Deployment?

1. **Circular Dependency Prevention**: Phase 1 creates Lambda functions, Phase 3 creates tables/DAX that Lambda needs, but Phase 3 can't update Phase 1 resources without creating a circular dependency.

2. **Clean Separation**: Keeps infrastructure stacks independent and deployable in any order.

3. **Flexibility**: Allows updating Lambda configurations without redeploying entire stacks.

## Deployment Steps

### 1. Deploy Phase 3 Infrastructure

```bash
npm run cdk deploy AlmanacAPI-Phase3-dev -- --require-approval never
```

This creates:
- User usage tracking table
- API keys table  
- DAX cluster in ap-south-1
- VPC and security groups for DAX

### 2. Run Post-Deployment Configuration

```bash
npm run post-deploy:phase3
# or
./scripts/post-deploy-phase3.sh dev
```

This script:
- Updates Lambda environment variables with Phase 3 resource names
- Grants IAM permissions to access new tables and DAX
- Configures all three Lambda functions (holidays, business-days, timezone)

## What Gets Configured

### Environment Variables Added to Lambda Functions:
- `USER_USAGE_TABLE`: DynamoDB table for tracking API usage per user
- `API_KEYS_TABLE`: DynamoDB table for API key management
- `DAX_ENDPOINT`: DAX cluster endpoint for caching

### IAM Permissions Added:
- Read/Write access to user usage table
- Read access to API keys table
- Full DAX access for caching operations

## Verification

After deployment, verify the configuration:

```bash
# Check Lambda environment variables
aws lambda get-function-configuration \
  --function-name almanac-api-dev-holidays \
  --region ap-south-1 \
  --query "Environment.Variables"

# Test API through CloudFront
curl -H "x-api-key: YOUR_API_KEY" \
  "https://YOUR_CLOUDFRONT_DOMAIN/holidays?country=US&year=2025"
```

## Troubleshooting

### If Lambda functions don't have Phase 3 variables:
1. Ensure Phase 3 stack is in CREATE_COMPLETE or UPDATE_COMPLETE state
2. Re-run the post-deployment script
3. Wait 10-15 seconds for Lambda configuration to propagate

### If you see permission errors:
1. Check that the Lambda execution roles have the Phase3TableAccess policy
2. Verify DAX cluster is running and accessible from Lambda VPC

## Future Improvements

When CDK supports better cross-stack resource updates, this could be integrated directly into the infrastructure code using:
- Custom resources with proper dependency handling
- Step Functions for orchestrating multi-stack deployments
- AWS Service Catalog for managed deployments