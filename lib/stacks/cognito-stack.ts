import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AlmanacConfig } from '../config';

export interface CognitoStackProps extends cdk.StackProps {
  config: AlmanacConfig;
}

export class CognitoStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Create User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${config.projectName}-${config.environment}`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        fullname: {
          required: false,
          mutable: true,
        },
      },
      customAttributes: {
        tier: new cognito.StringAttribute({
          mutable: true,
        }),
        organization: new cognito.StringAttribute({
          mutable: true,
        }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // MFA is disabled as requested
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: config.environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Create app client
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${config.projectName}-${config.environment}-client`,
      generateSecret: false, // Public client for web/mobile apps
      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: config.environment === 'prod'
          ? ['https://api.almanac.io/callback']
          : ['http://localhost:3000/callback', 'https://dev.almanac.io/callback'],
        logoutUrls: config.environment === 'prod'
          ? ['https://api.almanac.io/logout']
          : ['http://localhost:3000/logout', 'https://dev.almanac.io/logout'],
      },
      preventUserExistenceErrors: true,
      enablePropagateAdditionalUserContextData: false,
      authSessionValidity: cdk.Duration.minutes(5),
      refreshTokenValidity: cdk.Duration.days(30),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
    });

    // Add Lambda trigger for auto-confirming users (optional, for dev environment)
    if (config.environment === 'dev') {
      const autoConfirmFunction = new lambda.Function(this, 'AutoConfirmFunction', {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
          exports.handler = async (event) => {
            // Auto-confirm user in dev environment
            event.response.autoConfirmUser = true;
            event.response.autoVerifyEmail = true;
            return event;
          };
        `),
      });

      this.userPool.addTrigger(
        cognito.UserPoolOperation.PRE_SIGN_UP,
        autoConfirmFunction
      );
    }


    // Create admin group
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Admin users with full access',
      precedence: 1,
    });

    // Create premium group
    new cognito.CfnUserPoolGroup(this, 'PremiumGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'premium',
      description: 'Premium tier users',
      precedence: 10,
    });

    // Create free tier group
    new cognito.CfnUserPoolGroup(this, 'FreeGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'free',
      description: 'Free tier users',
      precedence: 100,
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });


    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: `https://${this.userPool.userPoolId}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito Hosted UI Domain',
    });
  }
}