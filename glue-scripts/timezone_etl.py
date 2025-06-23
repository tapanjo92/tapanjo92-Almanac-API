import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql.functions import col, lit, when, split, regexp_replace
from datetime import datetime
import boto3
import json
import pytz

# Get job parameters
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'RAW_BUCKET',
    'STAGING_BUCKET', 
    'VALIDATED_BUCKET',
    'TIMEZONES_TABLE',
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
table = dynamodb.Table(args['TIMEZONES_TABLE'])

def process_timezones():
    """Process timezone data from IANA database"""
    
    # Create comprehensive timezone data
    timezone_data = create_timezone_data()
    
    # Convert to DataFrame
    df = spark.createDataFrame(timezone_data)
    
    # Data transformations
    df_transformed = df \
        .withColumn("utc_offset_hours", col("utc_offset") / 3600) \
        .withColumn("has_dst", when(col("dst_offset") > 0, True).otherwise(False)) \
        .withColumn("processed_timestamp", lit(datetime.now().isoformat()))
    
    # Data quality checks
    df_validated = df_transformed.filter(
        (col("timezone").isNotNull()) &
        (col("country").isNotNull()) &
        (col("utc_offset").isNotNull())
    )
    
    # Save to staging bucket
    staging_path = f"s3://{args['STAGING_BUCKET']}/timezones/validated/"
    df_validated.write \
        .mode("overwrite") \
        .partitionBy("country") \
        .parquet(staging_path)
    
    # Also save as JSON for validation Lambda
    df_validated.coalesce(1).write \
        .mode("overwrite") \
        .json(f"s3://{args['STAGING_BUCKET']}/timezones/validated/latest.json")
    
    # Write to DynamoDB
    write_to_dynamodb(df_validated)
    
    return df_validated.count()

def create_timezone_data():
    """Create timezone data for major cities"""
    
    # Focus on our target countries
    timezones = [
        # Australia
        {"timezone": "Australia/Sydney", "country": "AU", "city": "Sydney", "state": "NSW"},
        {"timezone": "Australia/Melbourne", "country": "AU", "city": "Melbourne", "state": "VIC"},
        {"timezone": "Australia/Brisbane", "country": "AU", "city": "Brisbane", "state": "QLD"},
        {"timezone": "Australia/Perth", "country": "AU", "city": "Perth", "state": "WA"},
        {"timezone": "Australia/Adelaide", "country": "AU", "city": "Adelaide", "state": "SA"},
        {"timezone": "Australia/Hobart", "country": "AU", "city": "Hobart", "state": "TAS"},
        {"timezone": "Australia/Darwin", "country": "AU", "city": "Darwin", "state": "NT"},
        
        # United Kingdom
        {"timezone": "Europe/London", "country": "UK", "city": "London", "state": None},
        {"timezone": "Europe/Belfast", "country": "UK", "city": "Belfast", "state": "Northern Ireland"},
        {"timezone": "Europe/Edinburgh", "country": "UK", "city": "Edinburgh", "state": "Scotland"},
        {"timezone": "Europe/Cardiff", "country": "UK", "city": "Cardiff", "state": "Wales"},
        
        # Germany
        {"timezone": "Europe/Berlin", "country": "DE", "city": "Berlin", "state": None},
        {"timezone": "Europe/Hamburg", "country": "DE", "city": "Hamburg", "state": None},
        {"timezone": "Europe/Munich", "country": "DE", "city": "Munich", "state": "Bavaria"},
        {"timezone": "Europe/Frankfurt", "country": "DE", "city": "Frankfurt", "state": "Hesse"},
        {"timezone": "Europe/Cologne", "country": "DE", "city": "Cologne", "state": "NRW"},
    ]
    
    # Enrich with timezone information
    enriched_timezones = []
    for tz_info in timezones:
        try:
            tz = pytz.timezone(tz_info['timezone'])
            now = datetime.now(tz)
            
            # Get UTC offset in seconds
            utc_offset = int(now.utcoffset().total_seconds())
            
            # Check if DST is active
            dst_offset = int(now.dst().total_seconds()) if now.dst() else 0
            
            enriched_tz = {
                **tz_info,
                'utc_offset': utc_offset,
                'dst_offset': dst_offset,
                'timezone_name': tz.zone,
                'timezone_abbr': now.strftime('%Z'),
                'is_dst_active': dst_offset > 0,
                'country_name': get_country_name(tz_info['country'])
            }
            
            enriched_timezones.append(enriched_tz)
            
        except Exception as e:
            print(f"Error processing timezone {tz_info['timezone']}: {str(e)}")
            continue
    
    return enriched_timezones

def get_country_name(country_code):
    """Map country codes to names"""
    country_map = {
        'AU': 'Australia',
        'UK': 'United Kingdom',
        'DE': 'Germany'
    }
    return country_map.get(country_code, country_code)

def write_to_dynamodb(df):
    """Write processed timezone data to DynamoDB"""
    
    # Convert to Pandas for easier DynamoDB writing
    pandas_df = df.toPandas()
    
    with table.batch_writer() as batch:
        for index, row in pandas_df.iterrows():
            item = {
                'PK': f"COUNTRY#{row['country']}",
                'SK': f"TIMEZONE#{row['timezone']}",
                'timezone': row['timezone'],
                'timezone_name': row['timezone_name'],
                'timezone_abbr': row['timezone_abbr'],
                'country': row['country'],
                'country_name': row['country_name'],
                'city': row['city'],
                'utc_offset': int(row['utc_offset']),
                'utc_offset_hours': float(row['utc_offset_hours']),
                'dst_offset': int(row['dst_offset']),
                'has_dst': bool(row['has_dst']),
                'is_dst_active': bool(row['is_dst_active']),
                'processed_timestamp': row['processed_timestamp']
            }
            
            # Add optional fields
            if row.get('state'):
                item['state'] = row['state']
            
            batch.put_item(Item=item)
    
    print(f"Successfully wrote {len(pandas_df)} timezone records to DynamoDB")

# Main execution
try:
    record_count = process_timezones()
    print(f"Successfully processed {record_count} timezone records")
    
    # Write success marker
    success_marker = {
        'status': 'SUCCESS',
        'record_count': record_count,
        'timestamp': datetime.now().isoformat(),
        'job_name': args['JOB_NAME']
    }
    
    s3_client.put_object(
        Bucket=args['VALIDATED_BUCKET'],
        Key='timezones/_SUCCESS',
        Body=json.dumps(success_marker)
    )
    
except Exception as e:
    print(f"Job failed with error: {str(e)}")
    raise e

job.commit()