"""
Australian Holiday Data Cleanup Lambda
Fixes the data quality disaster in production

Author: Senior Cloud Architect
Purpose: One-time cleanup + ongoing data quality enforcement
"""

import os
import json
import boto3
from datetime import datetime
from typing import Dict, List, Set, Tuple, Any
from collections import defaultdict
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

# Initialize AWS services
logger = Logger()
tracer = Tracer()
metrics = Metrics()

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['HOLIDAYS_TABLE'])

# This is how you define data quality rules - explicitly
VALID_REGIONS = {'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'ALL'}
VALID_HOLIDAY_TYPES = {'public', 'bank', 'observance'}
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

class DataQualityError(Exception):
    """Raised when data doesn't meet our quality standards"""
    pass

@tracer.capture_method
def scan_all_australian_holidays() -> List[Dict[str, Any]]:
    """Scan all Australian holidays from DynamoDB"""
    logger.info("Starting full table scan for Australian holidays")
    
    holidays = []
    last_evaluated_key = None
    scan_count = 0
    
    while True:
        scan_params = {
            'FilterExpression': 'country = :country',
            'ExpressionAttributeValues': {':country': 'AU'}
        }
        
        if last_evaluated_key:
            scan_params['ExclusiveStartKey'] = last_evaluated_key
            
        response = table.scan(**scan_params)
        holidays.extend(response.get('Items', []))
        scan_count += 1
        
        last_evaluated_key = response.get('LastEvaluatedKey')
        if not last_evaluated_key:
            break
            
    logger.info(f"Scanned {len(holidays)} Australian holidays in {scan_count} requests")
    metrics.add_metric(name="HolidaysScanned", unit=MetricUnit.Count, value=len(holidays))
    
    return holidays

@tracer.capture_method
def analyze_data_quality(holidays: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Analyze data quality issues - this is what I should have done from day one"""
    
    issues = {
        'total_records': len(holidays),
        'duplicates': [],
        'case_inconsistencies': [],
        'missing_data_source': [],
        'invalid_regions': [],
        'national_holiday_duplication': defaultdict(list)
    }
    
    # Check for issues that should never exist in a professional system
    for holiday in holidays:
        # 1. Case inconsistency check
        regions = holiday.get('regions', [])
        for region in regions:
            if region != region.upper() and region != 'ALL':
                issues['case_inconsistencies'].append({
                    'pk': holiday['PK'],
                    'sk': holiday['SK'],
                    'regions': regions
                })
                
        # 2. Missing data source - this is basic data lineage
        if 'data_source' not in holiday:
            issues['missing_data_source'].append({
                'pk': holiday['PK'],
                'sk': holiday['SK']
            })
            
        # 3. Invalid regions - data validation 101
        invalid_regions = set(regions) - VALID_REGIONS
        if invalid_regions:
            issues['invalid_regions'].append({
                'pk': holiday['PK'],
                'sk': holiday['SK'],
                'invalid': list(invalid_regions)
            })
            
        # 4. National holiday duplication - the worst offense
        if holiday['name'] in NATIONAL_HOLIDAYS:
            key = f"{holiday['date']}_{holiday['name']}"
            issues['national_holiday_duplication'][key].append({
                'pk': holiday['PK'],
                'sk': holiday['SK'],
                'regions': regions
            })
    
    # Find actual duplicates (should be 1 record per state for national holidays)
    for key, records in issues['national_holiday_duplication'].items():
        if len(records) > 1:
            # Check if we have individual state records instead of one ALL record
            all_regions = set()
            for record in records:
                all_regions.update(record['regions'])
            
            if len(all_regions) >= 6 and 'ALL' not in all_regions:
                issues['duplicates'].append({
                    'holiday': key,
                    'count': len(records),
                    'regions_covered': sorted(list(all_regions))
                })
    
    return issues

@tracer.capture_method
def fix_case_inconsistencies(holidays: List[Dict[str, Any]]) -> int:
    """Fix region case inconsistencies - should be uppercase"""
    
    fixed_count = 0
    
    with table.batch_writer() as batch:
        for holiday in holidays:
            regions = holiday.get('regions', [])
            needs_fix = False
            
            # Check if any region is lowercase
            for i, region in enumerate(regions):
                if region != 'ALL' and region != region.upper():
                    regions[i] = region.upper()
                    needs_fix = True
                    
            if needs_fix:
                holiday['regions'] = regions
                holiday['last_updated'] = datetime.utcnow().isoformat()
                holiday['updated_by'] = 'data-cleanup-lambda'
                
                batch.put_item(Item=holiday)
                fixed_count += 1
                
                if fixed_count % 25 == 0:
                    logger.info(f"Fixed {fixed_count} case inconsistencies...")
                    
    logger.info(f"Fixed {fixed_count} total case inconsistencies")
    metrics.add_metric(name="CaseInconsistenciesFixed", unit=MetricUnit.Count, value=fixed_count)
    
    return fixed_count

@tracer.capture_method
def consolidate_national_holidays(holidays: List[Dict[str, Any]]) -> int:
    """Consolidate national holidays - one record with regions: ['ALL'] instead of 8 records"""
    
    # Group holidays by date and name
    holiday_groups = defaultdict(list)
    
    for holiday in holidays:
        if holiday['name'] in NATIONAL_HOLIDAYS:
            key = f"{holiday['date']}_{holiday['name']}"
            holiday_groups[key].append(holiday)
    
    consolidated_count = 0
    
    with table.batch_writer() as batch:
        for key, group in holiday_groups.items():
            if len(group) > 1:
                # Collect all regions
                all_regions = set()
                for record in group:
                    all_regions.update(record.get('regions', []))
                
                # If this covers most states, it's a national holiday
                if len(all_regions) >= 6:
                    # Create consolidated record
                    consolidated = group[0].copy()  # Use first record as template
                    consolidated['regions'] = ['ALL']
                    consolidated['data_source'] = 'consolidated_from_duplicates'
                    consolidated['last_updated'] = datetime.utcnow().isoformat()
                    consolidated['updated_by'] = 'data-cleanup-lambda'
                    consolidated['original_regions'] = sorted(list(all_regions))
                    
                    # Update the sort key to ensure uniqueness
                    consolidated['SK'] = f"HOLIDAY#{consolidated['date']}#{consolidated['name'].replace(' ', '_')}"
                    
                    # Delete old records
                    for record in group:
                        batch.delete_item(
                            Key={
                                'PK': record['PK'],
                                'SK': record['SK']
                            }
                        )
                    
                    # Add consolidated record
                    batch.put_item(Item=consolidated)
                    consolidated_count += 1
                    
                    logger.info(f"Consolidated {holiday['name']} on {holiday['date']} from {len(group)} records")
    
    metrics.add_metric(name="HolidaysConsolidated", unit=MetricUnit.Count, value=consolidated_count)
    
    return consolidated_count

@tracer.capture_method
def add_missing_metadata(holidays: List[Dict[str, Any]]) -> int:
    """Add missing data_source and other metadata"""
    
    updated_count = 0
    
    with table.batch_writer() as batch:
        for holiday in holidays:
            needs_update = False
            
            # Add data_source if missing
            if 'data_source' not in holiday:
                # Infer based on data patterns
                if holiday.get('year', 0) <= 2023:
                    holiday['data_source'] = 'legacy_import'
                elif 'last_updated' in holiday:
                    holiday['data_source'] = 'government_api'
                else:
                    holiday['data_source'] = 'manual_entry'
                    
                needs_update = True
                
            # Ensure all records have last_updated
            if 'last_updated' not in holiday:
                holiday['last_updated'] = datetime.utcnow().isoformat()
                holiday['updated_by'] = 'data-cleanup-lambda'
                needs_update = True
                
            if needs_update:
                batch.put_item(Item=holiday)
                updated_count += 1
                
    metrics.add_metric(name="MetadataAdded", unit=MetricUnit.Count, value=updated_count)
    
    return updated_count

@tracer.capture_method
def generate_cleanup_report(before_issues: Dict[str, Any], actions_taken: Dict[str, int]) -> Dict[str, Any]:
    """Generate a detailed cleanup report - always document your data fixes"""
    
    report = {
        'timestamp': datetime.utcnow().isoformat(),
        'executed_by': 'data-cleanup-lambda',
        'before_state': {
            'total_records': before_issues['total_records'],
            'case_inconsistencies': len(before_issues['case_inconsistencies']),
            'missing_data_source': len(before_issues['missing_data_source']),
            'invalid_regions': len(before_issues['invalid_regions']),
            'duplicate_national_holidays': len(before_issues['duplicates'])
        },
        'actions_taken': actions_taken,
        'estimated_records_after': before_issues['total_records'] - (actions_taken.get('holidays_consolidated', 0) * 7),
        'data_quality_improvement': 'Significant - standardized regions, consolidated duplicates, added metadata'
    }
    
    return report

@logger.inject_lambda_context(correlation_id_path="requestContext.requestId")
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def handler(event, context):
    """
    Main handler - fixes the data quality mess
    This should run as a one-time cleanup, then be converted to ongoing validation
    """
    
    try:
        # Step 1: Scan all holidays
        holidays = scan_all_australian_holidays()
        
        # Step 2: Analyze data quality issues
        issues = analyze_data_quality(holidays)
        logger.info(f"Data quality analysis complete", extra={'issues_summary': {
            'case_inconsistencies': len(issues['case_inconsistencies']),
            'missing_data_source': len(issues['missing_data_source']),
            'duplicates': len(issues['duplicates'])
        }})
        
        # Step 3: Fix issues (only if not a dry run)
        if not event.get('dry_run', False):
            actions_taken = {}
            
            # Fix case inconsistencies
            actions_taken['case_fixes'] = fix_case_inconsistencies(holidays)
            
            # Consolidate national holidays
            actions_taken['holidays_consolidated'] = consolidate_national_holidays(holidays)
            
            # Add missing metadata
            actions_taken['metadata_added'] = add_missing_metadata(holidays)
            
            # Generate report
            report = generate_cleanup_report(issues, actions_taken)
            
            logger.info("Data cleanup completed successfully", extra={'report': report})
            
            # Store report in DynamoDB for audit trail
            table.put_item(Item={
                'PK': 'CLEANUP_REPORT',
                'SK': f"REPORT#{datetime.utcnow().isoformat()}",
                'report': report,
                'type': 'data_cleanup'
            })
            
            return {
                'statusCode': 200,
                'body': json.dumps(report),
                'message': 'Data cleanup completed successfully'
            }
            
        else:
            # Dry run - just return analysis
            return {
                'statusCode': 200,
                'body': json.dumps(issues),
                'message': 'Dry run analysis complete',
                'action': 'No changes made - set dry_run=false to execute cleanup'
            }
            
    except Exception as e:
        logger.error(f"Data cleanup failed: {str(e)}")
        metrics.add_metric(name="DataCleanupError", unit=MetricUnit.Count, value=1)
        raise

# This is how you build production systems - with data quality built in from day one