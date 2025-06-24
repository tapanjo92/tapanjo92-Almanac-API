#!/usr/bin/env python3
"""
Direct test of holiday data and API
Principal Architect: Quick verification
"""

import boto3
import json
from boto3.dynamodb.conditions import Key

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-holidays')

print("🧪 Direct Holiday Data Test")
print("=" * 50)

# Test 1: Query DynamoDB directly
print("\n1️⃣ DynamoDB Direct Query for AU 2025:")
response = table.query(
    KeyConditionExpression=Key('PK').eq('COUNTRY#AU#2025')
)

holidays = response.get('Items', [])
print(f"   Total holidays: {len(holidays)}")

# Group by type
nationals = [h for h in holidays if 'ALL' in h.get('regions', [])]
states = [h for h in holidays if 'ALL' not in h.get('regions', [])]

print(f"   National holidays: {len(nationals)}")
print(f"   State holidays: {len(states)}")

# Show some samples
print("\n   Sample national holidays:")
for h in nationals[:3]:
    print(f"   - {h['date']}: {h['name']}")

# Test 2: Check the Lambda function locally
print("\n2️⃣ Lambda Function Environment Check:")
import subprocess
result = subprocess.run(
    ['aws', 'lambda', 'get-function-configuration', 
     '--function-name', 'almanac-api-dev-holidays',
     '--region', 'ap-south-1'],
    capture_output=True,
    text=True
)

if result.returncode == 0:
    config = json.loads(result.stdout)
    env_vars = config.get('Environment', {}).get('Variables', {})
    print(f"   HOLIDAYS_TABLE: {env_vars.get('HOLIDAYS_TABLE', 'NOT SET')}")
    print(f"   DAX_ENDPOINT: {env_vars.get('DAX_ENDPOINT', 'NOT SET')}")
    print(f"   USE_DAX: {env_vars.get('USE_DAX', 'NOT SET')}")

# Test 3: Invoke Lambda directly
print("\n3️⃣ Direct Lambda Invocation:")
lambda_client = boto3.client('lambda', region_name='ap-south-1')

test_event = {
    "queryStringParameters": {
        "country": "AU",
        "year": "2025"
    },
    "headers": {},
    "requestContext": {
        "authorizer": {
            "tier": "free"
        }
    }
}

try:
    response = lambda_client.invoke(
        FunctionName='almanac-api-dev-holidays',
        InvocationType='RequestResponse',
        Payload=json.dumps(test_event)
    )
    
    result = json.loads(response['Payload'].read())
    print(f"   Status code: {result.get('statusCode', 'N/A')}")
    
    if result.get('body'):
        body = json.loads(result['body'])
        data = body.get('data', [])
        print(f"   Holidays returned: {len(data)}")
        
        if len(data) == 0:
            print("   ⚠️  Lambda returned 0 holidays - checking for errors...")
            print(f"   Full response: {json.dumps(body, indent=2)}")
    else:
        print(f"   Error: {result}")
        
except Exception as e:
    print(f"   ❌ Lambda invocation failed: {e}")

# Test 4: Check CloudWatch logs
print("\n4️⃣ Recent Lambda Logs:")
logs_client = boto3.client('logs', region_name='ap-south-1')

try:
    # Get recent log streams
    streams = logs_client.describe_log_streams(
        logGroupName='/aws/lambda/almanac-api-dev-holidays',
        orderBy='LastEventTime',
        descending=True,
        limit=1
    )
    
    if streams['logStreams']:
        stream_name = streams['logStreams'][0]['logStreamName']
        
        # Get recent events
        events = logs_client.get_log_events(
            logGroupName='/aws/lambda/almanac-api-dev-holidays',
            logStreamName=stream_name,
            limit=10
        )
        
        print("   Recent log entries:")
        for event in events['events'][-5:]:
            message = event['message'].strip()
            if 'ERROR' in message or 'error' in message or 'PK' in message:
                print(f"   {message}")
                
except Exception as e:
    print(f"   Could not fetch logs: {e}")

print("\n✅ Test complete!")