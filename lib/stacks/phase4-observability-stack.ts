import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as xray from 'aws-cdk-lib/aws-xray';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';

export interface Phase4ObservabilityStackProps extends cdk.StackProps {
  config: AlmanacConfig;
  phase1Stack: any;
  apiGatewayStack: any;
  phase3Stack: any;
}

export class Phase4ObservabilityStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: Phase4ObservabilityStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Create SNS topic for alarms
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${config.projectName}-${config.environment}-alarms`,
      displayName: `Almanac API ${config.environment} Alarms`,
    });

    // Add email subscription if provided in config
    if (config.alarmEmail) {
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(config.alarmEmail)
      );
    }

    // Create main dashboard
    this.dashboard = this.createMainDashboard(props);

    // Create API Gateway metrics and alarms
    this.createApiGatewayMonitoring(props);

    // Create Lambda metrics and alarms
    this.createLambdaMonitoring(props);

    // Create DynamoDB metrics and alarms
    this.createDynamoDBMonitoring(props);

    // Create DAX metrics and alarms
    this.createDAXMonitoring(props);

    // Create CloudFront metrics
    this.createCloudFrontMonitoring(props);

    // Create synthetic monitoring
    this.createSyntheticMonitoring(props);

    // Create log insights queries
    this.createLogInsightsQueries(props);

    // Create custom metrics dashboard
    this.createCustomMetricsDashboard(props);

    // Enable X-Ray tracing
    this.enableXRayTracing(props);

    // Output the dashboard URL
    new cdk.CfnOutput(this, 'DashboardURL', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS Topic for CloudWatch Alarms',
    });
  }

  private createMainDashboard(props: Phase4ObservabilityStackProps): cloudwatch.Dashboard {
    const { config } = props;
    
    const dashboard = new cloudwatch.Dashboard(this, 'MainDashboard', {
      dashboardName: `${config.projectName}-${config.environment}-main`,
      defaultInterval: cdk.Duration.hours(1),
    });

    // Add overview widgets
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# Almanac API - ${config.environment.toUpperCase()} Environment
        
## Key Metrics Overview
- **API Gateway**: Request count, latency, and errors
- **Lambda Functions**: Invocations, errors, and duration
- **DynamoDB**: Read/write capacity and throttles
- **DAX**: Cache hits and misses
- **CloudFront**: Requests and cache hit rate`,
        width: 24,
        height: 4,
      })
    );

    return dashboard;
  }

  private createApiGatewayMonitoring(props: Phase4ObservabilityStackProps): void {
    const { config, apiGatewayStack } = props;
    const apiName = apiGatewayStack.api.restApiName;

    // API Gateway request metrics
    const apiRequestsMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: {
        ApiName: apiName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const api4xxErrorsMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      dimensionsMap: {
        ApiName: apiName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const api5xxErrorsMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      dimensionsMap: {
        ApiName: apiName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const apiLatencyMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      dimensionsMap: {
        ApiName: apiName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    const apiP99LatencyMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      dimensionsMap: {
        ApiName: apiName,
      },
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });

    // Add API Gateway widgets to dashboard
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway - Request Volume',
        left: [apiRequestsMetric],
        right: [api4xxErrorsMetric, api5xxErrorsMetric],
        leftYAxis: {
          label: 'Requests',
          showUnits: false,
        },
        rightYAxis: {
          label: 'Errors',
          showUnits: false,
        },
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway - Latency',
        left: [apiLatencyMetric],
        right: [apiP99LatencyMetric],
        leftYAxis: {
          label: 'Average Latency (ms)',
          showUnits: false,
        },
        rightYAxis: {
          label: 'p99 Latency (ms)',
          showUnits: false,
        },
        width: 12,
        height: 6,
      })
    );

    // Create alarms
    new cloudwatch.Alarm(this, 'ApiGateway5xxAlarm', {
      metric: api5xxErrorsMetric,
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway 5XX errors exceed threshold',
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    new cloudwatch.Alarm(this, 'ApiGatewayLatencyAlarm', {
      metric: apiP99LatencyMetric,
      threshold: 1000, // 1 second
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway p99 latency exceeds 1 second',
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createLambdaMonitoring(props: Phase4ObservabilityStackProps): void {
    const { phase1Stack } = props;
    
    const lambdaFunctions = [
      { name: 'Holidays', fn: phase1Stack.holidaysFunction },
      { name: 'BusinessDays', fn: phase1Stack.businessDaysFunction },
      { name: 'Timezone', fn: phase1Stack.timezoneFunction },
    ];

    lambdaFunctions.forEach(({ name, fn }) => {
      const invocationsMetric = new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensionsMap: {
          FunctionName: fn.functionName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      const errorsMetric = new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: {
          FunctionName: fn.functionName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      const durationMetric = new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        dimensionsMap: {
          FunctionName: fn.functionName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      });

      const throttlesMetric = new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Throttles',
        dimensionsMap: {
          FunctionName: fn.functionName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // Add Lambda widgets
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `Lambda - ${name} Function`,
          left: [invocationsMetric, errorsMetric],
          right: [durationMetric],
          leftYAxis: {
            label: 'Count',
            showUnits: false,
          },
          rightYAxis: {
            label: 'Duration (ms)',
            showUnits: false,
          },
          width: 8,
          height: 6,
        })
      );

      // Create alarms
      new cloudwatch.Alarm(this, `${name}LambdaErrorAlarm`, {
        metric: errorsMetric,
        threshold: 5,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda function errors exceed threshold`,
      }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

      new cloudwatch.Alarm(this, `${name}LambdaThrottleAlarm`, {
        metric: throttlesMetric,
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda function is being throttled`,
      }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
    });
  }

  private createDynamoDBMonitoring(props: Phase4ObservabilityStackProps): void {
    const { config } = props;
    
    const tables = [
      `${config.projectName}-${config.environment}-holidays`,
      `${config.projectName}-${config.environment}-timezones`,
      `${config.projectName}-${config.environment}-api-keys`,
      `${config.projectName}-${config.environment}-user-usage`,
    ];

    tables.forEach((tableName) => {
      const consumedReadMetric = new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ConsumedReadCapacityUnits',
        dimensionsMap: {
          TableName: tableName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      const consumedWriteMetric = new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ConsumedWriteCapacityUnits',
        dimensionsMap: {
          TableName: tableName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      const throttledRequestsMetric = new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'UserErrors',
        dimensionsMap: {
          TableName: tableName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // Add DynamoDB widgets
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `DynamoDB - ${tableName}`,
          left: [consumedReadMetric, consumedWriteMetric],
          right: [throttledRequestsMetric],
          leftYAxis: {
            label: 'Capacity Units',
            showUnits: false,
          },
          rightYAxis: {
            label: 'Throttled Requests',
            showUnits: false,
          },
          width: 12,
          height: 6,
        })
      );

      // Create alarm for throttled requests
      new cloudwatch.Alarm(this, `${tableName}ThrottleAlarm`, {
        metric: throttledRequestsMetric,
        threshold: 1,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `DynamoDB table ${tableName} is being throttled`,
      }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
    });
  }

  private createDAXMonitoring(props: Phase4ObservabilityStackProps): void {
    const { config } = props;
    const clusterName = `${config.projectName}-${config.environment}-dax`;

    const cacheHitsMetric = new cloudwatch.Metric({
      namespace: 'AWS/DAX',
      metricName: 'ItemCacheHits',
      dimensionsMap: {
        ClusterName: clusterName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const cacheMissesMetric = new cloudwatch.Metric({
      namespace: 'AWS/DAX',
      metricName: 'ItemCacheMisses',
      dimensionsMap: {
        ClusterName: clusterName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const cacheHitRateMetric = new cloudwatch.MathExpression({
      expression: '(cacheHits / (cacheHits + cacheMisses)) * 100',
      usingMetrics: {
        cacheHits: cacheHitsMetric,
        cacheMisses: cacheMissesMetric,
      },
      period: cdk.Duration.minutes(5),
    });

    // Add DAX widgets
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DAX Cache Performance',
        left: [cacheHitsMetric, cacheMissesMetric],
        right: [cacheHitRateMetric],
        leftYAxis: {
          label: 'Count',
          showUnits: false,
        },
        rightYAxis: {
          label: 'Hit Rate (%)',
          showUnits: false,
        },
        width: 12,
        height: 6,
      })
    );

    // Create alarm for cache hit rate
    new cloudwatch.Alarm(this, 'DAXCacheHitRateAlarm', {
      metric: cacheHitRateMetric,
      threshold: 80, // Alert if cache hit rate drops below 80%
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'DAX cache hit rate is below 80%',
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createCloudFrontMonitoring(props: Phase4ObservabilityStackProps): void {
    const { config } = props;
    
    // Note: CloudFront metrics are in us-east-1
    const requestsMetric = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: 'Requests',
      dimensionsMap: {
        DistributionId: props.config.cloudFrontDistributionId || 'E294HONVZ6GZA5',
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      region: 'us-east-1',
    });

    const bytesDownloadedMetric = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: 'BytesDownloaded',
      dimensionsMap: {
        DistributionId: props.config.cloudFrontDistributionId || 'E294HONVZ6GZA5',
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      region: 'us-east-1',
    });

    const cacheHitRateMetric = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: 'CacheHitRate',
      dimensionsMap: {
        DistributionId: props.config.cloudFrontDistributionId || 'E294HONVZ6GZA5',
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
      region: 'us-east-1',
    });

    // Add CloudFront widgets
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CloudFront Distribution',
        left: [requestsMetric],
        right: [cacheHitRateMetric],
        leftYAxis: {
          label: 'Requests',
          showUnits: false,
        },
        rightYAxis: {
          label: 'Cache Hit Rate (%)',
          showUnits: false,
        },
        width: 12,
        height: 6,
      })
    );
  }

  private createSyntheticMonitoring(props: Phase4ObservabilityStackProps): void {
    const { config } = props;
    
    // Create synthetic canary for health check
    const canaryRole = new iam.Role(this, 'CanaryRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchSyntheticsFullAccess'),
      ],
    });

    const healthCheckCanary = new synthetics.Canary(this, 'HealthCheckCanary', {
      canaryName: `${config.projectName}-${config.environment}-hc`,
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_6_2,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
          const synthetics = require('Synthetics');
          const log = require('SyntheticsLogger');
          
          const apiEndpoint = '${props.apiGatewayStack.api.url}health';
          
          const apiCanaryBlueprint = async function () {
            const validateSuccessful = async function(res) {
              return new Promise((resolve, reject) => {
                if (res.statusCode < 200 || res.statusCode > 299) {
                  throw new Error(res.statusCode + ' ' + res.statusMessage);
                }
                
                let responseBody = '';
                res.on('data', (d) => {
                  responseBody += d;
                });
                
                res.on('end', () => {
                  const response = JSON.parse(responseBody);
                  if (response.status !== 'healthy') {
                    throw new Error('Health check failed: ' + responseBody);
                  }
                  resolve();
                });
              });
            };
            
            const headers = {
              'x-api-key': '${props.config.testApiKey || 'test-key'}',
            };
            
            await synthetics.executeHttpStep('Health Check', apiEndpoint, headers, validateSuccessful);
          };
          
          exports.handler = async () => {
            return await synthetics.executeStep('API Health Check', apiCanaryBlueprint);
          };
        `),
        handler: 'index.handler',
      }),
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
      role: canaryRole,
      artifactsBucketLocation: {
        bucket: new cdk.aws_s3.Bucket(this, 'CanaryArtifacts', {
          bucketName: `${config.projectName}-${config.environment}-canary-artifacts-${cdk.Aws.ACCOUNT_ID}`,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
        }),
      },
    });

    // Add canary success rate to dashboard
    const canarySuccessMetric = new cloudwatch.Metric({
      namespace: 'CloudWatchSynthetics',
      metricName: 'SuccessPercent',
      dimensionsMap: {
        CanaryName: healthCheckCanary.canaryName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    this.dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Health Check Status',
        metrics: [canarySuccessMetric],
        width: 6,
        height: 6,
      })
    );

    // Create alarm for canary failures
    new cloudwatch.Alarm(this, 'HealthCheckAlarm', {
      metric: canarySuccessMetric,
      threshold: 90,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Health check success rate below 90%',
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createLogInsightsQueries(props: Phase4ObservabilityStackProps): void {
    const { config, phase1Stack } = props;
    
    // Define common queries
    const queries = [
      {
        name: 'API Errors by Type',
        logGroupNames: [
          `/aws/lambda/${phase1Stack.holidaysFunction.functionName}`,
          `/aws/lambda/${phase1Stack.businessDaysFunction.functionName}`,
          `/aws/lambda/${phase1Stack.timezoneFunction.functionName}`,
        ],
        queryString: `fields @timestamp, @message
          | filter @message like /ERROR/
          | stats count() by error.name
          | sort count() desc`,
      },
      {
        name: 'Slow API Requests',
        logGroupNames: [
          `/aws/lambda/${phase1Stack.holidaysFunction.functionName}`,
          `/aws/lambda/${phase1Stack.businessDaysFunction.functionName}`,
          `/aws/lambda/${phase1Stack.timezoneFunction.functionName}`,
        ],
        queryString: `fields @timestamp, @duration, @message
          | filter @duration > 1000
          | sort @duration desc
          | limit 100`,
      },
      {
        name: 'Request Count by Country',
        logGroupNames: [
          `/aws/lambda/${phase1Stack.holidaysFunction.functionName}`,
          `/aws/lambda/${phase1Stack.businessDaysFunction.functionName}`,
        ],
        queryString: `fields @timestamp, @message
          | parse @message /"country":"(?<country>[^"]+)"/
          | stats count() by country
          | sort count() desc`,
      },
    ];

    // Store queries as SSM parameters for easy access
    queries.forEach((query, index) => {
      new cdk.aws_ssm.StringParameter(this, `LogQuery${index}`, {
        parameterName: `/${config.projectName}/${config.environment}/log-insights/query-${index}`,
        stringValue: JSON.stringify(query),
        description: query.name,
      });
    });
  }

  private createCustomMetricsDashboard(props: Phase4ObservabilityStackProps): void {
    const { config } = props;
    
    // Create a separate dashboard for custom business metrics
    const customDashboard = new cloudwatch.Dashboard(this, 'CustomMetricsDashboard', {
      dashboardName: `${config.projectName}-${config.environment}-business-metrics`,
    });

    // Holiday requests by country
    const holidayRequestsMetric = new cloudwatch.Metric({
      namespace: 'AlmanacAPI',
      metricName: 'HolidayRequests',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Business days calculations
    const businessDaysMetric = new cloudwatch.Metric({
      namespace: 'AlmanacAPI',
      metricName: 'BusinessDaysRequests',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Timezone lookups
    const timezoneMetric = new cloudwatch.Metric({
      namespace: 'AlmanacAPI',
      metricName: 'TimezoneRequests',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    customDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Usage by Endpoint',
        left: [holidayRequestsMetric, businessDaysMetric, timezoneMetric],
        width: 24,
        height: 6,
      })
    );

    // API key usage tracking
    const apiKeyUsageWidget = new cloudwatch.LogQueryWidget({
      title: 'API Key Usage',
      logGroupNames: ['/aws/lambda/*'],
      queryLines: [
        'fields @timestamp, @message',
        '| parse @message /"x-api-key":"(?<apiKey>[^"]+)"/',
        '| stats count() by apiKey',
        '| sort count() desc',
        '| limit 10',
      ],
      width: 12,
      height: 6,
    });

    customDashboard.addWidgets(apiKeyUsageWidget);
  }

  private enableXRayTracing(props: Phase4ObservabilityStackProps): void {
    const { phase1Stack } = props;
    
    // X-Ray is already enabled on Lambda functions via tracing: Tracing.ACTIVE
    // Create X-Ray service map widget
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## X-Ray Service Map
        
[View X-Ray Service Map](https://console.aws.amazon.com/xray/home?region=${this.region}#/service-map)
        
X-Ray tracing is enabled for all Lambda functions. Click the link above to view the service map and trace analysis.`,
        width: 24,
        height: 4,
      })
    );

    // X-Ray sampling rules can be configured separately if needed
  }
}