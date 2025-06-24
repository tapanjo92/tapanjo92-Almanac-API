import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as dax from 'aws-cdk-lib/aws-dax';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { Phase0Stack } from './phase0-stack';

export interface Phase3StackProps extends cdk.StackProps {
  config: AlmanacConfig;
  phase0Stack: Phase0Stack;
}

export class Phase3Stack extends cdk.Stack {
  public readonly userUsageTable: dynamodb.Table;
  public readonly apiKeysTable: dynamodb.Table;
  public readonly daxCluster: dax.CfnCluster;

  constructor(scope: Construct, id: string, props: Phase3StackProps) {
    super(scope, id, props);

    const { config } = props;

    // Create VPC for DAX (required)
    const vpc = new ec2.Vpc(this, 'DaxVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Create security group for DAX
    const daxSecurityGroup = new ec2.SecurityGroup(this, 'DaxSecurityGroup', {
      vpc,
      description: 'Security group for DAX cluster',
      allowAllOutbound: true,
    });

    // Allow DAX port from Lambda functions
    daxSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8111),
      'Allow DAX access from VPC'
    );

    // Create User Usage Tracking Table
    this.userUsageTable = this.createUserUsageTable(config);

    // Create API Keys Table
    this.apiKeysTable = this.createApiKeysTable(config);

    // Create DAX Cluster
    this.daxCluster = this.createDaxCluster(config, vpc, daxSecurityGroup);

    // Create outputs
    this.createOutputs();
    
    // Note: Lambda functions from Phase1Stack need to be updated after deployment
    // using the post-deploy-phase3.sh script to avoid circular dependencies
  }

  private createUserUsageTable(config: AlmanacConfig): dynamodb.Table {
    const table = new dynamodb.Table(this, 'UserUsageTable', {
      tableName: `${config.projectName}-${config.environment}-user-usage`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI for querying by date
    table.addGlobalSecondaryIndex({
      indexName: 'DateUserIndex',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for querying by user tier
    table.addGlobalSecondaryIndex({
      indexName: 'TierUsageIndex',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['apiCalls', 'dataTransfer', 'uniqueEndpoints'],
    });

    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(table).add(key, value);
    });

    return table;
  }

  private createApiKeysTable(config: AlmanacConfig): dynamodb.Table {
    const table = new dynamodb.Table(this, 'ApiKeysTable', {
      tableName: `${config.projectName}-${config.environment}-api-keys`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI for API key lookup
    table.addGlobalSecondaryIndex({
      indexName: 'ApiKeyIndex',
      partitionKey: { name: 'apiKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Add tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(table).add(key, value);
    });

    return table;
  }

  private createDaxCluster(
    config: AlmanacConfig,
    vpc: ec2.Vpc,
    securityGroup: ec2.SecurityGroup
  ): dax.CfnCluster {
    // Create IAM role for DAX
    const daxRole = new iam.Role(this, 'DaxServiceRole', {
      assumedBy: new iam.ServicePrincipal('dax.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'),
      ],
    });

    // Create subnet group for DAX
    const subnetGroup = new dax.CfnSubnetGroup(this, 'DaxSubnetGroup', {
      subnetGroupName: `${config.projectName}-${config.environment}-dax-subnet-group`,
      description: 'Subnet group for DAX cluster',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    // Create parameter group
    const parameterGroup = new dax.CfnParameterGroup(this, 'DaxParameterGroup', {
      parameterGroupName: `${config.projectName}-${config.environment}-dax-params`,
      description: 'Parameter group for DAX cluster',
      parameterNameValues: {
        'query-ttl-millis': '600000', // 10 minutes
        'record-ttl-millis': '300000', // 5 minutes
      },
    });

    // Create DAX cluster
    const cluster = new dax.CfnCluster(this, 'DaxCluster', {
      clusterName: `${config.projectName}-${config.environment}-dax`,
      description: 'DAX cluster for Almanac API caching',
      iamRoleArn: daxRole.roleArn,
      nodeType: 'dax.r5.large',
      replicationFactor: config.environment === 'prod' ? 3 : 2,
      subnetGroupName: subnetGroup.ref,
      parameterGroupName: parameterGroup.ref,
      securityGroupIds: [securityGroup.securityGroupId],
      sseSpecification: {
        sseEnabled: true,
      },
      clusterEndpointEncryptionType: 'TLS',
    });

    cluster.addDependency(subnetGroup);
    cluster.addDependency(parameterGroup);

    // Add tags to DAX cluster
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(cluster).add(key, value);
    });

    return cluster;
  }


  private createOutputs(): void {
    new cdk.CfnOutput(this, 'UserUsageTableName', {
      value: this.userUsageTable.tableName,
      description: 'DynamoDB table for user usage tracking',
    });

    new cdk.CfnOutput(this, 'ApiKeysTableName', {
      value: this.apiKeysTable.tableName,
      description: 'DynamoDB table for API key management',
    });

    new cdk.CfnOutput(this, 'DaxClusterEndpoint', {
      value: this.daxCluster.attrClusterDiscoveryEndpointUrl,
      description: 'DAX cluster endpoint',
    });
  }
}