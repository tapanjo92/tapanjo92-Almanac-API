#!/bin/bash

# Deploy Glue ETL scripts to S3

set -e

# Get environment from argument or default to dev
ENV=${1:-dev}

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="ap-south-1"

# S3 bucket for Glue scripts
GLUE_SCRIPTS_BUCKET="almanac-api-${ENV}-glue-scripts-${ACCOUNT_ID}"

echo "Deploying Glue ETL scripts to S3..."
echo "Environment: ${ENV}"
echo "Region: ${REGION}"
echo "Glue Scripts Bucket: ${GLUE_SCRIPTS_BUCKET}"

# Check if bucket exists
if ! aws s3 ls "s3://${GLUE_SCRIPTS_BUCKET}" 2>&1 | grep -q 'NoSuchBucket'; then
    echo "Bucket ${GLUE_SCRIPTS_BUCKET} exists"
else
    echo "Error: Bucket ${GLUE_SCRIPTS_BUCKET} does not exist. Deploy Phase 0 stack first."
    exit 1
fi

# Upload ETL scripts
echo "Uploading holiday_etl.py..."
aws s3 cp glue-scripts/holiday_etl.py "s3://${GLUE_SCRIPTS_BUCKET}/scripts/holiday_etl.py"

echo "Uploading timezone_etl.py..."
aws s3 cp glue-scripts/timezone_etl.py "s3://${GLUE_SCRIPTS_BUCKET}/scripts/timezone_etl.py"

# Create sample data directory
mkdir -p sample-data

# Create sample holiday data
cat > sample-data/holidays_raw.json << 'EOF'
[
  {
    "date": "2024-01-01",
    "name": "New Year's Day",
    "country": "AU",
    "type": "public"
  },
  {
    "date": "2024-01-26",
    "name": "Australia Day", 
    "country": "AU",
    "type": "public"
  }
]
EOF

# Create sample timezone data
cat > sample-data/timezones_raw.json << 'EOF'
[
  {
    "timezone": "Australia/Sydney",
    "country": "AU",
    "city": "Sydney",
    "utcOffset": 36000
  },
  {
    "timezone": "Europe/London",
    "country": "UK", 
    "city": "London",
    "utcOffset": 0
  }
]
EOF

# Get raw bucket name
RAW_BUCKET="almanac-api-${ENV}-raw-${ACCOUNT_ID}"

# Upload sample data to raw bucket
echo "Uploading sample data to raw bucket..."
aws s3 cp sample-data/holidays_raw.json "s3://${RAW_BUCKET}/holidays/2024/raw_data.json"
aws s3 cp sample-data/timezones_raw.json "s3://${RAW_BUCKET}/timezones/current/raw_data.json"

echo "Glue scripts deployment completed!"
echo ""
echo "Next steps:"
echo "1. Deploy the data pipeline stack: cdk deploy AlmanacAPI-DataPipeline-${ENV}"
echo "2. Start the Step Functions workflow to process data"
echo "3. Check DynamoDB tables for populated data"

# Cleanup
rm -rf sample-data