import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { DataPipelineStack } from './data-pipeline-stack';

export function addDataPipelineMonitoring(
  stack: DataPipelineStack,
  alertTopic: sns.Topic
): cloudwatch.Dashboard {
  const dashboard = new cloudwatch.Dashboard(stack, 'DataPipelineDashboard', {
    dashboardName: `${stack.stackName}-monitoring`,
  });

  // Government Data Fetcher Metrics
  const fetcherErrorMetric = new cloudwatch.Metric({
    namespace: 'AWS/Lambda',
    metricName: 'Errors',
    dimensionsMap: {
      FunctionName: stack.governmentDataFetcherLambda.functionName,
    },
    statistic: 'Sum',
    period: cdk.Duration.minutes(5),
  });

  const fetcherDurationMetric = new cloudwatch.Metric({
    namespace: 'AWS/Lambda',
    metricName: 'Duration',
    dimensionsMap: {
      FunctionName: stack.governmentDataFetcherLambda.functionName,
    },
    statistic: 'Average',
    period: cdk.Duration.minutes(5),
  });

  const dataFetchSuccessMetric = new cloudwatch.Metric({
    namespace: 'AlmanacAPI',
    metricName: 'DataFetchSuccess',
    statistic: 'Sum',
    period: cdk.Duration.hours(1),
  });

  const dataFetchErrorMetric = new cloudwatch.Metric({
    namespace: 'AlmanacAPI',
    metricName: 'DataFetchError',
    statistic: 'Sum',
    period: cdk.Duration.hours(1),
  });

  const holidaysLoadedMetric = new cloudwatch.Metric({
    namespace: 'AlmanacAPI',
    metricName: 'HolidaysLoaded',
    statistic: 'Sum',
    period: cdk.Duration.hours(1),
  });

  // Data Quality Metrics
  const dataQualityScoreMetric = new cloudwatch.Metric({
    namespace: 'AlmanacAPI/DataQuality',
    metricName: 'completeness',
    dimensionsMap: {
      DataType: 'holidays',
    },
    statistic: 'Average',
    period: cdk.Duration.days(1),
  });

  // State Machine Metrics
  const stateMachineFailedMetric = new cloudwatch.Metric({
    namespace: 'AWS/States',
    metricName: 'ExecutionsFailed',
    dimensionsMap: {
      StateMachineArn: stack.governmentDataStateMachine.stateMachineArn,
    },
    statistic: 'Sum',
    period: cdk.Duration.minutes(5),
  });

  // Create Alarms
  const fetcherErrorAlarm = new cloudwatch.Alarm(stack, 'GovernmentDataFetcherErrorAlarm', {
    metric: fetcherErrorMetric,
    threshold: 3,
    evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: 'Government data fetcher Lambda errors',
  });
  fetcherErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

  const fetcherTimeoutAlarm = new cloudwatch.Alarm(stack, 'GovernmentDataFetcherTimeoutAlarm', {
    metric: fetcherDurationMetric,
    threshold: 840000, // 14 minutes (close to 15 min timeout)
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: 'Government data fetcher Lambda approaching timeout',
  });
  fetcherTimeoutAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

  const dataQualityAlarm = new cloudwatch.Alarm(stack, 'DataQualityAlarm', {
    metric: dataQualityScoreMetric,
    threshold: 95,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    alarmDescription: 'Data quality below threshold',
  });
  dataQualityAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

  const stateMachineFailureAlarm = new cloudwatch.Alarm(stack, 'GovernmentDataStateMachineFailureAlarm', {
    metric: stateMachineFailedMetric,
    threshold: 1,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: 'Government data state machine execution failed',
  });
  stateMachineFailureAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

  // Monthly execution monitoring
  const monthlyExecutionMetric = new cloudwatch.Metric({
    namespace: 'AWS/Events',
    metricName: 'SuccessfulRuleMatches',
    dimensionsMap: {
      RuleName: `${stack.stackName}-gov-data-monthly`,
    },
    statistic: 'Sum',
    period: cdk.Duration.days(30),
  });

  const missedExecutionAlarm = new cloudwatch.Alarm(stack, 'MissedMonthlyExecutionAlarm', {
    metric: monthlyExecutionMetric,
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    alarmDescription: 'Monthly government data fetch did not execute',
  });
  missedExecutionAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

  // Add widgets to dashboard
  dashboard.addWidgets(
    new cloudwatch.TextWidget({
      markdown: '# Government Data Pipeline Monitoring\n\nReal-time monitoring of Australian holiday data fetching from government sources.',
      width: 24,
      height: 2,
    })
  );

  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      title: 'Data Fetch Success Rate',
      left: [dataFetchSuccessMetric],
      right: [dataFetchErrorMetric],
      width: 12,
      height: 6,
    }),
    new cloudwatch.GraphWidget({
      title: 'Lambda Performance',
      left: [fetcherDurationMetric],
      right: [fetcherErrorMetric],
      width: 12,
      height: 6,
    })
  );

  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      title: 'Holidays Loaded',
      left: [holidaysLoadedMetric],
      width: 12,
      height: 6,
    }),
    new cloudwatch.GraphWidget({
      title: 'Data Quality Score',
      left: [dataQualityScoreMetric],
      width: 12,
      height: 6,
      leftYAxis: {
        min: 0,
        max: 100,
      },
    })
  );

  dashboard.addWidgets(
    new cloudwatch.SingleValueWidget({
      title: 'State Machine Failures (24h)',
      metrics: [stateMachineFailedMetric],
      width: 6,
      height: 4,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Lambda Errors (24h)',
      metrics: [fetcherErrorMetric],
      width: 6,
      height: 4,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Avg Fetch Duration',
      metrics: [fetcherDurationMetric],
      width: 6,
      height: 4,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Data Quality',
      metrics: [dataQualityScoreMetric],
      width: 6,
      height: 4,
    })
  );

  // Log Insights widget for error analysis
  dashboard.addWidgets(
    new cloudwatch.LogQueryWidget({
      title: 'Recent Errors',
      logGroupNames: [`/aws/lambda/${stack.governmentDataFetcherLambda.functionName}`],
      queryString: `
        fields @timestamp, @message
        | filter @message like /ERROR/
        | sort @timestamp desc
        | limit 20
      `,
      width: 24,
      height: 6,
    })
  );

  return dashboard;
}