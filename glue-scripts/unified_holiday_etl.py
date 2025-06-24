import sys
import json
import boto3
import hashlib
from datetime import datetime, timedelta
from typing import Dict, List, Any, Set, Tuple
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit, when, udf, collect_set, first, array_distinct
from pyspark.sql.types import StringType, ArrayType, BooleanType, StructType, StructField
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError
import requests
from decimal import Decimal

# Get job parameters
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'RAW_BUCKET',
    'STAGING_BUCKET',
    'VALIDATED_BUCKET',
    'HOLIDAYS_TABLE',
    'ETL_METADATA_TABLE'
])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# Initialize clients
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
ssm = boto3.client('ssm')
cloudwatch = boto3.client('cloudwatch')

# Tables
holidays_table = dynamodb.Table(args['HOLIDAYS_TABLE'])
metadata_table = dynamodb.Table(args.get('ETL_METADATA_TABLE', 'almanac-etl-metadata'))

# Australian state codes
AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']

# National holidays that should have regions: ['ALL']
NATIONAL_HOLIDAYS = [
    "New Year's Day",
    "Australia Day",
    "Good Friday",
    "Easter Saturday",
    "Easter Monday",
    "Anzac Day",
    "Queen's Birthday",
    "Christmas Day",
    "Boxing Day"
]

class UnifiedHolidayETL:
    """Unified ETL processor with built-in deduplication and idempotency"""
    
    def __init__(self):
        self.etl_run_id = self.generate_run_id()
        self.processed_items = set()
        self.metrics = {
            'extracted': 0,
            'transformed': 0,
            'duplicates_found': 0,
            'duplicates_prevented': 0,
            'new_records': 0,
            'updated_records': 0,
            'errors': 0
        }
        
    def generate_run_id(self) -> str:
        """Generate unique ETL run ID"""
        timestamp = datetime.utcnow().isoformat()
        return f"holiday-etl-{timestamp}-{hashlib.md5(timestamp.encode()).hexdigest()[:8]}"
    
    def get_existing_holidays(self, year: int) -> Dict[str, Any]:
        """Fetch existing holidays from DynamoDB for comparison"""
        existing = {}
        
        try:
            response = holidays_table.query(
                KeyConditionExpression=Key('PK').eq(f'COUNTRY#AU#{year}')
            )
            
            for item in response.get('Items', []):
                # Create composite key for deduplication
                regions_key = ','.join(sorted(item.get('regions', [])))
                composite_key = f"{item['date']}|{item['name']}|{regions_key}"
                existing[composite_key] = item
                
            # Handle pagination
            while 'LastEvaluatedKey' in response:
                response = holidays_table.query(
                    KeyConditionExpression=Key('PK').eq(f'COUNTRY#AU#{year}'),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                for item in response.get('Items', []):
                    regions_key = ','.join(sorted(item.get('regions', [])))
                    composite_key = f"{item['date']}|{item['name']}|{regions_key}"
                    existing[composite_key] = item
                    
        except Exception as e:
            print(f"Error fetching existing holidays: {e}")
            
        return existing
    
    def should_consolidate_to_national(self, holiday_name: str, regions: List[str]) -> bool:
        """Determine if holiday should be consolidated to national level"""
        if holiday_name in NATIONAL_HOLIDAYS:
            # If we have records for 6+ states, it's national
            state_coverage = len([r for r in regions if r in AU_STATES])
            return state_coverage >= 6
        return False
    
    def extract_from_sources(self) -> List[Dict[str, Any]]:
        """Extract from all configured sources"""
        all_holidays = []
        
        # Get data source configuration from SSM
        try:
            sources_param = ssm.get_parameter(Name='/almanac/unified-data-sources/config')
            sources = json.loads(sources_param['Parameter']['Value'])
        except:
            sources = self.get_default_sources()
        
        # Extract from each source
        for source_type, source_config in sources.items():
            if source_type == 'national':
                holidays = self.extract_national_holidays(source_config)
                all_holidays.extend(holidays)
            elif source_type == 'states':
                holidays = self.extract_state_holidays(source_config)
                all_holidays.extend(holidays)
                
        self.metrics['extracted'] = len(all_holidays)
        return all_holidays
    
    def extract_national_holidays(self, sources: Dict[str, str]) -> List[Dict[str, Any]]:
        """Extract national holiday data"""
        holidays = []
        
        for year, url in sources.items():
            try:
                response = requests.get(url, timeout=30)
                if response.status_code == 200:
                    # Parse CSV data
                    lines = response.text.strip().split('\n')
                    headers = lines[0].split(',')
                    
                    for line in lines[1:]:
                        values = line.split(',')
                        if len(values) >= 3:
                            holiday = {
                                'date': values[0].strip(),
                                'name': values[1].strip().strip('"'),
                                'jurisdiction': values[2].strip() if len(values) > 2 else 'national',
                                'type': 'public',
                                'source': url,
                                'year': year
                            }
                            holidays.append(holiday)
                            
            except Exception as e:
                print(f"Error extracting from {url}: {e}")
                self.metrics['errors'] += 1
                
        return holidays
    
    def extract_state_holidays(self, sources: Dict[str, str]) -> List[Dict[str, Any]]:
        """Extract state-specific holiday data"""
        holidays = []
        
        for state, url in sources.items():
            try:
                response = requests.get(url, timeout=30)
                if response.status_code == 200:
                    # Parse state-specific data
                    # Implementation depends on state data format
                    pass
            except Exception as e:
                print(f"Error extracting {state} holidays: {e}")
                self.metrics['errors'] += 1
                
        return holidays
    
    def transform_and_deduplicate(self, raw_holidays: List[Dict[str, Any]]) -> pd.DataFrame:
        """Transform and deduplicate holiday data"""
        import pandas as pd
        
        # Convert to DataFrame for easier processing
        df = pd.DataFrame(raw_holidays)
        
        # Parse dates
        df['date_parsed'] = pd.to_datetime(df['date'], errors='coerce')
        df = df.dropna(subset=['date_parsed'])
        
        # Normalize holiday names
        df['name_normalized'] = df['name'].apply(self.normalize_holiday_name)
        
        # Determine regions for each holiday
        df['regions'] = df.apply(self.determine_regions, axis=1)
        
        # Group by date and normalized name to consolidate regions
        consolidated = []
        for (date, name), group in df.groupby(['date_parsed', 'name_normalized']):
            all_regions = set()
            for _, row in group.iterrows():
                all_regions.update(row['regions'])
            
            # Check if this should be a national holiday
            if self.should_consolidate_to_national(name, list(all_regions)):
                regions = ['ALL']
            else:
                regions = sorted(list(all_regions))
            
            holiday = {
                'date': date.strftime('%Y-%m-%d'),
                'name': name,
                'type': 'public',
                'country': 'AU',
                'country_name': 'Australia',
                'year': date.year,
                'month': date.month,
                'day': date.day,
                'day_of_week': date.strftime('%A'),
                'is_weekend': date.weekday() >= 5,
                'is_fixed': True,
                'regions': regions,
                'etl_run_id': self.etl_run_id,
                'last_updated': datetime.utcnow().isoformat()
            }
            consolidated.append(holiday)
        
        self.metrics['transformed'] = len(consolidated)
        return pd.DataFrame(consolidated)
    
    def normalize_holiday_name(self, name: str) -> str:
        """Normalize holiday names for consistency"""
        name_mapping = {
            "ANZAC Day": "Anzac Day",
            "Queen's Birthday": "Queen's Birthday",
            "New Years Day": "New Year's Day",
            "Australia Day Holiday": "Australia Day",
            "Christmas Day Holiday": "Christmas Day",
            "Boxing Day Holiday": "Boxing Day"
        }
        return name_mapping.get(name, name)
    
    def determine_regions(self, row) -> List[str]:
        """Determine regions for a holiday"""
        jurisdiction = row.get('jurisdiction', '').upper()
        
        if jurisdiction in ['NATIONAL', 'FEDERAL', 'COMMONWEALTH', 'ALL']:
            return ['ALL']
        elif jurisdiction in AU_STATES:
            return [jurisdiction]
        else:
            # Try to infer from holiday name
            name = row.get('name', '')
            if 'Melbourne Cup' in name:
                return ['VIC']
            elif 'Bank Holiday' in name and 'NSW' in str(row.get('source', '')):
                return ['NSW']
            else:
                return ['ALL']
    
    def load_with_deduplication(self, df: pd.DataFrame) -> Dict[str, int]:
        """Load data to DynamoDB with deduplication and conditional writes"""
        results = {
            'new': 0,
            'updated': 0,
            'skipped': 0,
            'errors': 0
        }
        
        # Get existing holidays for all years in the dataset
        years = df['year'].unique()
        existing_holidays = {}
        for year in years:
            existing_holidays.update(self.get_existing_holidays(int(year)))
        
        # Process each holiday
        for _, holiday in df.iterrows():
            try:
                # Create composite key
                regions_key = ','.join(sorted(holiday['regions']))
                composite_key = f"{holiday['date']}|{holiday['name']}|{regions_key}"
                
                # Check if already exists
                existing = existing_holidays.get(composite_key)
                
                # Prepare DynamoDB item
                item = {
                    'PK': f"COUNTRY#AU#{holiday['year']}",
                    'SK': f"HOLIDAY#{holiday['date']}#{holiday['name'].replace(' ', '_')}#{regions_key.replace(',', '_')}",
                    'GSI1PK': f"YEAR#{holiday['year']}",
                    'GSI1SK': f"DATE#{holiday['date']}",
                    **holiday
                }
                
                # Convert lists to DynamoDB format
                item['regions'] = holiday['regions']
                
                if existing:
                    # Check if update needed
                    if self.needs_update(existing, item):
                        # Update with version check
                        item['version'] = existing.get('version', 0) + 1
                        item['previous_etl_run_id'] = existing.get('etl_run_id')
                        
                        holidays_table.put_item(
                            Item=item,
                            ConditionExpression=Attr('version').eq(existing.get('version', 0))
                        )
                        results['updated'] += 1
                    else:
                        results['skipped'] += 1
                        self.metrics['duplicates_found'] += 1
                else:
                    # New item - conditional write to prevent race conditions
                    item['version'] = 1
                    
                    holidays_table.put_item(
                        Item=item,
                        ConditionExpression='attribute_not_exists(PK) AND attribute_not_exists(SK)'
                    )
                    results['new'] += 1
                    
            except ClientError as e:
                if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                    # Another process already wrote this item
                    results['skipped'] += 1
                    self.metrics['duplicates_prevented'] += 1
                else:
                    print(f"Error loading holiday: {e}")
                    results['errors'] += 1
                    self.metrics['errors'] += 1
            except Exception as e:
                print(f"Unexpected error: {e}")
                results['errors'] += 1
                self.metrics['errors'] += 1
        
        self.metrics['new_records'] = results['new']
        self.metrics['updated_records'] = results['updated']
        
        return results
    
    def needs_update(self, existing: Dict[str, Any], new: Dict[str, Any]) -> bool:
        """Check if existing record needs update"""
        # Compare key fields
        fields_to_check = ['name', 'type', 'regions', 'is_fixed']
        
        for field in fields_to_check:
            if existing.get(field) != new.get(field):
                return True
                
        return False
    
    def record_etl_metadata(self):
        """Record ETL run metadata for auditing"""
        try:
            metadata_table.put_item(
                Item={
                    'PK': 'ETL_RUN',
                    'SK': self.etl_run_id,
                    'run_type': 'holiday_etl',
                    'start_time': job.init_timestamp,
                    'end_time': datetime.utcnow().isoformat(),
                    'metrics': self.metrics,
                    'status': 'completed',
                    'data_sources': 'unified'
                }
            )
        except Exception as e:
            print(f"Error recording metadata: {e}")
    
    def send_metrics_to_cloudwatch(self):
        """Send ETL metrics to CloudWatch"""
        try:
            cloudwatch.put_metric_data(
                Namespace='AlmanacAPI/ETL',
                MetricData=[
                    {
                        'MetricName': 'RecordsExtracted',
                        'Value': self.metrics['extracted'],
                        'Unit': 'Count',
                        'Dimensions': [{'Name': 'ETLType', 'Value': 'holidays'}]
                    },
                    {
                        'MetricName': 'NewRecords',
                        'Value': self.metrics['new_records'],
                        'Unit': 'Count',
                        'Dimensions': [{'Name': 'ETLType', 'Value': 'holidays'}]
                    },
                    {
                        'MetricName': 'DuplicatesPrevented',
                        'Value': self.metrics['duplicates_prevented'],
                        'Unit': 'Count',
                        'Dimensions': [{'Name': 'ETLType', 'Value': 'holidays'}]
                    },
                    {
                        'MetricName': 'ETLErrors',
                        'Value': self.metrics['errors'],
                        'Unit': 'Count',
                        'Dimensions': [{'Name': 'ETLType', 'Value': 'holidays'}]
                    }
                ]
            )
        except Exception as e:
            print(f"Error sending metrics: {e}")
    
    def get_default_sources(self) -> Dict[str, Any]:
        """Default data sources if SSM parameter not found"""
        return {
            'national': {
                '2024': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/9e920340-0744-4031-a497-98ab796633e8/download/australian_public_holidays_2024.csv',
                '2025': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/4d4d744b-50ed-45b9-ae77-760bc478ad75/download/australian_public_holidays_2025.csv',
            }
        }

# Main execution
if __name__ == "__main__":
    etl = UnifiedHolidayETL()
    
    try:
        print(f"Starting unified holiday ETL run: {etl.etl_run_id}")
        
        # Extract
        raw_holidays = etl.extract_from_sources()
        print(f"Extracted {len(raw_holidays)} raw holiday records")
        
        # Transform and deduplicate
        transformed_df = etl.transform_and_deduplicate(raw_holidays)
        print(f"Transformed to {len(transformed_df)} unique holiday records")
        
        # Load with deduplication
        load_results = etl.load_with_deduplication(transformed_df)
        print(f"Load results: {json.dumps(load_results, indent=2)}")
        
        # Record metadata and metrics
        etl.record_etl_metadata()
        etl.send_metrics_to_cloudwatch()
        
        print(f"ETL completed successfully. Metrics: {json.dumps(etl.metrics, indent=2)}")
        
    except Exception as e:
        print(f"ETL failed: {e}")
        raise
    finally:
        job.commit()