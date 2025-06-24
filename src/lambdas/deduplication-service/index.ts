import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Context } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const HOLIDAYS_TABLE = process.env.HOLIDAYS_TABLE!;
const BATCH_SIZE = 25;

interface Holiday {
  PK: string;
  SK: string;
  date: string;
  name: string;
  type: string;
  country: string;
  regions: string[];
  year: number;
  month: number;
  day: number;
  version?: number;
  etl_run_id?: string;
}

interface DeduplicationResult {
  processed: number;
  duplicatesFound: number;
  duplicatesRemoved: number;
  consolidations: number;
  errors: number;
}

export const handler = async (event: any, context: Context): Promise<any> => {
  console.log('Starting deduplication service', { requestId: context.awsRequestId });
  
  const result: DeduplicationResult = {
    processed: 0,
    duplicatesFound: 0,
    duplicatesRemoved: 0,
    consolidations: 0,
    errors: 0
  };

  try {
    // Process by year
    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear + 1, currentYear + 2];
    
    for (const year of years) {
      await processYearHolidays(year, result);
    }
    
    // Send metrics to CloudWatch
    await sendMetrics(result);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Deduplication completed successfully',
        result
      })
    };
  } catch (error) {
    console.error('Deduplication failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Deduplication failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};

async function processYearHolidays(year: number, result: DeduplicationResult): Promise<void> {
  console.log(`Processing holidays for year ${year}`);
  
  // Query all holidays for the year
  const holidays = await getAllHolidaysForYear(year);
  result.processed += holidays.length;
  
  // Group holidays by date and name
  const holidayGroups = groupHolidaysByDateAndName(holidays);
  
  // Process each group for duplicates
  for (const [key, group] of holidayGroups.entries()) {
    if (group.length > 1) {
      result.duplicatesFound += group.length - 1;
      await consolidateHolidayGroup(group, result);
    }
  }
}

async function getAllHolidaysForYear(year: number): Promise<Holiday[]> {
  const holidays: Holiday[] = [];
  let lastEvaluatedKey: any = undefined;
  
  do {
    const params: any = {
      TableName: HOLIDAYS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `COUNTRY#AU#${year}`
      }
    };
    
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }
    
    const response = await docClient.send(new QueryCommand(params));
    
    if (response.Items) {
      holidays.push(...(response.Items as Holiday[]));
    }
    
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  
  return holidays;
}

function groupHolidaysByDateAndName(holidays: Holiday[]): Map<string, Holiday[]> {
  const groups = new Map<string, Holiday[]>();
  
  for (const holiday of holidays) {
    const key = `${holiday.date}|${holiday.name}`;
    const existing = groups.get(key) || [];
    existing.push(holiday);
    groups.set(key, existing);
  }
  
  return groups;
}

async function consolidateHolidayGroup(group: Holiday[], result: DeduplicationResult): Promise<void> {
  // Collect all unique regions
  const allRegions = new Set<string>();
  let hasNationalRecord = false;
  
  for (const holiday of group) {
    if (holiday.regions?.includes('ALL')) {
      hasNationalRecord = true;
    }
    holiday.regions?.forEach(region => allRegions.add(region));
  }
  
  // Determine if this should be a national holiday
  const stateRegions = Array.from(allRegions).filter(r => 
    ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].includes(r)
  );
  
  const shouldBeNational = stateRegions.length >= 6 || hasNationalRecord;
  
  // Create consolidated record
  const consolidatedHoliday = { ...group[0] };
  
  if (shouldBeNational) {
    consolidatedHoliday.regions = ['ALL'];
    consolidatedHoliday.SK = `HOLIDAY#${consolidatedHoliday.date}#${consolidatedHoliday.name.replace(/ /g, '_')}#ALL`;
  } else {
    consolidatedHoliday.regions = Array.from(allRegions).sort();
    const regionsKey = consolidatedHoliday.regions.join('_');
    consolidatedHoliday.SK = `HOLIDAY#${consolidatedHoliday.date}#${consolidatedHoliday.name.replace(/ /g, '_')}#${regionsKey}`;
  }
  
  consolidatedHoliday.version = (consolidatedHoliday.version || 0) + 1;
  consolidatedHoliday.etl_run_id = `dedup-${new Date().toISOString()}`;
  
  try {
    // Write consolidated record
    await docClient.send(new PutCommand({
      TableName: HOLIDAYS_TABLE,
      Item: consolidatedHoliday,
      ConditionExpression: 'attribute_not_exists(PK) OR #version < :newVersion',
      ExpressionAttributeNames: {
        '#version': 'version'
      },
      ExpressionAttributeValues: {
        ':newVersion': consolidatedHoliday.version
      }
    }));
    
    // Delete duplicates (except the consolidated one)
    const itemsToDelete = group.filter(h => h.SK !== consolidatedHoliday.SK);
    
    if (itemsToDelete.length > 0) {
      await deleteHolidays(itemsToDelete);
      result.duplicatesRemoved += itemsToDelete.length;
      result.consolidations += 1;
    }
  } catch (error) {
    console.error('Error consolidating holiday group:', error);
    result.errors += 1;
  }
}

async function deleteHolidays(holidays: Holiday[]): Promise<void> {
  // Process in batches
  for (let i = 0; i < holidays.length; i += BATCH_SIZE) {
    const batch = holidays.slice(i, i + BATCH_SIZE);
    
    const deleteRequests = batch.map(holiday => ({
      DeleteRequest: {
        Key: {
          PK: holiday.PK,
          SK: holiday.SK
        }
      }
    }));
    
    try {
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [HOLIDAYS_TABLE]: deleteRequests
        }
      }));
    } catch (error) {
      console.error('Error deleting batch:', error);
      throw error;
    }
  }
}

async function sendMetrics(result: DeduplicationResult): Promise<void> {
  // CloudWatch metrics sending is handled by CloudWatch Logs Insights
  // Log metrics in structured format for analysis
  console.log('METRICS', {
    type: 'deduplication_metrics',
    metrics: {
      holidaysProcessed: result.processed,
      duplicatesFound: result.duplicatesFound,
      duplicatesRemoved: result.duplicatesRemoved,
      consolidations: result.consolidations
    }
  });
}