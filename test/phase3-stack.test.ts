import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { Phase1Stack } from '../lib/stacks/phase1-stack';
import { Phase3Stack } from '../lib/stacks/phase3-stack';
import { getConfig } from '../lib/config';

describe('Phase3Stack', () => {
  let app: cdk.App;
  let phase0Stack: Phase0Stack;
  let phase1Stack: Phase1Stack;
  let phase3Stack: Phase3Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    const config = getConfig('test');
    
    phase0Stack = new Phase0Stack(app, 'TestPhase0Stack', { config });
    phase1Stack = new Phase1Stack(app, 'TestPhase1Stack', { config, phase0Stack });
    
    // For testing, we need to avoid circular dependencies
    // In production, Phase3Stack would be deployed after Phase1Stack
    phase3Stack = new Phase3Stack(app, 'TestPhase3Stack', { 
      config, 
      phase0Stack
    });
    
    template = Template.fromStack(phase3Stack);
  });

  test('Creates User Usage Tracking Table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: Match.stringLikeRegexp('.*user-usage'),
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('Creates API Keys Table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: Match.stringLikeRegexp('.*api-keys'),
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  test('Creates VPC for DAX', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  test('Creates DAX Cluster', () => {
    template.hasResourceProperties('AWS::DAX::Cluster', {
      ClusterName: Match.stringLikeRegexp('.*dax'),
      NodeType: 'dax.r5.large',
      ReplicationFactor: 2,
      SSESpecification: {
        SSEEnabled: true,
      },
      ClusterEndpointEncryptionType: 'TLS',
    });
  });

  test('Creates DAX Security Group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for DAX cluster',
    });
  });

  test('Creates Global Secondary Indexes', () => {
    // User Usage Table GSIs
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: Match.stringLikeRegexp('.*user-usage'),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'DateUserIndex',
        }),
        Match.objectLike({
          IndexName: 'TierUsageIndex',
        }),
      ]),
    });

    // API Keys Table GSI
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: Match.stringLikeRegexp('.*api-keys'),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'ApiKeyIndex',
        }),
      ]),
    });
  });

  test('DAX Cluster has proper IAM role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Principal: {
            Service: 'dax.amazonaws.com',
          },
          Action: 'sts:AssumeRole',
        }],
      },
    });
  });

  test('Creates Stack Outputs', () => {
    template.hasOutput('UserUsageTableName', {
      Description: 'DynamoDB table for user usage tracking',
    });
    
    template.hasOutput('ApiKeysTableName', {
      Description: 'DynamoDB table for API key management',
    });
    
    template.hasOutput('DaxClusterEndpoint', {
      Description: 'DAX cluster endpoint',
    });
  });
});