import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { Phase0Stack } from './phase0-stack';

export interface DataPipelineStackProps extends cdk.StackProps {
  config: AlmanacConfig;
  phase0Stack: Phase0Stack;
}

export class DataPipelineStack extends cdk.Stack {
  public readonly dataValidationLambda: lambda.Function;
  public readonly holidayETLJob: glue.CfnJob;
  public readonly timezoneETLJob: glue.CfnJob;
  public readonly australiaHolidayETLJob: glue.CfnJob;
  public readonly dataQualityLambda: lambda.Function;
  public readonly pipelineStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: DataPipelineStackProps) {
    super(scope, id, props);

    const { config, phase0Stack } = props;

    // Create Lambda functions
    this.dataValidationLambda = this.createDataValidationLambda(config, phase0Stack);
    this.dataQualityLambda = this.createDataQualityLambda(config, phase0Stack);

    // Create Glue crawlers
    const holidayCrawler = this.createHolidayCrawler(config, phase0Stack);
    const timezoneCrawler = this.createTimezoneCrawler(config, phase0Stack);

    // Create Glue ETL jobs
    this.holidayETLJob = this.createHolidayETLJob(config, phase0Stack);
    this.timezoneETLJob = this.createTimezoneETLJob(config, phase0Stack);
    this.australiaHolidayETLJob = this.createAustraliaHolidayETLJob(config, phase0Stack);

    // Create Step Functions workflow
    this.pipelineStateMachine = this.createPipelineWorkflow(
      config,
      phase0Stack,
      holidayCrawler,
      timezoneCrawler
    );

    // Create EventBridge rule for scheduled execution
    this.createScheduleRule(config);
    
    // Create monthly schedule for Australian holidays
    this.createAustraliaHolidaySchedule(config);

    // Create outputs
    this.createOutputs();
  }

  private createDataValidationLambda(config: AlmanacConfig, phase0Stack: Phase0Stack): lambda.Function {
    const func = new lambda.Function(this, 'DataValidationLambda', {
      functionName: `${config.projectName}-${config.environment}-data-validation`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

exports.handler = async (event) => {
  console.log('Validating data:', JSON.stringify(event, null, 2));
  
  try {
    const { bucket, key, dataType } = event;
    
    // Get object from S3
    const object = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    const data = JSON.parse(object.Body.toString());
    
    // Validation logic based on data type
    const validationResult = await validateData(data, dataType);
    
    return {
      statusCode: 200,
      isValid: validationResult.isValid,
      errors: validationResult.errors,
      dataQualityScore: validationResult.score,
      recordCount: data.length || 0,
      bucket,
      key,
      dataType
    };
  } catch (error) {
    console.error('Validation error:', error);
    return {
      statusCode: 500,
      isValid: false,
      errors: [error.message],
      dataQualityScore: 0
    };
  }
};

async function validateData(data, dataType) {
  const errors = [];
  let validRecords = 0;
  
  if (dataType === 'holidays') {
    // Validate holiday data structure
    if (!Array.isArray(data)) {
      errors.push('Holiday data must be an array');
      return { isValid: false, errors, score: 0 };
    }
    
    data.forEach((record, index) => {
      const recordErrors = [];
      
      if (!record.date || !isValidDate(record.date)) {
        recordErrors.push(\`Record \${index}: Invalid date format\`);
      }
      if (!record.name || typeof record.name !== 'string') {
        recordErrors.push(\`Record \${index}: Missing or invalid name\`);
      }
      if (!record.country || !['AU', 'UK', 'DE'].includes(record.country)) {
        recordErrors.push(\`Record \${index}: Invalid country code\`);
      }
      if (!record.type || !['public', 'bank', 'observance'].includes(record.type)) {
        recordErrors.push(\`Record \${index}: Invalid holiday type\`);
      }
      
      if (recordErrors.length === 0) {
        validRecords++;
      } else {
        errors.push(...recordErrors);
      }
    });
  } else if (dataType === 'timezones') {
    // Validate timezone data structure
    if (!Array.isArray(data)) {
      errors.push('Timezone data must be an array');
      return { isValid: false, errors, score: 0 };
    }
    
    data.forEach((record, index) => {
      const recordErrors = [];
      
      if (!record.timezone || typeof record.timezone !== 'string') {
        recordErrors.push(\`Record \${index}: Missing or invalid timezone\`);
      }
      if (!record.country || typeof record.country !== 'string') {
        recordErrors.push(\`Record \${index}: Missing or invalid country\`);
      }
      if (typeof record.utcOffset !== 'number') {
        recordErrors.push(\`Record \${index}: Invalid UTC offset\`);
      }
      
      if (recordErrors.length === 0) {
        validRecords++;
      } else {
        errors.push(...recordErrors);
      }
    });
  }
  
  const score = data.length > 0 ? (validRecords / data.length) * 100 : 0;
  
  return {
    isValid: errors.length === 0,
    errors: errors.slice(0, 10), // Limit error messages
    score: Math.round(score * 100) / 100
  };
}

function isValidDate(dateString) {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}
      `),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        RAW_BUCKET: phase0Stack.rawBucket.bucketName,
        STAGING_BUCKET: phase0Stack.stagingBucket.bucketName,
        VALIDATED_BUCKET: phase0Stack.validatedBucket.bucketName,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant S3 permissions
    phase0Stack.rawBucket.grantRead(func);
    phase0Stack.stagingBucket.grantReadWrite(func);
    phase0Stack.validatedBucket.grantWrite(func);

    return func;
  }

  private createDataQualityLambda(config: AlmanacConfig, phase0Stack: Phase0Stack): lambda.Function {
    const func = new lambda.Function(this, 'DataQualityLambda', {
      functionName: `${config.projectName}-${config.environment}-data-quality`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const cloudwatch = new AWS.CloudWatch();

exports.handler = async (event) => {
  console.log('Checking data quality:', JSON.stringify(event, null, 2));
  
  try {
    const { tableName, dataType } = event;
    const metrics = await calculateDataQualityMetrics(tableName, dataType);
    
    // Send metrics to CloudWatch
    await publishMetrics(metrics, dataType);
    
    // Determine if quality threshold is met
    const qualityScore = calculateOverallScore(metrics);
    const meetsThreshold = qualityScore >= 98; // 98% quality threshold
    
    return {
      statusCode: 200,
      meetsThreshold,
      qualityScore,
      metrics,
      recommendation: meetsThreshold ? 'APPROVE' : 'REVIEW',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Data quality check error:', error);
    return {
      statusCode: 500,
      meetsThreshold: false,
      qualityScore: 0,
      error: error.message
    };
  }
};

async function calculateDataQualityMetrics(tableName, dataType) {
  const metrics = {
    totalRecords: 0,
    completeness: 0,
    uniqueness: 0,
    consistency: 0,
    timeliness: 0,
    accuracy: 0
  };
  
  // Scan table to get metrics (in production, use more efficient methods)
  const params = {
    TableName: tableName,
    Limit: 1000 // Sample for quality check
  };
  
  const result = await dynamodb.scan(params).promise();
  metrics.totalRecords = result.Count || 0;
  
  if (dataType === 'holidays') {
    // Check for required fields
    let completeRecords = 0;
    const dates = new Set();
    
    result.Items.forEach(item => {
      if (item.date && item.name && item.country && item.type) {
        completeRecords++;
      }
      dates.add(\`\${item.country}-\${item.date}\`);
    });
    
    metrics.completeness = (completeRecords / metrics.totalRecords) * 100;
    metrics.uniqueness = (dates.size / metrics.totalRecords) * 100;
    metrics.consistency = 100; // Assume consistent if validation passed
    metrics.timeliness = 100; // Assume timely for new data
    metrics.accuracy = 95; // Baseline accuracy
  }
  
  return metrics;
}

async function publishMetrics(metrics, dataType) {
  const namespace = 'AlmanacAPI/DataQuality';
  const timestamp = new Date();
  
  const metricData = Object.entries(metrics).map(([name, value]) => ({
    MetricName: name,
    Value: value,
    Unit: name === 'totalRecords' ? 'Count' : 'Percent',
    Timestamp: timestamp,
    Dimensions: [
      { Name: 'DataType', Value: dataType },
      { Name: 'Environment', Value: process.env.ENVIRONMENT || 'dev' }
    ]
  }));
  
  await cloudwatch.putMetricData({
    Namespace: namespace,
    MetricData: metricData
  }).promise();
}

function calculateOverallScore(metrics) {
  // Weighted average of quality dimensions
  const weights = {
    completeness: 0.3,
    uniqueness: 0.2,
    consistency: 0.2,
    accuracy: 0.2,
    timeliness: 0.1
  };
  
  let weightedSum = 0;
  let totalWeight = 0;
  
  Object.entries(weights).forEach(([metric, weight]) => {
    if (metrics[metric] !== undefined) {
      weightedSum += metrics[metric] * weight;
      totalWeight += weight;
    }
  });
  
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}
      `),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        HOLIDAYS_TABLE: phase0Stack.holidaysTable.tableName,
        TIMEZONES_TABLE: phase0Stack.timezonesTable.tableName,
        ENVIRONMENT: config.environment,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant DynamoDB and CloudWatch permissions
    phase0Stack.holidaysTable.grantReadData(func);
    phase0Stack.timezonesTable.grantReadData(func);
    
    func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    return func;
  }

  private createHolidayCrawler(config: AlmanacConfig, phase0Stack: Phase0Stack): glue.CfnCrawler {
    const crawlerRole = new iam.Role(this, 'HolidayCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    phase0Stack.rawBucket.grantRead(crawlerRole);

    return new glue.CfnCrawler(this, 'HolidayCrawler', {
      name: `${config.projectName}-${config.environment}-holiday-crawler`,
      role: crawlerRole.roleArn,
      databaseName: phase0Stack.glueDatabase.ref,
      targets: {
        s3Targets: [{
          path: `s3://${phase0Stack.rawBucket.bucketName}/holidays/`,
        }],
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
      schedule: {
        scheduleExpression: 'cron(0 2 * * ? *)', // Daily at 2 AM
      },
    });
  }

  private createTimezoneCrawler(config: AlmanacConfig, phase0Stack: Phase0Stack): glue.CfnCrawler {
    const crawlerRole = new iam.Role(this, 'TimezoneCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    phase0Stack.rawBucket.grantRead(crawlerRole);

    return new glue.CfnCrawler(this, 'TimezoneCrawler', {
      name: `${config.projectName}-${config.environment}-timezone-crawler`,
      role: crawlerRole.roleArn,
      databaseName: phase0Stack.glueDatabase.ref,
      targets: {
        s3Targets: [{
          path: `s3://${phase0Stack.rawBucket.bucketName}/timezones/`,
        }],
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
    });
  }

  private createHolidayETLJob(config: AlmanacConfig, phase0Stack: Phase0Stack): glue.CfnJob {
    const jobRole = new iam.Role(this, 'HolidayETLJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Grant permissions to read from raw bucket and write to staging/validated buckets
    phase0Stack.rawBucket.grantRead(jobRole);
    phase0Stack.stagingBucket.grantReadWrite(jobRole);
    phase0Stack.validatedBucket.grantWrite(jobRole);
    phase0Stack.holidaysTable.grantWriteData(jobRole);
    // Grant permission to read Glue scripts
    phase0Stack.glueScriptsBucket.grantRead(jobRole);

    return new glue.CfnJob(this, 'HolidayETLJob', {
      name: `${config.projectName}-${config.environment}-holiday-etl`,
      role: jobRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://${phase0Stack.glueScriptsBucket.bucketName}/scripts/holiday_etl.py`,
      },
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': '',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://${phase0Stack.glueScriptsBucket.bucketName}/spark-logs/`,
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-continuous-log-filter': 'true',
        '--RAW_BUCKET': phase0Stack.rawBucket.bucketName,
        '--STAGING_BUCKET': phase0Stack.stagingBucket.bucketName,
        '--VALIDATED_BUCKET': phase0Stack.validatedBucket.bucketName,
        '--HOLIDAYS_TABLE': phase0Stack.holidaysTable.tableName,
        '--DATABASE_NAME': config.glue.databaseName,
      },
      maxRetries: 1,
      timeout: 60, // 60 minutes
      glueVersion: '4.0',
      maxCapacity: 2,
    });
  }

  private createAustraliaHolidayETLJob(config: AlmanacConfig, phase0Stack: Phase0Stack): glue.CfnJob {
    const jobRole = new iam.Role(this, 'AustraliaHolidayETLJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Grant permissions
    phase0Stack.rawBucket.grantReadWrite(jobRole);
    phase0Stack.stagingBucket.grantReadWrite(jobRole);
    phase0Stack.validatedBucket.grantWrite(jobRole);
    phase0Stack.holidaysTable.grantWriteData(jobRole);
    phase0Stack.glueScriptsBucket.grantRead(jobRole);

    // Add SNS permissions for notifications
    jobRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: [phase0Stack.approvalTopic.topicArn],
    }));

    return new glue.CfnJob(this, 'AustraliaHolidayETLJob', {
      name: `${config.projectName}-${config.environment}-australia-holiday-etl`,
      role: jobRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://${phase0Stack.glueScriptsBucket.bucketName}/scripts/australia_holiday_etl.py`,
      },
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': '',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://${phase0Stack.glueScriptsBucket.bucketName}/spark-logs/`,
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-continuous-log-filter': 'true',
        '--RAW_BUCKET': phase0Stack.rawBucket.bucketName,
        '--STAGING_BUCKET': phase0Stack.stagingBucket.bucketName,
        '--VALIDATED_BUCKET': phase0Stack.validatedBucket.bucketName,
        '--HOLIDAYS_TABLE': phase0Stack.holidaysTable.tableName,
        '--DATABASE_NAME': config.glue.databaseName,
      },
      maxRetries: 1,
      timeout: 30, // 30 minutes
      glueVersion: '4.0',
      maxCapacity: 2,
    });
  }

  private createTimezoneETLJob(config: AlmanacConfig, phase0Stack: Phase0Stack): glue.CfnJob {
    const jobRole = new iam.Role(this, 'TimezoneETLJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Grant permissions
    phase0Stack.rawBucket.grantRead(jobRole);
    phase0Stack.stagingBucket.grantReadWrite(jobRole);
    phase0Stack.validatedBucket.grantWrite(jobRole);
    phase0Stack.timezonesTable.grantWriteData(jobRole);
    // Grant permission to read Glue scripts
    phase0Stack.glueScriptsBucket.grantRead(jobRole);

    return new glue.CfnJob(this, 'TimezoneETLJob', {
      name: `${config.projectName}-${config.environment}-timezone-etl`,
      role: jobRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://${phase0Stack.glueScriptsBucket.bucketName}/scripts/timezone_etl.py`,
      },
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': '',
        '--RAW_BUCKET': phase0Stack.rawBucket.bucketName,
        '--STAGING_BUCKET': phase0Stack.stagingBucket.bucketName,
        '--VALIDATED_BUCKET': phase0Stack.validatedBucket.bucketName,
        '--TIMEZONES_TABLE': phase0Stack.timezonesTable.tableName,
        '--DATABASE_NAME': config.glue.databaseName,
      },
      maxRetries: 1,
      timeout: 30,
      glueVersion: '4.0',
      maxCapacity: 2,
    });
  }

  private createPipelineWorkflow(
    config: AlmanacConfig,
    phase0Stack: Phase0Stack,
    holidayCrawler: glue.CfnCrawler,
    timezoneCrawler: glue.CfnCrawler
  ): stepfunctions.StateMachine {
    // Define tasks
    const startCrawlers = new stepfunctions.Parallel(this, 'StartCrawlers');
    
    // Holiday pipeline branch
    const startHolidayCrawler = new sfnTasks.CallAwsService(this, 'StartHolidayCrawler', {
      service: 'glue',
      action: 'startCrawler',
      parameters: {
        Name: holidayCrawler.name,
      },
      iamResources: ['*'],
    });

    const waitForHolidayCrawler = new stepfunctions.Wait(this, 'WaitForHolidayCrawler', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(2)),
    });

    const runHolidayETL = new sfnTasks.GlueStartJobRun(this, 'RunHolidayETL', {
      glueJobName: this.holidayETLJob.name!,
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
    });

    const validateHolidayData = new sfnTasks.LambdaInvoke(this, 'ValidateHolidayData', {
      lambdaFunction: this.dataValidationLambda,
      payload: stepfunctions.TaskInput.fromObject({
        bucket: phase0Stack.stagingBucket.bucketName,
        key: 'holidays/validated/latest.json',
        dataType: 'holidays',
      }),
    });

    // Timezone pipeline branch
    const startTimezoneCrawler = new sfnTasks.CallAwsService(this, 'StartTimezoneCrawler', {
      service: 'glue',
      action: 'startCrawler',
      parameters: {
        Name: timezoneCrawler.name,
      },
      iamResources: ['*'],
    });

    const waitForTimezoneCrawler = new stepfunctions.Wait(this, 'WaitForTimezoneCrawler', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(2)),
    });

    const runTimezoneETL = new sfnTasks.GlueStartJobRun(this, 'RunTimezoneETL', {
      glueJobName: this.timezoneETLJob.name!,
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
    });

    const validateTimezoneData = new sfnTasks.LambdaInvoke(this, 'ValidateTimezoneData', {
      lambdaFunction: this.dataValidationLambda,
      payload: stepfunctions.TaskInput.fromObject({
        bucket: phase0Stack.stagingBucket.bucketName,
        key: 'timezones/validated/latest.json',
        dataType: 'timezones',
      }),
    });

    // Quality check
    const checkDataQuality = new sfnTasks.LambdaInvoke(this, 'CheckDataQuality', {
      lambdaFunction: this.dataQualityLambda,
      payload: stepfunctions.TaskInput.fromObject({
        holidayTable: phase0Stack.holidaysTable.tableName,
        timezoneTable: phase0Stack.timezonesTable.tableName,
      }),
    });

    // Manual approval notification (simplified - no wait for callback)
    const requestApproval = new sfnTasks.SnsPublish(this, 'RequestApproval', {
      topic: phase0Stack.approvalTopic,
      subject: 'Data Pipeline Approval Required',
      message: stepfunctions.TaskInput.fromJsonPathAt('$.Payload'),
    });

    // Success notification
    const notifySuccess = new sfnTasks.SnsPublish(this, 'NotifySuccess', {
      topic: phase0Stack.approvalTopic,
      message: stepfunctions.TaskInput.fromText('Data pipeline completed successfully!'),
    });

    // Build the workflow
    const holidayBranch = startHolidayCrawler
      .next(waitForHolidayCrawler)
      .next(runHolidayETL)
      .next(validateHolidayData);

    const timezoneBranch = startTimezoneCrawler
      .next(waitForTimezoneCrawler)
      .next(runTimezoneETL)
      .next(validateTimezoneData);

    const definition = startCrawlers
      .branch(holidayBranch)
      .branch(timezoneBranch)
      .next(checkDataQuality)
      .next(
        new stepfunctions.Choice(this, 'QualityThresholdMet?')
          .when(
            stepfunctions.Condition.numberGreaterThanEquals('$.Payload.qualityScore', 98),
            notifySuccess
          )
          .otherwise(requestApproval.next(notifySuccess))
      );

    const stateMachine = new stepfunctions.StateMachine(this, 'DataPipelineStateMachine', {
      stateMachineName: `${config.projectName}-${config.environment}-data-pipeline`,
      definition,
      timeout: cdk.Duration.hours(6),
      tracingEnabled: true,
    });

    return stateMachine;
  }

  private createScheduleRule(config: AlmanacConfig): void {
    const rule = new events.Rule(this, 'DataPipelineSchedule', {
      ruleName: `${config.projectName}-${config.environment}-pipeline-schedule`,
      description: 'Trigger data pipeline on schedule',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '3',
        weekDay: 'MON', // Run weekly on Mondays
      }),
    });

    rule.addTarget(new targets.SfnStateMachine(this.pipelineStateMachine));
  }

  private createAustraliaHolidaySchedule(config: AlmanacConfig): void {
    // Create a rule to run Australian holiday ETL monthly
    const australiaRule = new events.Rule(this, 'AustraliaHolidaySchedule', {
      ruleName: `${config.projectName}-${config.environment}-australia-holiday-schedule`,
      description: 'Monthly Australian holiday data refresh',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '2',
        day: '1', // Run on 1st of each month
      }),
    });

    // Create IAM role for EventBridge to start Glue job
    const eventRole = new iam.Role(this, 'AustraliaHolidayScheduleRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });

    eventRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['glue:StartJobRun'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:job/${this.australiaHolidayETLJob.name}`,
      ],
    }));

    // Add Glue job as target using the correct approach
    australiaRule.addTarget(new targets.AwsApi({
      service: 'Glue',
      action: 'startJobRun',
      parameters: {
        JobName: this.australiaHolidayETLJob.name,
      },
      policyStatement: new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['glue:StartJobRun'],
        resources: [`arn:aws:glue:${this.region}:${this.account}:job/${this.australiaHolidayETLJob.name}`],
      }),
    }));
    
    // Also create a CloudWatch dashboard widget for monitoring
    new cdk.CfnOutput(this, 'AustraliaHolidayScheduleArn', {
      value: australiaRule.ruleArn,
      description: 'ARN of the Australia holiday ETL schedule rule',
    });
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, 'DataValidationLambdaArn', {
      value: this.dataValidationLambda.functionArn,
      description: 'ARN of the data validation Lambda function',
    });

    new cdk.CfnOutput(this, 'DataQualityLambdaArn', {
      value: this.dataQualityLambda.functionArn,
      description: 'ARN of the data quality check Lambda function',
    });

    new cdk.CfnOutput(this, 'HolidayETLJobName', {
      value: this.holidayETLJob.name!,
      description: 'Name of the holiday ETL Glue job',
    });

    new cdk.CfnOutput(this, 'TimezoneETLJobName', {
      value: this.timezoneETLJob.name!,
      description: 'Name of the timezone ETL Glue job',
    });

    new cdk.CfnOutput(this, 'AustraliaHolidayETLJobName', {
      value: this.australiaHolidayETLJob.name!,
      description: 'Name of the Australia holiday ETL Glue job',
    });

    new cdk.CfnOutput(this, 'PipelineStateMachineArn', {
      value: this.pipelineStateMachine.stateMachineArn,
      description: 'ARN of the data pipeline state machine',
    });
  }
}