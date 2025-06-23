#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { getConfig } from '../lib/config';

const app = new cdk.App();

const env = app.node.tryGetContext('env') || 'dev';
const config = getConfig(env);

// Phase 0: Foundation Infrastructure
new Phase0Stack(app, `AlmanacAPI-Phase0-${env}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
  config: config,
  description: 'Almanac API Phase 0: Foundation Infrastructure (DynamoDB, S3, Glue)',
});