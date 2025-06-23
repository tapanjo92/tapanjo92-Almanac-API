import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql.functions import col, to_date, year, month, dayofmonth, when, lit
from datetime import datetime
import boto3
import json

# Get job parameters
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'RAW_BUCKET',
    'STAGING_BUCKET',
    'VALIDATED_BUCKET',
    'HOLIDAYS_TABLE',
    'DATABASE_NAME'
])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# Initialize boto3 clients
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(args['HOLIDAYS_TABLE'])

def process_holidays():
    """Process holiday data from multiple sources"""
    
    # Define holiday data sources
    sources = {
        'AU': {
            'url': 'https://date.nager.at/api/v3/publicholidays/2024/AU',
            'country_code': 'AU',
            'country_name': 'Australia'
        },
        'UK': {
            'url': 'https://date.nager.at/api/v3/publicholidays/2024/GB',
            'country_code': 'UK', 
            'country_name': 'United Kingdom'
        },
        'DE': {
            'url': 'https://date.nager.at/api/v3/publicholidays/2024/DE',
            'country_code': 'DE',
            'country_name': 'Germany'
        }
    }
    
    all_holidays = []
    
    # Fetch holiday data from each source
    for country_code, source_info in sources.items():
        try:
            # In production, this would read from S3 where external data is staged
            # For now, we'll create sample data
            holidays = create_sample_holiday_data(country_code, source_info['country_name'])
            all_holidays.extend(holidays)
        except Exception as e:
            print(f"Error processing {country_code}: {str(e)}")
            continue
    
    # Convert to DataFrame
    df = spark.createDataFrame(all_holidays)
    
    # Data transformations
    df_transformed = df \
        .withColumn("date", to_date(col("date"), "yyyy-MM-dd")) \
        .withColumn("year", year(col("date"))) \
        .withColumn("month", month(col("date"))) \
        .withColumn("day", dayofmonth(col("date"))) \
        .withColumn("is_weekend", when(
            col("day_of_week").isin(["Saturday", "Sunday"]), True
        ).otherwise(False)) \
        .withColumn("processed_timestamp", lit(datetime.now().isoformat()))
    
    # Data quality checks
    df_validated = df_transformed.filter(
        (col("date").isNotNull()) &
        (col("name").isNotNull()) &
        (col("country").isNotNull()) &
        (col("year") >= 2024) &
        (col("year") <= 2025)
    )
    
    # Save to staging bucket
    staging_path = f"s3://{args['STAGING_BUCKET']}/holidays/validated/"
    df_validated.write \
        .mode("overwrite") \
        .partitionBy("country", "year") \
        .parquet(staging_path)
    
    # Also save as JSON for validation Lambda
    df_validated.coalesce(1).write \
        .mode("overwrite") \
        .json(f"s3://{args['STAGING_BUCKET']}/holidays/validated/latest.json")
    
    # Write to DynamoDB
    write_to_dynamodb(df_validated)
    
    return df_validated.count()

def create_sample_holiday_data(country_code, country_name):
    """Create sample holiday data for testing"""
    
    # Sample holidays for 2024
    holidays_2024 = {
        'AU': [
            {"date": "2024-01-01", "name": "New Year's Day", "type": "public"},
            {"date": "2024-01-26", "name": "Australia Day", "type": "public"},
            {"date": "2024-03-29", "name": "Good Friday", "type": "public"},
            {"date": "2024-04-01", "name": "Easter Monday", "type": "public"},
            {"date": "2024-04-25", "name": "Anzac Day", "type": "public"},
            {"date": "2024-06-10", "name": "Queen's Birthday", "type": "public"},
            {"date": "2024-12-25", "name": "Christmas Day", "type": "public"},
            {"date": "2024-12-26", "name": "Boxing Day", "type": "public"}
        ],
        'UK': [
            {"date": "2024-01-01", "name": "New Year's Day", "type": "public"},
            {"date": "2024-03-29", "name": "Good Friday", "type": "public"},
            {"date": "2024-04-01", "name": "Easter Monday", "type": "public"},
            {"date": "2024-05-06", "name": "Early May Bank Holiday", "type": "bank"},
            {"date": "2024-05-27", "name": "Spring Bank Holiday", "type": "bank"},
            {"date": "2024-08-26", "name": "Summer Bank Holiday", "type": "bank"},
            {"date": "2024-12-25", "name": "Christmas Day", "type": "public"},
            {"date": "2024-12-26", "name": "Boxing Day", "type": "public"}
        ],
        'DE': [
            {"date": "2024-01-01", "name": "Neujahr", "type": "public"},
            {"date": "2024-03-29", "name": "Karfreitag", "type": "public"},
            {"date": "2024-04-01", "name": "Ostermontag", "type": "public"},
            {"date": "2024-05-01", "name": "Tag der Arbeit", "type": "public"},
            {"date": "2024-05-09", "name": "Christi Himmelfahrt", "type": "public"},
            {"date": "2024-05-20", "name": "Pfingstmontag", "type": "public"},
            {"date": "2024-10-03", "name": "Tag der Deutschen Einheit", "type": "public"},
            {"date": "2024-12-25", "name": "1. Weihnachtstag", "type": "public"},
            {"date": "2024-12-26", "name": "2. Weihnachtstag", "type": "public"}
        ]
    }
    
    holidays = []
    for holiday in holidays_2024.get(country_code, []):
        # Calculate day of week
        date_obj = datetime.strptime(holiday['date'], '%Y-%m-%d')
        day_of_week = date_obj.strftime('%A')
        
        holidays.append({
            'date': holiday['date'],
            'name': holiday['name'],
            'type': holiday['type'],
            'country': country_code,
            'country_name': country_name,
            'day_of_week': day_of_week,
            'is_fixed': True,  # Simplified - in reality would check if date changes yearly
            'global': False,  # Country-specific
            'counties': None,  # Would contain state/region info if applicable
            'launch_year': 1900  # Historical holidays
        })
    
    return holidays

def write_to_dynamodb(df):
    """Write processed data to DynamoDB"""
    
    # Convert to Pandas for easier DynamoDB writing
    pandas_df = df.toPandas()
    
    with table.batch_writer() as batch:
        for index, row in pandas_df.iterrows():
            item = {
                'PK': f"COUNTRY#{row['country']}",
                'SK': f"DATE#{row['date'].strftime('%Y-%m-%d')}",
                'GSI1PK': f"YEAR#{row['year']}",
                'GSI1SK': f"COUNTRY#{row['country']}#DATE#{row['date'].strftime('%Y-%m-%d')}",
                'date': row['date'].strftime('%Y-%m-%d'),
                'name': row['name'],
                'type': row['type'],
                'country': row['country'],
                'country_name': row['country_name'],
                'year': int(row['year']),
                'month': int(row['month']),
                'day': int(row['day']),
                'day_of_week': row['day_of_week'],
                'is_weekend': row['is_weekend'],
                'is_fixed': row.get('is_fixed', True),
                'processed_timestamp': row['processed_timestamp']
            }
            
            # Add optional fields if present
            if row.get('counties'):
                item['counties'] = row['counties']
            
            batch.put_item(Item=item)
    
    print(f"Successfully wrote {len(pandas_df)} holiday records to DynamoDB")

# Main execution
try:
    record_count = process_holidays()
    print(f"Successfully processed {record_count} holiday records")
    
    # Write success marker
    success_marker = {
        'status': 'SUCCESS',
        'record_count': record_count,
        'timestamp': datetime.now().isoformat(),
        'job_name': args['JOB_NAME']
    }
    
    s3_client.put_object(
        Bucket=args['VALIDATED_BUCKET'],
        Key='holidays/_SUCCESS',
        Body=json.dumps(success_marker)
    )
    
except Exception as e:
    print(f"Job failed with error: {str(e)}")
    raise e

job.commit()