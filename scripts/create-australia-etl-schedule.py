#!/usr/bin/env python3
import boto3
import json

# Create EventBridge rule to run Australia Holiday ETL monthly
events = boto3.client('events', region_name='ap-south-1')

# Create rule - run on the 1st of every month at 2 AM UTC
rule_name = 'almanac-api-dev-australia-holiday-etl-schedule'

try:
    # Create the rule
    response = events.put_rule(
        Name=rule_name,
        Description='Monthly Australian holiday data refresh',
        ScheduleExpression='cron(0 2 1 * ? *)',  # 2 AM UTC on 1st of month
        State='ENABLED'
    )
    
    print(f"Created EventBridge rule: {response['RuleArn']}")
    
    # Add target - Glue job
    events.put_targets(
        Rule=rule_name,
        Targets=[
            {
                'Id': '1',
                'Arn': 'arn:aws:glue:ap-south-1:809555764832:job/almanac-api-dev-australia-holiday-etl',
                'RoleArn': 'arn:aws:iam::809555764832:role/service-role/AWSGlueServiceRole'
            }
        ]
    )
    
    print(f"Added Glue job as target for rule {rule_name}")
    
except Exception as e:
    print(f"Error creating schedule: {e}")

# Alternative: Create Step Functions state machine for more complex workflow
sfn = boto3.client('stepfunctions', region_name='ap-south-1')

state_machine_definition = {
    "Comment": "Australian Holiday ETL Pipeline",
    "StartAt": "StartAustraliaETL",
    "States": {
        "StartAustraliaETL": {
            "Type": "Task",
            "Resource": "arn:aws:states:::glue:startJobRun.sync",
            "Parameters": {
                "JobName": "almanac-api-dev-australia-holiday-etl"
            },
            "Next": "CheckDataQuality"
        },
        "CheckDataQuality": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:ap-south-1:809555764832:function:almanac-api-dev-data-quality",
            "Parameters": {
                "tableName": "almanac-api-dev-holidays",
                "dataType": "holidays"
            },
            "Next": "NotifyCompletion"
        },
        "NotifyCompletion": {
            "Type": "Task",
            "Resource": "arn:aws:states:::sns:publish",
            "Parameters": {
                "TopicArn": "arn:aws:sns:ap-south-1:809555764832:almanac-api-dev-data-approval",
                "Subject": "Australian Holiday ETL Complete",
                "Message.$": "$.Payload"
            },
            "End": true
        }
    }
}

print(f"\nStep Functions definition created for Australian Holiday ETL workflow")
print("To deploy, add this to your CDK stack or create via console")