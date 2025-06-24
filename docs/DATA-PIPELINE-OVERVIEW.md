# DataPipeline Stack Overview

## Purpose

The DataPipeline stack is responsible for **populating your DynamoDB tables with actual holiday and timezone data**. Without this pipeline, your API would return empty results (as we saw during testing).

## What It Does

The DataPipeline implements an automated ETL (Extract, Transform, Load) workflow that:

1. **Extracts** raw holiday and timezone data from S3 buckets
2. **Transforms** the data into the correct format for DynamoDB
3. **Loads** the processed data into your DynamoDB tables
4. **Validates** data quality throughout the process

## Components

### 1. **AWS Glue Crawlers**
- `HolidayCrawler`: Discovers and catalogs holiday data files in S3
- `TimezoneCrawler`: Discovers and catalogs timezone data files in S3

### 2. **AWS Glue ETL Jobs**
- `HolidayETLJob`: Processes holiday data (dates, names, types, countries)
- `TimezoneETLJob`: Processes timezone data (coordinates, UTC offsets, timezone names)

### 3. **Lambda Functions**
- `DataValidationLambda`: Validates data format and required fields
- `DataQualityLambda`: Checks data completeness and accuracy

### 4. **Step Functions State Machine**
- Orchestrates the entire pipeline workflow
- Runs both holiday and timezone pipelines in parallel
- Handles retries and error notifications

## Workflow

```
┌─────────────────┐
│   S3 Raw Data   │
└────────┬────────┘
         │
    ┌────▼────┐
    │ Crawlers │ (Discover data schema)
    └────┬────┘
         │
   ┌─────▼─────┐
   │ ETL Jobs  │ (Transform data)
   └─────┬─────┘
         │
  ┌──────▼──────┐
  │ Validation  │ (Check data quality)
  └──────┬──────┘
         │
   ┌─────▼─────┐
   │ DynamoDB  │ (Store processed data)
   └───────────┘
```

## Data Flow

1. **Raw Data** → Uploaded to `almanac-api-dev-raw-*` S3 bucket
2. **Crawlers** → Analyze data structure and create Glue catalog
3. **ETL Jobs** → Process and transform data
4. **Staging** → Validated data stored in `almanac-api-dev-staging-*`
5. **Production** → Final data loaded into DynamoDB tables

## How to Use It

### 1. Deploy the DataPipeline Stack
```bash
npm run cdk deploy AlmanacAPI-DataPipeline-dev
```

### 2. Upload Raw Data Files

Upload your data files to the raw S3 bucket:

**Holiday Data Format (JSON)**:
```json
[
  {
    "country": "US",
    "date": "2025-01-01",
    "name": "New Year's Day",
    "type": "PUBLIC",
    "observedDate": "2025-01-01"
  },
  {
    "country": "US",
    "date": "2025-07-04",
    "name": "Independence Day",
    "type": "PUBLIC",
    "observedDate": "2025-07-04"
  }
]
```

**Timezone Data Format (JSON)**:
```json
[
  {
    "lat": 40.7128,
    "lng": -74.0060,
    "timezone": "America/New_York",
    "utcOffset": -5,
    "city": "New York"
  },
  {
    "lat": 51.5074,
    "lng": -0.1278,
    "timezone": "Europe/London",
    "utcOffset": 0,
    "city": "London"
  }
]
```

### 3. Run the Pipeline

You can trigger the pipeline:
- **Manually**: Through Step Functions console
- **Scheduled**: The pipeline runs daily at 2 AM UTC
- **On Upload**: Triggered when new files arrive in S3

### 4. Monitor Progress

- Check Step Functions execution in AWS Console
- View CloudWatch logs for detailed ETL progress
- Receive SNS notifications on failures

## Why It's Important

Without the DataPipeline:
- ❌ API returns empty results
- ❌ No holiday data for business day calculations
- ❌ No timezone lookups available

With the DataPipeline:
- ✅ Automated data ingestion
- ✅ Data quality validation
- ✅ Regular updates from data sources
- ✅ Monitoring and alerting

## Cost Considerations

- **Glue Jobs**: Charged per DPU-hour (minimal for small datasets)
- **Step Functions**: Charged per state transition
- **Lambda**: Minimal cost for validation functions
- **Schedule**: Run only when needed to minimize costs

## Next Steps

1. Prepare your holiday and timezone data files
2. Upload to the raw S3 bucket
3. Run the pipeline to populate DynamoDB
4. Your API will now return actual data!

The DataPipeline is essential for making your Almanac API functional with real-world data.