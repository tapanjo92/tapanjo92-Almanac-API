#!/bin/bash

# Post-deployment script to update Lambda functions with Phase 3 resources
# This avoids circular dependencies in CDK

set -e

ENV=${1:-dev}
REGION=${AWS_REGION:-ap-south-1}

echo "🔄 Post-deployment Phase 3 configuration"
echo "Environment: $ENV"
echo "Region: $REGION"

# Check if Phase 3 stack exists
PHASE3_STATUS=$(aws cloudformation describe-stacks \
    --stack-name AlmanacAPI-Phase3-$ENV \
    --region $REGION \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || echo "NOT_FOUND")

if [[ "$PHASE3_STATUS" == "NOT_FOUND" ]]; then
    echo "❌ Phase 3 stack not found. Please deploy Phase 3 first."
    exit 1
fi

if [[ "$PHASE3_STATUS" != "CREATE_COMPLETE" && "$PHASE3_STATUS" != "UPDATE_COMPLETE" ]]; then
    echo "❌ Phase 3 stack is in $PHASE3_STATUS state. Please wait for it to complete."
    exit 1
fi

echo "✅ Phase 3 stack found and ready"

# Get Phase 3 outputs
echo "📊 Getting Phase 3 resources..."

USER_USAGE_TABLE=$(aws cloudformation describe-stacks \
    --stack-name AlmanacAPI-Phase3-$ENV \
    --region $REGION \
    --query "Stacks[0].Outputs[?OutputKey=='UserUsageTableName'].OutputValue" \
    --output text)

API_KEYS_TABLE=$(aws cloudformation describe-stacks \
    --stack-name AlmanacAPI-Phase3-$ENV \
    --region $REGION \
    --query "Stacks[0].Outputs[?OutputKey=='ApiKeysTableName'].OutputValue" \
    --output text)

DAX_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name AlmanacAPI-Phase3-$ENV \
    --region $REGION \
    --query "Stacks[0].Outputs[?OutputKey=='DaxClusterEndpoint'].OutputValue" \
    --output text)

echo "  User Usage Table: $USER_USAGE_TABLE"
echo "  API Keys Table: $API_KEYS_TABLE"
echo "  DAX Endpoint: $DAX_ENDPOINT"

# Lambda function names
LAMBDA_FUNCTIONS=(
    "almanac-api-$ENV-holidays"
    "almanac-api-$ENV-business-days"
    "almanac-api-$ENV-timezone"
)

# Update Lambda environment variables
echo ""
echo "🔧 Updating Lambda functions..."

for FUNCTION_NAME in "${LAMBDA_FUNCTIONS[@]}"; do
    echo -n "  Updating $FUNCTION_NAME..."
    
    # Get current environment variables
    CURRENT_ENV=$(aws lambda get-function-configuration \
        --function-name $FUNCTION_NAME \
        --region $REGION \
        --query "Environment.Variables" \
        --output json 2>/dev/null || echo "{}")
    
    # Update with Phase 3 variables
    UPDATED_ENV=$(echo $CURRENT_ENV | jq --arg uut "$USER_USAGE_TABLE" \
        --arg akt "$API_KEYS_TABLE" \
        --arg dax "$DAX_ENDPOINT" \
        '. + {USER_USAGE_TABLE: $uut, API_KEYS_TABLE: $akt, DAX_ENDPOINT: $dax}')
    
    # Write to temp file to avoid shell escaping issues
    echo "$UPDATED_ENV" > /tmp/env-vars.json
    
    aws lambda update-function-configuration \
        --function-name $FUNCTION_NAME \
        --region $REGION \
        --cli-input-json "{\"Environment\": {\"Variables\": $(cat /tmp/env-vars.json)}}" \
        --output text > /dev/null
    
    rm -f /tmp/env-vars.json
    
    echo " ✓"
done

# Update Lambda IAM policies
echo ""
echo "🔐 Updating IAM policies..."

for FUNCTION_NAME in "${LAMBDA_FUNCTIONS[@]}"; do
    # Get the Lambda execution role
    ROLE_ARN=$(aws lambda get-function \
        --function-name $FUNCTION_NAME \
        --region $REGION \
        --query "Configuration.Role" \
        --output text)
    
    ROLE_NAME=$(echo $ROLE_ARN | awk -F'/' '{print $NF}')
    
    echo -n "  Updating policy for $FUNCTION_NAME..."
    
    # Create Phase 3 access policy
    cat > /tmp/phase3-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem"
            ],
            "Resource": [
                "arn:aws:dynamodb:$REGION:*:table/$USER_USAGE_TABLE",
                "arn:aws:dynamodb:$REGION:*:table/$USER_USAGE_TABLE/index/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:GetItem",
                "dynamodb:Query"
            ],
            "Resource": [
                "arn:aws:dynamodb:$REGION:*:table/$API_KEYS_TABLE",
                "arn:aws:dynamodb:$REGION:*:table/$API_KEYS_TABLE/index/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "dax:*"
            ],
            "Resource": [
                "*"
            ]
        }
    ]
}
EOF
    
    # Attach the policy
    aws iam put-role-policy \
        --role-name $ROLE_NAME \
        --policy-name Phase3TableAccess \
        --policy-document file:///tmp/phase3-policy.json 2>/dev/null
    
    echo " ✓"
done

rm -f /tmp/phase3-policy.json

echo ""
echo "✅ Phase 3 post-deployment configuration complete!"
echo ""
echo "ℹ️  Lambda functions now have access to:"
echo "   - User usage tracking table"
echo "   - API keys table"
echo "   - DAX cluster for caching"
echo ""
echo "Note: It may take a few seconds for the changes to propagate."