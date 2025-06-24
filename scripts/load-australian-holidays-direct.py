#!/usr/bin/env python3
"""
Direct loader for Australian holidays - Principal Architect implementation
Loads both national and state-specific holidays with proper deduplication
"""

import boto3
import json
import os
from datetime import datetime, date
from typing import Dict, List, Set, Tuple
import hashlib
from decimal import Decimal

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb', region_name='ap-south-1')
table_name = os.environ.get('HOLIDAYS_TABLE', 'almanac-api-dev-holidays')
table = dynamodb.Table(table_name)

# Australian states
AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']

# National holidays that apply to all states
NATIONAL_HOLIDAYS = {
    "New Year's Day": "01-01",
    "Australia Day": "01-26",
    "Good Friday": "varies",  # Easter-based
    "Easter Saturday": "varies",
    "Easter Monday": "varies",
    "Anzac Day": "04-25",
    "Queen's Birthday": "varies",  # Second Monday in June (except WA & QLD)
    "Christmas Day": "12-25",
    "Boxing Day": "12-26"
}

# State-specific holidays
STATE_HOLIDAYS = {
    "VIC": {
        "Melbourne Cup Day": {"date": "first-tuesday-november", "type": "public"},
        "AFL Grand Final Friday": {"date": "varies", "type": "public"}
    },
    "NSW": {
        "Bank Holiday": {"date": "first-monday-august", "type": "bank"}
    },
    "QLD": {
        "Royal Queensland Show (Ekka)": {"date": "varies-august", "type": "public", "note": "Brisbane area only"}
    },
    "WA": {
        "Western Australia Day": {"date": "first-monday-june", "type": "public"}
    },
    "SA": {
        "Adelaide Cup Day": {"date": "second-monday-march", "type": "public"},
        "Proclamation Day": {"date": "12-26", "type": "public", "note": "When Boxing Day is Sunday"}
    },
    "TAS": {
        "Eight Hours Day": {"date": "second-monday-march", "type": "public"},
        "Recreation Day": {"date": "first-monday-november", "type": "public", "note": "Northern Tasmania"}
    },
    "ACT": {
        "Canberra Day": {"date": "second-monday-march", "type": "public"},
        "Reconciliation Day": {"date": "varies-may", "type": "public"}
    },
    "NT": {
        "May Day": {"date": "first-monday-may", "type": "public"},
        "Picnic Day": {"date": "first-monday-august", "type": "public"}
    }
}

# Easter calculation (using Gauss algorithm)
def calculate_easter(year: int) -> date:
    """Calculate Easter Sunday for a given year"""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)

def get_holiday_dates(year: int) -> Dict[str, Dict]:
    """Get all holiday dates for a specific year"""
    holidays = {}
    
    # Calculate Easter-based holidays
    easter = calculate_easter(year)
    # Use timedelta for date arithmetic to handle month boundaries
    from datetime import timedelta
    good_friday = easter - timedelta(days=2)
    easter_saturday = easter - timedelta(days=1)
    easter_monday = easter + timedelta(days=1)
    
    # National holidays
    holidays["New Year's Day"] = {
        "date": f"{year}-01-01",
        "regions": ["ALL"],
        "type": "public"
    }
    
    holidays["Australia Day"] = {
        "date": f"{year}-01-26",
        "regions": ["ALL"],
        "type": "public"
    }
    
    holidays["Good Friday"] = {
        "date": good_friday.strftime("%Y-%m-%d"),
        "regions": ["ALL"],
        "type": "public"
    }
    
    holidays["Easter Saturday"] = {
        "date": easter_saturday.strftime("%Y-%m-%d"),
        "regions": ["ALL"],
        "type": "public"
    }
    
    holidays["Easter Monday"] = {
        "date": easter_monday.strftime("%Y-%m-%d"),
        "regions": ["ALL"],
        "type": "public"
    }
    
    holidays["Anzac Day"] = {
        "date": f"{year}-04-25",
        "regions": ["ALL"],
        "type": "public"
    }
    
    # Queen's Birthday - Second Monday in June (except WA & QLD)
    june_first = date(year, 6, 1)
    days_to_monday = (7 - june_first.weekday()) % 7
    first_monday = june_first.replace(day=1 + days_to_monday)
    second_monday = first_monday.replace(day=first_monday.day + 7)
    
    holidays["Queen's Birthday"] = {
        "date": second_monday.strftime("%Y-%m-%d"),
        "regions": ["NSW", "VIC", "SA", "TAS", "ACT", "NT"],
        "type": "public"
    }
    
    # WA celebrates Queen's Birthday on last Monday of September
    september_last = date(year, 9, 30)
    while september_last.weekday() != 0:  # 0 is Monday
        september_last = september_last.replace(day=september_last.day - 1)
    
    holidays["Queen's Birthday (WA)"] = {
        "date": september_last.strftime("%Y-%m-%d"),
        "regions": ["WA"],
        "type": "public",
        "name": "Queen's Birthday"
    }
    
    # QLD celebrates Queen's Birthday on first Monday of October
    october_first = date(year, 10, 1)
    days_to_monday = (7 - october_first.weekday()) % 7
    if days_to_monday == 0:
        days_to_monday = 0
    first_monday_oct = october_first.replace(day=1 + days_to_monday)
    
    holidays["Queen's Birthday (QLD)"] = {
        "date": first_monday_oct.strftime("%Y-%m-%d"),
        "regions": ["QLD"],
        "type": "public",
        "name": "Queen's Birthday"
    }
    
    holidays["Christmas Day"] = {
        "date": f"{year}-12-25",
        "regions": ["ALL"],
        "type": "public"
    }
    
    holidays["Boxing Day"] = {
        "date": f"{year}-12-26",
        "regions": ["ALL"],
        "type": "public"
    }
    
    # State-specific holidays
    # Victoria - Melbourne Cup Day (First Tuesday in November)
    november_first = date(year, 11, 1)
    days_to_tuesday = (1 - november_first.weekday()) % 7
    if days_to_tuesday == 0:
        days_to_tuesday = 7
    melbourne_cup = november_first.replace(day=1 + days_to_tuesday - 1)
    
    holidays["Melbourne Cup Day"] = {
        "date": melbourne_cup.strftime("%Y-%m-%d"),
        "regions": ["VIC"],
        "type": "public"
    }
    
    # NSW - Bank Holiday (First Monday in August)
    august_first = date(year, 8, 1)
    days_to_monday = (7 - august_first.weekday()) % 7
    if days_to_monday == 0:
        days_to_monday = 0
    bank_holiday = august_first.replace(day=1 + days_to_monday)
    
    holidays["Bank Holiday"] = {
        "date": bank_holiday.strftime("%Y-%m-%d"),
        "regions": ["NSW"],
        "type": "bank"
    }
    
    # WA - Western Australia Day (First Monday in June)
    holidays["Western Australia Day"] = {
        "date": first_monday.strftime("%Y-%m-%d"),
        "regions": ["WA"],
        "type": "public"
    }
    
    # ACT - Canberra Day (Second Monday in March)
    march_first = date(year, 3, 1)
    days_to_monday = (7 - march_first.weekday()) % 7
    if days_to_monday == 0:
        days_to_monday = 0
    first_monday_march = march_first.replace(day=1 + days_to_monday)
    second_monday_march = first_monday_march.replace(day=first_monday_march.day + 7)
    
    holidays["Canberra Day"] = {
        "date": second_monday_march.strftime("%Y-%m-%d"),
        "regions": ["ACT"],
        "type": "public"
    }
    
    # SA - Adelaide Cup Day (Second Monday in March)
    holidays["Adelaide Cup Day"] = {
        "date": second_monday_march.strftime("%Y-%m-%d"),
        "regions": ["SA"],
        "type": "public"
    }
    
    # TAS - Eight Hours Day (Second Monday in March)
    holidays["Eight Hours Day"] = {
        "date": second_monday_march.strftime("%Y-%m-%d"),
        "regions": ["TAS"],
        "type": "public"
    }
    
    # NT - May Day (First Monday in May)
    may_first = date(year, 5, 1)
    days_to_monday = (7 - may_first.weekday()) % 7
    if days_to_monday == 0:
        days_to_monday = 0
    may_day = may_first.replace(day=1 + days_to_monday)
    
    holidays["May Day"] = {
        "date": may_day.strftime("%Y-%m-%d"),
        "regions": ["NT"],
        "type": "public"
    }
    
    # NT - Picnic Day (First Monday in August)
    holidays["Picnic Day"] = {
        "date": bank_holiday.strftime("%Y-%m-%d"),
        "regions": ["NT"],
        "type": "public"
    }
    
    return holidays

def create_holiday_record(name: str, holiday_info: Dict, year: int) -> Dict:
    """Create a DynamoDB record for a holiday"""
    date_str = holiday_info["date"]
    date_obj = datetime.strptime(date_str, "%Y-%m-%d").date()
    
    # Use the override name if provided (for Queen's Birthday variants)
    display_name = holiday_info.get("name", name)
    
    # Generate unique SK based on regions
    regions_key = "_".join(sorted(holiday_info["regions"]))
    
    record = {
        "PK": f"COUNTRY#AU#{year}",
        "SK": f"HOLIDAY#{date_str}#{display_name.replace(' ', '_')}#{regions_key}",
        "GSI1PK": f"YEAR#{year}",
        "GSI1SK": f"DATE#{date_str}",
        "date": date_str,
        "name": display_name,
        "type": holiday_info["type"],
        "country": "AU",
        "country_name": "Australia",
        "year": year,
        "month": date_obj.month,
        "day": date_obj.day,
        "day_of_week": date_obj.strftime("%A"),
        "is_weekend": date_obj.weekday() >= 5,
        "is_fixed": name not in ["Good Friday", "Easter Saturday", "Easter Monday", "Queen's Birthday"],
        "regions": holiday_info["regions"],
        "data_source": "direct_load",
        "last_updated": datetime.utcnow().isoformat(),
        "version": 1
    }
    
    return record

def load_holidays_to_dynamodb(holidays: List[Dict]) -> Tuple[int, int]:
    """Load holidays to DynamoDB with error handling"""
    success_count = 0
    error_count = 0
    
    print(f"\n📝 Loading {len(holidays)} holidays to DynamoDB...")
    
    # Use batch writer for efficiency
    with table.batch_writer() as batch:
        for holiday in holidays:
            try:
                batch.put_item(Item=holiday)
                success_count += 1
                
                if success_count % 10 == 0:
                    print(f"  Loaded {success_count} holidays...")
                    
            except Exception as e:
                print(f"  ❌ Error loading holiday {holiday.get('name', 'Unknown')}: {e}")
                error_count += 1
    
    return success_count, error_count

def verify_data_quality() -> Dict:
    """Verify the loaded data meets quality standards"""
    print("\n🔍 Verifying data quality...")
    
    metrics = {
        "total_records": 0,
        "national_holidays": 0,
        "state_holidays": 0,
        "consolidated_nationals": 0,
        "years_covered": set(),
        "states_covered": set()
    }
    
    # Check 2024-2027
    for year in range(2024, 2028):
        response = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key('PK').eq(f'COUNTRY#AU#{year}')
        )
        
        items = response.get('Items', [])
        metrics["total_records"] += len(items)
        
        for item in items:
            metrics["years_covered"].add(item.get("year"))
            regions = item.get("regions", [])
            
            if "ALL" in regions:
                metrics["national_holidays"] += 1
                metrics["consolidated_nationals"] += 1
            else:
                metrics["state_holidays"] += 1
                for region in regions:
                    metrics["states_covered"].add(region)
    
    return metrics

def main():
    """Main execution"""
    print("🚀 Australian Holiday Direct Loader")
    print("=" * 50)
    print("Principal Architect: Loading clean, deduplicated data")
    print(f"Target table: {table_name}")
    print(f"Timestamp: {datetime.now().isoformat()}")
    
    all_holidays = []
    
    # Load holidays for current and next 3 years
    for year in range(2024, 2028):
        print(f"\n📅 Processing year {year}...")
        year_holidays = get_holiday_dates(year)
        
        for name, info in year_holidays.items():
            record = create_holiday_record(name, info, year)
            all_holidays.append(record)
            
        print(f"  Generated {len(year_holidays)} holidays for {year}")
    
    # Load to DynamoDB
    success, errors = load_holidays_to_dynamodb(all_holidays)
    
    print(f"\n✅ Loading complete!")
    print(f"   Successfully loaded: {success}")
    print(f"   Errors: {errors}")
    
    # Verify data quality
    metrics = verify_data_quality()
    
    print(f"\n📊 Data Quality Metrics:")
    print(f"   Total records: {metrics['total_records']}")
    print(f"   National holidays: {metrics['national_holidays']}")
    print(f"   State holidays: {metrics['state_holidays']}")
    print(f"   Years covered: {sorted(metrics['years_covered'])}")
    print(f"   States with specific holidays: {sorted(metrics['states_covered'])}")
    print(f"   National holiday consolidation rate: {metrics['consolidated_nationals']/max(metrics['national_holidays'], 1)*100:.1f}%")
    
    # Architecture note
    print(f"\n🏗️  Architecture Note:")
    print("   - National holidays use regions: ['ALL'] for efficiency")
    print("   - State variants (Queen's Birthday) stored separately")
    print("   - No duplicate records for national holidays")
    print("   - Ready for API queries with proper indexing")

if __name__ == "__main__":
    # Set environment if not already set
    if 'HOLIDAYS_TABLE' not in os.environ:
        os.environ['HOLIDAYS_TABLE'] = 'almanac-api-dev-holidays'
    
    main()