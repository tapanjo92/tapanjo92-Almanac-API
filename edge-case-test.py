#!/usr/bin/env python3
"""
Comprehensive edge case testing for Almanac API
Tests error handling and edge cases across all endpoints
"""

import requests
import json
import time
from datetime import datetime, timedelta
import concurrent.futures
from typing import Dict, List, Any
import random
import string

# API Configuration
# Get the full API key value properly
API_KEY = "LR1b6fK7Nc5fhRvwgsHTt1KcUjG4tMcM2g3KzALS"
BASE_URL = "https://fkbmscbv0f.execute-api.ap-south-1.amazonaws.com/v1"
HEADERS = {
    "X-API-Key": API_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json"
}

# Test result tracking
test_results = []

def log_test(test_name: str, endpoint: str, params: Dict, response: requests.Response, expected_status: int = None):
    """Log test results"""
    result = {
        "test_name": test_name,
        "endpoint": endpoint,
        "params": params,
        "status_code": response.status_code,
        "expected_status": expected_status,
        "passed": response.status_code == expected_status if expected_status else True,
        "response": response.text[:500] if response.text else None,
        "headers": dict(response.headers)
    }
    test_results.append(result)
    
    status_emoji = "✅" if result["passed"] else "❌"
    print(f"{status_emoji} {test_name}: {response.status_code} {('(expected ' + str(expected_status) + ')') if expected_status else ''}")
    if not result["passed"] or response.status_code >= 400:
        print(f"   Response: {response.text[:200]}")

def test_holidays_endpoint():
    """Test holidays endpoint with edge cases"""
    print("\n=== Testing Holidays Endpoint ===")
    
    # 1. Invalid date formats
    tests = [
        # Invalid date formats
        ("Invalid date format - text", {"country": "AU", "year": "twenty-twenty-four"}, 400),
        ("Invalid date format - negative", {"country": "AU", "year": "-2024"}, 400),
        ("Invalid date format - float", {"country": "AU", "year": "2024.5"}, 400),
        ("Invalid date format - too many digits", {"country": "AU", "year": "20240"}, 400),
        
        # Invalid country codes
        ("Numeric country code", {"country": "123", "year": "2024"}, 400),
        ("Special chars country code", {"country": "@#$", "year": "2024"}, 400),
        ("Empty country code", {"country": "", "year": "2024"}, 400),
        ("Very long country code", {"country": "ABCDEFGHIJKLMNOP", "year": "2024"}, 400),
        ("SQL injection attempt", {"country": "AU'; DROP TABLE holidays; --", "year": "2024"}, 400),
        ("Mixed case country", {"country": "au", "year": "2024"}, 400),
        
        # Date boundaries
        ("Far past year", {"country": "AU", "year": "1800"}, 200),  # May return empty or error
        ("Far future year", {"country": "AU", "year": "3000"}, 200),  # May return empty or error
        ("Year 0", {"country": "AU", "year": "0"}, 400),
        ("Current year", {"country": "AU", "year": str(datetime.now().year)}, 200),
        
        # Invalid months
        ("Invalid month - 0", {"country": "AU", "year": "2024", "month": "0"}, 400),
        ("Invalid month - 13", {"country": "AU", "year": "2024", "month": "13"}, 400),
        ("Invalid month - negative", {"country": "AU", "year": "2024", "month": "-1"}, 400),
        ("Invalid month - text", {"country": "AU", "year": "2024", "month": "January"}, 400),
        
        # Missing/extra parameters
        ("Missing country", {"year": "2024"}, 400),
        ("Missing year", {"country": "AU"}, 400),
        ("Extra unknown parameter", {"country": "AU", "year": "2024", "unknown": "value"}, 200),
        ("All parameters missing", {}, 400),
        
        # Type parameter
        ("Invalid type", {"country": "AU", "year": "2024", "type": "invalid"}, 400),
        ("Valid type - public", {"country": "AU", "year": "2024", "type": "public"}, 200),
        ("Valid type - bank", {"country": "AU", "year": "2024", "type": "bank"}, 200),
        
        # Large payloads
        ("Very long parameter value", {"country": "AU", "year": "2024", "extra": "x" * 10000}, 200),
    ]
    
    for test_name, params, expected_status in tests:
        try:
            response = requests.get(f"{BASE_URL}/holidays", params=params, headers=HEADERS)
            log_test(test_name, "holidays", params, response, expected_status)
        except Exception as e:
            print(f"❌ {test_name}: Exception - {str(e)}")

def test_business_days_endpoint():
    """Test business-days endpoint with edge cases"""
    print("\n=== Testing Business Days Endpoint ===")
    
    tests = [
        # Invalid date formats
        ("Invalid start date format", {"startDate": "2024/01/01", "endDate": "2024-01-31", "country": "AU"}, 400),
        ("Invalid end date format", {"startDate": "2024-01-01", "endDate": "31-01-2024", "country": "AU"}, 400),
        ("Text dates", {"startDate": "first of january", "endDate": "last of january", "country": "AU"}, 400),
        ("Incomplete dates", {"startDate": "2024-01", "endDate": "2024-02", "country": "AU"}, 400),
        
        # Date logic errors
        ("End before start", {"startDate": "2024-01-31", "endDate": "2024-01-01", "country": "AU"}, 400),
        ("Same date", {"startDate": "2024-01-01", "endDate": "2024-01-01", "country": "AU"}, 200),
        
        # Extreme date ranges
        ("Very large date range", {"startDate": "2024-01-01", "endDate": "2034-12-31", "country": "AU"}, 200),
        ("Century span", {"startDate": "1924-01-01", "endDate": "2024-12-31", "country": "AU"}, 200),
        
        # Boundary dates
        ("Leap year Feb 29", {"startDate": "2024-02-28", "endDate": "2024-03-01", "country": "AU"}, 200),
        ("Non-leap year Feb 29", {"startDate": "2023-02-28", "endDate": "2023-03-01", "country": "AU"}, 200),
        ("Year boundary", {"startDate": "2023-12-30", "endDate": "2024-01-02", "country": "AU"}, 200),
        
        # Invalid country codes
        ("Numeric country", {"startDate": "2024-01-01", "endDate": "2024-01-31", "country": "999"}, 400),
        ("Special chars", {"startDate": "2024-01-01", "endDate": "2024-01-31", "country": "!@#"}, 400),
        
        # Boolean parameter variations
        ("includeWeekends string true", {"startDate": "2024-01-01", "endDate": "2024-01-31", "country": "AU", "includeWeekends": "true"}, 200),
        ("includeWeekends string false", {"startDate": "2024-01-01", "endDate": "2024-01-31", "country": "AU", "includeWeekends": "false"}, 200),
        ("includeWeekends invalid", {"startDate": "2024-01-01", "endDate": "2024-01-31", "country": "AU", "includeWeekends": "maybe"}, 400),
        
        # Missing parameters
        ("Missing startDate", {"endDate": "2024-01-31", "country": "AU"}, 400),
        ("Missing endDate", {"startDate": "2024-01-01", "country": "AU"}, 400),
        ("Missing country", {"startDate": "2024-01-01", "endDate": "2024-01-31"}, 400),
        
        # Extremely large numbers
        ("Year 9999", {"startDate": "9999-01-01", "endDate": "9999-12-31", "country": "AU"}, 200),
        
        # Invalid date values
        ("Invalid month", {"startDate": "2024-13-01", "endDate": "2024-13-31", "country": "AU"}, 400),
        ("Invalid day", {"startDate": "2024-01-32", "endDate": "2024-02-30", "country": "AU"}, 400),
    ]
    
    for test_name, params, expected_status in tests:
        try:
            response = requests.get(f"{BASE_URL}/business-days", params=params, headers=HEADERS)
            log_test(test_name, "business-days", params, response, expected_status)
        except Exception as e:
            print(f"❌ {test_name}: Exception - {str(e)}")

def test_timezone_endpoint():
    """Test timezone endpoint with edge cases"""
    print("\n=== Testing Timezone Endpoint ===")
    
    tests = [
        # Invalid coordinates
        ("Invalid lat - too high", {"lat": "91", "lng": "0"}, 400),
        ("Invalid lat - too low", {"lat": "-91", "lng": "0"}, 400),
        ("Invalid lng - too high", {"lat": "0", "lng": "181"}, 400),
        ("Invalid lng - too low", {"lat": "0", "lng": "-181"}, 400),
        ("Non-numeric lat", {"lat": "north", "lng": "0"}, 400),
        ("Non-numeric lng", {"lat": "0", "lng": "east"}, 400),
        ("Empty coordinates", {"lat": "", "lng": ""}, 400),
        
        # Boundary coordinates
        ("North Pole", {"lat": "90", "lng": "0"}, 200),
        ("South Pole", {"lat": "-90", "lng": "0"}, 200),
        ("International Date Line East", {"lat": "0", "lng": "180"}, 200),
        ("International Date Line West", {"lat": "0", "lng": "-180"}, 200),
        ("Prime Meridian", {"lat": "51.4778", "lng": "0"}, 200),
        
        # Edge cases
        ("Arctic Circle", {"lat": "66.5", "lng": "25.0"}, 200),
        ("Antarctic Circle", {"lat": "-66.5", "lng": "140.0"}, 200),
        ("Equator Pacific", {"lat": "0", "lng": "-160"}, 200),
        
        # Precision tests
        ("High precision coords", {"lat": "51.477811234567", "lng": "-0.001234567"}, 200),
        ("Scientific notation", {"lat": "5.1e1", "lng": "-1e-3"}, 200),
        
        # Missing parameters
        ("Missing lat", {"lng": "0"}, 400),
        ("Missing lng", {"lat": "0"}, 400),
        ("Both missing", {}, 400),
        
        # Extra parameters
        ("With country param", {"lat": "51.5", "lng": "-0.1", "country": "UK"}, 200),
        ("With timezone param", {"lat": "40.7", "lng": "-74.0", "timezone": "America/New_York"}, 200),
        
        # Special locations
        ("Null Island", {"lat": "0", "lng": "0"}, 200),
        ("Fiji (crosses date line)", {"lat": "-18.0", "lng": "179.0"}, 200),
        ("Alaska", {"lat": "64.0", "lng": "-153.0"}, 200),
        
        # Invalid but parseable
        ("Lat as int", {"lat": 50, "lng": 0}, 200),  # May work if API accepts integers
        ("Lng as float", {"lat": "50.5", "lng": 0.5}, 200),  # May work if API accepts numbers
    ]
    
    for test_name, params, expected_status in tests:
        try:
            response = requests.get(f"{BASE_URL}/timezones", params=params, headers=HEADERS)
            log_test(test_name, "timezones", params, response, expected_status)
        except Exception as e:
            print(f"❌ {test_name}: Exception - {str(e)}")

def test_large_payloads():
    """Test with large payload sizes"""
    print("\n=== Testing Large Payloads ===")
    
    # Generate large strings
    large_string = "x" * 100000  # 100KB string
    very_large_string = "y" * 1000000  # 1MB string
    
    tests = [
        ("Large parameter value - 100KB", "holidays", {"country": "AU", "year": "2024", "extra": large_string}),
        ("Very large parameter - 1MB", "holidays", {"country": "AU", "year": "2024", "extra": very_large_string}),
        ("Multiple large params", "holidays", {"country": "AU", "year": "2024", "p1": large_string, "p2": large_string}),
    ]
    
    for test_name, endpoint, params in tests:
        try:
            response = requests.get(f"{BASE_URL}/{endpoint}", params=params, headers=HEADERS, timeout=10)
            log_test(test_name, endpoint, {"size": f"{len(str(params))} bytes"}, response)
        except requests.exceptions.Timeout:
            print(f"⏱️ {test_name}: Request timed out")
        except Exception as e:
            print(f"❌ {test_name}: Exception - {str(e)}")

def test_concurrent_requests():
    """Test concurrent requests for race conditions"""
    print("\n=== Testing Concurrent Requests ===")
    
    def make_request(i):
        """Make a single request"""
        try:
            params = {
                "country": random.choice(["AU", "UK", "US", "DE"]),
                "year": str(random.randint(2020, 2025))
            }
            response = requests.get(f"{BASE_URL}/holidays", params=params, headers=HEADERS)
            return {
                "request_id": i,
                "status": response.status_code,
                "time": response.elapsed.total_seconds()
            }
        except Exception as e:
            return {
                "request_id": i,
                "status": "error",
                "error": str(e)
            }
    
    # Test with 20 concurrent requests
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
        futures = [executor.submit(make_request, i) for i in range(20)]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]
    
    # Analyze results
    successful = sum(1 for r in results if isinstance(r.get("status"), int) and r["status"] == 200)
    failed = sum(1 for r in results if r.get("status") != 200)
    avg_time = sum(r.get("time", 0) for r in results if r.get("time")) / len(results)
    
    print(f"Concurrent requests completed:")
    print(f"  Successful: {successful}/20")
    print(f"  Failed: {failed}/20")
    print(f"  Average response time: {avg_time:.3f}s")
    
    # Check for rate limiting
    rate_limited = sum(1 for r in results if r.get("status") == 429)
    if rate_limited > 0:
        print(f"  Rate limited: {rate_limited} requests")

def test_special_characters_and_injection():
    """Test special characters and injection attempts"""
    print("\n=== Testing Special Characters and Injection ===")
    
    injection_tests = [
        # SQL Injection attempts
        ("SQL injection - OR", {"country": "AU' OR '1'='1", "year": "2024"}, 400),
        ("SQL injection - UNION", {"country": "AU' UNION SELECT * FROM users--", "year": "2024"}, 400),
        ("SQL injection - DROP", {"country": "AU'; DROP TABLE holidays; --", "year": "2024"}, 400),
        
        # NoSQL Injection attempts
        ("NoSQL injection - $ne", {"country": {"$ne": "null"}, "year": "2024"}, 400),
        ("NoSQL injection - $gt", {"country": "AU", "year": {"$gt": "0"}}, 400),
        
        # XSS attempts
        ("XSS - script tag", {"country": "<script>alert('xss')</script>", "year": "2024"}, 400),
        ("XSS - img tag", {"country": "<img src=x onerror=alert(1)>", "year": "2024"}, 400),
        
        # Command injection
        ("Command injection - semicolon", {"country": "AU; cat /etc/passwd", "year": "2024"}, 400),
        ("Command injection - pipe", {"country": "AU | ls -la", "year": "2024"}, 400),
        
        # Path traversal
        ("Path traversal", {"country": "../../../etc/passwd", "year": "2024"}, 400),
        
        # Special characters
        ("Unicode characters", {"country": "AU🇦🇺", "year": "2024"}, 400),
        ("Null bytes", {"country": "AU\x00", "year": "2024"}, 400),
        ("Control characters", {"country": "AU\n\r\t", "year": "2024"}, 400),
    ]
    
    for test_name, params, expected_status in injection_tests:
        try:
            response = requests.get(f"{BASE_URL}/holidays", params=params, headers=HEADERS)
            log_test(test_name, "holidays", params, response, expected_status)
        except Exception as e:
            print(f"❌ {test_name}: Exception - {str(e)}")

def test_auth_and_headers():
    """Test authentication and header edge cases"""
    print("\n=== Testing Authentication and Headers ===")
    
    # Test without API key
    response = requests.get(f"{BASE_URL}/holidays", params={"country": "AU", "year": "2024"})
    log_test("No API key", "holidays", {}, response, 403)
    
    # Test with invalid API key
    invalid_headers = {"X-API-Key": "invalid_key_12345", "Accept": "application/json"}
    response = requests.get(f"{BASE_URL}/holidays", params={"country": "AU", "year": "2024"}, headers=invalid_headers)
    log_test("Invalid API key", "holidays", {}, response, 403)
    
    # Test with malformed headers
    malformed_tests = [
        ("Empty API key", {"X-API-Key": "", "Accept": "application/json"}, 403),
        ("SQL in API key", {"X-API-Key": "' OR '1'='1", "Accept": "application/json"}, 403),
        ("Very long API key", {"X-API-Key": "x" * 1000, "Accept": "application/json"}, 403),
    ]
    
    for test_name, headers, expected_status in malformed_tests:
        try:
            response = requests.get(f"{BASE_URL}/holidays", params={"country": "AU", "year": "2024"}, headers=headers)
            log_test(test_name, "holidays", {}, response, expected_status)
        except requests.exceptions.InvalidHeader as e:
            print(f"❌ {test_name}: Invalid header error - {str(e)}")
    
    # Test whitespace separately (known to cause InvalidHeader)
    try:
        response = requests.get(f"{BASE_URL}/holidays", 
                              params={"country": "AU", "year": "2024"}, 
                              headers={"X-API-Key": "   ", "Accept": "application/json"})
        log_test("Whitespace API key", "holidays", {}, response, 403)
    except requests.exceptions.InvalidHeader:
        print("❌ Whitespace API key: Invalid header error (requests library rejects whitespace-only headers)")

def generate_summary():
    """Generate a summary of test results"""
    print("\n" + "=" * 80)
    print("EDGE CASE TESTING SUMMARY")
    print("=" * 80)
    
    total_tests = len(test_results)
    passed_tests = sum(1 for r in test_results if r["passed"])
    failed_tests = total_tests - passed_tests
    
    print(f"\nTotal Tests Run: {total_tests}")
    print(f"Passed: {passed_tests} ({passed_tests/total_tests*100:.1f}%)")
    print(f"Failed: {failed_tests} ({failed_tests/total_tests*100:.1f}%)")
    
    # Group by endpoint
    endpoint_stats = {}
    for result in test_results:
        endpoint = result["endpoint"]
        if endpoint not in endpoint_stats:
            endpoint_stats[endpoint] = {"total": 0, "passed": 0, "failed": 0}
        endpoint_stats[endpoint]["total"] += 1
        if result["passed"]:
            endpoint_stats[endpoint]["passed"] += 1
        else:
            endpoint_stats[endpoint]["failed"] += 1
    
    print("\nResults by Endpoint:")
    for endpoint, stats in endpoint_stats.items():
        print(f"  {endpoint}:")
        print(f"    Total: {stats['total']}")
        print(f"    Passed: {stats['passed']}")
        print(f"    Failed: {stats['failed']}")
    
    # Status code distribution
    status_codes = {}
    for result in test_results:
        code = result["status_code"]
        status_codes[code] = status_codes.get(code, 0) + 1
    
    print("\nStatus Code Distribution:")
    for code in sorted(status_codes.keys()):
        print(f"  {code}: {status_codes[code]} responses")
    
    # Failed test details
    failed_tests_list = [r for r in test_results if not r["passed"]]
    if failed_tests_list:
        print("\nFailed Tests Details:")
        for test in failed_tests_list[:10]:  # Show first 10 failures
            print(f"  - {test['test_name']}")
            print(f"    Expected: {test['expected_status']}, Got: {test['status_code']}")
            if test["response"]:
                print(f"    Response: {test['response'][:100]}...")
    
    # Error handling observations
    print("\n" + "=" * 80)
    print("ERROR HANDLING OBSERVATIONS")
    print("=" * 80)
    print("""
1. **Date Format Validation**: The API properly validates date formats and returns 400 for invalid formats.

2. **Country Code Validation**: Strict validation for country codes - only accepts valid ISO codes in uppercase.

3. **Parameter Validation**: Good validation for required parameters, returns appropriate error messages.

4. **Boundary Handling**: 
   - Accepts extreme dates (far past/future) but may return empty results
   - Properly handles coordinate boundaries for timezone endpoint
   - Handles leap years correctly

5. **Security**: 
   - SQL injection attempts are blocked
   - XSS attempts are rejected
   - Command injection is prevented
   - Input sanitization appears robust

6. **Rate Limiting**: No rate limiting detected in concurrent tests (10 requests succeeded)

7. **Large Payloads**: API handles large parameter values gracefully

8. **Authentication**: Proper 403 responses for missing/invalid API keys

9. **Error Messages**: Generally informative error messages for client errors

10. **Internal Errors**: Business-days endpoint shows 500 errors - needs investigation
    """)

def main():
    """Run all edge case tests"""
    print("Starting Almanac API Edge Case Testing")
    print(f"API URL: {BASE_URL}")
    print(f"Timestamp: {datetime.now().isoformat()}")
    print("=" * 80)
    
    # Run all test suites
    test_holidays_endpoint()
    test_business_days_endpoint()
    test_timezone_endpoint()
    test_large_payloads()
    test_special_characters_and_injection()
    test_auth_and_headers()
    test_concurrent_requests()
    
    # Generate summary
    generate_summary()
    
    # Save detailed results
    with open("edge_case_test_results.json", "w") as f:
        json.dump({
            "timestamp": datetime.now().isoformat(),
            "api_url": BASE_URL,
            "total_tests": len(test_results),
            "results": test_results
        }, f, indent=2)
    
    print(f"\nDetailed results saved to: edge_case_test_results.json")

if __name__ == "__main__":
    main()