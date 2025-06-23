import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';

export interface Phase0StackProps extends cdk.StackProps {
  config: AlmanacConfig;
}

export class Phase0Stack extends cdk.Stack {
  public readonly holidaysTable: dynamodb.Table;
  public readonly timezonesTable: dynamodb.Table;
  public readonly rawBucket: s3.Bucket;
  public readonly stagingBucket: s3.Bucket;
  public readonly validatedBucket: s3.Bucket;
  public readonly archiveBucket: s3.Bucket;
  public readonly glueScriptsBucket: s3.Bucket;
  public readonly glueDatabase: glue.CfnDatabase;
  public readonly approvalTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: Phase0StackProps) {
    super(scope, id, props);

    const { config } = props;

    // DynamoDB Tables
    this.holidaysTable = this.createHolidaysTable(config);
    this.timezonesTable = this.createTimezonesTable(config);

    // S3 Buckets
    this.rawBucket = this.createS3Bucket(`${config.s3.rawBucket}-${this.account}`, 'Raw data from external sources');
    this.stagingBucket = this.createS3Bucket(`${config.s3.stagingBucket}-${this.account}`, 'Staging area for validation');
    this.validatedBucket = this.createS3Bucket(`${config.s3.validatedBucket}-${this.account}`, 'Validated data ready for production');
    this.archiveBucket = this.createS3Bucket(`${config.s3.archiveBucket}-${this.account}`, 'Historical data archive');
    this.glueScriptsBucket = this.createS3Bucket(`${config.s3.glueScriptsBucket}-${this.account}`, 'Glue ETL scripts');

    // SNS Topic for approvals (create before roles that reference it)
    this.approvalTopic = new sns.Topic(this, 'DataApprovalTopic', {
      topicName: `${config.projectName}-${config.environment}-data-approval`,
      displayName: 'Almanac API Data Pipeline Approval',
    });

    // IAM Roles
    const glueRole = this.createGlueRole(config);
    const lambdaRole = this.createLambdaRole(config);
    const stepFunctionsRole = this.createStepFunctionsRole(config);

    // Glue Database
    this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: config.glue.databaseName,
        description: 'Almanac API data catalog for holiday and timezone data',
      },
    });

    // CloudWatch Log Groups
    this.createLogGroups(config);

    // Outputs
    this.createOutputs(config);
  }

  private createHolidaysTable(config: AlmanacConfig): dynamodb.Table {
    const table = new dynamodb.Table(this, 'HolidaysTable', {
      tableName: config.dynamodb.holidaysTable,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode[config.dynamodb.billingMode],
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Global Secondary Index for year-based queries
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(table).add(key, value);
    });

    return table;
  }

  private createTimezonesTable(config: AlmanacConfig): dynamodb.Table {
    const table = new dynamodb.Table(this, 'TimezonesTable', {
      tableName: config.dynamodb.timezonesTable,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode[config.dynamodb.billingMode],
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(table).add(key, value);
    });

    return table;
  }

  private createS3Bucket(bucketName: string, description: string): s3.Bucket {
    const bucket = new s3.Bucket(this, bucketName.replace(/-/g, ''), {
      bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'delete-old-versions',
          noncurrentVersionExpiration: cdk.Duration.days(90),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // Add CORS for future web access if needed
    bucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
      allowedOrigins: ['*'],
      allowedHeaders: ['*'],
      maxAge: 3000,
    });

    return bucket;
  }

  private createGlueRole(config: AlmanacConfig): iam.Role {
    const role = new iam.Role(this, 'GlueServiceRole', {
      roleName: `${config.projectName}-${config.environment}-glue-role`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Add S3 permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
      ],
      resources: [
        this.rawBucket.bucketArn,
        this.stagingBucket.bucketArn,
        this.validatedBucket.bucketArn,
        this.archiveBucket.bucketArn,
        this.glueScriptsBucket.bucketArn,
        `${this.rawBucket.bucketArn}/*`,
        `${this.stagingBucket.bucketArn}/*`,
        `${this.validatedBucket.bucketArn}/*`,
        `${this.archiveBucket.bucketArn}/*`,
        `${this.glueScriptsBucket.bucketArn}/*`,
      ],
    }));

    // Add DynamoDB permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:PutItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        this.holidaysTable.tableArn,
        this.timezonesTable.tableArn,
      ],
    }));

    return role;
  }

  private createLambdaRole(config: AlmanacConfig): iam.Role {
    const role = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `${config.projectName}-${config.environment}-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add X-Ray permissions if enabled
    if (config.monitoring.enableXRay) {
      role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
      );
    }

    // Add DynamoDB permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
      ],
      resources: [
        this.holidaysTable.tableArn,
        this.timezonesTable.tableArn,
        `${this.holidaysTable.tableArn}/index/*`,
        `${this.timezonesTable.tableArn}/index/*`,
      ],
    }));

    // Add S3 permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
      ],
      resources: [
        this.validatedBucket.bucketArn,
        `${this.validatedBucket.bucketArn}/*`,
      ],
    }));

    return role;
  }

  private createStepFunctionsRole(config: AlmanacConfig): iam.Role {
    const role = new iam.Role(this, 'StepFunctionsRole', {
      roleName: `${config.projectName}-${config.environment}-stepfunctions-role`,
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    // Add permissions for invoking Lambda functions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: ['arn:aws:lambda:*:*:function:*'],
    }));

    // Add permissions for Glue
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:StartJobRun',
        'glue:GetJobRun',
        'glue:BatchStopJobRun',
        'glue:StartCrawler',
        'glue:GetCrawler',
      ],
      resources: ['*'],
    }));

    // Add SNS permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: [this.approvalTopic.topicArn],
    }));

    return role;
  }

  private createLogGroups(config: AlmanacConfig): void {
    const logGroups = [
      `/aws/lambda/${config.projectName}-${config.environment}`,
      `/aws/glue/${config.projectName}-${config.environment}`,
      `/aws/stepfunctions/${config.projectName}-${config.environment}`,
    ];

    logGroups.forEach(logGroupName => {
      new logs.LogGroup(this, `LogGroup-${logGroupName.replace(/\//g, '-')}`, {
        logGroupName,
        retention: config.monitoring.logRetentionDays,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    });
  }

  private createOutputs(config: AlmanacConfig): void {
    new cdk.CfnOutput(this, 'HolidaysTableName', {
      value: this.holidaysTable.tableName,
      description: 'DynamoDB table for holiday data',
    });

    new cdk.CfnOutput(this, 'TimezonesTableName', {
      value: this.timezonesTable.tableName,
      description: 'DynamoDB table for timezone data',
    });

    new cdk.CfnOutput(this, 'RawBucketName', {
      value: this.rawBucket.bucketName,
      description: 'S3 bucket for raw data',
    });

    new cdk.CfnOutput(this, 'ValidatedBucketName', {
      value: this.validatedBucket.bucketName,
      description: 'S3 bucket for validated data',
    });

    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: config.glue.databaseName,
      description: 'Glue database name',
    });

    new cdk.CfnOutput(this, 'ApprovalTopicArn', {
      value: this.approvalTopic.topicArn,
      description: 'SNS topic for data approval workflow',
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'Deployment region',
    });
  }
}