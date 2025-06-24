#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { Phase1Stack } from '../lib/stacks/phase1-stack';
import { DataPipelineStack } from '../lib/stacks/data-pipeline-stack';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';
import { Phase3Stack } from '../lib/stacks/phase3-stack';
import { CloudFrontStack } from '../lib/stacks/cloudfront-stack';
import { getConfig } from '../lib/config';

const app = new cdk.App();

const env = app.node.tryGetContext('env') || 'dev';
const config = getConfig(env);

const stackEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

// Phase 0: Foundation Infrastructure
const phase0Stack = new Phase0Stack(app, `AlmanacAPI-Phase0-${env}`, {
  env: stackEnv,
  config: config,
  description: 'Almanac API Phase 0: Foundation Infrastructure (DynamoDB, S3, Glue)',
});

// Phase 0.3: Data Pipeline
const dataPipelineStack = new DataPipelineStack(app, `AlmanacAPI-DataPipeline-${env}`, {
  env: stackEnv,
  config: config,
  phase0Stack: phase0Stack,
  description: 'Almanac API Data Pipeline: ETL jobs, validation, and orchestration',
});

// Phase 1: Core Infrastructure (Lambda functions)
const phase1Stack = new Phase1Stack(app, `AlmanacAPI-Phase1-${env}`, {
  env: stackEnv,
  config: config,
  phase0Stack: phase0Stack,
  description: 'Almanac API Phase 1: Core Infrastructure (Lambda functions)',
});

// Phase 2.2: API Gateway
const apiGatewayStack = new ApiGatewayStack(app, `AlmanacAPI-APIGateway-${env}`, {
  env: stackEnv,
  config: config,
  phase1Stack: phase1Stack,
  description: 'Almanac API Phase 2.2: API Gateway with endpoints and usage plans',
});

// Phase 3: Data Layer and Caching (DynamoDB & DAX)
const phase3Stack = new Phase3Stack(app, `AlmanacAPI-Phase3-${env}`, {
  env: stackEnv,
  config: config,
  phase0Stack: phase0Stack,
  description: 'Almanac API Phase 3: Data Layer and Caching (DynamoDB, DAX)',
});

// CloudFront Distribution (separate to avoid circular dependencies)
const cloudFrontStack = new CloudFrontStack(app, `AlmanacAPI-CloudFront-${env}`, {
  env: stackEnv,
  config: config,
  apiGatewayStack: apiGatewayStack,
  description: 'Almanac API CloudFront Distribution for global edge caching',
});

// Add dependencies
dataPipelineStack.addDependency(phase0Stack);
phase1Stack.addDependency(phase0Stack);
apiGatewayStack.addDependency(phase1Stack);
phase3Stack.addDependency(phase0Stack);
// Note: Phase3 cannot depend on Phase1 due to circular dependency with custom resource
cloudFrontStack.addDependency(apiGatewayStack);