#!/bin/bash

# Test DAX Performance Script
# This script tests the performance of DAX vs direct DynamoDB access

set -e

echo "DAX Performance Testing Script"
echo "=============================="

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get stack outputs
STACK_NAME="AlmanacAPI-Phase3-${ENV:-dev}"
REGION=${AWS_REGION:-ap-south-1}

echo -e "${YELLOW}Getting stack outputs...${NC}"
DAX_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $REGION \
    --query "Stacks[0].Outputs[?OutputKey=='DaxClusterEndpoint'].OutputValue" \
    --output text 2>/dev/null || echo "")

HOLIDAYS_TABLE=$(aws cloudformation describe-stacks \
    --stack-name AlmanacAPI-Phase0-${ENV:-dev} \
    --region $REGION \
    --query "Stacks[0].Outputs[?OutputKey=='HolidaysTableName'].OutputValue" \
    --output text)

if [ -z "$DAX_ENDPOINT" ]; then
    echo -e "${RED}Error: Could not find DAX endpoint. Is Phase 3 stack deployed?${NC}"
    exit 1
fi

echo -e "${GREEN}DAX Endpoint: $DAX_ENDPOINT${NC}"
echo -e "${GREEN}Holidays Table: $HOLIDAYS_TABLE${NC}"

# Test parameters
COUNTRY="US"
YEAR="2024"
ITERATIONS=100

echo ""
echo "Test Parameters:"
echo "- Country: $COUNTRY"
echo "- Year: $YEAR"
echo "- Iterations: $ITERATIONS"
echo ""

# Create test Lambda function to run performance tests
cat > /tmp/dax-test.js << 'EOF'
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { DaxClient } = require('@aws-sdk/client-dax');

const tableName = process.env.HOLIDAYS_TABLE;
const daxEndpoint = process.env.DAX_ENDPOINT;
const country = process.env.TEST_COUNTRY;
const year = process.env.TEST_YEAR;
const iterations = parseInt(process.env.ITERATIONS);

// Standard DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// DAX client
let daxDocClient;
try {
    const daxClient = new DaxClient({
        endpoints: [daxEndpoint],
        region: process.env.AWS_REGION,
    });
    daxDocClient = DynamoDBDocumentClient.from(daxClient);
} catch (error) {
    console.error('Failed to initialize DAX client:', error.message);
}

async function runQuery(client, useCache) {
    const params = {
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
            ':pk': `COUNTRY#${country}`,
            ':sk': `DATE#${year}`,
        },
    };

    const start = Date.now();
    await client.send(new QueryCommand(params));
    return Date.now() - start;
}

async function runTest() {
    console.log('Starting performance test...\n');

    // Warm up caches
    console.log('Warming up caches...');
    for (let i = 0; i < 5; i++) {
        await runQuery(docClient, false);
        if (daxDocClient) await runQuery(daxDocClient, true);
    }

    // Test direct DynamoDB
    console.log('\nTesting direct DynamoDB access...');
    const dynamoTimes = [];
    for (let i = 0; i < iterations; i++) {
        const time = await runQuery(docClient, false);
        dynamoTimes.push(time);
        if (i % 10 === 0) process.stdout.write('.');
    }
    console.log('\n');

    // Test DAX
    let daxTimes = [];
    if (daxDocClient) {
        console.log('Testing DAX access...');
        for (let i = 0; i < iterations; i++) {
            const time = await runQuery(daxDocClient, true);
            daxTimes.push(time);
            if (i % 10 === 0) process.stdout.write('.');
        }
        console.log('\n');
    }

    // Calculate statistics
    const stats = (times) => {
        const sorted = times.sort((a, b) => a - b);
        return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            avg: times.reduce((a, b) => a + b, 0) / times.length,
            p50: sorted[Math.floor(times.length * 0.5)],
            p90: sorted[Math.floor(times.length * 0.9)],
            p99: sorted[Math.floor(times.length * 0.99)],
        };
    };

    // Print results
    console.log('\n=== Performance Test Results ===\n');
    
    const dynamoStats = stats(dynamoTimes);
    console.log('Direct DynamoDB Access:');
    console.log(`  Min: ${dynamoStats.min}ms`);
    console.log(`  Max: ${dynamoStats.max}ms`);
    console.log(`  Avg: ${dynamoStats.avg.toFixed(2)}ms`);
    console.log(`  P50: ${dynamoStats.p50}ms`);
    console.log(`  P90: ${dynamoStats.p90}ms`);
    console.log(`  P99: ${dynamoStats.p99}ms`);

    if (daxTimes.length > 0) {
        const daxStats = stats(daxTimes);
        console.log('\nDAX Cached Access:');
        console.log(`  Min: ${daxStats.min}ms`);
        console.log(`  Max: ${daxStats.max}ms`);
        console.log(`  Avg: ${daxStats.avg.toFixed(2)}ms`);
        console.log(`  P50: ${daxStats.p50}ms`);
        console.log(`  P90: ${daxStats.p90}ms`);
        console.log(`  P99: ${daxStats.p99}ms`);

        console.log('\nPerformance Improvement:');
        console.log(`  Avg Latency Reduction: ${((1 - daxStats.avg / dynamoStats.avg) * 100).toFixed(1)}%`);
        console.log(`  P99 Latency Reduction: ${((1 - daxStats.p99 / dynamoStats.p99) * 100).toFixed(1)}%`);
        
        if (daxStats.p99 < 10) {
            console.log('\n✅ SUCCESS: P99 latency is under 10ms!');
        } else {
            console.log('\n⚠️  WARNING: P99 latency is above 10ms target');
        }
    }
}

exports.handler = runTest;

// Run if executed directly
if (require.main === module) {
    runTest().catch(console.error);
}
EOF

# Run the test
echo -e "${YELLOW}Running performance test...${NC}"
echo ""

cd /tmp
npm init -y > /dev/null 2>&1
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-dax > /dev/null 2>&1

HOLIDAYS_TABLE=$HOLIDAYS_TABLE \
DAX_ENDPOINT=$DAX_ENDPOINT \
TEST_COUNTRY=$COUNTRY \
TEST_YEAR=$YEAR \
ITERATIONS=$ITERATIONS \
AWS_REGION=$REGION \
node -e "require('./dax-test.js').handler()"

echo ""
echo -e "${GREEN}Performance test complete!${NC}"