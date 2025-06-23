import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { Phase0Stack } from './phase0-stack';

export interface Phase1StackProps extends cdk.StackProps {
  config: AlmanacConfig;
  phase0Stack: Phase0Stack;
}

export class Phase1Stack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly holidaysFunction: lambdaNodejs.NodejsFunction;
  public readonly businessDaysFunction: lambdaNodejs.NodejsFunction;
  public readonly timezoneFunction: lambdaNodejs.NodejsFunction;
  public readonly lambdaLayer: lambda.LayerVersion;

  constructor(scope: Construct, id: string, props: Phase1StackProps) {
    super(scope, id, props);

    const { config, phase0Stack } = props;

    // Create Lambda Layer for shared dependencies
    this.lambdaLayer = this.createLambdaLayer(config);

    // Create Lambda Functions
    this.holidaysFunction = this.createHolidaysFunction(config, phase0Stack);
    this.businessDaysFunction = this.createBusinessDaysFunction(config, phase0Stack);
    this.timezoneFunction = this.createTimezoneFunction(config, phase0Stack);

    // Create API Gateway
    this.api = this.createApiGateway(config);

    // Create API Resources and Methods
    this.setupApiEndpoints();

    // Store API URL in SSM Parameter
    this.storeApiUrl(config);

    // Create Outputs
    this.createOutputs(config);
  }

  private createLambdaLayer(config: AlmanacConfig): lambda.LayerVersion {
    return new lambda.LayerVersion(this, 'SharedDependenciesLayer', {
      code: lambda.Code.fromAsset('layers/shared-deps'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared dependencies for Almanac API Lambda functions',
      layerVersionName: `${config.projectName}-${config.environment}-shared-deps`,
    });
  }

  private createHolidaysFunction(config: AlmanacConfig, phase0Stack: Phase0Stack): lambdaNodejs.NodejsFunction {
    const func = new lambdaNodejs.NodejsFunction(this, 'HolidaysFunction', {
      functionName: `${config.projectName}-${config.environment}-holidays`,
      entry: 'src/lambdas/holidays/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        NODE_ENV: config.environment,
        HOLIDAYS_TABLE: phase0Stack.holidaysTable.tableName,
        REGION: this.region,
        LOG_LEVEL: config.environment === 'prod' ? 'info' : 'debug',
      },
      layers: [this.lambdaLayer],
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: config.environment === 'prod',
        sourceMap: true,
        externalModules: ['@aws-sdk/*'], // SDK v3 is included in Lambda runtime
      },
    });

    // Grant permissions
    phase0Stack.holidaysTable.grantReadData(func);
    
    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(func).add(key, value);
    });

    return func;
  }

  private createBusinessDaysFunction(config: AlmanacConfig, phase0Stack: Phase0Stack): lambdaNodejs.NodejsFunction {
    const func = new lambdaNodejs.NodejsFunction(this, 'BusinessDaysFunction', {
      functionName: `${config.projectName}-${config.environment}-business-days`,
      entry: 'src/lambdas/business-days/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        NODE_ENV: config.environment,
        HOLIDAYS_TABLE: phase0Stack.holidaysTable.tableName,
        REGION: this.region,
        LOG_LEVEL: config.environment === 'prod' ? 'info' : 'debug',
      },
      layers: [this.lambdaLayer],
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: config.environment === 'prod',
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant permissions
    phase0Stack.holidaysTable.grantReadData(func);
    
    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(func).add(key, value);
    });

    return func;
  }

  private createTimezoneFunction(config: AlmanacConfig, phase0Stack: Phase0Stack): lambdaNodejs.NodejsFunction {
    const func = new lambdaNodejs.NodejsFunction(this, 'TimezoneFunction', {
      functionName: `${config.projectName}-${config.environment}-timezone`,
      entry: 'src/lambdas/timezone/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256, // Less memory needed for timezone lookups
      timeout: cdk.Duration.seconds(10),
      environment: {
        NODE_ENV: config.environment,
        TIMEZONES_TABLE: phase0Stack.timezonesTable.tableName,
        REGION: this.region,
        LOG_LEVEL: config.environment === 'prod' ? 'info' : 'debug',
        USE_FALLBACK_API: 'true', // Feature flag for external API fallback
      },
      layers: [this.lambdaLayer],
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: config.environment === 'prod',
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant permissions
    phase0Stack.timezonesTable.grantReadData(func);
    
    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(func).add(key, value);
    });

    return func;
  }

  private createApiGateway(config: AlmanacConfig): apigateway.RestApi {
    const api = new apigateway.RestApi(this, 'AlmanacApi', {
      restApiName: `${config.projectName}-${config.environment}`,
      description: 'Almanac API - Global Holidays & Time-Zones Service',
      deployOptions: {
        stageName: config.environment,
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: config.environment !== 'prod',
        metricsEnabled: true,
        throttlingBurstLimit: 1000,
        throttlingRateLimit: 500,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        maxAge: cdk.Duration.hours(1),
      },
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: true,
    });

    // Add usage plan for API key management
    const plan = api.addUsagePlan('UsagePlan', {
      name: `${config.projectName}-${config.environment}-usage-plan`,
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.DAY,
      },
    });

    plan.addApiStage({
      stage: api.deploymentStage,
    });

    // Create API key for testing
    const apiKey = api.addApiKey('TestApiKey', {
      apiKeyName: `${config.projectName}-${config.environment}-test-key`,
      description: 'Test API key for development',
    });

    plan.addApiKey(apiKey);

    return api;
  }

  private setupApiEndpoints(): void {
    // API versioning
    const v1 = this.api.root.addResource('v1');

    // Holidays endpoint
    const holidays = v1.addResource('holidays');
    holidays.addMethod('GET', new apigateway.LambdaIntegration(this.holidaysFunction, {
      requestTemplates: {
        'application/json': JSON.stringify({
          statusCode: 200,
        }),
      },
    }), {
      apiKeyRequired: true,
      requestParameters: {
        'method.request.querystring.country': true,
        'method.request.querystring.year': true,
        'method.request.querystring.region': false,
      },
      requestValidator: new apigateway.RequestValidator(this, 'HolidaysValidator', {
        restApi: this.api,
        requestValidatorName: 'holidays-validator',
        validateRequestParameters: true,
      }),
    });

    // Business days endpoint
    const businessDays = v1.addResource('business-days');
    businessDays.addMethod('POST', new apigateway.LambdaIntegration(this.businessDaysFunction), {
      apiKeyRequired: true,
      requestValidator: new apigateway.RequestValidator(this, 'BusinessDaysValidator', {
        restApi: this.api,
        requestValidatorName: 'business-days-validator',
        validateRequestBody: true,
      }),
    });

    // Timezone endpoint
    const timezone = v1.addResource('timezone');
    timezone.addMethod('GET', new apigateway.LambdaIntegration(this.timezoneFunction, {
      requestTemplates: {
        'application/json': JSON.stringify({
          statusCode: 200,
        }),
      },
    }), {
      apiKeyRequired: true,
      requestParameters: {
        'method.request.querystring.lat': true,
        'method.request.querystring.lng': true,
      },
      requestValidator: new apigateway.RequestValidator(this, 'TimezoneValidator', {
        restApi: this.api,
        requestValidatorName: 'timezone-validator',
        validateRequestParameters: true,
      }),
    });

    // Health check endpoint (no API key required)
    const health = v1.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      requestTemplates: {
        'application/json': JSON.stringify({
          statusCode: 200,
        }),
      },
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': JSON.stringify({
            status: 'healthy',
            timestamp: '$context.requestTime',
          }),
        },
      }],
    }), {
      methodResponses: [{
        statusCode: '200',
      }],
    });
  }

  private storeApiUrl(config: AlmanacConfig): void {
    new ssm.StringParameter(this, 'ApiUrlParameter', {
      parameterName: `/${config.projectName}/${config.environment}/api-url`,
      stringValue: this.api.url,
      description: 'API Gateway URL for Almanac API',
    });
  }

  private createOutputs(config: AlmanacConfig): void {
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
    });

    new cdk.CfnOutput(this, 'HolidaysFunctionArn', {
      value: this.holidaysFunction.functionArn,
      description: 'Holidays Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'BusinessDaysFunctionArn', {
      value: this.businessDaysFunction.functionArn,
      description: 'Business Days Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'TimezoneFunctionArn', {
      value: this.timezoneFunction.functionArn,
      description: 'Timezone Lambda function ARN',
    });
  }
}