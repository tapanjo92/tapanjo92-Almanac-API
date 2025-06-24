#!/usr/bin/env python3
"""
Verify holiday data quality - Principal Architect verification
"""

import boto3
from boto3.dynamodb.conditions import Key
import json
from collections import defaultdict

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-holidays')

def verify_holidays():
    print("🔍 Verifying Australian Holiday Data Quality")
    print("=" * 60)
    
    # Check 2025 data specifically
    response = table.query(
        KeyConditionExpression=Key('PK').eq('COUNTRY#AU#2025')
    )
    
    holidays = response.get('Items', [])
    print(f"\n📊 2025 Holiday Analysis:")
    print(f"Total holidays: {len(holidays)}")
    
    # Analyze by type
    national_holidays = []
    state_holidays = defaultdict(list)
    
    for holiday in holidays:
        regions = holiday.get('regions', [])
        name = holiday.get('name', 'Unknown')
        date = holiday.get('date', 'Unknown')
        
        if 'ALL' in regions:
            national_holidays.append({
                'name': name,
                'date': date,
                'type': holiday.get('type')
            })
        else:
            for region in regions:
                state_holidays[region].append({
                    'name': name,
                    'date': date,
                    'type': holiday.get('type')
                })
    
    print(f"\n🌏 National Holidays ({len(national_holidays)}):")
    for h in sorted(national_holidays, key=lambda x: x['date']):
        print(f"  - {h['date']}: {h['name']} ({h['type']})")
    
    print(f"\n🏛️  State-Specific Holidays:")
    for state in sorted(state_holidays.keys()):
        print(f"\n{state} ({len(state_holidays[state])}):")
        for h in sorted(state_holidays[state], key=lambda x: x['date']):
            print(f"  - {h['date']}: {h['name']} ({h['type']})")
    
    # Check for duplicates
    print(f"\n🔄 Duplicate Check:")
    holiday_keys = defaultdict(int)
    for holiday in holidays:
        key = f"{holiday['date']}|{holiday['name']}"
        holiday_keys[key] += 1
    
    duplicates = {k: v for k, v in holiday_keys.items() if v > 1}
    if duplicates:
        print("  ⚠️  Found duplicates:")
        for key, count in duplicates.items():
            print(f"    - {key}: {count} instances")
    else:
        print("  ✅ No duplicates found!")
    
    # Sample record structure
    print(f"\n📄 Sample Record Structure:")
    if holidays:
        sample = holidays[0]
        print(json.dumps(sample, indent=2, default=str))

if __name__ == "__main__":
    verify_holidays()