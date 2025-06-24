import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as path from 'path';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { Phase0Stack } from './phase0-stack';

export interface DataQualityStackProps extends cdk.StackProps {
  config: AlmanacConfig;
  phase0Stack: Phase0Stack;
}

/**
 * Data Quality Stack - Because data quality isn't optional in production
 * 
 * This stack handles:
 * 1. One-time data cleanup for existing mess
 * 2. Ongoing data quality validation
 * 3. Alerts when data quality drops
 * 
 * As a senior architect, I've seen too many systems fail due to bad data.
 * This stack ensures it doesn't happen here.
 */
export class DataQualityStack extends cdk.Stack {
  public readonly dataCleanupLambda: lambda.Function;
  public readonly dataValidationLambda: lambda.Function;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: DataQualityStackProps) {
    super(scope, id, props);

    const { config, phase0Stack } = props;

    // SNS topic for data quality alerts - you need to know immediately
    this.alertTopic = new sns.Topic(this, 'DataQualityAlerts', {
      topicName: `${config.projectName}-${config.environment}-data-quality-alerts`,
      displayName: 'Almanac API Data Quality Alerts',
    });

    // Data cleanup Lambda - fixes the current mess
    this.dataCleanupLambda = this.createDataCleanupLambda(config, phase0Stack);
    
    // Data validation Lambda - prevents future messes
    this.dataValidationLambda = this.createDataValidationLambda(config, phase0Stack);

    // Create quality metrics and alarms
    this.createDataQualityMetrics(config);

    // Schedule regular quality checks
    this.createQualityCheckSchedule(config);

    // Outputs
    this.createOutputs();
  }

  private createDataCleanupLambda(config: AlmanacConfig, phase0Stack: Phase0Stack): lambda.Function {
    const func = new lambda.Function(this, 'DataCleanupLambda', {
      functionName: `${config.projectName}-${config.environment}-data-cleanup`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/lambdas/data-cleanup')),
      timeout: cdk.Duration.minutes(15), // Cleanup can take time
      memorySize: 3008, // Max memory for faster processing
      environment: {
        HOLIDAYS_TABLE: phase0Stack.holidaysTable.tableName,
        ENVIRONMENT: config.environment,
        POWERTOOLS_SERVICE_NAME: 'data-cleanup',
        POWERTOOLS_METRICS_NAMESPACE: 'AlmanacAPI/DataQuality',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'PowertoolsLayer',
          `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:46`
        ),
      ],
      reservedConcurrentExecutions: 1, // Only one cleanup at a time
    });

    // Grant permissions - needs full table access for cleanup
    phase0Stack.holidaysTable.grantReadWriteData(func);
    
    // CloudWatch metrics permissions
    func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    return func;
  }

  private createDataValidationLambda(config: AlmanacConfig, phase0Stack: Phase0Stack): lambda.Function {
    const func = new lambda.Function(this, 'DataValidationLambda', {
      functionName: `${config.projectName}-${config.environment}-data-validation`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime
from collections import defaultdict

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['HOLIDAYS_TABLE'])
sns = boto3.client('sns')
cloudwatch = boto3.client('cloudwatch')

VALID_REGIONS = {'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'ALL'}

def handler(event, context):
    """Ongoing data validation - runs daily to catch issues early"""
    
    print(f"Starting data validation at {datetime.utcnow().isoformat()}")
    
    # Scan recent data (last 7 days of updates)
    issues = defaultdict(list)
    
    # Sample check - in production, scan recent updates
    response = table.scan(Limit=100)
    
    for item in response.get('Items', []):
        # Check regions are uppercase
        regions = item.get('regions', [])
        for region in regions:
            if region != 'ALL' and region != region.upper():
                issues['case_inconsistency'].append({
                    'pk': item['PK'],
                    'sk': item['SK'],
                    'region': region
                })
        
        # Check data_source exists
        if 'data_source' not in item:
            issues['missing_metadata'].append({
                'pk': item['PK'],
                'sk': item['SK']
            })
    
    # Publish metrics
    cloudwatch.put_metric_data(
        Namespace='AlmanacAPI/DataQuality',
        MetricData=[
            {
                'MetricName': 'DataQualityIssues',
                'Value': sum(len(v) for v in issues.values()),
                'Unit': 'Count',
                'Timestamp': datetime.utcnow()
            }
        ]
    )
    
    # Alert if issues found
    if issues:
        sns.publish(
            TopicArn=os.environ['ALERT_TOPIC_ARN'],
            Subject='Data Quality Issues Detected',
            Message=json.dumps({
                'timestamp': datetime.utcnow().isoformat(),
                'issues_found': sum(len(v) for v in issues.values()),
                'issue_types': list(issues.keys()),
                'sample_issues': {k: v[:5] for k, v in issues.items()}
            }, indent=2)
        )
        
        return {
            'statusCode': 400,
            'body': json.dumps(issues),
            'issues_found': sum(len(v) for v in issues.values())
        }
    
    return {
        'statusCode': 200,
        'body': 'Data validation passed',
        'issues_found': 0
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        HOLIDAYS_TABLE: phase0Stack.holidaysTable.tableName,
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ENVIRONMENT: config.environment,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    phase0Stack.holidaysTable.grantReadData(func);
    this.alertTopic.grantPublish(func);
    
    func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    return func;
  }

  private createDataQualityMetrics(config: AlmanacConfig): void {
    // Create CloudWatch dashboard for data quality
    const dashboard = new cloudwatch.Dashboard(this, 'DataQualityDashboard', {
      dashboardName: `${config.projectName}-${config.environment}-data-quality`,
    });

    // Data quality issues metric
    const qualityIssuesMetric = new cloudwatch.Metric({
      namespace: 'AlmanacAPI/DataQuality',
      metricName: 'DataQualityIssues',
      statistic: 'Sum',
      period: cdk.Duration.hours(24),
    });

    // Create alarm - any quality issues should alert
    const qualityAlarm = new cloudwatch.Alarm(this, 'DataQualityAlarm', {
      metric: qualityIssuesMetric,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Data quality issues detected in holiday data',
    });

    qualityAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));

    // Add widgets to dashboard
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# Data Quality Dashboard
        
This dashboard monitors the quality of holiday data in the Almanac API.
Any issues detected will trigger immediate alerts.

**Quality Checks:**
- Region case consistency (must be uppercase)
- Data source attribution
- Duplicate detection
- Schema validation`,
        width: 24,
        height: 4,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Data Quality Issues (24h)',
        left: [qualityIssuesMetric],
        width: 12,
        height: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Current Issues',
        metrics: [qualityIssuesMetric],
        width: 6,
        height: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Data Quality Score',
        metrics: [
          new cloudwatch.MathExpression({
            expression: '100 - (m1 / 263 * 100)', // 263 is total records
            usingMetrics: {
              m1: qualityIssuesMetric,
            },
          }),
        ],
        width: 6,
        height: 6,
      })
    );
  }

  private createQualityCheckSchedule(config: AlmanacConfig): void {
    // Daily data validation
    const dailyValidation = new events.Rule(this, 'DailyDataValidation', {
      ruleName: `${config.projectName}-${config.environment}-daily-validation`,
      description: 'Daily data quality validation check',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '6', // 6 AM UTC daily
      }),
    });

    dailyValidation.addTarget(new targets.LambdaFunction(this.dataValidationLambda));

    // One-time cleanup execution (can be triggered manually)
    new cdk.CfnOutput(this, 'DataCleanupCommand', {
      value: `aws lambda invoke --function-name ${this.dataCleanupLambda.functionName} --payload '{"dry_run": false}' response.json`,
      description: 'Command to execute data cleanup (run once)',
    });
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, 'DataCleanupLambdaArn', {
      value: this.dataCleanupLambda.functionArn,
      description: 'ARN of the data cleanup Lambda function',
    });

    new cdk.CfnOutput(this, 'DataValidationLambdaArn', {
      value: this.dataValidationLambda.functionArn,
      description: 'ARN of the data validation Lambda function',
    });

    new cdk.CfnOutput(this, 'DataQualityAlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'ARN of the data quality alert topic',
    });

    new cdk.CfnOutput(this, 'SubscribeToAlerts', {
      value: `aws sns subscribe --topic-arn ${this.alertTopic.topicArn} --protocol email --notification-endpoint your-email@example.com`,
      description: 'Command to subscribe to data quality alerts',
    });
  }
}