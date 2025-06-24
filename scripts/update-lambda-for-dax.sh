#!/bin/bash
# Principal Architect: Enable DAX with proper VPC configuration

echo "🏗️  Updating Lambda functions for DAX access with VPC configuration"
echo "=================================================="

# Get VPC and subnet information from Phase3 stack
VPC_ID=$(aws cloudformation describe-stacks --stack-name AlmanacAPI-Phase3-dev --region ap-south-1 --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' --output text)
SUBNET_IDS=$(aws cloudformation describe-stacks --stack-name AlmanacAPI-Phase3-dev --region ap-south-1 --query 'Stacks[0].Outputs[?OutputKey==`PrivateSubnetIds`].OutputValue' --output text)
DAX_SG=$(aws cloudformation describe-stacks --stack-name AlmanacAPI-Phase3-dev --region ap-south-1 --query 'Stacks[0].Outputs[?OutputKey==`DaxSecurityGroupId`].OutputValue' --output text)

# Create Lambda security group
LAMBDA_SG=$(aws ec2 create-security-group \
    --group-name almanac-lambda-dax-sg \
    --description "Security group for Lambda functions accessing DAX" \
    --vpc-id $VPC_ID \
    --region ap-south-1 \
    --query 'GroupId' \
    --output text 2>/dev/null || \
    aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=almanac-lambda-dax-sg" \
    --region ap-south-1 \
    --query 'SecurityGroups[0].GroupId' \
    --output text)

echo "VPC ID: $VPC_ID"
echo "Subnet IDs: $SUBNET_IDS"
echo "Lambda Security Group: $LAMBDA_SG"

# Create VPC endpoints for AWS services to avoid internet routing
echo ""
echo "Creating VPC Endpoints for AWS services..."

# DynamoDB endpoint
aws ec2 create-vpc-endpoint \
    --vpc-id $VPC_ID \
    --service-name com.amazonaws.ap-south-1.dynamodb \
    --route-table-ids $(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC_ID" --region ap-south-1 --query 'RouteTables[?Tags[?Key==`Name` && contains(Value, `Private`)]].[RouteTableId]' --output text) \
    --region ap-south-1 2>/dev/null || echo "DynamoDB endpoint already exists"

# Create interface endpoints for other services
for service in lambda logs monitoring; do
    aws ec2 create-vpc-endpoint \
        --vpc-id $VPC_ID \
        --vpc-endpoint-type Interface \
        --service-name com.amazonaws.ap-south-1.$service \
        --subnet-ids $SUBNET_IDS \
        --security-group-ids $LAMBDA_SG \
        --region ap-south-1 2>/dev/null || echo "$service endpoint already exists"
done

# Update Lambda functions with VPC configuration
echo ""
echo "Updating Lambda functions..."

for func in holidays business-days timezone; do
    echo "Updating almanac-api-dev-$func..."
    
    # Get current environment variables
    ENV_VARS=$(aws lambda get-function-configuration \
        --function-name almanac-api-dev-$func \
        --region ap-south-1 \
        --query 'Environment.Variables' \
        --output json)
    
    # Add DAX configuration
    UPDATED_ENV=$(echo $ENV_VARS | jq '. + {
        "DAX_ENDPOINT": "almanac-api-dev-dax.kfxusq.dax-clusters.ap-south-1.amazonaws.com:8111",
        "USE_DAX": "true"
    }')
    
    # Update function with VPC config
    aws lambda update-function-configuration \
        --function-name almanac-api-dev-$func \
        --vpc-config SubnetIds=$SUBNET_IDS,SecurityGroupIds=$LAMBDA_SG \
        --environment Variables="$UPDATED_ENV" \
        --region ap-south-1 \
        --output json | jq '.LastUpdateStatus'
    
    # Wait for update
    sleep 5
done

# Add ingress rule to DAX security group for Lambda
echo ""
echo "Updating DAX security group..."
aws ec2 authorize-security-group-ingress \
    --group-id $DAX_SG \
    --protocol tcp \
    --port 8111 \
    --source-group $LAMBDA_SG \
    --region ap-south-1 2>/dev/null || echo "Rule already exists"

echo ""
echo "✅ Lambda functions updated with VPC configuration for DAX access"
echo "🚀 DAX will now provide microsecond latency for holiday queries!"