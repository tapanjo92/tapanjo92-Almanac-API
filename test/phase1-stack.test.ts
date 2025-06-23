import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { Phase1Stack } from '../lib/stacks/phase1-stack';
import { getConfig } from '../lib/config';

describe('Phase1Stack', () => {
  let app: cdk.App;
  let phase0Stack: Phase0Stack;
  let phase1Stack: Phase1Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    const config = getConfig('test');
    
    phase0Stack = new Phase0Stack(app, 'TestPhase0Stack', {
      env: { account: '123456789012', region: 'ap-south-1' },
      config: config,
    });
    
    phase1Stack = new Phase1Stack(app, 'TestPhase1Stack', {
      env: { account: '123456789012', region: 'ap-south-1' },
      config: config,
      phase0Stack: phase0Stack,
    });
    
    template = Template.fromStack(phase1Stack);
  });

  describe('Lambda Functions', () => {
    test('creates holidays Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'almanac-api-test-holidays',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        MemorySize: 512,
        Timeout: 30,
        Architectures: ['arm64'],
      });
    });

    test('creates business days Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'almanac-api-test-business-days',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        MemorySize: 512,
        Timeout: 30,
        Architectures: ['arm64'],
      });
    });

    test('creates timezone Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'almanac-api-test-timezone',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        MemorySize: 256,
        Timeout: 10,
        Architectures: ['arm64'],
      });
    });

    test('Lambda functions have X-Ray tracing enabled', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        TracingConfig: {
          Mode: 'Active',
        },
      });
    });
  });

  describe('Lambda Layer', () => {
    test('creates shared dependencies layer', () => {
      template.hasResourceProperties('AWS::Lambda::LayerVersion', {
        LayerName: 'almanac-api-test-shared-deps',
        CompatibleRuntimes: ['nodejs20.x'],
      });
    });
  });

  describe('API Gateway', () => {
    test('creates REST API', () => {
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: 'almanac-api-test',
        Description: 'Almanac API - Global Holidays & Time-Zones Service',
        EndpointConfiguration: {
          Types: ['REGIONAL'],
        },
      });
    });

    test('creates API deployment with stage', () => {
      template.hasResourceProperties('AWS::ApiGateway::Deployment', {
        StageName: 'test',
      });
    });

    test('creates usage plan', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        UsagePlanName: 'almanac-api-test-usage-plan',
        Throttle: {
          RateLimit: 100,
          BurstLimit: 200,
        },
        Quota: {
          Limit: 10000,
          Period: 'DAY',
        },
      });
    });

    test('creates API key', () => {
      template.hasResourceProperties('AWS::ApiGateway::ApiKey', {
        Name: 'almanac-api-test-test-key',
        Description: 'Test API key for development',
      });
    });
  });

  describe('API Resources', () => {
    test('creates v1 resource', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'v1',
      });
    });

    test('creates holidays resource with GET method', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'holidays',
      });
      
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        ApiKeyRequired: true,
      });
    });

    test('creates business-days resource with POST method', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'business-days',
      });
      
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        ApiKeyRequired: true,
      });
    });

    test('creates timezone resource with GET method', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'timezone',
      });
      
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        ApiKeyRequired: true,
      });
    });

    test('creates health resource without API key', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'health',
      });
      
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        ApiKeyRequired: false,
      });
    });
  });

  describe('Request Validators', () => {
    test('creates request validators', () => {
      template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
        Name: 'holidays-validator',
        ValidateRequestParameters: true,
      });

      template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
        Name: 'business-days-validator',
        ValidateRequestBody: true,
      });

      template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
        Name: 'timezone-validator',
        ValidateRequestParameters: true,
      });
    });
  });

  describe('IAM Permissions', () => {
    test('Lambda functions have DynamoDB read permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: Match.arrayWith([
                'dynamodb:GetItem',
                'dynamodb:Query',
              ]),
            }),
          ]),
        },
      });
    });
  });

  describe('SSM Parameters', () => {
    test('stores API URL in SSM parameter', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/almanac-api/test/api-url',
        Type: 'String',
      });
    });
  });

  describe('Stack Outputs', () => {
    test('has all required outputs', () => {
      const outputs = template.findOutputs('*');
      const outputKeys = Object.keys(outputs);

      expect(outputKeys).toContain('ApiUrl');
      expect(outputKeys).toContain('ApiId');
      expect(outputKeys).toContain('HolidaysFunctionArn');
      expect(outputKeys).toContain('BusinessDaysFunctionArn');
      expect(outputKeys).toContain('TimezoneFunctionArn');
    });
  });
});