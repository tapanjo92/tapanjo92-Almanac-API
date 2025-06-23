#!/bin/bash

# Test the Almanac API endpoints

set -e

ENV=${1:-dev}
API_KEY=${2:-}
REGION="ap-south-1"

echo "Testing Almanac API..."
echo "Environment: ${ENV}"
echo "Region: ${REGION}"

# Get API Gateway URL from CloudFormation
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "AlmanacAPI-APIGateway-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text --region ${REGION} 2>/dev/null || echo "")

if [ -z "${API_URL}" ]; then
  echo "Error: API Gateway stack not found or not deployed"
  exit 1
fi

echo "API URL: ${API_URL}"

# Get API key if not provided
if [ -z "${API_KEY}" ]; then
  echo ""
  echo "Retrieving API key..."
  API_KEY_ID=$(aws cloudformation describe-stacks \
    --stack-name "AlmanacAPI-APIGateway-${ENV}" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiKeyId'].OutputValue" \
    --output text --region ${REGION})
  
  if [ -n "${API_KEY_ID}" ]; then
    API_KEY=$(aws apigateway get-api-key \
      --api-key "${API_KEY_ID}" \
      --include-value \
      --region ${REGION} \
      --query 'value' \
      --output text)
    echo "Using API key: ${API_KEY:0:10}..."
  else
    echo "Error: Could not retrieve API key"
    exit 1
  fi
fi

# Function to make API call
make_api_call() {
  local endpoint=$1
  local params=$2
  
  echo ""
  echo "Testing ${endpoint}${params}"
  
  response=$(curl -s -w "\n%{http_code}" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Accept: application/json" \
    "${API_URL}${endpoint}${params}")
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  echo "HTTP Status: ${http_code}"
  
  if [ "${http_code}" -eq 200 ]; then
    echo "Response:"
    echo "${body}" | jq '.' 2>/dev/null || echo "${body}"
  else
    echo "Error Response:"
    echo "${body}" | jq '.' 2>/dev/null || echo "${body}"
  fi
  
  return 0
}

# Test health endpoint (no auth required)
echo "========================================="
echo "1. Testing Health Check Endpoint"
echo "========================================="
response=$(curl -s -w "\n%{http_code}" "${API_URL}health")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')
echo "HTTP Status: ${http_code}"
echo "Response:"
echo "${body}" | jq '.'

# Test holidays endpoint
echo ""
echo "========================================="
echo "2. Testing Holidays Endpoint"
echo "========================================="
make_api_call "holidays" "?country=AU&year=2024"
make_api_call "holidays" "?country=UK&year=2024&month=12"
make_api_call "holidays" "?country=DE&year=2024&type=public"

# Test invalid requests
echo ""
echo "Testing invalid country code (should return 400):"
make_api_call "holidays" "?country=XX&year=2024"

echo ""
echo "Testing missing parameters (should return 400):"
make_api_call "holidays" "?country=AU"

# Test business days endpoint
echo ""
echo "========================================="
echo "3. Testing Business Days Endpoint"
echo "========================================="
make_api_call "business-days" "?startDate=2024-01-01&endDate=2024-01-31&country=AU"
make_api_call "business-days" "?startDate=2024-12-01&endDate=2024-12-31&country=UK&includeWeekends=false"

# Test timezones endpoint
echo ""
echo "========================================="
echo "4. Testing Timezones Endpoint"
echo "========================================="
make_api_call "timezones" "?country=AU"
make_api_call "timezones" "?timezone=Australia/Sydney"
make_api_call "timezones" "?city=London"

# Test rate limiting
echo ""
echo "========================================="
echo "5. Testing Rate Limiting"
echo "========================================="
echo "Making 10 rapid requests..."
for i in {1..10}; do
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-API-Key: ${API_KEY}" \
    "${API_URL}holidays?country=AU&year=2024")
  echo "Request $i: HTTP ${response}"
  
  # Check if rate limited
  if [ "${response}" -eq 429 ]; then
    echo "Rate limit hit at request $i"
    break
  fi
done

# Test without API key (should return 403)
echo ""
echo "========================================="
echo "6. Testing Without API Key"
echo "========================================="
response=$(curl -s -w "\n%{http_code}" "${API_URL}holidays?country=AU&year=2024")
http_code=$(echo "$response" | tail -n1)
echo "HTTP Status: ${http_code} (should be 403 Forbidden)"

echo ""
echo "========================================="
echo "API Testing Complete!"
echo "========================================="

# Summary
echo ""
echo "Summary:"
echo "- API URL: ${API_URL}"
echo "- API Key: ${API_KEY:0:10}..."
echo "- All endpoints tested"
echo ""
echo "To retrieve full API key:"
echo "aws apigateway get-api-key --api-key ${API_KEY_ID} --include-value --region ${REGION}"