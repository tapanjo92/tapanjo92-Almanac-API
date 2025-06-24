#!/usr/bin/env python3
"""
Test direct DynamoDB query patterns
"""

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-holidays')

print("Testing different query patterns:\n")

# Pattern 1: COUNTRY#AU#2025
print("1. Query with COUNTRY#AU#2025:")
response = table.query(
    KeyConditionExpression=Key('PK').eq('COUNTRY#AU#2025')
)
print(f"   Results: {response['Count']}")

# Pattern 2: COUNTRY#AU (old format)
print("\n2. Query with COUNTRY#AU:")
response = table.query(
    KeyConditionExpression=Key('PK').eq('COUNTRY#AU')
)
print(f"   Results: {response['Count']}")

# Pattern 3: With GSI
print("\n3. Query with GSI (YEAR#2025):")
response = table.query(
    IndexName='GSI1',
    KeyConditionExpression=Key('GSI1PK').eq('YEAR#2025')
)
print(f"   Results: {response['Count']}")

# Show sample record structure
print("\n4. Sample record:")
response = table.query(
    KeyConditionExpression=Key('PK').eq('COUNTRY#AU#2025'),
    Limit=1
)
if response['Items']:
    item = response['Items'][0]
    print(f"   PK: {item['PK']}")
    print(f"   SK: {item['SK']}")
    print(f"   GSI1PK: {item.get('GSI1PK', 'N/A')}")
    print(f"   GSI1SK: {item.get('GSI1SK', 'N/A')}")
    
print("\nThe Lambda likely needs to query with COUNTRY#AU#2025, not COUNTRY#AU")