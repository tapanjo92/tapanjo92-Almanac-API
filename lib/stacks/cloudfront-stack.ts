import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';
import { ApiGatewayStack } from './api-gateway-stack';

export interface CloudFrontStackProps extends cdk.StackProps {
  config: AlmanacConfig;
  apiGatewayStack: ApiGatewayStack;
}

export class CloudFrontStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontStackProps) {
    super(scope, id, props);

    const { config, apiGatewayStack } = props;
    const api = apiGatewayStack.api;

    // Create cache policies
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: `${config.projectName}-${config.environment}-api-cache`,
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.hours(24),
      minTtl: cdk.Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'x-api-key',
        'Content-Type'
      ),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Create origin request policy
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      originRequestPolicyName: `${config.projectName}-${config.environment}-origin-request`,
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'x-api-key',
        'Content-Type',
        'CloudFront-Viewer-Country',
        'CloudFront-Is-Mobile-Viewer',
        'CloudFront-Is-Desktop-Viewer'
      ),
    });

    // Create CloudFront log bucket with proper permissions
    const logBucket = new s3.Bucket(this, 'CloudFrontLogs', {
      bucketName: `${config.projectName}-${config.environment}-cf-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{
        expiration: cdk.Duration.days(30),
      }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    // Create CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: `${config.projectName} API Distribution`,
      defaultBehavior: {
        origin: new origins.RestApiOrigin(api),
        cachePolicy: apiCachePolicy,
        originRequestPolicy: originRequestPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        compress: true,
      },
      additionalBehaviors: {
        '/holidays/*': {
          origin: new origins.RestApiOrigin(api),
          cachePolicy: new cloudfront.CachePolicy(this, 'HolidaysCachePolicy', {
            defaultTtl: cdk.Duration.hours(24),
            maxTtl: cdk.Duration.days(7),
            minTtl: cdk.Duration.hours(1),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
        },
        '/timezones/*': {
          origin: new origins.RestApiOrigin(api),
          cachePolicy: new cloudfront.CachePolicy(this, 'TimezonesCachePolicy', {
            defaultTtl: cdk.Duration.days(7),
            maxTtl: cdk.Duration.days(30),
            minTtl: cdk.Duration.days(1),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
        },
        '/business-days/*': {
          origin: new origins.RestApiOrigin(api),
          cachePolicy: new cloudfront.CachePolicy(this, 'BusinessDaysCachePolicy', {
            defaultTtl: cdk.Duration.hours(1),
            maxTtl: cdk.Duration.hours(24),
            minTtl: cdk.Duration.minutes(5),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logBucket: logBucket,
      logFilePrefix: 'api-access-logs/',
    });

    // Enable Origin Shield in Mumbai
    const cfnDistribution = this.distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginShield', {
      Enabled: true,
      OriginShieldRegion: 'ap-south-1',
    });

    // Create outputs
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });
  }
}