#!/usr/bin/env python3
import boto3
import json
from datetime import datetime

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-holidays')

# Read the holiday data
with open('/root/Almanac-API/data/australia-holidays-2024-2025.json', 'r') as f:
    holidays = json.load(f)

# Process and insert each holiday
for holiday in holidays:
    # Parse the date
    date_obj = datetime.strptime(holiday['date'], '%Y-%m-%d')
    
    # Prepare the item
    item = {
        'PK': 'COUNTRY#AU',
        'SK': f"DATE#{holiday['date']}",
        'date': holiday['date'],
        'name': holiday['name'],
        'country': 'AU',
        'country_name': 'Australia',
        'type': holiday['type'],
        'year': date_obj.year,
        'month': date_obj.month,
        'day': date_obj.day,
        'day_of_week': date_obj.strftime('%A'),
        'is_weekend': date_obj.weekday() >= 5,
        'is_fixed': True,
        'regions': holiday.get('regions', ['ALL']),
        'processed_timestamp': datetime.now().isoformat()
    }
    
    # Insert into DynamoDB
    try:
        table.put_item(Item=item)
        print(f"Inserted: {holiday['date']} - {holiday['name']}")
    except Exception as e:
        print(f"Error inserting {holiday['date']}: {e}")

print("\nDone! All Australian holidays have been loaded.")