"""
Government Data Fetcher Lambda Function
Serverless implementation for fetching Australian holiday data
"""

import json
import boto3
import urllib.request
import ssl
import csv
from io import StringIO
from datetime import datetime
from typing import Dict, List, Any, Optional
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

# Initialize AWS services
logger = Logger()
tracer = Tracer()
metrics = Metrics()
ssm = boto3.client('ssm')
dynamodb = boto3.resource('dynamodb')

class GovernmentDataFetcher:
    """Fetches holiday data from government sources using SSM parameters"""
    
    def __init__(self):
        # Get configuration from SSM Parameter Store
        self.config = self._load_config_from_ssm()
        self.ssl_context = self._create_ssl_context()
        self.table = dynamodb.Table(os.environ['HOLIDAYS_TABLE'])
        
    @tracer.capture_method
    def _load_config_from_ssm(self) -> Dict[str, Any]:
        """Load data source configuration from SSM Parameter Store"""
        try:
            response = ssm.get_parameter(
                Name='/almanac/data-sources/config',
                WithDecryption=True
            )
            return json.loads(response['Parameter']['Value'])
        except Exception as e:
            logger.error(f"Failed to load config from SSM: {str(e)}")
            # Fallback to environment variables
            return {
                'national': {
                    '2024': os.environ.get('DATA_GOV_AU_2024'),
                    '2025': os.environ.get('DATA_GOV_AU_2025')
                },
                'states': {
                    'nsw': os.environ.get('NSW_TRANSPORT_API'),
                    'vic': os.environ.get('VIC_GOV_API')
                }
            }
    
    def _create_ssl_context(self) -> ssl.SSLContext:
        """Create SSL context for government sites"""
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context
    
    @tracer.capture_method
    def fetch_url(self, url: str) -> str:
        """Fetch content from URL with retry logic"""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'AWS-Lambda-AlmanacAPI/1.0'
                })
                response = urllib.request.urlopen(req, context=self.ssl_context, timeout=30)
                content = response.read().decode('utf-8')
                
                metrics.add_metric(name="DataFetchSuccess", unit=MetricUnit.Count, value=1)
                metrics.add_metadata(key="source", value=url)
                
                return content
            except Exception as e:
                logger.warning(f"Attempt {attempt + 1} failed for {url}: {str(e)}")
                if attempt == max_retries - 1:
                    metrics.add_metric(name="DataFetchError", unit=MetricUnit.Count, value=1)
                    raise
                    
    @tracer.capture_method
    def parse_national_csv(self, csv_content: str, year: str) -> List[Dict[str, Any]]:
        """Parse national holiday CSV from data.gov.au"""
        holidays = []
        csv_reader = csv.DictReader(StringIO(csv_content))
        
        for row in csv_reader:
            try:
                # Skip empty dates
                if not row.get('Date'):
                    continue
                    
                date_obj = datetime.strptime(row['Date'], '%Y%m%d')
                jurisdiction = row.get('Jurisdiction', '').strip().upper()
                
                # Map jurisdictions
                regions = ['ALL'] if jurisdiction == 'NAT' else [jurisdiction]
                
                holiday = {
                    'date': date_obj.strftime('%Y-%m-%d'),
                    'name': row.get('Holiday Name', '').strip(),
                    'type': 'public',
                    'country': 'AU',
                    'country_name': 'Australia',
                    'year': int(year),
                    'month': date_obj.month,
                    'day': date_obj.day,
                    'day_of_week': date_obj.strftime('%A'),
                    'is_weekend': date_obj.weekday() >= 5,
                    'is_fixed': True,
                    'regions': regions,
                    'data_source': 'data.gov.au',
                    'last_updated': datetime.utcnow().isoformat()
                }
                
                holidays.append(holiday)
                
            except Exception as e:
                logger.warning(f"Error parsing row: {str(e)}", extra={"row": row})
                
        return holidays
    
    @tracer.capture_method
    def parse_state_csv(self, csv_content: str, state: str) -> List[Dict[str, Any]]:
        """Generic state CSV parser with flexible field detection"""
        holidays = []
        csv_reader = csv.DictReader(StringIO(csv_content))
        
        # Detect column names
        first_row = next(csv_reader, None)
        if not first_row:
            return holidays
            
        # Find date and name columns
        date_col = next((col for col in first_row.keys() 
                        if col.lower() in ['date', 'day', 'holiday_date']), None)
        name_col = next((col for col in first_row.keys() 
                        if col.lower() in ['name', 'holiday', 'significance', 'holiday_name']), None)
        
        if not date_col or not name_col:
            logger.error(f"Could not find date/name columns for {state}")
            return holidays
            
        # Reset reader
        csv_reader = csv.DictReader(StringIO(csv_content))
        
        for row in csv_reader:
            try:
                date_str = row.get(date_col, '').strip()
                holiday_name = row.get(name_col, '').strip()
                
                if not date_str or not holiday_name:
                    continue
                    
                # Try multiple date formats
                date_obj = None
                for fmt in ['%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y', '%Y%m%d']:
                    try:
                        date_obj = datetime.strptime(date_str, fmt)
                        break
                    except:
                        continue
                        
                if not date_obj or date_obj.year < 2024:
                    continue
                    
                holiday = {
                    'date': date_obj.strftime('%Y-%m-%d'),
                    'name': holiday_name,
                    'type': 'public',
                    'country': 'AU',
                    'country_name': 'Australia',
                    'year': date_obj.year,
                    'month': date_obj.month,
                    'day': date_obj.day,
                    'day_of_week': date_obj.strftime('%A'),
                    'is_weekend': date_obj.weekday() >= 5,
                    'is_fixed': True,
                    'regions': [state.upper()],
                    'data_source': f'{state.lower()}_government',
                    'last_updated': datetime.utcnow().isoformat()
                }
                
                holidays.append(holiday)
                
            except Exception as e:
                logger.warning(f"Error parsing {state} row: {str(e)}")
                
        return holidays
    
    @tracer.capture_method
    def merge_and_deduplicate(self, all_holidays: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Merge holidays with state data taking priority"""
        holiday_map = {}
        
        # Sort by specificity - state data has priority
        all_holidays.sort(key=lambda h: (len(h['regions']), h['date']))
        
        for holiday in all_holidays:
            key = f"{holiday['date']}_{holiday['name'].lower().replace(' ', '_')}"
            
            # State-specific holidays override national ones
            if key not in holiday_map or len(holiday['regions']) == 1:
                holiday_map[key] = holiday
                
        return sorted(holiday_map.values(), key=lambda h: h['date'])
    
    @tracer.capture_method
    def fetch_all_holidays(self) -> Dict[str, Any]:
        """Fetch holidays from all configured sources"""
        all_holidays = []
        fetch_results = {
            'success': [],
            'failed': [],
            'total_fetched': 0
        }
        
        # Fetch national holidays
        for year, url in self.config.get('national', {}).items():
            if url:
                try:
                    logger.info(f"Fetching national holidays for {year}")
                    csv_content = self.fetch_url(url)
                    holidays = self.parse_national_csv(csv_content, year)
                    all_holidays.extend(holidays)
                    fetch_results['success'].append(f"National {year}: {len(holidays)} holidays")
                except Exception as e:
                    fetch_results['failed'].append(f"National {year}: {str(e)}")
                    
        # Fetch state holidays
        for state, url in self.config.get('states', {}).items():
            if url:
                try:
                    logger.info(f"Fetching {state.upper()} holidays")
                    csv_content = self.fetch_url(url)
                    holidays = self.parse_state_csv(csv_content, state)
                    all_holidays.extend(holidays)
                    fetch_results['success'].append(f"{state.upper()}: {len(holidays)} holidays")
                except Exception as e:
                    fetch_results['failed'].append(f"{state.upper()}: {str(e)}")
                    
        # Merge and deduplicate
        merged_holidays = self.merge_and_deduplicate(all_holidays)
        fetch_results['total_fetched'] = len(all_holidays)
        fetch_results['total_unique'] = len(merged_holidays)
        
        return {
            'holidays': merged_holidays,
            'fetch_results': fetch_results
        }
    
    @tracer.capture_method
    def load_to_dynamodb(self, holidays: List[Dict[str, Any]]) -> Dict[str, int]:
        """Load holidays to DynamoDB with batch processing"""
        success = 0
        failed = 0
        
        with self.table.batch_writer() as batch:
            for holiday in holidays:
                try:
                    item = {
                        'PK': f"COUNTRY#{holiday['country']}#{holiday['year']}",
                        'SK': f"HOLIDAY#{holiday['date']}#{holiday['name'].replace(' ', '_')}",
                        **holiday,
                        'GSI1PK': f"YEAR#{holiday['year']}",
                        'GSI1SK': f"DATE#{holiday['date']}"
                    }
                    
                    batch.put_item(Item=item)
                    success += 1
                    
                except Exception as e:
                    logger.error(f"Failed to load holiday: {str(e)}", extra={"holiday": holiday})
                    failed += 1
                    
        metrics.add_metric(name="HolidaysLoaded", unit=MetricUnit.Count, value=success)
        metrics.add_metric(name="HolidaysFailedToLoad", unit=MetricUnit.Count, value=failed)
        
        return {'success': success, 'failed': failed}

import os

@logger.inject_lambda_context(correlation_id_path="requestContext.requestId")
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def handler(event, context):
    """Lambda handler for government data fetching"""
    
    try:
        fetcher = GovernmentDataFetcher()
        
        # Fetch all holidays
        result = fetcher.fetch_all_holidays()
        holidays = result['holidays']
        
        # Filter for current and next year only
        current_year = datetime.now().year
        filtered_holidays = [
            h for h in holidays 
            if h['year'] in [current_year, current_year + 1]
        ]
        
        # Load to DynamoDB
        load_result = fetcher.load_to_dynamodb(filtered_holidays)
        
        # Prepare response
        response = {
            'statusCode': 200,
            'timestamp': datetime.utcnow().isoformat(),
            'fetch_summary': result['fetch_results'],
            'load_summary': load_result,
            'years_covered': sorted(set(h['year'] for h in filtered_holidays)),
            'regions_covered': sorted(set(r for h in filtered_holidays for r in h['regions']))
        }
        
        logger.info("Government data fetch completed", extra=response)
        
        # Send SNS notification if configured
        if 'SNS_TOPIC_ARN' in os.environ:
            sns = boto3.client('sns')
            sns.publish(
                TopicArn=os.environ['SNS_TOPIC_ARN'],
                Subject='Holiday Data Fetch Complete',
                Message=json.dumps(response, indent=2)
            )
        
        return response
        
    except Exception as e:
        logger.error(f"Failed to fetch government data: {str(e)}")
        metrics.add_metric(name="DataFetchCriticalError", unit=MetricUnit.Count, value=1)
        
        raise