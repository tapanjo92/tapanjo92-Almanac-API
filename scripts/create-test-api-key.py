#!/usr/bin/env python3
import boto3
import uuid
from datetime import datetime, timedelta

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-api-keys')

# Generate API key
api_key = f"alm_{uuid.uuid4().hex}"

# Create API key record
item = {
    'PK': f'API_KEY#{api_key}',
    'SK': 'METADATA',
    'apiKey': api_key,
    'cognitoSub': 'a1932dca-3021-7060-12b2-4b75644df531',  # testuser's sub
    'tier': 'premium',
    'isActive': True,
    'createdAt': datetime.now().isoformat(),
    'expiresAt': (datetime.now() + timedelta(days=365)).isoformat(),
    'description': 'Test API key for premium user',
    'lastUsed': None,
    'requestCount': 0
}

# Insert into DynamoDB
try:
    table.put_item(Item=item)
    print(f"Created API key: {api_key}")
    print(f"Tier: premium")
    print(f"User: testuser")
except Exception as e:
    print(f"Error creating API key: {e}")