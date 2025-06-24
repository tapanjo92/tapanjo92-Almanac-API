# Data Cleanup Runbook - Australian Holiday Data

## Overview
This runbook addresses critical data quality issues in the Australian holiday dataset. As a senior architect, I'm documenting this properly so it doesn't happen again.

## Current Data Quality Issues

### 1. **Massive Duplication** (Critical)
- **Issue**: National holidays stored 8 times (once per state)
- **Impact**: 263 records instead of ~100
- **Example**: New Year's Day 2024 exists as 8 separate records

### 2. **Case Inconsistency** (High)
- **Issue**: 77% of records use lowercase regions (nsw, vic)
- **Impact**: API queries may miss data
- **Root Cause**: No validation on data input

### 3. **Missing Metadata** (Medium)
- **Issue**: 100% of records missing `data_source` field
- **Impact**: Cannot track data lineage
- **Risk**: No audit trail for data changes

## Cleanup Process

### Phase 1: Deploy Data Quality Stack

```bash
# 1. Add to CDK app (bin/almanac-api.ts)
const dataQualityStack = new DataQualityStack(app, `AlmanacAPI-DataQuality-${env}`, {
  env: stackEnv,
  config: config,
  phase0Stack: phase0Stack,
  description: 'Almanac API Data Quality: Cleanup and validation',
});

# 2. Deploy the stack
pnpm run build
cdk deploy AlmanacAPI-DataQuality-dev

# 3. Subscribe to alerts
aws sns subscribe \
  --topic-arn <output-from-deploy> \
  --protocol email \
  --notification-endpoint your-email@company.com
```

### Phase 2: Analyze Current State (Dry Run)

```bash
# Run analysis without making changes
aws lambda invoke \
  --function-name almanac-api-dev-data-cleanup \
  --payload '{"dry_run": true}' \
  response.json

# Check the analysis
cat response.json | jq .
```

Expected output:
```json
{
  "total_records": 263,
  "case_inconsistencies": 202,
  "missing_data_source": 263,
  "duplicates": 8,
  "action": "No changes made - set dry_run=false to execute cleanup"
}
```

### Phase 3: Execute Cleanup

```bash
# BACKUP FIRST - Always backup before data operations
aws dynamodb create-backup \
  --table-name almanac-api-dev-holidays \
  --backup-name "pre-cleanup-backup-$(date +%Y%m%d-%H%M%S)"

# Execute cleanup
aws lambda invoke \
  --function-name almanac-api-dev-data-cleanup \
  --payload '{"dry_run": false}' \
  cleanup-result.json

# Check results
cat cleanup-result.json | jq .
```

### Phase 4: Verify Results

```bash
# Check new record count
aws dynamodb scan \
  --table-name almanac-api-dev-holidays \
  --select COUNT \
  --filter-expression "country = :country" \
  --expression-attribute-values '{":country":{"S":"AU"}}' \
  --query 'Count'

# Should see ~100-120 records (down from 263)

# Test API to ensure it still works
./scripts/test-api.sh
```

## Expected Outcomes

### Before Cleanup:
- 263 total records
- 8x duplication for national holidays
- Mixed case regions
- No data lineage

### After Cleanup:
- ~100-120 records
- National holidays: single record with `regions: ["ALL"]`
- All regions uppercase
- Every record has `data_source` and `last_updated`

## Ongoing Prevention

The Data Quality Stack includes:

1. **Daily Validation** (6 AM UTC)
   - Checks for case inconsistencies
   - Validates required fields
   - Alerts on any issues

2. **CloudWatch Dashboard**
   - Real-time data quality score
   - Issue tracking
   - Historical trends

3. **Immediate Alerts**
   - SNS notifications for any quality issues
   - PagerDuty integration (if configured)

## Rollback Plan

If something goes wrong:

```bash
# 1. List backups
aws dynamodb list-backups \
  --table-name almanac-api-dev-holidays

# 2. Restore from backup
aws dynamodb restore-table-from-backup \
  --target-table-name almanac-api-dev-holidays-restored \
  --backup-arn <backup-arn>

# 3. Swap tables (requires app update)
```

## Lessons Learned

1. **Always validate input data** - This mess happened because we trusted data sources
2. **Implement quality checks from day one** - Not as an afterthought
3. **Use proper composite keys** - Would have prevented duplicates
4. **Monitor data quality continuously** - Not just when issues arise

## Post-Cleanup Actions

1. **Update ETL pipelines** to include deduplication logic
2. **Add input validation** to all data ingestion points
3. **Create data governance documentation**
4. **Set up quality SLIs** (target: 99.9% quality score)

---

**Remember**: In production systems, data quality is not optional. It's the foundation everything else builds on.

*- Senior Cloud Architect*