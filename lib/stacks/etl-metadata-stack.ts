import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';

export class ETLMetadataStack extends cdk.Stack {
  public readonly metadataTable: dynamodb.Table;
  public readonly etlDashboard: cloudwatch.Dashboard;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: cdk.StackProps & {
    config: AlmanacConfig;
  }) {
    super(scope, id, props);

    const { config } = props;

    // Create ETL metadata table
    this.metadataTable = this.createMetadataTable(config);
    
    // Create CloudWatch dashboard
    this.etlDashboard = this.createETLDashboard(config);
    
    // Create SNS topic for alerts
    this.alertTopic = this.createAlertTopic(config);
    
    // Create CloudWatch alarms
    this.createETLAlarms(config);
    
    // Output the table name
    new cdk.CfnOutput(this, 'ETLMetadataTableName', {
      value: this.metadataTable.tableName,
      description: 'DynamoDB table for ETL metadata tracking',
    });
  }

  private createMetadataTable(config: AlmanacConfig): dynamodb.Table {
    const table = new dynamodb.Table(this, 'ETLMetadataTable', {
      tableName: `${config.projectName}-${config.environment}-etl-metadata`,
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      contributorInsightsEnabled: true,
    });

    // GSI for querying by ETL type and status
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: {
        name: 'GSI1PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'GSI1SK',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for querying by timestamp
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: {
        name: 'GSI2PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'GSI2SK',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    return table;
  }

  private createETLDashboard(config: AlmanacConfig): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'ETLDashboard', {
      dashboardName: `${config.projectName}-${config.environment}-etl-monitoring`,
    });

    // Add widgets for ETL monitoring
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ETL Success Rate',
        left: [
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'RecordsExtracted',
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
          }),
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'NewRecords',
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'DuplicatesPrevented',
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Data Quality Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'HolidayDataQualityScore',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ETL Errors',
        left: [
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'ETLErrors',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Records Processed (24h)',
        metrics: [
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'RecordsExtracted',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
          }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Duplicates Prevented (24h)',
        metrics: [
          new cloudwatch.Metric({
            namespace: 'AlmanacAPI/ETL',
            metricName: 'DuplicatesPrevented',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
          }),
        ],
        width: 6,
        height: 6,
      })
    );

    return dashboard;
  }

  private createAlertTopic(config: AlmanacConfig): sns.Topic {
    return new sns.Topic(this, 'ETLAlertTopic', {
      topicName: `${config.projectName}-${config.environment}-etl-alerts`,
      displayName: 'ETL Pipeline Alerts',
    });
  }

  private createETLAlarms(config: AlmanacConfig): void {
    // Alarm for high error rate
    const errorAlarm = new cloudwatch.Alarm(this, 'ETLErrorAlarm', {
      alarmName: `${config.projectName}-${config.environment}-etl-errors`,
      alarmDescription: 'ETL pipeline error rate is too high',
      metric: new cloudwatch.Metric({
        namespace: 'AlmanacAPI/ETL',
        metricName: 'ETLErrors',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    errorAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alertTopic)
    );

    // Alarm for data quality drop
    const qualityAlarm = new cloudwatch.Alarm(this, 'DataQualityAlarm', {
      alarmName: `${config.projectName}-${config.environment}-data-quality`,
      alarmDescription: 'Data quality score dropped below threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AlmanacAPI/ETL',
        metricName: 'HolidayDataQualityScore',
        statistic: 'Average',
        period: cdk.Duration.hours(1),
      }),
      threshold: 95,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    qualityAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alertTopic)
    );

    // Alarm for duplicate surge
    const duplicateAlarm = new cloudwatch.Alarm(this, 'DuplicateSurgeAlarm', {
      alarmName: `${config.projectName}-${config.environment}-duplicate-surge`,
      alarmDescription: 'High number of duplicate records detected',
      metric: new cloudwatch.Metric({
        namespace: 'AlmanacAPI/ETL',
        metricName: 'DuplicatesPrevented',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    duplicateAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alertTopic)
    );
  }
}