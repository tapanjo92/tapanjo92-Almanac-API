import sys
import json
import boto3
import requests
from datetime import datetime, timedelta
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit, when, udf
from pyspark.sql.types import StringType, ArrayType

# Get job parameters
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'RAW_BUCKET',
    'STAGING_BUCKET',
    'VALIDATED_BUCKET',
    'HOLIDAYS_TABLE'
])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# Initialize clients
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

# Australian state codes
AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']

def extract_holidays():
    """
    Extract holiday data from Australian government sources
    For production, replace with actual API endpoints
    """
    print("Extracting Australian holiday data...")
    
    # Example structure - in production, fetch from real APIs
    # Australian Government public holidays API
    # Each state has different data sources
    
    sources = {
        'federal': {
            'url': 'https://data.gov.au/dataset/australian-holidays/resource/public-holidays.json',
            'format': 'json'
        },
        'nsw': {
            'url': 'https://www.nsw.gov.au/api/holidays',
            'format': 'json'
        },
        'vic': {
            'url': 'https://business.vic.gov.au/api/public-holidays',
            'format': 'json'
        }
    }
    
    raw_data = {
        'extraction_timestamp': datetime.now().isoformat(),
        'sources': sources,
        'holidays': []
    }
    
    # For now, we'll use a structured format that real APIs would provide
    # In production, this would be actual API calls
    sample_holidays = [
        {
            "date": "2024-01-01",
            "name": "New Year's Day",
            "jurisdiction": "national",
            "type": "public"
        },
        {
            "date": "2024-01-26",
            "name": "Australia Day", 
            "jurisdiction": "national",
            "type": "public"
        },
        {
            "date": "2024-03-11",
            "name": "Labour Day",
            "jurisdiction": "VIC",
            "type": "public"
        },
        {
            "date": "2024-03-04",
            "name": "Labour Day",
            "jurisdiction": "WA",
            "type": "public"
        },
        {
            "date": "2024-08-05",
            "name": "Bank Holiday",
            "jurisdiction": "NSW",
            "type": "public"
        },
        {
            "date": "2024-11-05",
            "name": "Melbourne Cup Day",
            "jurisdiction": "VIC",
            "type": "public"
        }
    ]
    
    raw_data['holidays'] = sample_holidays
    
    # Save raw data to S3
    raw_key = f"holidays/australia/{datetime.now().strftime('%Y/%m/%d')}/raw_extract.json"
    s3.put_object(
        Bucket=args['RAW_BUCKET'],
        Key=raw_key,
        Body=json.dumps(raw_data, indent=2),
        ContentType='application/json'
    )
    
    print(f"Saved raw data to s3://{args['RAW_BUCKET']}/{raw_key}")
    return raw_data

def transform_holidays(raw_data):
    """
    Transform raw holiday data to our standard format
    """
    print("Transforming holiday data...")
    
    holidays = raw_data.get('holidays', [])
    transformed = []
    
    for holiday in holidays:
        # Parse date
        date_str = holiday.get('date')
        date_obj = datetime.strptime(date_str, '%Y-%m-%d')
        
        # Determine regions
        jurisdiction = holiday.get('jurisdiction', '').upper()
        if jurisdiction == 'NATIONAL' or jurisdiction == 'FEDERAL':
            regions = ['ALL']
        elif jurisdiction in AU_STATES:
            regions = [jurisdiction]
        else:
            # Try to parse from description or default to ALL
            regions = ['ALL']
        
        # Create transformed record
        transformed_holiday = {
            'date': date_str,
            'name': holiday.get('name'),
            'country': 'AU',
            'country_name': 'Australia',
            'type': holiday.get('type', 'public'),
            'year': date_obj.year,
            'month': date_obj.month,
            'day': date_obj.day,
            'day_of_week': date_obj.strftime('%A'),
            'is_weekend': date_obj.weekday() >= 5,
            'is_fixed': True,  # Most AU holidays are fixed
            'regions': regions,
            'source': raw_data.get('sources', {}).get(jurisdiction.lower(), {}).get('url', 'unknown'),
            'last_updated': datetime.now().isoformat()
        }
        
        # Add to DynamoDB format
        transformed_holiday['PK'] = 'COUNTRY#AU'
        transformed_holiday['SK'] = f"DATE#{date_str}"
        
        transformed.append(transformed_holiday)
    
    # Create Spark DataFrame
    df = spark.createDataFrame(transformed)
    
    # Additional transformations
    df = df.filter(col('year') >= datetime.now().year)  # Only current and future years
    df = df.dropDuplicates(['date', 'name', 'regions'])
    
    return df

def validate_holidays(df):
    """
    Validate transformed holiday data
    """
    print("Validating holiday data...")
    
    # Validation rules
    errors = []
    
    # Check required fields
    required_fields = ['date', 'name', 'country', 'type', 'regions']
    for field in required_fields:
        null_count = df.filter(col(field).isNull()).count()
        if null_count > 0:
            errors.append(f"Found {null_count} records with null {field}")
    
    # Validate date format
    date_pattern = r'^\d{4}-\d{2}-\d{2}$'
    invalid_dates = df.filter(~col('date').rlike(date_pattern)).count()
    if invalid_dates > 0:
        errors.append(f"Found {invalid_dates} records with invalid date format")
    
    # Validate regions
    valid_regions = AU_STATES + ['ALL']
    
    def validate_regions_udf(regions):
        if not regions:
            return False
        return all(r in valid_regions for r in regions)
    
    from pyspark.sql.types import BooleanType
    validate_regions = udf(validate_regions_udf, BooleanType())
    invalid_regions = df.filter(validate_regions(col('regions')) == False).count()
    if invalid_regions > 0:
        errors.append(f"Found {invalid_regions} records with invalid regions")
    
    # Data quality metrics
    total_records = df.count()
    unique_holidays = df.select('date', 'name').distinct().count()
    
    quality_metrics = {
        'total_records': total_records,
        'unique_holidays': unique_holidays,
        'validation_errors': errors,
        'quality_score': 100 if len(errors) == 0 else 80,
        'validated_at': datetime.now().isoformat()
    }
    
    # Save validation report
    report_key = f"holidays/australia/{datetime.now().strftime('%Y/%m/%d')}/validation_report.json"
    s3.put_object(
        Bucket=args['STAGING_BUCKET'],
        Key=report_key,
        Body=json.dumps(quality_metrics, indent=2),
        ContentType='application/json'
    )
    
    print(f"Validation complete. Score: {quality_metrics['quality_score']}%")
    return len(errors) == 0, df, quality_metrics

def load_to_dynamodb(df):
    """
    Load validated data to DynamoDB
    """
    print("Loading data to DynamoDB...")
    
    table = dynamodb.Table(args['HOLIDAYS_TABLE'])
    
    # Convert to Pandas for easier DynamoDB operations
    pdf = df.toPandas()
    
    # Batch write to DynamoDB
    with table.batch_writer() as batch:
        for _, row in pdf.iterrows():
            item = row.to_dict()
            # Convert numpy types to Python types
            item['year'] = int(item['year'])
            item['month'] = int(item['month'])
            item['day'] = int(item['day'])
            item['is_weekend'] = bool(item['is_weekend'])
            item['is_fixed'] = bool(item['is_fixed'])
            
            batch.put_item(Item=item)
    
    print(f"Loaded {len(pdf)} holidays to DynamoDB")
    
    # Save to validated bucket
    validated_key = f"holidays/australia/{datetime.now().strftime('%Y/%m/%d')}/validated_holidays.json"
    df.write.mode('overwrite').json(f"s3://{args['VALIDATED_BUCKET']}/{validated_key}")
    
    return len(pdf)

def send_notification(success, metrics):
    """
    Send SNS notification about ETL job completion
    """
    sns = boto3.client('sns')
    topic_arn = 'arn:aws:sns:ap-south-1:809555764832:almanac-api-dev-data-approval'
    
    if success:
        subject = "Australian Holiday ETL - Success"
        message = f"""
Australian Holiday ETL completed successfully!

Metrics:
- Total records processed: {metrics.get('total_records', 0)}
- Unique holidays: {metrics.get('unique_holidays', 0)}
- Quality score: {metrics.get('quality_score', 0)}%
- Timestamp: {metrics.get('validated_at', 'N/A')}

The data has been loaded to DynamoDB.
        """
    else:
        subject = "Australian Holiday ETL - Failed"
        message = f"""
Australian Holiday ETL failed validation.

Errors:
{json.dumps(metrics.get('validation_errors', []), indent=2)}

Please review the data and fix the issues.
        """
    
    try:
        sns.publish(
            TopicArn=topic_arn,
            Subject=subject,
            Message=message
        )
    except Exception as e:
        print(f"Failed to send notification: {e}")

# Main ETL process
try:
    # Extract
    raw_data = extract_holidays()
    
    # Transform
    transformed_df = transform_holidays(raw_data)
    
    # Validate
    is_valid, validated_df, metrics = validate_holidays(transformed_df)
    
    if is_valid:
        # Load
        record_count = load_to_dynamodb(validated_df)
        metrics['loaded_records'] = record_count
        
        # Notify success
        send_notification(True, metrics)
        print("ETL job completed successfully!")
    else:
        # Notify failure
        send_notification(False, metrics)
        raise Exception(f"Validation failed: {metrics['validation_errors']}")
    
    job.commit()
    
except Exception as e:
    print(f"ETL job failed: {str(e)}")
    job.commit()
    raise e