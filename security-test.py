#!/usr/bin/env python3
"""
Almanac API Security Assessment Script
Tests various security mechanisms and potential vulnerabilities
"""

import requests
import time
import json
import ssl
import socket
from datetime import datetime
from urllib.parse import urljoin
import concurrent.futures
from typing import Dict, List, Any

class SecurityTester:
    def __init__(self, base_url: str):
        self.base_url = base_url
        self.results = {
            "timestamp": datetime.now().isoformat(),
            "target": base_url,
            "tests": []
        }
        
    def add_result(self, test_name: str, status: str, details: Dict[str, Any]):
        """Add a test result to the results collection"""
        self.results["tests"].append({
            "test": test_name,
            "status": status,
            "details": details,
            "timestamp": datetime.now().isoformat()
        })
        
    def test_no_auth(self):
        """Test API access without authentication"""
        print("\n[*] Testing access without API key...")
        
        endpoints = [
            "holidays?country=AU&year=2024",
            "business-days?startDate=2024-01-01&endDate=2024-01-31&country=AU",
            "timezones?country=AU"
        ]
        
        for endpoint in endpoints:
            try:
                url = urljoin(self.base_url, endpoint)
                response = requests.get(url, timeout=10)
                
                self.add_result(
                    f"No Auth - {endpoint.split('?')[0]}",
                    "PASS" if response.status_code == 403 else "FAIL",
                    {
                        "endpoint": endpoint,
                        "status_code": response.status_code,
                        "expected": 403,
                        "response": response.text[:200]
                    }
                )
                
                print(f"  ✓ {endpoint.split('?')[0]}: {response.status_code} (Expected: 403)")
                
            except Exception as e:
                self.add_result(
                    f"No Auth - {endpoint.split('?')[0]}",
                    "ERROR",
                    {"error": str(e)}
                )
                print(f"  ✗ Error testing {endpoint}: {e}")
                
    def test_invalid_auth(self):
        """Test API access with invalid authentication"""
        print("\n[*] Testing with invalid API keys...")
        
        invalid_keys = [
            "invalid_key_123",
            "alm_invalid123456789",
            "Bearer invalid.jwt.token",
            "' OR '1'='1",
            "<script>alert('xss')</script>",
            "../../../etc/passwd",
            "alm_" + "a" * 1000  # Very long key
        ]
        
        endpoint = "holidays?country=AU&year=2024"
        url = urljoin(self.base_url, endpoint)
        
        for key in invalid_keys:
            try:
                headers = {"Authorization": key}
                response = requests.get(url, headers=headers, timeout=10)
                
                self.add_result(
                    f"Invalid Auth - {key[:20]}...",
                    "PASS" if response.status_code == 403 else "FAIL",
                    {
                        "auth_header": key[:50],
                        "status_code": response.status_code,
                        "expected": 403,
                        "response": response.text[:200]
                    }
                )
                
                print(f"  ✓ Key '{key[:20]}...': {response.status_code} (Expected: 403)")
                
            except Exception as e:
                self.add_result(
                    f"Invalid Auth - {key[:20]}...",
                    "ERROR",
                    {"error": str(e)}
                )
                print(f"  ✗ Error with key '{key[:20]}...': {e}")
                
    def test_sql_injection(self):
        """Test for SQL injection vulnerabilities"""
        print("\n[*] Testing SQL injection attempts...")
        
        # Note: Using a valid test API key format for these tests
        headers = {"Authorization": "alm_test123"}
        
        sql_payloads = [
            ("country", "AU' OR '1'='1"),
            ("country", "AU'; DROP TABLE holidays; --"),
            ("year", "2024 OR 1=1"),
            ("year", "2024'; SELECT * FROM users; --"),
            ("month", "12 UNION SELECT * FROM api_keys"),
            ("type", "public' AND SLEEP(5)--"),
            ("region", "NSW' OR EXISTS(SELECT * FROM information_schema.tables)--")
        ]
        
        for param, payload in sql_payloads:
            try:
                # Build URL with injection payload
                if param == "country":
                    url = urljoin(self.base_url, f"holidays?country={payload}&year=2024")
                elif param == "year":
                    url = urljoin(self.base_url, f"holidays?country=AU&year={payload}")
                else:
                    url = urljoin(self.base_url, f"holidays?country=AU&year=2024&{param}={payload}")
                
                response = requests.get(url, headers=headers, timeout=10)
                
                # Check if response indicates SQL error or unexpected behavior
                sql_error_indicators = ["sql", "syntax", "database", "query", "select", "table"]
                response_lower = response.text.lower()
                sql_error_found = any(indicator in response_lower for indicator in sql_error_indicators)
                
                self.add_result(
                    f"SQL Injection - {param}",
                    "FAIL" if sql_error_found or response.status_code == 500 else "PASS",
                    {
                        "parameter": param,
                        "payload": payload,
                        "status_code": response.status_code,
                        "sql_error_found": sql_error_found,
                        "response_snippet": response.text[:200]
                    }
                )
                
                status = "VULNERABLE" if sql_error_found else "SAFE"
                print(f"  ✓ {param}='{payload[:30]}...': {status} (Status: {response.status_code})")
                
            except Exception as e:
                self.add_result(
                    f"SQL Injection - {param}",
                    "ERROR",
                    {"error": str(e)}
                )
                print(f"  ✗ Error testing {param}: {e}")
                
    def test_xss_attempts(self):
        """Test for XSS vulnerabilities"""
        print("\n[*] Testing XSS attempts...")
        
        headers = {"Authorization": "alm_test123"}
        
        xss_payloads = [
            "<script>alert('XSS')</script>",
            "<img src=x onerror=alert('XSS')>",
            "javascript:alert('XSS')",
            "<svg onload=alert('XSS')>",
            "'><script>alert(String.fromCharCode(88,83,83))</script>",
            "<iframe src='javascript:alert(`XSS`)'></iframe>",
            "<input onfocus=alert('XSS') autofocus>"
        ]
        
        for payload in xss_payloads:
            try:
                # Test in different parameters
                url = urljoin(self.base_url, f"holidays?country={payload}&year=2024")
                response = requests.get(url, headers=headers, timeout=10)
                
                # Check if payload is reflected without encoding
                xss_found = payload in response.text
                
                self.add_result(
                    f"XSS Test - country parameter",
                    "FAIL" if xss_found else "PASS",
                    {
                        "payload": payload,
                        "reflected": xss_found,
                        "status_code": response.status_code,
                        "response_snippet": response.text[:200]
                    }
                )
                
                status = "VULNERABLE" if xss_found else "SAFE"
                print(f"  ✓ Payload '{payload[:30]}...': {status}")
                
            except Exception as e:
                self.add_result(
                    "XSS Test",
                    "ERROR",
                    {"error": str(e)}
                )
                print(f"  ✗ Error testing XSS: {e}")
                
    def test_rate_limiting(self):
        """Test rate limiting implementation"""
        print("\n[*] Testing rate limiting...")
        
        # Test without auth (should have stricter limits)
        print("  Testing without authentication:")
        url = urljoin(self.base_url, "holidays?country=AU&year=2024")
        
        rate_limit_hit = False
        requests_made = 0
        
        for i in range(50):
            try:
                response = requests.get(url, timeout=5)
                requests_made += 1
                
                if response.status_code == 429:
                    rate_limit_hit = True
                    print(f"    ✓ Rate limit hit after {i+1} requests")
                    
                    # Check for rate limit headers
                    headers_found = []
                    for header in ["X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"]:
                        if header in response.headers:
                            headers_found.append(f"{header}: {response.headers[header]}")
                    
                    self.add_result(
                        "Rate Limiting - No Auth",
                        "PASS",
                        {
                            "requests_before_limit": i+1,
                            "status_code": 429,
                            "rate_limit_headers": headers_found
                        }
                    )
                    break
                    
            except Exception as e:
                print(f"    ✗ Error at request {i+1}: {e}")
                break
                
        if not rate_limit_hit:
            self.add_result(
                "Rate Limiting - No Auth",
                "FAIL",
                {
                    "requests_made": requests_made,
                    "rate_limit_hit": False,
                    "message": "No rate limit encountered"
                }
            )
            print(f"    ✗ No rate limit hit after {requests_made} requests")
            
        # Test rapid concurrent requests
        print("\n  Testing concurrent requests:")
        
        def make_request(i):
            try:
                return requests.get(url, timeout=5)
            except:
                return None
                
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
            futures = [executor.submit(make_request, i) for i in range(20)]
            responses = [f.result() for f in concurrent.futures.as_completed(futures) if f.result()]
            
        rate_limited = sum(1 for r in responses if r and r.status_code == 429)
        print(f"    ✓ {rate_limited}/{len(responses)} concurrent requests were rate limited")
        
        self.add_result(
            "Rate Limiting - Concurrent",
            "PASS" if rate_limited > 0 else "WARNING",
            {
                "concurrent_requests": len(responses),
                "rate_limited": rate_limited
            }
        )
        
    def test_cors_headers(self):
        """Test CORS configuration"""
        print("\n[*] Testing CORS headers...")
        
        test_origins = [
            "https://evil.com",
            "http://localhost:3000",
            "https://example.com",
            "null"
        ]
        
        url = urljoin(self.base_url, "health")
        
        for origin in test_origins:
            try:
                headers = {"Origin": origin}
                response = requests.get(url, headers=headers, timeout=10)
                
                cors_headers = {
                    "Access-Control-Allow-Origin": response.headers.get("Access-Control-Allow-Origin"),
                    "Access-Control-Allow-Credentials": response.headers.get("Access-Control-Allow-Credentials"),
                    "Access-Control-Allow-Methods": response.headers.get("Access-Control-Allow-Methods"),
                    "Access-Control-Allow-Headers": response.headers.get("Access-Control-Allow-Headers")
                }
                
                # Check if origin is reflected (potential security issue)
                origin_reflected = cors_headers["Access-Control-Allow-Origin"] == origin
                
                self.add_result(
                    f"CORS Test - {origin}",
                    "WARNING" if origin_reflected and origin != "null" else "PASS",
                    {
                        "origin": origin,
                        "cors_headers": cors_headers,
                        "origin_reflected": origin_reflected
                    }
                )
                
                print(f"  ✓ Origin '{origin}': {'REFLECTED' if origin_reflected else 'NOT REFLECTED'}")
                
            except Exception as e:
                self.add_result(
                    f"CORS Test - {origin}",
                    "ERROR",
                    {"error": str(e)}
                )
                print(f"  ✗ Error testing origin '{origin}': {e}")
                
    def test_tls_ssl(self):
        """Test TLS/SSL configuration"""
        print("\n[*] Testing TLS/SSL configuration...")
        
        # Extract hostname from URL
        from urllib.parse import urlparse
        parsed = urlparse(self.base_url)
        hostname = parsed.hostname
        port = parsed.port or 443
        
        try:
            # Create SSL context
            context = ssl.create_default_context()
            
            # Connect and get certificate info
            with socket.create_connection((hostname, port), timeout=10) as sock:
                with context.wrap_socket(sock, server_hostname=hostname) as ssock:
                    # Get protocol version
                    protocol = ssock.version()
                    
                    # Get cipher suite
                    cipher = ssock.cipher()
                    
                    # Get certificate
                    cert = ssock.getpeercert()
                    
                    # Check certificate validity
                    not_after = datetime.strptime(cert['notAfter'], '%b %d %H:%M:%S %Y %Z')
                    days_until_expiry = (not_after - datetime.now()).days
                    
                    # Check for weak protocols
                    weak_protocols = ["TLSv1", "TLSv1.1", "SSLv2", "SSLv3"]
                    is_weak = any(weak in protocol for weak in weak_protocols)
                    
                    self.add_result(
                        "TLS/SSL Configuration",
                        "FAIL" if is_weak else "PASS",
                        {
                            "protocol": protocol,
                            "cipher": cipher,
                            "certificate_cn": cert.get('subject', [[]])[0][0][1] if cert.get('subject') else None,
                            "days_until_expiry": days_until_expiry,
                            "weak_protocol": is_weak
                        }
                    )
                    
                    print(f"  ✓ Protocol: {protocol} {'(WEAK)' if is_weak else '(SECURE)'}")
                    print(f"  ✓ Cipher: {cipher[0]}")
                    print(f"  ✓ Certificate expires in: {days_until_expiry} days")
                    
        except Exception as e:
            self.add_result(
                "TLS/SSL Configuration",
                "ERROR",
                {"error": str(e)}
            )
            print(f"  ✗ Error testing TLS/SSL: {e}")
            
    def test_parameter_validation(self):
        """Test parameter validation"""
        print("\n[*] Testing parameter validation...")
        
        headers = {"Authorization": "alm_test123"}
        
        test_cases = [
            # Invalid country codes
            ("holidays", {"country": "XX", "year": "2024"}, "Invalid country code"),
            ("holidays", {"country": "123", "year": "2024"}, "Numeric country code"),
            ("holidays", {"country": "", "year": "2024"}, "Empty country code"),
            ("holidays", {"country": "A" * 100, "year": "2024"}, "Very long country code"),
            
            # Invalid years
            ("holidays", {"country": "AU", "year": "1800"}, "Year too old"),
            ("holidays", {"country": "AU", "year": "3000"}, "Year too far in future"),
            ("holidays", {"country": "AU", "year": "abc"}, "Non-numeric year"),
            ("holidays", {"country": "AU", "year": "-2024"}, "Negative year"),
            ("holidays", {"country": "AU", "year": "2024.5"}, "Decimal year"),
            
            # Invalid dates for business-days
            ("business-days", {"startDate": "invalid", "endDate": "2024-01-31", "country": "AU"}, "Invalid date format"),
            ("business-days", {"startDate": "2024-13-01", "endDate": "2024-01-31", "country": "AU"}, "Invalid month"),
            ("business-days", {"startDate": "2024-01-32", "endDate": "2024-01-31", "country": "AU"}, "Invalid day"),
            ("business-days", {"startDate": "2024-01-31", "endDate": "2024-01-01", "country": "AU"}, "End before start"),
            
            # Missing required parameters
            ("holidays", {"country": "AU"}, "Missing year"),
            ("holidays", {"year": "2024"}, "Missing country"),
            ("business-days", {"startDate": "2024-01-01", "endDate": "2024-01-31"}, "Missing country"),
        ]
        
        for endpoint, params, description in test_cases:
            try:
                url = urljoin(self.base_url, endpoint)
                response = requests.get(url, params=params, headers=headers, timeout=10)
                
                # Should return 400 for bad requests
                expected_status = 400
                is_valid = response.status_code == expected_status
                
                self.add_result(
                    f"Parameter Validation - {description}",
                    "PASS" if is_valid else "FAIL",
                    {
                        "endpoint": endpoint,
                        "parameters": params,
                        "status_code": response.status_code,
                        "expected": expected_status,
                        "response": response.text[:200]
                    }
                )
                
                print(f"  ✓ {description}: {response.status_code} (Expected: {expected_status})")
                
            except Exception as e:
                self.add_result(
                    f"Parameter Validation - {description}",
                    "ERROR",
                    {"error": str(e)}
                )
                print(f"  ✗ Error testing {description}: {e}")
                
    def generate_report(self):
        """Generate security assessment report"""
        print("\n" + "="*60)
        print("SECURITY ASSESSMENT REPORT")
        print("="*60)
        
        # Count results by status
        status_counts = {}
        for test in self.results["tests"]:
            status = test["status"]
            status_counts[status] = status_counts.get(status, 0) + 1
            
        print(f"\nTarget: {self.results['target']}")
        print(f"Timestamp: {self.results['timestamp']}")
        print(f"\nTest Summary:")
        print(f"  Total Tests: {len(self.results['tests'])}")
        for status, count in status_counts.items():
            print(f"  {status}: {count}")
            
        # Detailed findings
        print("\n" + "-"*60)
        print("DETAILED FINDINGS")
        print("-"*60)
        
        # Group by test category
        categories = {}
        for test in self.results["tests"]:
            category = test["test"].split(" - ")[0]
            if category not in categories:
                categories[category] = []
            categories[category].append(test)
            
        for category, tests in categories.items():
            print(f"\n{category}:")
            for test in tests:
                status_symbol = {
                    "PASS": "✓",
                    "FAIL": "✗",
                    "WARNING": "⚠",
                    "ERROR": "!"
                }.get(test["status"], "?")
                
                print(f"  {status_symbol} {test['test']}: {test['status']}")
                
                # Print important details for failures
                if test["status"] in ["FAIL", "WARNING"]:
                    details = test.get("details", {})
                    if "status_code" in details:
                        print(f"    - Status Code: {details['status_code']} (Expected: {details.get('expected', 'N/A')})")
                    if "message" in details:
                        print(f"    - Message: {details['message']}")
                        
        # Security recommendations
        print("\n" + "-"*60)
        print("SECURITY RECOMMENDATIONS")
        print("-"*60)
        
        recommendations = []
        
        # Check for specific issues
        for test in self.results["tests"]:
            if test["status"] == "FAIL":
                if "Rate Limiting" in test["test"]:
                    recommendations.append("- Implement or strengthen rate limiting to prevent abuse")
                elif "SQL Injection" in test["test"]:
                    recommendations.append("- Review and strengthen input validation and parameterized queries")
                elif "XSS" in test["test"]:
                    recommendations.append("- Implement proper output encoding to prevent XSS attacks")
                elif "TLS/SSL" in test["test"]:
                    recommendations.append("- Update TLS configuration to use only secure protocols (TLS 1.2+)")
                    
            elif test["status"] == "WARNING":
                if "CORS" in test["test"]:
                    recommendations.append("- Review CORS policy to ensure it doesn't allow unrestricted access")
                    
        if recommendations:
            for rec in set(recommendations):
                print(rec)
        else:
            print("- No critical security issues found")
            print("- Continue monitoring and regular security assessments")
            
        # Save full report to file
        report_file = f"security_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_file, 'w') as f:
            json.dump(self.results, f, indent=2)
            
        print(f"\n[*] Full report saved to: {report_file}")
        
def main():
    # Test both endpoints
    endpoints = [
        ("API Gateway", "https://fkbmscbv0f.execute-api.ap-south-1.amazonaws.com/v1/"),
        ("CloudFront", "https://d1f3xis8nbs3on.cloudfront.net/")
    ]
    
    for name, url in endpoints:
        print(f"\n{'='*60}")
        print(f"TESTING {name.upper()}")
        print(f"URL: {url}")
        print(f"{'='*60}")
        
        tester = SecurityTester(url)
        
        # Run all tests
        tester.test_no_auth()
        tester.test_invalid_auth()
        tester.test_sql_injection()
        tester.test_xss_attempts()
        tester.test_rate_limiting()
        tester.test_cors_headers()
        tester.test_tls_ssl()
        tester.test_parameter_validation()
        
        # Generate report
        tester.generate_report()
        
        # Small delay between endpoints
        time.sleep(2)

if __name__ == "__main__":
    main()