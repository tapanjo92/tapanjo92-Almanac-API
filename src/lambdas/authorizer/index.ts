import { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Logger } from '@aws-lambda-powertools/logger';
import { dataAccessService } from '../../common/data-access';

const logger = new Logger({ serviceName: 'api-authorizer' });

// Environment variables
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

// Create verifier for Cognito tokens
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'access',
  clientId: CLIENT_ID,
});

interface AuthContext {
  cognitoSub?: string;
  tier: string;
  apiKey?: string;
  email?: string;
  username?: string;
}

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  logger.info('Authorization request', {
    methodArn: event.methodArn,
    type: event.type,
  });

  try {
    // Extract token from Authorization header
    const token = event.authorizationToken;
    
    if (!token) {
      logger.warn('No authorization token provided');
      throw new Error('Unauthorized');
    }

    let authContext: AuthContext = { tier: 'free' };
    let principalId: string;

    // Check if it's a Bearer token (Cognito JWT)
    if (token.startsWith('Bearer ')) {
      const jwt = token.substring(7);
      
      try {
        // Verify Cognito JWT
        const payload = await verifier.verify(jwt);
        
        authContext = {
          cognitoSub: payload.sub,
          tier: String(payload['custom:tier'] || 'free'),
          email: typeof payload.email === 'string' ? payload.email : undefined,
          username: typeof payload.username === 'string' ? payload.username : (typeof payload['cognito:username'] === 'string' ? payload['cognito:username'] : undefined),
        };
        
        principalId = payload.sub;
        
        logger.info('Cognito token verified', {
          sub: payload.sub,
          tier: authContext.tier,
        });
      } catch (error) {
        logger.error('Invalid Cognito token', { error });
        throw new Error('Unauthorized');
      }
    }
    // Check if it's an API key
    else if (token.startsWith('alm_')) {
      const apiKeyRecord = await dataAccessService.getApiKey(token);
      
      if (!apiKeyRecord || !apiKeyRecord.isActive) {
        logger.warn('Invalid or inactive API key');
        throw new Error('Unauthorized');
      }

      // Check if API key has expired
      if (apiKeyRecord.expiresAt && new Date(apiKeyRecord.expiresAt) < new Date()) {
        logger.warn('API key has expired');
        throw new Error('Unauthorized');
      }

      authContext = {
        cognitoSub: apiKeyRecord.cognitoSub,
        tier: apiKeyRecord.tier,
        apiKey: token,
      };
      
      principalId = apiKeyRecord.cognitoSub;
      
      // Update last used timestamp (fire and forget)
      dataAccessService.updateApiKeyUsage(token).catch(err => 
        logger.error('Failed to update API key usage', { error: err })
      );
      
      logger.info('API key verified', {
        keyId: apiKeyRecord.keyId,
        tier: apiKeyRecord.tier,
      });
    } else {
      logger.warn('Invalid authorization format');
      throw new Error('Unauthorized');
    }

    // Check user quota
    if (authContext.cognitoSub) {
      const quotaCheck = await dataAccessService.checkUserQuota(
        authContext.cognitoSub,
        authContext.tier
      );
      
      if (!quotaCheck.allowed) {
        logger.warn('User quota exceeded', {
          cognitoSub: authContext.cognitoSub,
          dailyUsed: quotaCheck.dailyUsed,
          monthlyUsed: quotaCheck.monthlyUsed,
          quota: quotaCheck.quota,
        });
        throw new Error('Quota exceeded');
      }
    }

    // Generate policy
    const policy = generatePolicy(principalId, 'Allow', event.methodArn, authContext);
    
    logger.info('Authorization successful', { principalId, tier: authContext.tier });
    
    return policy;
  } catch (error) {
    logger.error('Authorization failed', { error });
    
    // Return explicit deny for quota exceeded
    if (error instanceof Error && error.message === 'Quota exceeded') {
      return generatePolicy('user', 'Deny', event.methodArn, { tier: 'free' });
    }
    
    // For other errors, throw to return 401
    throw new Error('Unauthorized');
  }
};

function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context: AuthContext
): APIGatewayAuthorizerResult {
  const authResponse: APIGatewayAuthorizerResult = {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: context as any,
  };

  // Add usage plan ID based on tier
  const usagePlanIds: Record<string, string> = {
    free: 'free-tier',
    starter: 'starter-tier',
    growth: 'growth-tier',
    enterprise: 'enterprise-tier',
  };

  if (usagePlanIds[context.tier]) {
    authResponse.usageIdentifierKey = context.apiKey || principalId;
  }

  return authResponse;
}