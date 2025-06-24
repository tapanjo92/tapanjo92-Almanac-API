import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { DAXClient } from '@aws-sdk/client-dax';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'dax-client' });

let documentClient: DynamoDBDocumentClient;
let daxDocumentClient: DynamoDBDocumentClient | null = null;

// Initialize standard DynamoDB client
const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: {
    convertEmptyValues: false,
    removeUndefinedValues: true,
  },
});

// Initialize DAX client if endpoint is available
if (process.env.DAX_ENDPOINT && process.env.AWS_EXECUTION_ENV) {
  try {
    const daxClient = new DAXClient({
      endpoint: process.env.DAX_ENDPOINT,
      region: process.env.AWS_REGION,
      requestHandler: {
        requestTimeout: 2000, // 2 second timeout for DAX
      },
    });
    
    daxDocumentClient = DynamoDBDocumentClient.from(daxClient as any, {
      marshallOptions: {
        convertEmptyValues: false,
        removeUndefinedValues: true,
      },
    });
    
    logger.info('DAX client initialized successfully', {
      endpoint: process.env.DAX_ENDPOINT,
    });
  } catch (error) {
    logger.warn('Failed to initialize DAX client, falling back to DynamoDB', { error });
  }
}

// In-memory cache for Lambda container reuse
interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

const memoryCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 1000;
const DEFAULT_MEMORY_TTL = 5 * 60 * 1000; // 5 minutes

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (now > entry.timestamp + entry.ttl) {
      memoryCache.delete(key);
    }
  }
}, 60000); // Clean up every minute

export class CachedDynamoDBClient {
  private useCache: boolean;
  private tableName: string;

  constructor(tableName: string, useCache: boolean = true) {
    this.tableName = tableName;
    this.useCache = useCache;
  }

  private getClient(): DynamoDBDocumentClient {
    // Use DAX for read operations if available
    if (this.useCache && daxDocumentClient) {
      return daxDocumentClient;
    }
    return documentClient;
  }

  private getCacheKey(operation: string, params: any): string {
    return `${operation}:${JSON.stringify(params)}`;
  }

  private getFromMemoryCache(key: string): any | null {
    const entry = memoryCache.get(key);
    if (entry && Date.now() < entry.timestamp + entry.ttl) {
      logger.debug('Memory cache hit', { key });
      return entry.data;
    }
    return null;
  }

  private setMemoryCache(key: string, data: any, ttl: number = DEFAULT_MEMORY_TTL): void {
    // Limit cache size
    if (memoryCache.size >= MAX_CACHE_SIZE) {
      const firstKey = memoryCache.keys().next().value;
      memoryCache.delete(firstKey);
    }

    memoryCache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
  }

  async query(params: Omit<QueryCommand['input'], 'TableName'>): Promise<any> {
    const fullParams = { ...params, TableName: this.tableName };
    
    // Check memory cache first
    const cacheKey = this.getCacheKey('query', fullParams);
    const cached = this.getFromMemoryCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const client = this.getClient();
      const response = await client.send(new QueryCommand(fullParams));
      
      // Cache successful responses
      if (response.Items && response.Items.length > 0) {
        this.setMemoryCache(cacheKey, response);
      }
      
      return response;
    } catch (error) {
      // If DAX fails, fallback to DynamoDB
      if (this.useCache && daxDocumentClient && error instanceof Error) {
        logger.warn('DAX query failed, falling back to DynamoDB', { error: error.message });
        const response = await documentClient.send(new QueryCommand(fullParams));
        return response;
      }
      throw error;
    }
  }

  async get(params: Omit<GetCommand['input'], 'TableName'>): Promise<any> {
    const fullParams = { ...params, TableName: this.tableName };
    
    // Check memory cache first
    const cacheKey = this.getCacheKey('get', fullParams);
    const cached = this.getFromMemoryCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const client = this.getClient();
      const response = await client.send(new GetCommand(fullParams));
      
      // Cache successful responses
      if (response.Item) {
        this.setMemoryCache(cacheKey, response);
      }
      
      return response;
    } catch (error) {
      // If DAX fails, fallback to DynamoDB
      if (this.useCache && daxDocumentClient && error instanceof Error) {
        logger.warn('DAX get failed, falling back to DynamoDB', { error: error.message });
        const response = await documentClient.send(new GetCommand(fullParams));
        return response;
      }
      throw error;
    }
  }

  async batchGet(params: { Keys: Record<string, any>[] } & Omit<BatchGetCommand['input'], 'RequestItems'>): Promise<any> {
    const fullParams = {
      ...params,
      RequestItems: {
        [this.tableName]: params.Keys as any,
      },
    };

    try {
      const client = this.getClient();
      const response = await client.send(new BatchGetCommand(fullParams));
      return response;
    } catch (error) {
      // If DAX fails, fallback to DynamoDB
      if (this.useCache && daxDocumentClient && error instanceof Error) {
        logger.warn('DAX batchGet failed, falling back to DynamoDB', { error: error.message });
        const response = await documentClient.send(new BatchGetCommand(fullParams));
        return response;
      }
      throw error;
    }
  }

  // Write operations always go directly to DynamoDB (not through DAX)
  getWriteClient(): DynamoDBDocumentClient {
    return documentClient;
  }
}