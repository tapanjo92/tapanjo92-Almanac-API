"""
AWS Glue ETL Script for Australian Public Holidays
Fetches data from official government sources
"""

import sys
import json
import boto3
from datetime import datetime
from typing import Dict, List, Any
import urllib.request
import urllib.parse
import ssl
import csv
from io import StringIO
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.dynamicframe import DynamicFrame

# Initialize Glue context
args = getResolvedOptions(sys.argv, ['JOB_NAME', 'HOLIDAYS_TABLE', 'REGION'])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# AWS clients
dynamodb = boto3.resource('dynamodb', region_name=args['REGION'])
sns = boto3.client('sns', region_name=args['REGION'])

class GovernmentDataETL:
    """ETL for fetching Australian holiday data from government sources"""
    
    def __init__(self):
        # Create SSL context for government sites
        self.ssl_context = ssl.create_default_context()
        self.ssl_context.check_hostname = False
        self.ssl_context.verify_mode = ssl.CERT_NONE
        
        # Data sources
        self.sources = {
            'national': {
                '2024': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/9e920340-0744-4031-a497-98ab796633e8/download/australian_public_holidays_2024.csv',
                '2025': 'https://data.gov.au/data/dataset/b1bc6077-dadd-4f61-9f8c-002ab2cdff10/resource/4d4d744b-50ed-45b9-ae77-760bc478ad75/download/australian_public_holidays_2025.csv',
                '2026': None,  # Will need to check for updates
                '2027': None   # Will need to check for updates
            },
            'nsw': 'https://opendata.transport.nsw.gov.au/data/dataset/963e4946-46c0-4c9c-b4dc-5033c9e61f5c/resource/15c69970-8fa3-4fe3-ac35-0f3cbe10447e/download/public_holiday-2019-2023.csv',
            'vic': 'https://discover.data.vic.gov.au/dataset/a8bc540d-181b-4fb5-8110-5fe52a04f6a7/resource/5b5ffd01-6f6e-499e-9143-71767756567f/download/important-dates-2025.csv'
        }
        
        self.holidays_table = dynamodb.Table(args['HOLIDAYS_TABLE'])
        
    def fetch_url(self, url: str) -> str:
        """Fetch content from URL"""
        try:
            print(f"Fetching data from: {url}")
            req = urllib.request.Request(url, headers={'User-Agent': 'AWS-Glue-ETL/1.0'})
            response = urllib.request.urlopen(req, context=self.ssl_context)
            content = response.read().decode('utf-8')
            print(f"Successfully fetched {len(content)} bytes")
            return content
        except Exception as e:
            print(f"Error fetching {url}: {str(e)}")
            raise
            
    def parse_national_csv(self, csv_content: str, year: str) -> List[Dict[str, Any]]:
        """Parse the national CSV format from data.gov.au"""
        holidays = []
        csv_reader = csv.DictReader(StringIO(csv_content))
        
        for row in csv_reader:
            try:
                # Parse date (format: YYYYMMDD)
                date_str = row.get('Date', '')
                date_obj = datetime.strptime(date_str, '%Y%m%d')
                
                # Determine regions
                jurisdiction = row.get('Jurisdiction', '').strip()
                if jurisdiction == 'NAT':
                    regions = ['ALL']
                else:
                    # Direct mapping of jurisdiction codes
                    regions = [jurisdiction] if jurisdiction in ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] else []
                
                if not regions:
                    continue
                
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
                    'regions': regions
                }
                
                holidays.append(holiday)
                
            except Exception as e:
                print(f"Error parsing row: {row}, error: {str(e)}")
                continue
                
        return holidays
        
    def parse_nsw_csv(self, csv_content: str) -> List[Dict[str, Any]]:
        """Parse NSW Transport holiday CSV"""
        holidays = []
        csv_reader = csv.DictReader(StringIO(csv_content))
        
        for row in csv_reader:
            try:
                date_obj = datetime.strptime(row.get('date', ''), '%Y-%m-%d')
                
                # Only include future holidays
                if date_obj.year < 2024:
                    continue
                
                holiday = {
                    'date': row.get('date', ''),
                    'name': row.get('holidayName', '').strip(),
                    'type': 'public',
                    'country': 'AU',
                    'country_name': 'Australia',
                    'year': date_obj.year,
                    'month': date_obj.month,
                    'day': date_obj.day,
                    'day_of_week': date_obj.strftime('%A'),
                    'is_weekend': date_obj.weekday() >= 5,
                    'is_fixed': True,
                    'regions': ['NSW']
                }
                
                holidays.append(holiday)
                
            except Exception as e:
                print(f"Error parsing NSW row: {row}, error: {str(e)}")
                continue
                
        return holidays
        
    def parse_vic_csv(self, csv_content: str) -> List[Dict[str, Any]]:
        """Parse Victorian Important Dates CSV"""
        holidays = []
        csv_reader = csv.DictReader(StringIO(csv_content))
        
        for row in csv_reader:
            try:
                # Filter for public holidays only
                if 'public holiday' not in row.get('Type', '').lower():
                    continue
                    
                date_obj = datetime.strptime(row.get('Date', ''), '%d/%m/%Y')
                
                holiday = {
                    'date': date_obj.strftime('%Y-%m-%d'),
                    'name': row.get('Name', '').strip(),
                    'type': 'public',
                    'country': 'AU',
                    'country_name': 'Australia',
                    'year': date_obj.year,
                    'month': date_obj.month,
                    'day': date_obj.day,
                    'day_of_week': date_obj.strftime('%A'),
                    'is_weekend': date_obj.weekday() >= 5,
                    'is_fixed': True,
                    'regions': ['VIC']
                }
                
                holidays.append(holiday)
                
            except Exception as e:
                print(f"Error parsing VIC row: {row}, error: {str(e)}")
                continue
                
        return holidays
        
    def merge_and_deduplicate(self, all_holidays: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Merge holidays and remove duplicates, prioritizing state-specific data"""
        # Create a map for deduplication
        holiday_map = {}
        
        # Process holidays, state-specific data takes priority
        for holiday in all_holidays:
            # Create unique key
            regions_str = ','.join(sorted(holiday['regions']))
            key = f"{holiday['date']}_{holiday['name'].lower().replace(' ', '_')}_{regions_str}"
            
            # If not seen before, or if this is more specific (state vs national)
            if key not in holiday_map or len(holiday['regions']) == 1:
                holiday_map[key] = holiday
                
        # Convert back to list and sort
        merged = list(holiday_map.values())
        merged.sort(key=lambda x: (x['date'], x['name']))
        
        return merged
        
    def transform_to_dynamodb(self, holidays: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Transform holidays to DynamoDB format"""
        items = []
        
        for holiday in holidays:
            item = {
                'PK': f"COUNTRY#{holiday['country']}#{holiday['year']}",
                'SK': f"HOLIDAY#{holiday['date']}#{holiday['name'].replace(' ', '_')}",
                'date': holiday['date'],
                'name': holiday['name'],
                'type': holiday['type'],
                'country': holiday['country'],
                'country_name': holiday['country_name'],
                'year': holiday['year'],
                'month': holiday['month'],
                'day': holiday['day'],
                'day_of_week': holiday['day_of_week'],
                'is_weekend': holiday['is_weekend'],
                'is_fixed': holiday['is_fixed'],
                'regions': holiday['regions'],
                'GSI1PK': f"YEAR#{holiday['year']}",
                'GSI1SK': f"DATE#{holiday['date']}",
                'last_updated': datetime.utcnow().isoformat(),
                'data_source': 'government_api'
            }
            
            items.append(item)
            
        return items
        
    def load_to_dynamodb(self, items: List[Dict[str, Any]]) -> Dict[str, int]:
        """Load items to DynamoDB with batch processing"""
        successful = 0
        failed = 0
        
        # Process in batches of 25
        for i in range(0, len(items), 25):
            batch = items[i:i+25]
            
            try:
                with self.holidays_table.batch_writer() as batch_writer:
                    for item in batch:
                        batch_writer.put_item(Item=item)
                        successful += 1
                        
            except Exception as e:
                print(f"Error loading batch: {str(e)}")
                failed += len(batch)
                
        return {'successful': successful, 'failed': failed}
        
    def run_etl(self):
        """Main ETL process"""
        print("Starting Government Data ETL...")
        
        all_holidays = []
        fetch_summary = []
        
        # Fetch national holidays
        for year in ['2024', '2025']:
            if self.sources['national'].get(year):
                try:
                    print(f"Fetching national holidays for {year}...")
                    csv_content = self.fetch_url(self.sources['national'][year])
                    holidays = self.parse_national_csv(csv_content, year)
                    all_holidays.extend(holidays)
                    fetch_summary.append(f"National {year}: {len(holidays)} holidays")
                except Exception as e:
                    fetch_summary.append(f"National {year}: Failed - {str(e)}")
                    
        # Fetch NSW holidays
        try:
            print("Fetching NSW holidays...")
            csv_content = self.fetch_url(self.sources['nsw'])
            holidays = self.parse_nsw_csv(csv_content)
            all_holidays.extend(holidays)
            fetch_summary.append(f"NSW: {len(holidays)} holidays")
        except Exception as e:
            fetch_summary.append(f"NSW: Failed - {str(e)}")
            
        # Fetch VIC holidays
        try:
            print("Fetching VIC holidays...")
            csv_content = self.fetch_url(self.sources['vic'])
            holidays = self.parse_vic_csv(csv_content)
            all_holidays.extend(holidays)
            fetch_summary.append(f"VIC: {len(holidays)} holidays")
        except Exception as e:
            fetch_summary.append(f"VIC: Failed - {str(e)}")
            
        # Merge and deduplicate
        print(f"Total holidays before deduplication: {len(all_holidays)}")
        merged_holidays = self.merge_and_deduplicate(all_holidays)
        print(f"Total holidays after deduplication: {len(merged_holidays)}")
        
        # Transform to DynamoDB format
        dynamodb_items = self.transform_to_dynamodb(merged_holidays)
        
        # Load to DynamoDB
        print("Loading to DynamoDB...")
        load_result = self.load_to_dynamodb(dynamodb_items)
        
        # Create summary
        summary = {
            'timestamp': datetime.utcnow().isoformat(),
            'fetch_summary': fetch_summary,
            'total_fetched': len(all_holidays),
            'total_unique': len(merged_holidays),
            'load_result': load_result,
            'years_covered': sorted(set(h['year'] for h in merged_holidays)),
            'regions_covered': sorted(set(r for h in merged_holidays for r in h['regions']))
        }
        
        print(f"\nETL Summary: {json.dumps(summary, indent=2)}")
        
        # Send SNS notification
        if 'SNS_TOPIC_ARN' in args:
            try:
                sns.publish(
                    TopicArn=args['SNS_TOPIC_ARN'],
                    Subject='Australian Holiday ETL Complete',
                    Message=json.dumps(summary, indent=2)
                )
            except Exception as e:
                print(f"Failed to send SNS notification: {str(e)}")
                
        return summary

# Main execution
if __name__ == '__main__':
    etl = GovernmentDataETL()
    result = etl.run_etl()
    
    # Commit job
    job.commit()
    
    print("ETL job completed successfully")