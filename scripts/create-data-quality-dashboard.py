#!/usr/bin/env python3
import boto3
import json

# Create CloudWatch dashboard for data quality monitoring
cloudwatch = boto3.client('cloudwatch', region_name='ap-south-1')

dashboard_name = 'AlmanacAPI-DataQuality'
dashboard_body = {
    "widgets": [
        {
            "type": "metric",
            "x": 0,
            "y": 0,
            "width": 12,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AlmanacAPI/ETL", "HolidayDataQualityScore", { "stat": "Average", "period": 300 } ],
                    [ ".", ".", { "stat": "Maximum", "period": 300 } ],
                    [ ".", ".", { "stat": "Minimum", "period": 300 } ]
                ],
                "view": "timeSeries",
                "stacked": False,
                "region": "ap-south-1",
                "title": "Holiday Data Quality Score",
                "period": 300,
                "yAxis": {
                    "left": {
                        "min": 0,
                        "max": 100
                    }
                }
            }
        },
        {
            "type": "metric",
            "x": 12,
            "y": 0,
            "width": 12,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AlmanacAPI/ETL", "HolidayRecordCount", { "stat": "Sum", "period": 300 } ]
                ],
                "view": "timeSeries",
                "stacked": False,
                "region": "ap-south-1",
                "title": "Holiday Record Count",
                "period": 300
            }
        },
        {
            "type": "metric",
            "x": 0,
            "y": 6,
            "width": 12,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AlmanacAPI/ETL", "HolidayDataSources", { "stat": "Maximum", "period": 300 } ]
                ],
                "view": "timeSeries",
                "stacked": False,
                "region": "ap-south-1",
                "title": "Number of Data Sources",
                "period": 300
            }
        },
        {
            "type": "metric",
            "x": 12,
            "y": 6,
            "width": 12,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AWS/Glue", "glue.ALL.s3.filesystem.read_bytes", { "stat": "Sum", "period": 300 } ],
                    [ ".", "glue.ALL.s3.filesystem.write_bytes", { "stat": "Sum", "period": 300 } ]
                ],
                "view": "timeSeries",
                "stacked": False,
                "region": "ap-south-1",
                "title": "Glue Job Data Transfer",
                "period": 300,
                "yAxis": {
                    "left": {
                        "showUnits": True
                    }
                }
            }
        },
        {
            "type": "metric",
            "x": 0,
            "y": 12,
            "width": 24,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AlmanacAPI/DataQuality", "completeness", { "stat": "Average", "period": 86400 } ],
                    [ ".", "uniqueness", { "stat": "Average", "period": 86400 } ],
                    [ ".", "consistency", { "stat": "Average", "period": 86400 } ],
                    [ ".", "accuracy", { "stat": "Average", "period": 86400 } ],
                    [ ".", "timeliness", { "stat": "Average", "period": 86400 } ]
                ],
                "view": "timeSeries",
                "stacked": False,
                "region": "ap-south-1",
                "title": "Data Quality Dimensions",
                "period": 86400
            }
        }
    ]
}

try:
    response = cloudwatch.put_dashboard(
        DashboardName=dashboard_name,
        DashboardBody=json.dumps(dashboard_body)
    )
    print(f"Created dashboard: {dashboard_name}")
    print(f"Dashboard URL: https://ap-south-1.console.aws.amazon.com/cloudwatch/home?region=ap-south-1#dashboards:name={dashboard_name}")
except Exception as e:
    print(f"Error creating dashboard: {e}")

# Create CloudWatch alarm for data quality
try:
    cloudwatch.put_metric_alarm(
        AlarmName='AlmanacAPI-LowDataQuality',
        ComparisonOperator='LessThanThreshold',
        EvaluationPeriods=1,
        MetricName='HolidayDataQualityScore',
        Namespace='AlmanacAPI/ETL',
        Period=300,
        Statistic='Average',
        Threshold=80.0,
        ActionsEnabled=True,
        AlarmActions=[
            'arn:aws:sns:ap-south-1:809555764832:almanac-api-dev-data-approval'
        ],
        AlarmDescription='Alert when data quality score drops below 80%',
        Dimensions=[
            {
                'Name': 'Country',
                'Value': 'AU'
            },
            {
                'Name': 'Environment', 
                'Value': 'dev'
            }
        ]
    )
    print("Created data quality alarm")
except Exception as e:
    print(f"Error creating alarm: {e}")