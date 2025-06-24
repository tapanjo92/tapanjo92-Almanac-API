#!/usr/bin/env python3
import boto3
import json
from datetime import datetime

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-holidays')

# Read the holiday data
import sys
file_path = sys.argv[1] if len(sys.argv) > 1 else '/root/Almanac-API/data/australia-holidays-2026.json'
with open(file_path, 'r') as f:
    holidays = json.load(f)

year = holidays[0]['date'][:4] if holidays else 'unknown'
print(f"Loading {len(holidays)} Australian holidays for {year}...")

# Process and insert each holiday
success_count = 0
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
    
    # Add note if present
    if 'note' in holiday:
        item['note'] = holiday['note']
    
    # Insert into DynamoDB
    try:
        table.put_item(Item=item)
        success_count += 1
        print(f"✓ Inserted: {holiday['date']} - {holiday['name']} ({', '.join(holiday['regions'])})")
    except Exception as e:
        print(f"✗ Error inserting {holiday['date']}: {e}")

print(f"\nDone! Successfully loaded {success_count} out of {len(holidays)} holidays for 2026.")