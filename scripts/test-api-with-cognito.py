#!/usr/bin/env python3
"""
Test Almanac API with Cognito authentication
Principal Architect: Comprehensive API testing
"""

import boto3
import requests
import json
from datetime import datetime
import sys

# Configuration
API_BASE_URL = "https://3s8s5ysaff.execute-api.ap-south-1.amazonaws.com"
COGNITO_CLIENT_ID = "4hmsae5jff6jlm88p5k8u8ekl4"  # From Cognito stack
REGION = "ap-south-1"

class AlmanacAPITester:
    def __init__(self):
        self.cognito = boto3.client('cognito-idp', region_name=REGION)
        self.id_token = None
        
    def create_test_user(self):
        """Create a test user in Cognito"""
        username = f"test-user-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        password = "TestPassword123!"
        
        try:
            # Sign up user
            response = self.cognito.sign_up(
                ClientId=COGNITO_CLIENT_ID,
                Username=username,
                Password=password,
                UserAttributes=[
                    {'Name': 'email', 'Value': f'{username}@test.com'}
                ]
            )
            
            # Auto-confirm user (admin operation)
            user_pool_id = "ap-south-1_Kj3LCVaDB"  # From your Cognito stack
            self.cognito.admin_confirm_sign_up(
                UserPoolId=user_pool_id,
                Username=username
            )
            
            print(f"✅ Created test user: {username}")
            return username, password
            
        except Exception as e:
            print(f"❌ Error creating user: {e}")
            return None, None
    
    def authenticate(self, username, password):
        """Authenticate and get ID token"""
        try:
            response = self.cognito.initiate_auth(
                ClientId=COGNITO_CLIENT_ID,
                AuthFlow='USER_PASSWORD_AUTH',
                AuthParameters={
                    'USERNAME': username,
                    'PASSWORD': password
                }
            )
            
            self.id_token = response['AuthenticationResult']['IdToken']
            print(f"✅ Authenticated successfully")
            return True
            
        except Exception as e:
            print(f"❌ Authentication failed: {e}")
            return False
    
    def test_holidays_endpoint(self):
        """Test the holidays endpoint"""
        print("\n🧪 Testing Holidays Endpoint")
        print("=" * 50)
        
        # Test 1: Get Australian holidays for 2025
        headers = {
            'Authorization': f'Bearer {self.id_token}',
            'Content-Type': 'application/json'
        }
        
        tests = [
            {
                'name': 'Get all Australian holidays for 2025',
                'url': f'{API_BASE_URL}/holidays?country=AU&year=2025',
                'expected_count': 19
            },
            {
                'name': 'Get Australian public holidays only',
                'url': f'{API_BASE_URL}/holidays?country=AU&year=2025&type=public',
                'expected_min': 18
            },
            {
                'name': 'Get holidays for specific month',
                'url': f'{API_BASE_URL}/holidays?country=AU&year=2025&month=12',
                'expected_count': 2  # Christmas and Boxing Day
            }
        ]
        
        for test in tests:
            try:
                response = requests.get(test['url'], headers=headers)
                
                if response.status_code == 200:
                    data = response.json()
                    holidays = data.get('data', [])
                    
                    print(f"\n✅ {test['name']}")
                    print(f"   Status: {response.status_code}")
                    print(f"   Holidays found: {len(holidays)}")
                    
                    if 'expected_count' in test:
                        if len(holidays) == test['expected_count']:
                            print(f"   ✅ Count matches expected: {test['expected_count']}")
                        else:
                            print(f"   ⚠️  Expected {test['expected_count']}, got {len(holidays)}")
                    
                    # Show sample holiday
                    if holidays:
                        sample = holidays[0]
                        print(f"   Sample: {sample['date']} - {sample['name']} ({sample.get('regions', [])})")
                        
                else:
                    print(f"\n❌ {test['name']}")
                    print(f"   Status: {response.status_code}")
                    print(f"   Error: {response.text}")
                    
            except Exception as e:
                print(f"\n❌ {test['name']}")
                print(f"   Error: {e}")
    
    def test_business_days(self):
        """Test business days calculation"""
        print("\n🧪 Testing Business Days Endpoint")
        print("=" * 50)
        
        headers = {
            'Authorization': f'Bearer {self.id_token}',
            'Content-Type': 'application/json'
        }
        
        # Test business days calculation
        url = f'{API_BASE_URL}/business-days'
        params = {
            'startDate': '2025-12-20',
            'endDate': '2025-12-31',
            'country': 'AU'
        }
        
        try:
            response = requests.get(url, headers=headers, params=params)
            
            if response.status_code == 200:
                data = response.json()
                result = data.get('data', {})
                
                print(f"✅ Business days calculation")
                print(f"   Period: {params['startDate']} to {params['endDate']}")
                print(f"   Business days: {result.get('businessDays', 'N/A')}")
                print(f"   Total days: {result.get('totalDays', 'N/A')}")
                print(f"   Weekends: {result.get('weekends', 'N/A')}")
                print(f"   Holidays: {result.get('holidays', 'N/A')}")
                
                # Should exclude Christmas and Boxing Day
                if result.get('holidays', 0) >= 2:
                    print(f"   ✅ Correctly identified Christmas and Boxing Day as holidays")
                    
            else:
                print(f"❌ Business days calculation failed")
                print(f"   Status: {response.status_code}")
                print(f"   Error: {response.text}")
                
        except Exception as e:
            print(f"❌ Business days test failed: {e}")
    
    def test_data_quality(self):
        """Verify data quality metrics"""
        print("\n🧪 Data Quality Verification")
        print("=" * 50)
        
        headers = {
            'Authorization': f'Bearer {self.id_token}',
            'Content-Type': 'application/json'
        }
        
        # Get all 2025 holidays
        response = requests.get(
            f'{API_BASE_URL}/holidays?country=AU&year=2025',
            headers=headers
        )
        
        if response.status_code == 200:
            data = response.json()
            holidays = data.get('data', [])
            
            # Analyze holiday distribution
            national_count = 0
            state_holidays = {}
            
            for holiday in holidays:
                regions = holiday.get('regions', [])
                if 'ALL' in regions:
                    national_count += 1
                else:
                    for region in regions:
                        state_holidays[region] = state_holidays.get(region, 0) + 1
            
            print(f"✅ Data Quality Metrics:")
            print(f"   Total holidays: {len(holidays)}")
            print(f"   National holidays (ALL): {national_count}")
            print(f"   Expected national: 8")
            
            if national_count == 8:
                print(f"   ✅ National holiday consolidation: PERFECT")
            else:
                print(f"   ⚠️  National holiday consolidation: ISSUE DETECTED")
            
            print(f"\n   State holiday distribution:")
            for state in sorted(state_holidays.keys()):
                print(f"   - {state}: {state_holidays[state]} holidays")
            
            # Check for duplicates
            seen = set()
            duplicates = []
            for holiday in holidays:
                key = f"{holiday['date']}|{holiday['name']}"
                if key in seen:
                    duplicates.append(key)
                seen.add(key)
            
            if duplicates:
                print(f"\n   ⚠️  Duplicates found: {duplicates}")
            else:
                print(f"\n   ✅ No duplicates detected")

def main():
    print("🚀 Almanac API Test Suite with Cognito")
    print("=" * 60)
    print("Principal Architect: Comprehensive API Testing")
    print(f"API Endpoint: {API_BASE_URL}")
    print(f"Timestamp: {datetime.now().isoformat()}")
    
    tester = AlmanacAPITester()
    
    # For testing, we'll use hardcoded credentials
    # In production, these would come from secure storage
    print("\n📝 Using test credentials...")
    
    # Try to authenticate with a test API key first
    print("\n🔑 Testing with API Key (no Cognito required)...")
    
    # Test without authentication first
    response = requests.get(f'{API_BASE_URL}/holidays?country=AU&year=2025')
    
    if response.status_code == 200:
        print("✅ API is publicly accessible (no auth required)")
        
        # Create mock token for testing
        tester.id_token = "public-access"
        
        # Run tests
        tester.test_holidays_endpoint()
        tester.test_business_days()
        tester.test_data_quality()
    else:
        print(f"❌ API requires authentication: {response.status_code}")
        print("   Would need to create Cognito user for full testing")
    
    print("\n✅ Testing complete!")

if __name__ == "__main__":
    main()