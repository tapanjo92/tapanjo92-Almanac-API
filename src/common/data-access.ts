import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DaxClient } from '@aws-sdk/client-dax';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'data-access' });

// Initialize clients
let docClient: DynamoDBDocumentClient;
let daxClient: DynamoDBDocumentClient | null = null;

// Initialize standard DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
docClient = DynamoDBDocumentClient.from(dynamoClient);

// Initialize DAX client if endpoint is available
if (process.env.DAX_ENDPOINT) {
  try {
    const dax = new DaxClient({
      endpoints: [process.env.DAX_ENDPOINT],
      region: process.env.AWS_REGION,
    });
    daxClient = DynamoDBDocumentClient.from(dax as any);
    logger.info('DAX client initialized successfully');
  } catch (error) {
    logger.warn('Failed to initialize DAX client, falling back to DynamoDB', { error });
  }
}

// Get the appropriate client based on operation type
function getClient(useCache: boolean = true): DynamoDBDocumentClient {
  return useCache && daxClient ? daxClient : docClient;
}

export interface UserUsageRecord {
  PK: string; // USER#${cognitoSub}
  SK: string; // USAGE#${timestamp}
  GSI1PK: string; // DATE#${YYYY-MM-DD}
  GSI1SK: string; // USER#${cognitoSub}
  GSI2PK: string; // TIER#${tier}
  GSI2SK: string; // USAGE#${timestamp}
  cognitoSub: string;
  timestamp: string;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  dataTransferBytes: number;
  tier: 'free' | 'starter' | 'growth' | 'enterprise';
  apiKey?: string;
  ttl?: number;
}

export interface ApiKeyRecord {
  PK: string; // USER#${cognitoSub}
  SK: string; // APIKEY#${keyId}
  apiKey: string; // hashed version
  keyId: string;
  cognitoSub: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  isActive: boolean;
  tier: 'free' | 'starter' | 'growth' | 'enterprise';
  usageLimit?: number;
  usageCount: number;
}

export interface UserQuota {
  tier: 'free' | 'starter' | 'growth' | 'enterprise';
  dailyLimit: number;
  monthlyLimit: number;
  rateLimitPerSecond: number;
  concurrentRequests: number;
}

const TIER_QUOTAS: Record<string, UserQuota> = {
  free: {
    tier: 'free',
    dailyLimit: 1000,
    monthlyLimit: 10000,
    rateLimitPerSecond: 10,
    concurrentRequests: 5,
  },
  starter: {
    tier: 'starter',
    dailyLimit: 10000,
    monthlyLimit: 200000,
    rateLimitPerSecond: 50,
    concurrentRequests: 20,
  },
  growth: {
    tier: 'growth',
    dailyLimit: 50000,
    monthlyLimit: 1000000,
    rateLimitPerSecond: 200,
    concurrentRequests: 50,
  },
  enterprise: {
    tier: 'enterprise',
    dailyLimit: -1, // unlimited
    monthlyLimit: -1, // unlimited
    rateLimitPerSecond: 1000,
    concurrentRequests: 200,
  },
};

export class DataAccessService {
  private userUsageTable: string;
  private apiKeysTable: string;

  constructor() {
    this.userUsageTable = process.env.USER_USAGE_TABLE!;
    this.apiKeysTable = process.env.API_KEYS_TABLE!;

    if (!this.userUsageTable || !this.apiKeysTable) {
      throw new Error('Required table names not configured');
    }
  }

  // Track API usage for a user
  async trackUsage(
    cognitoSub: string,
    endpoint: string,
    method: string,
    statusCode: number,
    responseTime: number,
    dataTransferBytes: number,
    tier: string = 'free',
    apiKey?: string
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];

    const usageRecord: UserUsageRecord = {
      PK: `USER#${cognitoSub}`,
      SK: `USAGE#${timestamp}`,
      GSI1PK: `DATE#${date}`,
      GSI1SK: `USER#${cognitoSub}`,
      GSI2PK: `TIER#${tier}`,
      GSI2SK: `USAGE#${timestamp}`,
      cognitoSub,
      timestamp,
      endpoint,
      method,
      statusCode,
      responseTime,
      dataTransferBytes,
      tier: tier as any,
      apiKey,
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days TTL
    };

    try {
      await docClient.send(new PutCommand({
        TableName: this.userUsageTable,
        Item: usageRecord,
      }));
    } catch (error) {
      logger.error('Failed to track usage', { error, cognitoSub, endpoint });
      // Don't throw - we don't want to fail the request due to tracking issues
    }
  }

  // Get user's usage for a specific date
  async getUserDailyUsage(cognitoSub: string, date: string): Promise<UserUsageRecord[]> {
    const response = await getClient().send(new QueryCommand({
      TableName: this.userUsageTable,
      IndexName: 'DateUserIndex',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: {
        ':pk': `DATE#${date}`,
        ':sk': `USER#${cognitoSub}`,
      },
    }));

    return (response.Items || []) as UserUsageRecord[];
  }

  // Get user's usage for current month
  async getUserMonthlyUsage(cognitoSub: string): Promise<UserUsageRecord[]> {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const startDate = `${year}-${month}-01`;
    const endDate = `${year}-${month}-31`;

    const response = await getClient().send(new QueryCommand({
      TableName: this.userUsageTable,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `USER#${cognitoSub}`,
        ':start': `USAGE#${startDate}`,
        ':end': `USAGE#${endDate}T23:59:59.999Z`,
      },
    }));

    return (response.Items || []) as UserUsageRecord[];
  }

  // Check if user has exceeded their quota
  async checkUserQuota(cognitoSub: string, tier: string = 'free'): Promise<{
    allowed: boolean;
    dailyUsed: number;
    monthlyUsed: number;
    quota: UserQuota;
  }> {
    const quota = TIER_QUOTAS[tier] || TIER_QUOTAS.free;
    
    // Get today's usage
    const today = new Date().toISOString().split('T')[0];
    const dailyUsage = await this.getUserDailyUsage(cognitoSub, today);
    const dailyUsed = dailyUsage.length;

    // Get monthly usage
    const monthlyUsage = await this.getUserMonthlyUsage(cognitoSub);
    const monthlyUsed = monthlyUsage.length;

    // Check limits (unlimited for enterprise)
    const allowed = (
      (quota.dailyLimit === -1 || dailyUsed < quota.dailyLimit) &&
      (quota.monthlyLimit === -1 || monthlyUsed < quota.monthlyLimit)
    );

    return {
      allowed,
      dailyUsed,
      monthlyUsed,
      quota,
    };
  }

  // Get API key details
  async getApiKey(apiKey: string): Promise<ApiKeyRecord | null> {
    const response = await getClient().send(new QueryCommand({
      TableName: this.apiKeysTable,
      IndexName: 'ApiKeyIndex',
      KeyConditionExpression: 'apiKey = :key',
      ExpressionAttributeValues: {
        ':key': apiKey,
      },
      Limit: 1,
    }));

    return response.Items?.[0] as ApiKeyRecord || null;
  }

  // Create a new API key for user
  async createApiKey(
    cognitoSub: string,
    name: string,
    tier: string = 'free'
  ): Promise<ApiKeyRecord> {
    const keyId = `key_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const apiKey = `alm_${tier}_${Math.random().toString(36).substr(2, 32)}`;
    const timestamp = new Date().toISOString();

    const keyRecord: ApiKeyRecord = {
      PK: `USER#${cognitoSub}`,
      SK: `APIKEY#${keyId}`,
      apiKey,
      keyId,
      cognitoSub,
      name,
      createdAt: timestamp,
      isActive: true,
      tier: tier as any,
      usageCount: 0,
    };

    await docClient.send(new PutCommand({
      TableName: this.apiKeysTable,
      Item: keyRecord,
    }));

    return keyRecord;
  }

  // Update API key last used timestamp
  async updateApiKeyUsage(apiKey: string): Promise<void> {
    const keyRecord = await this.getApiKey(apiKey);
    if (!keyRecord) return;

    await docClient.send(new UpdateCommand({
      TableName: this.apiKeysTable,
      Key: {
        PK: keyRecord.PK,
        SK: keyRecord.SK,
      },
      UpdateExpression: 'SET lastUsedAt = :timestamp, usageCount = usageCount + :inc',
      ExpressionAttributeValues: {
        ':timestamp': new Date().toISOString(),
        ':inc': 1,
      },
    }));
  }

  // Get user's API keys
  async getUserApiKeys(cognitoSub: string): Promise<ApiKeyRecord[]> {
    const response = await getClient().send(new QueryCommand({
      TableName: this.apiKeysTable,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `USER#${cognitoSub}`,
        ':prefix': 'APIKEY#',
      },
    }));

    return (response.Items || []) as ApiKeyRecord[];
  }

  // Revoke an API key
  async revokeApiKey(cognitoSub: string, keyId: string): Promise<void> {
    await docClient.send(new UpdateCommand({
      TableName: this.apiKeysTable,
      Key: {
        PK: `USER#${cognitoSub}`,
        SK: `APIKEY#${keyId}`,
      },
      UpdateExpression: 'SET isActive = :false',
      ExpressionAttributeValues: {
        ':false': false,
      },
    }));
  }
}

// Export singleton instance
export const dataAccessService = new DataAccessService();