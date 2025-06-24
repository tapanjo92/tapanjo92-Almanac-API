import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { Phase0Stack } from './phase0-stack';
import { ETLMetadataStack } from './etl-metadata-stack';

export class UnifiedDataPipelineStack extends cdk.Stack {
  public readonly unifiedHolidayETLJob: glue.CfnJob;
  public readonly deduplicationServiceLambda: lambda.Function;
  public readonly dataQualityLambda: lambda.Function;
  public readonly pipelineStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: cdk.StackProps & {
    config: AlmanacConfig;
    phase0Stack: Phase0Stack;
    metadataStack: ETLMetadataStack;
  }) {
    super(scope, id, props);

    const { config, phase0Stack, metadataStack } = props;

    // Create unified ETL job
    this.unifiedHolidayETLJob = this.createUnifiedETLJob(config, phase0Stack, metadataStack);

    // Create deduplication service Lambda
    this.deduplicationServiceLambda = this.createDeduplicationLambda(config, phase0Stack);

    // Create data quality Lambda
    this.dataQualityLambda = this.createDataQualityLambda(config, phase0Stack);

    // Create unified pipeline state machine
    this.pipelineStateMachine = this.createUnifiedPipeline(config, phase0Stack);

    // Create single schedule for all holiday ETL
    this.createUnifiedSchedule(config);

    // Store configuration in SSM
    this.createDataSourceParameters(config);

    // Create outputs
    this.createOutputs();
  }

  private createUnifiedETLJob(
    config: AlmanacConfig, 
    phase0Stack: Phase0Stack,
    metadataStack: ETLMetadataStack
  ): glue.CfnJob {
    const jobRole = new iam.Role(this, 'UnifiedETLJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Grant permissions
    phase0Stack.rawBucket.grantReadWrite(jobRole);
    phase0Stack.stagingBucket.grantReadWrite(jobRole);
    phase0Stack.validatedBucket.grantReadWrite(jobRole);
    phase0Stack.holidaysTable.grantReadWriteData(jobRole);
    metadataStack.metadataTable.grantReadWriteData(jobRole);
    phase0Stack.glueScriptsBucket.grantRead(jobRole);

    // Grant SSM parameter access
    jobRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/almanac/*`],
    }));

    // Grant CloudWatch metrics
    jobRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    return new glue.CfnJob(this, 'UnifiedHolidayETLJob', {
      name: `${config.projectName}-${config.environment}-unified-holiday-etl`,
      role: jobRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://${phase0Stack.glueScriptsBucket.bucketName}/scripts/unified_holiday_etl.py`,
      },
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': '',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-continuous-log-filter': 'true',
        '--RAW_BUCKET': phase0Stack.rawBucket.bucketName,
        '--STAGING_BUCKET': phase0Stack.stagingBucket.bucketName,
        '--VALIDATED_BUCKET': phase0Stack.validatedBucket.bucketName,
        '--HOLIDAYS_TABLE': phase0Stack.holidaysTable.tableName,
        '--ETL_METADATA_TABLE': metadataStack.metadataTable.tableName,
        '--DATABASE_NAME': config.glue.databaseName,
        '--ENABLE_DEDUPLICATION': 'true',
        '--CONSOLIDATE_NATIONAL': 'true',
      },
      maxRetries: 1,
      timeout: 60, // 60 minutes for comprehensive processing
      glueVersion: '4.0',
      maxCapacity: 5, // Increased capacity for unified processing
    });
  }

  private createDeduplicationLambda(config: AlmanacConfig, phase0Stack: Phase0Stack): lambda.Function {
    const func = new lambda.Function(this, 'DeduplicationServiceLambda', {
      functionName: `${config.projectName}-${config.environment}-deduplication-service`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambdas/deduplication-service'),
      environment: {
        HOLIDAYS_TABLE: phase0Stack.holidaysTable.tableName,
        ENVIRONMENT: config.environment,
      },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 2, // Prevent parallel runs
    });

    // Grant permissions
    phase0Stack.holidaysTable.grantReadWriteData(func);

    // Grant CloudWatch metrics
    func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    return func;
  }

  private createDataQualityLambda(config: AlmanacConfig, phase0Stack: Phase0Stack): lambda.Function {
    const func = new lambda.Function(this, 'DataQualityLambda', {
      functionName: `${config.projectName}-${config.environment}-unified-data-quality`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  console.log('Checking data quality:', JSON.stringify(event, null, 2));
  
  try {
    const { tableName, dataType } = event;
    const metrics = await calculateDataQualityMetrics(tableName, dataType);
    
    const qualityScore = calculateOverallScore(metrics);
    const meetsThreshold = qualityScore >= 95;
    
    return {
      statusCode: 200,
      meetsThreshold,
      qualityScore,
      metrics,
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
    nationalHolidayConsolidation: 0
  };
  
  const params = {
    TableName: tableName,
    Limit: 1000
  };
  
  const result = await dynamodb.scan(params).promise();
  metrics.totalRecords = result.Count || 0;
  
  if (dataType === 'holidays') {
    let completeRecords = 0;
    let nationalHolidaysWithAll = 0;
    let totalNationalHolidays = 0;
    
    result.Items.forEach(item => {
      if (item.date && item.name && item.country && item.type && item.regions) {
        completeRecords++;
      }
      
      // Check national holiday consolidation
      const nationalHolidays = ['Christmas Day', 'New Year\\'s Day', 'Australia Day', 'Good Friday', 'Anzac Day'];
      if (nationalHolidays.includes(item.name)) {
        totalNationalHolidays++;
        if (item.regions && item.regions.includes('ALL')) {
          nationalHolidaysWithAll++;
        }
      }
    });
    
    metrics.completeness = (completeRecords / metrics.totalRecords) * 100;
    metrics.nationalHolidayConsolidation = totalNationalHolidays > 0 
      ? (nationalHolidaysWithAll / totalNationalHolidays) * 100 
      : 100;
  }
  
  return metrics;
}

function calculateOverallScore(metrics) {
  return (metrics.completeness * 0.6 + metrics.nationalHolidayConsolidation * 0.4);
}
      `),
      environment: {
        ENVIRONMENT: config.environment,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
    });

    // Grant permissions
    phase0Stack.holidaysTable.grantReadData(func);
    phase0Stack.timezonesTable.grantReadData(func);

    return func;
  }

  private createUnifiedPipeline(
    config: AlmanacConfig,
    phase0Stack: Phase0Stack
  ): stepfunctions.StateMachine {
    // Step 1: Run unified ETL
    const runUnifiedETL = new sfnTasks.GlueStartJobRun(this, 'RunUnifiedETL', {
      glueJobName: this.unifiedHolidayETLJob.name!,
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      arguments: stepfunctions.TaskInput.fromObject({
        '--EXECUTION_ID': stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
        '--TRIGGER_TIME': stepfunctions.JsonPath.stringAt('$$.State.EnteredTime'),
      }),
    });

    // Step 2: Run deduplication service
    const runDeduplication = new sfnTasks.LambdaInvoke(this, 'RunDeduplication', {
      lambdaFunction: this.deduplicationServiceLambda,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
      payload: stepfunctions.TaskInput.fromObject({
        executionId: stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
      }),
    });

    // Step 3: Check data quality
    const checkDataQuality = new sfnTasks.LambdaInvoke(this, 'CheckDataQuality', {
      lambdaFunction: this.dataQualityLambda,
      outputPath: '$.Payload',
      payload: stepfunctions.TaskInput.fromObject({
        tableName: phase0Stack.holidaysTable.tableName,
        dataType: 'holidays',
      }),
    });

    // Step 4: Send success notification
    const notifySuccess = new sfnTasks.SnsPublish(this, 'NotifySuccess', {
      topic: phase0Stack.approvalTopic,
      subject: 'Unified ETL Pipeline - Success',
      message: stepfunctions.TaskInput.fromJsonPathAt('$'),
    });

    // Step 5: Send failure notification
    const notifyFailure = new sfnTasks.SnsPublish(this, 'NotifyFailure', {
      topic: phase0Stack.approvalTopic,
      subject: 'Unified ETL Pipeline - Failed',
      message: stepfunctions.TaskInput.fromJsonPathAt('$'),
    });

    // Error handler
    const handleError = new stepfunctions.Pass(this, 'HandleError', {
      parameters: {
        error: stepfunctions.JsonPath.stringAt('$.Error'),
        cause: stepfunctions.JsonPath.stringAt('$.Cause'),
        timestamp: stepfunctions.JsonPath.stringAt('$$.State.EnteredTime'),
      },
    }).next(notifyFailure);

    // Build the workflow
    const definition = runUnifiedETL
      .addCatch(handleError, {
        errors: ['States.ALL'],
        resultPath: '$.error',
      })
      .next(runDeduplication)
      .next(checkDataQuality)
      .next(
        new stepfunctions.Choice(this, 'QualityCheck')
          .when(
            stepfunctions.Condition.numberGreaterThanEquals('$.qualityScore', 95),
            notifySuccess
          )
          .otherwise(
            new stepfunctions.Pass(this, 'QualityIssue', {
              parameters: {
                message: 'Data quality below threshold',
                qualityScore: stepfunctions.JsonPath.numberAt('$.qualityScore'),
                metrics: stepfunctions.JsonPath.objectAt('$.metrics'),
              },
            }).next(notifyFailure)
          )
      );

    return new stepfunctions.StateMachine(this, 'UnifiedPipelineStateMachine', {
      stateMachineName: `${config.projectName}-${config.environment}-unified-pipeline`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    });
  }

  private createUnifiedSchedule(config: AlmanacConfig): void {
    // Single schedule for all holiday data
    const rule = new events.Rule(this, 'UnifiedETLSchedule', {
      ruleName: `${config.projectName}-${config.environment}-unified-etl-schedule`,
      description: 'Unified ETL pipeline schedule',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '2',
        day: '1', // Run monthly on the 1st
      }),
    });

    rule.addTarget(new targets.SfnStateMachine(this.pipelineStateMachine));

    // Add manual trigger via EventBridge
    const manualTriggerRule = new events.Rule(this, 'ManualETLTrigger', {
      ruleName: `${config.projectName}-${config.environment}-manual-etl-trigger`,
      description: 'Manual trigger for unified ETL pipeline',
      eventPattern: {
        source: ['almanac.etl'],
        detailType: ['Manual ETL Trigger'],
      },
    });

    manualTriggerRule.addTarget(new targets.SfnStateMachine(this.pipelineStateMachine));
  }

  private createDataSourceParameters(config: AlmanacConfig): void {
    new ssm.StringParameter(this, 'UnifiedDataSourcesConfig', {
      parameterName: '/almanac/unified-data-sources/config',
      stringValue: JSON.stringify({
        national: {
          '2024': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/9e920340-0744-4031-a497-98ab796633e8/download/australian_public_holidays_2024.csv',
          '2025': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/4d4d744b-50ed-45b9-ae77-760bc478ad75/download/australian_public_holidays_2025.csv',
          '2026': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/placeholder-2026/download/australian_public_holidays_2026.csv',
        },
        states: {
          nsw: 'https://data.nsw.gov.au/data/dataset/nsw-public-holidays',
          vic: 'https://discover.data.vic.gov.au/dataset/victorian-public-holidays',
          qld: 'https://data.qld.gov.au/dataset/queensland-public-holidays',
        },
        updateFrequency: 'monthly',
        consolidateNational: true,
      }),
      description: 'Unified data source configuration for holiday ETL',
      tier: ssm.ParameterTier.STANDARD,
    });
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, 'UnifiedETLJobName', {
      value: this.unifiedHolidayETLJob.name!,
      description: 'Name of the unified holiday ETL Glue job',
    });

    new cdk.CfnOutput(this, 'DeduplicationLambdaArn', {
      value: this.deduplicationServiceLambda.functionArn,
      description: 'ARN of the deduplication service Lambda',
    });

    new cdk.CfnOutput(this, 'UnifiedPipelineArn', {
      value: this.pipelineStateMachine.stateMachineArn,
      description: 'ARN of the unified pipeline state machine',
    });
  }
}