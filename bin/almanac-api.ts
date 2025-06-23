#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { Phase1Stack } from '../lib/stacks/phase1-stack';
import { DataPipelineStack } from '../lib/stacks/data-pipeline-stack';
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

// Phase 1: Core Infrastructure (Lambda, API Gateway)
const phase1Stack = new Phase1Stack(app, `AlmanacAPI-Phase1-${env}`, {
  env: stackEnv,
  config: config,
  phase0Stack: phase0Stack,
  description: 'Almanac API Phase 1: Core Infrastructure (Lambda, API Gateway)',
});

// Add dependencies
dataPipelineStack.addDependency(phase0Stack);
phase1Stack.addDependency(phase0Stack);