import * as cdk from 'aws-cdk-lib';
import * as dax from 'aws-cdk-lib/aws-dax';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DaxClusterProps {
  vpc: ec2.IVpc;
  tables: dynamodb.Table[];
  nodeType?: string;
  replicationFactor?: number;
  environment: string;
}

export class DaxCluster extends Construct {
  public readonly cluster: dax.CfnCluster;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, props: DaxClusterProps) {
    super(scope, id);

    const {
      vpc,
      tables,
      nodeType = 'dax.r5.large',
      replicationFactor = 2,
      environment,
    } = props;

    // Create security group
    this.securityGroup = new ec2.SecurityGroup(this, 'DaxSecurityGroup', {
      vpc,
      description: 'Security group for DAX cluster',
      allowAllOutbound: true,
    });

    // Allow DAX port from within VPC
    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8111),
      'Allow DAX access from VPC'
    );

    // Create IAM role
    const daxRole = new iam.Role(this, 'DaxServiceRole', {
      assumedBy: new iam.ServicePrincipal('dax.amazonaws.com'),
      description: 'Service role for DAX cluster',
    });

    // Grant permissions to access DynamoDB tables
    tables.forEach(table => {
      table.grantReadData(daxRole);
    });

    // Create subnet group
    const subnetGroup = new dax.CfnSubnetGroup(this, 'DaxSubnetGroup', {
      subnetGroupName: `${id}-subnet-group`,
      description: 'Subnet group for DAX cluster',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    // Create parameter group with optimized settings
    const parameterGroup = new dax.CfnParameterGroup(this, 'DaxParameterGroup', {
      parameterGroupName: `${id}-params`,
      description: 'Optimized parameters for DAX cluster',
      parameterNameValues: {
        'query-ttl-millis': environment === 'prod' ? '900000' : '300000', // 15 min prod, 5 min dev
        'record-ttl-millis': environment === 'prod' ? '600000' : '180000', // 10 min prod, 3 min dev
        'query-cache-size': '10000',
        'record-cache-size': '10000',
      },
    });

    // Create DAX cluster
    this.cluster = new dax.CfnCluster(this, 'Cluster', {
      clusterName: id,
      description: `DAX cluster for ${environment} environment`,
      iamRoleArn: daxRole.roleArn,
      nodeType,
      replicationFactor,
      subnetGroupName: subnetGroup.ref,
      parameterGroupName: parameterGroup.ref,
      securityGroupIds: [this.securityGroup.securityGroupId],
      sseSpecification: {
        sseEnabled: true,
      },
      clusterEndpointEncryptionType: 'TLS',
      preferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      notificationTopicArn: undefined, // Add SNS topic for production alerts
    });

    this.cluster.addDependency(subnetGroup);
    this.cluster.addDependency(parameterGroup);

    // Store endpoint for reference
    this.endpoint = this.cluster.attrClusterDiscoveryEndpointUrl;
  }

  // Grant Lambda function access to DAX
  public grantAccess(lambdaFunction: cdk.aws_lambda.Function): void {
    // Add Lambda to DAX security group
    lambdaFunction.connections.allowTo(
      this.securityGroup,
      ec2.Port.tcp(8111),
      'Allow Lambda to access DAX'
    );

    // Add environment variable
    lambdaFunction.addEnvironment('DAX_ENDPOINT', this.endpoint);
  }
}