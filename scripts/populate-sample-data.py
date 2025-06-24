#!/usr/bin/env python3
"""
Populate DynamoDB tables with sample holiday and timezone data
"""

import boto3
import json
from datetime import datetime
from decimal import Decimal

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')

def populate_holidays():
    """Populate holidays table with sample data"""
    table = dynamodb.Table('almanac-api-dev-holidays')
    
    # Sample holidays for 2024
    holidays = [
        # Australia
        {"date": "2024-01-01", "name": "New Year's Day", "country": "AU", "type": "public"},
        {"date": "2024-01-26", "name": "Australia Day", "country": "AU", "type": "public"},
        {"date": "2024-03-29", "name": "Good Friday", "country": "AU", "type": "public"},
        {"date": "2024-04-01", "name": "Easter Monday", "country": "AU", "type": "public"},
        {"date": "2024-04-25", "name": "Anzac Day", "country": "AU", "type": "public"},
        {"date": "2024-06-10", "name": "Queen's Birthday", "country": "AU", "type": "public"},
        {"date": "2024-12-25", "name": "Christmas Day", "country": "AU", "type": "public"},
        {"date": "2024-12-26", "name": "Boxing Day", "country": "AU", "type": "public"},
        
        # UK
        {"date": "2024-01-01", "name": "New Year's Day", "country": "UK", "type": "public"},
        {"date": "2024-03-29", "name": "Good Friday", "country": "UK", "type": "public"},
        {"date": "2024-04-01", "name": "Easter Monday", "country": "UK", "type": "public"},
        {"date": "2024-05-06", "name": "Early May Bank Holiday", "country": "UK", "type": "bank"},
        {"date": "2024-05-27", "name": "Spring Bank Holiday", "country": "UK", "type": "bank"},
        {"date": "2024-08-26", "name": "Summer Bank Holiday", "country": "UK", "type": "bank"},
        {"date": "2024-12-25", "name": "Christmas Day", "country": "UK", "type": "public"},
        {"date": "2024-12-26", "name": "Boxing Day", "country": "UK", "type": "public"},
        
        # Germany
        {"date": "2024-01-01", "name": "Neujahr", "country": "DE", "type": "public"},
        {"date": "2024-03-29", "name": "Karfreitag", "country": "DE", "type": "public"},
        {"date": "2024-04-01", "name": "Ostermontag", "country": "DE", "type": "public"},
        {"date": "2024-05-01", "name": "Tag der Arbeit", "country": "DE", "type": "public"},
        {"date": "2024-10-03", "name": "Tag der Deutschen Einheit", "country": "DE", "type": "public"},
        {"date": "2024-12-25", "name": "1. Weihnachtstag", "country": "DE", "type": "public"},
        {"date": "2024-12-26", "name": "2. Weihnachtstag", "country": "DE", "type": "public"},
    ]
    
    with table.batch_writer() as batch:
        for holiday in holidays:
            date_obj = datetime.strptime(holiday['date'], '%Y-%m-%d')
            item = {
                'PK': f"COUNTRY#{holiday['country']}",
                'SK': f"DATE#{holiday['date']}",
                'date': holiday['date'],
                'name': holiday['name'],
                'type': holiday['type'],
                'country': holiday['country'],
                'country_name': get_country_name(holiday['country']),
                'year': date_obj.year,
                'month': date_obj.month,
                'day': date_obj.day,
                'day_of_week': date_obj.strftime('%A'),
                'is_weekend': date_obj.weekday() >= 5,
                'is_fixed': True,
                'processed_timestamp': datetime.now().isoformat()
            }
            batch.put_item(Item=item)
    
    print(f"Populated {len(holidays)} holidays")

def populate_timezones():
    """Populate timezones table with sample data"""
    table = dynamodb.Table('almanac-api-dev-timezones')
    
    timezones = [
        # Australia
        {"timezone": "Australia/Sydney", "country": "AU", "city": "Sydney", "state": "NSW", "utc_offset": 39600},
        {"timezone": "Australia/Melbourne", "country": "AU", "city": "Melbourne", "state": "VIC", "utc_offset": 39600},
        {"timezone": "Australia/Brisbane", "country": "AU", "city": "Brisbane", "state": "QLD", "utc_offset": 36000},
        {"timezone": "Australia/Perth", "country": "AU", "city": "Perth", "state": "WA", "utc_offset": 28800},
        
        # UK
        {"timezone": "Europe/London", "country": "UK", "city": "London", "state": None, "utc_offset": 0},
        
        # Germany
        {"timezone": "Europe/Berlin", "country": "DE", "city": "Berlin", "state": None, "utc_offset": 3600},
        {"timezone": "Europe/Munich", "country": "DE", "city": "Munich", "state": "Bavaria", "utc_offset": 3600},
    ]
    
    with table.batch_writer() as batch:
        for tz in timezones:
            item = {
                'PK': f"COUNTRY#{tz['country']}",
                'SK': f"TIMEZONE#{tz['timezone']}",
                'timezone': tz['timezone'],
                'timezone_name': tz['timezone'],
                'timezone_abbr': get_timezone_abbr(tz['utc_offset']),
                'country': tz['country'],
                'country_name': get_country_name(tz['country']),
                'city': tz['city'],
                'utc_offset': tz['utc_offset'],
                'utc_offset_hours': Decimal(str(tz['utc_offset'] / 3600)),
                'dst_offset': 3600 if tz['utc_offset'] > 0 else 0,
                'has_dst': tz['country'] != 'AU' or tz['city'] not in ['Brisbane', 'Perth'],
                'is_dst_active': False,
                'processed_timestamp': datetime.now().isoformat()
            }
            if tz['state']:
                item['state'] = tz['state']
            batch.put_item(Item=item)
    
    print(f"Populated {len(timezones)} timezones")

def get_country_name(code):
    """Get country name from code"""
    return {
        'AU': 'Australia',
        'UK': 'United Kingdom',
        'DE': 'Germany'
    }.get(code, code)

def get_timezone_abbr(offset):
    """Get timezone abbreviation based on offset"""
    if offset == 0:
        return 'GMT'
    elif offset == 3600:
        return 'CET'
    elif offset == 28800:
        return 'AWST'
    elif offset == 36000:
        return 'AEST'
    elif offset == 39600:
        return 'AEDT'
    return 'UTC'

if __name__ == '__main__':
    print("Populating DynamoDB tables with sample data...")
    populate_holidays()
    populate_timezones()
    print("Done!")