#!/bin/bash

# Test the data pipeline end-to-end

set -e

ENV=${1:-dev}
REGION="ap-south-1"

echo "Testing Almanac API Data Pipeline..."
echo "Environment: ${ENV}"
echo "Region: ${REGION}"

# Get stack outputs
echo "Getting stack outputs..."
HOLIDAYS_TABLE=$(aws cloudformation describe-stacks \
  --stack-name "AlmanacAPI-Phase0-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='HolidaysTableName'].OutputValue" \
  --output text --region ${REGION})

TIMEZONES_TABLE=$(aws cloudformation describe-stacks \
  --stack-name "AlmanacAPI-Phase0-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='TimezonesTableName'].OutputValue" \
  --output text --region ${REGION})

PIPELINE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "AlmanacAPI-DataPipeline-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='PipelineStateMachineArn'].OutputValue" \
  --output text --region ${REGION} 2>/dev/null || echo "")

echo "Holidays Table: ${HOLIDAYS_TABLE}"
echo "Timezones Table: ${TIMEZONES_TABLE}"
echo "Pipeline ARN: ${PIPELINE_ARN}"

# Function to check table data
check_table_data() {
    local table_name=$1
    local table_type=$2
    
    echo ""
    echo "Checking ${table_type} table: ${table_name}"
    
    # Count items
    ITEM_COUNT=$(aws dynamodb scan \
        --table-name "${table_name}" \
        --select COUNT \
        --region ${REGION} \
        --query 'Count' \
        --output text)
    
    echo "Item count: ${ITEM_COUNT}"
    
    if [ "${ITEM_COUNT}" -gt 0 ]; then
        echo "Sample data:"
        aws dynamodb scan \
            --table-name "${table_name}" \
            --max-items 3 \
            --region ${REGION} \
            --query 'Items[*]' \
            --output json | jq '.'
    fi
}

# Check if pipeline exists
if [ -n "${PIPELINE_ARN}" ]; then
    echo ""
    echo "Starting data pipeline..."
    
    # Start the state machine execution
    EXECUTION_NAME="test-run-$(date +%Y%m%d-%H%M%S)"
    EXECUTION_ARN=$(aws stepfunctions start-execution \
        --state-machine-arn "${PIPELINE_ARN}" \
        --name "${EXECUTION_NAME}" \
        --region ${REGION} \
        --query 'executionArn' \
        --output text)
    
    echo "Started execution: ${EXECUTION_NAME}"
    echo "Execution ARN: ${EXECUTION_ARN}"
    
    # Wait for execution to complete (with timeout)
    echo "Waiting for pipeline to complete (this may take a few minutes)..."
    
    TIMEOUT=600  # 10 minutes
    ELAPSED=0
    INTERVAL=10
    
    while [ $ELAPSED -lt $TIMEOUT ]; do
        STATUS=$(aws stepfunctions describe-execution \
            --execution-arn "${EXECUTION_ARN}" \
            --region ${REGION} \
            --query 'status' \
            --output text)
        
        echo "Status: ${STATUS}"
        
        if [ "${STATUS}" = "SUCCEEDED" ]; then
            echo "Pipeline completed successfully!"
            break
        elif [ "${STATUS}" = "FAILED" ] || [ "${STATUS}" = "TIMED_OUT" ] || [ "${STATUS}" = "ABORTED" ]; then
            echo "Pipeline failed with status: ${STATUS}"
            
            # Get error details
            aws stepfunctions get-execution-history \
                --execution-arn "${EXECUTION_ARN}" \
                --region ${REGION} \
                --query 'events[?type==`ExecutionFailed`]' \
                --output json | jq '.'
            
            exit 1
        fi
        
        sleep $INTERVAL
        ELAPSED=$((ELAPSED + INTERVAL))
    done
    
    if [ $ELAPSED -ge $TIMEOUT ]; then
        echo "Timeout waiting for pipeline completion"
        exit 1
    fi
else
    echo ""
    echo "Warning: Data pipeline not found. Checking existing data only..."
fi

# Check table data
check_table_data "${HOLIDAYS_TABLE}" "Holidays"
check_table_data "${TIMEZONES_TABLE}" "Timezones"

# Test Lambda functions
echo ""
echo "Testing Lambda functions..."

# Test holidays endpoint
echo "Testing holidays lookup for Australia..."
HOLIDAYS_FUNCTION="almanac-api-${ENV}-holidays"

aws lambda invoke \
    --function-name "${HOLIDAYS_FUNCTION}" \
    --payload '{"country": "AU", "year": 2024}' \
    --region ${REGION} \
    /tmp/holidays-response.json >/dev/null 2>&1 || echo "Lambda not deployed yet"

if [ -f /tmp/holidays-response.json ]; then
    echo "Holidays response:"
    cat /tmp/holidays-response.json | jq '.'
fi

# Test timezone endpoint
echo ""
echo "Testing timezone lookup..."
TIMEZONE_FUNCTION="almanac-api-${ENV}-timezone"

aws lambda invoke \
    --function-name "${TIMEZONE_FUNCTION}" \
    --payload '{"timezone": "Australia/Sydney"}' \
    --region ${REGION} \
    /tmp/timezone-response.json >/dev/null 2>&1 || echo "Lambda not deployed yet"

if [ -f /tmp/timezone-response.json ]; then
    echo "Timezone response:"
    cat /tmp/timezone-response.json | jq '.'
fi

echo ""
echo "Data pipeline test completed!"

# Cleanup
rm -f /tmp/holidays-response.json /tmp/timezone-response.json