#!/usr/bin/env python3
"""
Delete all Australian holiday data from DynamoDB
Principal Architect: Clean slate approach for data integrity
"""

import boto3
from boto3.dynamodb.conditions import Key
import os
from datetime import datetime

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table_name = os.environ.get('HOLIDAYS_TABLE', 'almanac-api-dev-holidays')
table = dynamodb.Table(table_name)

def delete_australian_holidays():
    """Delete all Australian holiday records"""
    print(f"🗑️  Starting deletion of Australian holidays from {table_name}")
    print(f"Timestamp: {datetime.now().isoformat()}")
    
    deleted_count = 0
    error_count = 0
    
    # Query for all Australian holidays (AU country code)
    for year in range(2024, 2028):  # Current and future years
        try:
            print(f"\nProcessing year {year}...")
            
            # Query by partition key
            response = table.query(
                KeyConditionExpression=Key('PK').eq(f'COUNTRY#AU#{year}')
            )
            
            items = response.get('Items', [])
            print(f"Found {len(items)} items for year {year}")
            
            # Delete items in batches
            with table.batch_writer() as batch:
                for item in items:
                    try:
                        batch.delete_item(
                            Key={
                                'PK': item['PK'],
                                'SK': item['SK']
                            }
                        )
                        deleted_count += 1
                        
                        if deleted_count % 25 == 0:
                            print(f"  Deleted {deleted_count} items...")
                    except Exception as e:
                        print(f"  ❌ Error deleting item: {e}")
                        error_count += 1
            
            # Handle pagination
            while 'LastEvaluatedKey' in response:
                response = table.query(
                    KeyConditionExpression=Key('PK').eq(f'COUNTRY#AU#{year}'),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                
                items = response.get('Items', [])
                
                with table.batch_writer() as batch:
                    for item in items:
                        try:
                            batch.delete_item(
                                Key={
                                    'PK': item['PK'],
                                    'SK': item['SK']
                                }
                            )
                            deleted_count += 1
                            
                            if deleted_count % 25 == 0:
                                print(f"  Deleted {deleted_count} items...")
                        except Exception as e:
                            print(f"  ❌ Error deleting item: {e}")
                            error_count += 1
                            
        except Exception as e:
            print(f"❌ Error processing year {year}: {e}")
    
    # Also check for any records without year in PK (legacy format)
    try:
        print("\nChecking for legacy format records...")
        response = table.query(
            KeyConditionExpression=Key('PK').eq('COUNTRY#AU')
        )
        
        items = response.get('Items', [])
        if items:
            print(f"Found {len(items)} legacy items")
            
            with table.batch_writer() as batch:
                for item in items:
                    try:
                        batch.delete_item(
                            Key={
                                'PK': item['PK'],
                                'SK': item['SK']
                            }
                        )
                        deleted_count += 1
                    except Exception as e:
                        print(f"  ❌ Error deleting legacy item: {e}")
                        error_count += 1
    except:
        print("No legacy format records found")
    
    print(f"\n✅ Deletion complete!")
    print(f"   Total deleted: {deleted_count}")
    print(f"   Errors: {error_count}")
    print(f"   Table is now clean for fresh data load")
    
    return deleted_count, error_count

if __name__ == "__main__":
    # Set environment if not already set
    if 'HOLIDAYS_TABLE' not in os.environ:
        os.environ['HOLIDAYS_TABLE'] = 'almanac-api-dev-holidays'
    
    deleted, errors = delete_australian_holidays()
    
    # Exit with error code if there were errors
    exit(1 if errors > 0 else 0)