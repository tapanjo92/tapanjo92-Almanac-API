import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as waf from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { Phase1Stack } from './phase1-stack';

export interface ApiGatewayStackProps extends cdk.StackProps {
  config: AlmanacConfig;
  phase1Stack: Phase1Stack;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiKey: apigateway.ApiKey;
  public readonly usagePlan: apigateway.UsagePlan;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const { config, phase1Stack } = props;

    // Create REST API
    this.api = new apigateway.RestApi(this, 'AlmanacAPI', {
      restApiName: `${config.projectName}-${config.environment}`,
      description: 'Almanac API - Holiday, Business Days, and Timezone Services',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        dataTraceEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiAccessLogs', {
            logGroupName: `/aws/apigateway/${config.projectName}-${config.environment}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
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
          'X-Request-ID',
        ],
        maxAge: cdk.Duration.hours(24),
      },
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      retainDeployments: false,
    });

    // Create API Key
    this.apiKey = new apigateway.ApiKey(this, 'AlmanacApiKey', {
      apiKeyName: `${config.projectName}-${config.environment}-default`,
      description: 'Default API key for Almanac API',
      enabled: true,
    });

    // Create Usage Plan
    this.usagePlan = new apigateway.UsagePlan(this, 'AlmanacUsagePlan', {
      name: `${config.projectName}-${config.environment}-default`,
      description: 'Default usage plan for Almanac API',
      apiStages: [
        {
          api: this.api,
          stage: this.api.deploymentStage,
        },
      ],
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.DAY,
      },
    });

    // Associate API Key with Usage Plan
    this.usagePlan.addApiKey(this.apiKey);

    // Create request validator
    const requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: 'Validate query parameters',
      validateRequestParameters: true,
      validateRequestBody: false,
    });

    // Add health check endpoint (no auth required)
    const health = this.api.root.addResource('health');
    health.addMethod('GET', new apigateway.LambdaIntegration(
      this.createHealthCheckLambda()
    ), {
      apiKeyRequired: false,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // Add holidays endpoint
    const holidays = this.api.root.addResource('holidays');
    this.addHolidaysEndpoint(holidays, phase1Stack.holidaysFunction, requestValidator);

    // Add business-days endpoint
    const businessDays = this.api.root.addResource('business-days');
    this.addBusinessDaysEndpoint(businessDays, phase1Stack.businessDaysFunction, requestValidator);

    // Add timezones endpoint
    const timezones = this.api.root.addResource('timezones');
    this.addTimezonesEndpoint(timezones, phase1Stack.timezoneFunction, requestValidator);

    // Create CloudWatch dashboard
    this.createDashboard(config);

    // Add WAF if enabled
    if (config.security?.enableWAF) {
      this.addWAF(config);
    }

    // Outputs
    this.createOutputs();
  }

  private createHealthCheckLambda(): lambda.Function {
    return new lambda.Function(this, 'HealthCheckFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async () => {
          return {
            statusCode: 200,
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              status: 'healthy',
              timestamp: new Date().toISOString(),
              version: '1.0.0',
              region: process.env.AWS_REGION,
            }),
          };
        };
      `),
      timeout: cdk.Duration.seconds(3),
      memorySize: 128,
    });
  }

  private addHolidaysEndpoint(
    resource: apigateway.Resource,
    lambdaFunction: lambda.Function,
    validator: apigateway.RequestValidator
  ): void {
    resource.addMethod('GET', new apigateway.LambdaIntegration(lambdaFunction), {
      apiKeyRequired: true,
      requestValidator: validator,
      requestParameters: {
        'method.request.querystring.country': true,
        'method.request.querystring.year': true,
        'method.request.querystring.month': false,
        'method.request.querystring.type': false,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.X-Request-ID': true,
            'method.response.header.Cache-Control': true,
          },
        },
        { statusCode: '400' },
        { statusCode: '401' },
        { statusCode: '500' },
      ],
    });
  }

  private addBusinessDaysEndpoint(
    resource: apigateway.Resource,
    lambdaFunction: lambda.Function,
    validator: apigateway.RequestValidator
  ): void {
    // Create request model for business days calculation
    const businessDaysModel = new apigateway.Model(this, 'BusinessDaysModel', {
      restApi: this.api,
      contentType: 'application/json',
      description: 'Business days calculation request',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          startDate: { type: apigateway.JsonSchemaType.STRING },
          days: { type: apigateway.JsonSchemaType.NUMBER },
          country: { type: apigateway.JsonSchemaType.STRING },
          region: { type: apigateway.JsonSchemaType.STRING },
          includeWeekends: { type: apigateway.JsonSchemaType.BOOLEAN },
        },
        required: ['startDate', 'days', 'country'],
      },
    });

    // Create body validator
    const bodyValidator = new apigateway.RequestValidator(this, 'BusinessDaysBodyValidator', {
      restApi: this.api,
      requestValidatorName: 'Validate body',
      validateRequestBody: true,
      validateRequestParameters: false,
    });

    resource.addMethod('POST', new apigateway.LambdaIntegration(lambdaFunction), {
      apiKeyRequired: true,
      requestValidator: bodyValidator,
      requestModels: {
        'application/json': businessDaysModel,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.X-Request-ID': true,
            'method.response.header.Cache-Control': true,
          },
        },
        { statusCode: '400' },
        { statusCode: '401' },
        { statusCode: '500' },
      ],
    });
  }

  private addTimezonesEndpoint(
    resource: apigateway.Resource,
    lambdaFunction: lambda.Function,
    validator: apigateway.RequestValidator
  ): void {
    resource.addMethod('GET', new apigateway.LambdaIntegration(lambdaFunction), {
      apiKeyRequired: true,
      requestValidator: validator,
      requestParameters: {
        'method.request.querystring.lat': true,
        'method.request.querystring.lng': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.X-Request-ID': true,
            'method.response.header.Cache-Control': true,
          },
        },
        { statusCode: '400' },
        { statusCode: '401' },
        { statusCode: '500' },
      ],
    });
  }

  private createDashboard(config: AlmanacConfig): void {
    const dashboard = new cloudwatch.Dashboard(this, 'ApiDashboard', {
      dashboardName: `${config.projectName}-${config.environment}-api`,
    });

    // API Gateway metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Requests',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Count',
            dimensionsMap: {
              ApiName: this.api.restApiName,
            },
            statistic: 'Sum',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4XXError',
            dimensionsMap: {
              ApiName: this.api.restApiName,
            },
            statistic: 'Sum',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: {
              ApiName: this.api.restApiName,
            },
            statistic: 'Sum',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: {
              ApiName: this.api.restApiName,
            },
            statistic: 'Average',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: {
              ApiName: this.api.restApiName,
            },
            statistic: 'p99',
          }),
        ],
      })
    );
  }

  private addWAF(config: AlmanacConfig): void {
    const webAcl = new waf.CfnWebACL(this, 'ApiWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: [
        {
          name: 'RateLimitRule',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
        },
        {
          name: 'CommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${config.projectName}-${config.environment}-waf`,
      },
    });

    new waf.CfnWebACLAssociation(this, 'ApiWebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
      exportName: `${this.stackName}:ApiUrl`,
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
      exportName: `${this.stackName}:ApiId`,
    });

    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: this.apiKey.keyId,
      description: 'API Key ID (retrieve value from console)',
    });

    new cdk.CfnOutput(this, 'ApiKeyHint', {
      value: 'Use AWS CLI or Console to retrieve the API key value',
      description: 'aws apigateway get-api-key --api-key <key-id> --include-value',
    });
  }
}