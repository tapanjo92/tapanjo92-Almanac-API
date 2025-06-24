#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { Phase1Stack } from '../lib/stacks/phase1-stack';
import { DataPipelineStack } from '../lib/stacks/data-pipeline-stack';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';
import { Phase3Stack } from '../lib/stacks/phase3-stack';
import { CloudFrontStack } from '../lib/stacks/cloudfront-stack';
import { Phase4ObservabilityStack } from '../lib/stacks/phase4-observability-stack';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { ETLMetadataStack } from '../lib/stacks/etl-metadata-stack';
import { UnifiedDataPipelineStack } from '../lib/stacks/unified-data-pipeline-stack';
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

// ETL Metadata Stack (for tracking ETL runs)
const etlMetadataStack = new ETLMetadataStack(app, `AlmanacAPI-ETLMetadata-${env}`, {
  env: stackEnv,
  config: config,
  description: 'Almanac API ETL Metadata: Tracking and monitoring for ETL runs',
});

// Unified Data Pipeline Stack (replaces multiple ETL jobs)
const unifiedPipelineStack = new UnifiedDataPipelineStack(app, `AlmanacAPI-UnifiedPipeline-${env}`, {
  env: stackEnv,
  config: config,
  phase0Stack: phase0Stack,
  metadataStack: etlMetadataStack,
  description: 'Almanac API Unified Pipeline: Consolidated ETL with deduplication',
});

// Cognito Stack for authentication (deploy before Phase 1)
const cognitoStack = new CognitoStack(app, `AlmanacAPI-Cognito-${env}`, {
  env: stackEnv,
  config: config,
  description: 'Almanac API Cognito: User Pool and authentication',
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
  cognitoStack: cognitoStack,
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

// Phase 4: Observability and Operations
const phase4Stack = new Phase4ObservabilityStack(app, `AlmanacAPI-Phase4-${env}`, {
  env: stackEnv,
  config: config,
  phase1Stack: phase1Stack,
  apiGatewayStack: apiGatewayStack,
  phase3Stack: phase3Stack,
  description: 'Almanac API Phase 4: Observability and Operations',
});

// Add dependencies
dataPipelineStack.addDependency(phase0Stack);
etlMetadataStack.addDependency(phase0Stack);
unifiedPipelineStack.addDependency(phase0Stack);
unifiedPipelineStack.addDependency(etlMetadataStack);
phase1Stack.addDependency(phase0Stack);
apiGatewayStack.addDependency(phase1Stack);
phase3Stack.addDependency(phase0Stack);
// Note: Phase3 cannot depend on Phase1 due to circular dependency with custom resource
cloudFrontStack.addDependency(apiGatewayStack);
phase4Stack.addDependency(phase1Stack);
phase4Stack.addDependency(apiGatewayStack);
phase4Stack.addDependency(phase3Stack);