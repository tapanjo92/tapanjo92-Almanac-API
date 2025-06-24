#!/bin/bash

# Test script for fixed Almanac API endpoints

API_URL="$1"
API_KEY="$2"

if [ -z "$API_URL" ] || [ -z "$API_KEY" ]; then
    echo "Usage: $0 <API_URL> <API_KEY>"
    echo "Example: $0 https://abcd1234.execute-api.us-east-1.amazonaws.com/v1 your-api-key"
    exit 1
fi

echo "Testing Almanac API endpoints..."
echo "API URL: $API_URL"
echo ""

# Test 1: Business Days Endpoint (POST)
echo "1. Testing /business-days endpoint (POST)..."
echo "   Request: Calculate 10 business days from 2024-01-15 in Australia"
BUSINESS_DAYS_RESPONSE=$(curl -s -X POST "$API_URL/business-days" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "startDate": "2024-01-15",
        "days": 10,
        "country": "AU",
        "includeWeekends": false
    }')

if echo "$BUSINESS_DAYS_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$BUSINESS_DAYS_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $BUSINESS_DAYS_RESPONSE"
fi
echo ""

# Test 2: Business Days with region
echo "2. Testing /business-days endpoint with region..."
echo "   Request: Calculate 5 business days from 2024-03-01 in New South Wales, Australia"
BUSINESS_DAYS_NSW_RESPONSE=$(curl -s -X POST "$API_URL/business-days" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "startDate": "2024-03-01",
        "days": 5,
        "country": "AU",
        "region": "NSW"
    }')

if echo "$BUSINESS_DAYS_NSW_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$BUSINESS_DAYS_NSW_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $BUSINESS_DAYS_NSW_RESPONSE"
fi
echo ""

# Test 3: Timezone Endpoint - Sydney coordinates
echo "3. Testing /timezones endpoint (Sydney coordinates)..."
echo "   Request: lat=-33.8688, lng=151.2093"
TIMEZONE_SYDNEY_RESPONSE=$(curl -s -X GET "$API_URL/timezones?lat=-33.8688&lng=151.2093" \
    -H "x-api-key: $API_KEY")

if echo "$TIMEZONE_SYDNEY_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$TIMEZONE_SYDNEY_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $TIMEZONE_SYDNEY_RESPONSE"
fi
echo ""

# Test 4: Timezone Endpoint - London coordinates
echo "4. Testing /timezones endpoint (London coordinates)..."
echo "   Request: lat=51.5074, lng=-0.1278"
TIMEZONE_LONDON_RESPONSE=$(curl -s -X GET "$API_URL/timezones?lat=51.5074&lng=-0.1278" \
    -H "x-api-key: $API_KEY")

if echo "$TIMEZONE_LONDON_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$TIMEZONE_LONDON_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $TIMEZONE_LONDON_RESPONSE"
fi
echo ""

# Test 5: Timezone Endpoint - Berlin coordinates
echo "5. Testing /timezones endpoint (Berlin coordinates)..."
echo "   Request: lat=52.5200, lng=13.4050"
TIMEZONE_BERLIN_RESPONSE=$(curl -s -X GET "$API_URL/timezones?lat=52.5200&lng=13.4050" \
    -H "x-api-key: $API_KEY")

if echo "$TIMEZONE_BERLIN_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$TIMEZONE_BERLIN_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $TIMEZONE_BERLIN_RESPONSE"
fi
echo ""

# Test 6: Business Days - negative days (counting backwards)
echo "6. Testing /business-days endpoint with negative days..."
echo "   Request: Calculate -5 business days from 2024-01-15"
BUSINESS_DAYS_NEGATIVE_RESPONSE=$(curl -s -X POST "$API_URL/business-days" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "startDate": "2024-01-15",
        "days": -5,
        "country": "AU"
    }')

if echo "$BUSINESS_DAYS_NEGATIVE_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$BUSINESS_DAYS_NEGATIVE_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $BUSINESS_DAYS_NEGATIVE_RESPONSE"
fi
echo ""

# Test 7: Error case - missing required parameters
echo "7. Testing error handling - missing parameters..."
echo "   Request: Missing 'days' parameter"
ERROR_RESPONSE=$(curl -s -X POST "$API_URL/business-days" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "startDate": "2024-01-15",
        "country": "AU"
    }')

if echo "$ERROR_RESPONSE" | jq . > /dev/null 2>&1; then
    echo "   Response:"
    echo "$ERROR_RESPONSE" | jq .
else
    echo "   Error: Invalid JSON response or request failed"
    echo "   Raw response: $ERROR_RESPONSE"
fi
echo ""

echo "All tests completed!"