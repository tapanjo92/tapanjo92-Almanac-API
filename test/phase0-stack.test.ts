import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Phase0Stack } from '../lib/stacks/phase0-stack';
import { getConfig } from '../lib/config';

describe('Phase0Stack', () => {
  let app: cdk.App;
  let stack: Phase0Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    const config = getConfig('test');
    stack = new Phase0Stack(app, 'TestPhase0Stack', {
      env: { account: '123456789012', region: 'ap-south-1' },
      config: config,
    });
    template = Template.fromStack(stack);
  });

  describe('DynamoDB Tables', () => {
    test('creates holidays table with correct configuration', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'almanac-api-test-holidays',
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
        StreamSpecification: {
          StreamViewType: 'NEW_AND_OLD_IMAGES',
        },
        SSESpecification: {
          SSEEnabled: true,
        },
      });
    });

    test('creates timezones table with correct configuration', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'almanac-api-test-timezones',
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
        SSESpecification: {
          SSEEnabled: true,
        },
      });
    });

    test('holidays table has GSI1 index', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'almanac-api-test-holidays',
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      });
    });
  });

  describe('S3 Buckets', () => {
    test('creates all required S3 buckets', () => {
      const buckets = [
        'almanac-api-test-raw',
        'almanac-api-test-staging',
        'almanac-api-test-validated',
        'almanac-api-test-archive',
        'almanac-api-test-glue-scripts',
      ];

      buckets.forEach(bucketPrefix => {
        template.hasResourceProperties('AWS::S3::Bucket', {
          BucketName: Match.stringLikeRegexp(`^${bucketPrefix}-\\d{12}$`),
          VersioningConfiguration: {
            Status: 'Enabled',
          },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              {
                ServerSideEncryptionByDefault: {
                  SSEAlgorithm: 'AES256',
                },
              },
            ],
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        });
      });
    });

    test('buckets have lifecycle rules', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'delete-old-versions',
              NoncurrentVersionExpiration: {
                NoncurrentDays: 90,
              },
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation: 7,
              },
            }),
          ]),
        },
      });
    });
  });

  describe('IAM Roles', () => {
    test('creates Glue service role with correct permissions', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'almanac-api-test-glue-role',
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'glue.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
      });
    });

    test('creates Lambda execution role', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'almanac-api-test-lambda-role',
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
      });
    });

    test('creates Step Functions role', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'almanac-api-test-stepfunctions-role',
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: Match.anyValue(),
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
      });
    });
  });

  describe('Glue Resources', () => {
    test('creates Glue database', () => {
      template.hasResourceProperties('AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'almanac-api_test_db',
          Description: 'Almanac API data catalog for holiday and timezone data',
        },
      });
    });
  });

  describe('SNS Resources', () => {
    test('creates approval topic', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'almanac-api-test-data-approval',
        DisplayName: 'Almanac API Data Pipeline Approval',
      });
    });
  });

  describe('CloudWatch Log Groups', () => {
    test('creates log groups with correct retention', () => {
      const logGroups = [
        '/aws/lambda/almanac-api-test',
        '/aws/glue/almanac-api-test',
        '/aws/stepfunctions/almanac-api-test',
      ];

      logGroups.forEach(logGroupName => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: logGroupName,
          RetentionInDays: 30,
        });
      });
    });
  });

  describe('Stack Outputs', () => {
    test('has all required outputs', () => {
      const outputs = template.findOutputs('*');
      const outputKeys = Object.keys(outputs);

      expect(outputKeys).toContain('HolidaysTableName');
      expect(outputKeys).toContain('TimezonesTableName');
      expect(outputKeys).toContain('RawBucketName');
      expect(outputKeys).toContain('ValidatedBucketName');
      expect(outputKeys).toContain('GlueDatabaseName');
      expect(outputKeys).toContain('ApprovalTopicArn');
      expect(outputKeys).toContain('Region');
    });
  });
});