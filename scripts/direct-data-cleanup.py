#!/usr/bin/env python3
"""
Direct data cleanup script for Australian holidays
Run this to fix data quality issues immediately
"""

import boto3
import json
from datetime import datetime
from collections import defaultdict

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table = dynamodb.Table('almanac-api-dev-holidays')

# Constants
VALID_REGIONS = {'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'ALL'}
NATIONAL_HOLIDAYS = {
    "New Year's Day",
    "Australia Day", 
    "Good Friday",
    "Easter Saturday",
    "Easter Monday",
    "Anzac Day",
    "Christmas Day",
    "Boxing Day"
}

def analyze_data():
    """Analyze current data quality issues"""
    print("🔍 Analyzing Australian holiday data...")
    
    # Scan all Australian holidays
    holidays = []
    last_key = None
    
    while True:
        if last_key:
            response = table.scan(
                FilterExpression='country = :country',
                ExpressionAttributeValues={':country': 'AU'},
                ExclusiveStartKey=last_key
            )
        else:
            response = table.scan(
                FilterExpression='country = :country',
                ExpressionAttributeValues={':country': 'AU'}
            )
            
        holidays.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        
        if not last_key:
            break
    
    print(f"✅ Found {len(holidays)} Australian holidays")
    
    # Analyze issues
    issues = {
        'lowercase_regions': 0,
        'missing_data_source': 0,
        'potential_duplicates': defaultdict(list)
    }
    
    for holiday in holidays:
        # Check for lowercase regions
        regions = holiday.get('regions', [])
        if any(r != 'ALL' and r != r.upper() for r in regions):
            issues['lowercase_regions'] += 1
            
        # Check for missing data_source
        if 'data_source' not in holiday:
            issues['missing_data_source'] += 1
            
        # Check for potential duplicates
        if holiday['name'] in NATIONAL_HOLIDAYS:
            key = f"{holiday['date']}_{holiday['name']}"
            issues['potential_duplicates'][key].append({
                'regions': regions,
                'pk': holiday['PK'],
                'sk': holiday['SK']
            })
    
    # Count actual duplicates
    duplicate_count = sum(1 for records in issues['potential_duplicates'].values() 
                         if len(records) > 1)
    
    print(f"\n📊 Data Quality Issues Found:")
    print(f"  - Lowercase regions: {issues['lowercase_regions']} records")
    print(f"  - Missing data_source: {issues['missing_data_source']} records")
    print(f"  - Potential duplicate national holidays: {duplicate_count} holidays")
    
    return holidays, issues

def fix_region_case(holidays):
    """Fix lowercase region codes"""
    print("\n🔧 Fixing region case inconsistencies...")
    
    fixed = 0
    with table.batch_writer() as batch:
        for holiday in holidays:
            regions = holiday.get('regions', [])
            needs_fix = False
            
            # Convert to uppercase
            new_regions = []
            for region in regions:
                if region != 'ALL' and region != region.upper():
                    new_regions.append(region.upper())
                    needs_fix = True
                else:
                    new_regions.append(region)
                    
            if needs_fix:
                holiday['regions'] = new_regions
                holiday['last_updated'] = datetime.utcnow().isoformat()
                holiday['updated_by'] = 'direct-cleanup-script'
                
                batch.put_item(Item=holiday)
                fixed += 1
                
                if fixed % 25 == 0:
                    print(f"  Fixed {fixed} records...")
    
    print(f"✅ Fixed {fixed} region case issues")
    return fixed

def add_data_source(holidays):
    """Add missing data_source field"""
    print("\n🔧 Adding missing data_source metadata...")
    
    updated = 0
    with table.batch_writer() as batch:
        for holiday in holidays:
            if 'data_source' not in holiday:
                # Infer data source
                if holiday.get('regions', [])[0:1] == ['ALL']:
                    holiday['data_source'] = 'government_api'
                elif 'last_updated' in holiday:
                    holiday['data_source'] = 'government_api'
                else:
                    holiday['data_source'] = 'legacy_import'
                
                holiday['last_updated'] = datetime.utcnow().isoformat()
                
                batch.put_item(Item=holiday)
                updated += 1
                
                if updated % 25 == 0:
                    print(f"  Updated {updated} records...")
    
    print(f"✅ Added data_source to {updated} records")
    return updated

def main():
    """Main cleanup process"""
    print("🚀 Australian Holiday Data Cleanup")
    print("=" * 50)
    
    # Analyze current state
    holidays, issues = analyze_data()
    
    # Ask for confirmation
    print("\n⚠️  This will modify production data!")
    response = input("Do you want to proceed with cleanup? (yes/no): ")
    
    if response.lower() != 'yes':
        print("❌ Cleanup cancelled")
        return
    
    print("\n🏗️  Starting cleanup process...")
    
    # Fix issues
    case_fixes = fix_region_case(holidays)
    metadata_added = add_data_source(holidays)
    
    # Note: Not consolidating duplicates in this script since some are already consolidated
    
    print("\n✨ Cleanup Complete!")
    print(f"  - Fixed {case_fixes} region case issues")
    print(f"  - Added metadata to {metadata_added} records")
    
    # Re-scan to verify
    print("\n🔍 Verifying cleanup...")
    holidays, new_issues = analyze_data()
    
    print("\n📈 Final Status:")
    print(f"  - Total records: {len(holidays)}")
    print(f"  - Remaining lowercase regions: {new_issues['lowercase_regions']}")
    print(f"  - Remaining missing data_source: {new_issues['missing_data_source']}")

if __name__ == '__main__':
    main()