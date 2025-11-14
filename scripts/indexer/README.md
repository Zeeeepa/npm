# NPM Registry Complete Indexer

**Single-file, all-in-one solution for indexing 5.4M+ npm packages**

## Features

- 🚀 **100 parallel workers** for maximum speed
- 🔄 **Zero duplicates** with global Set-based deduplication
- 📊 **Full metadata enrichment**: descriptions, keywords, dependencies, file counts, sizes
- 💾 **Checkpoint system** for incremental sync
- 📝 **CSV export** with exact format specified
- 🔁 **Smart re-run**: Running again syncs to latest state
- ⚡ **Single command**: No parameters, no setup

## Quick Start

```bash
# First run - creates complete index
node initialize_index.js

# Output:
#   npm.csv             - Complete index (5.4M+ lines)
#   npm.checkpoint.json - State for sync

# Second run - syncs to latest
node initialize_index.js

# Automatically fetches only new/updated packages
```

## Output Format

### CSV Structure

```csv
number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords
1,https://www.npmjs.com/package/@storybook/preact,@storybook/preact,18,16803,0,117,2025-10-30,"Storybook Preact renderer...",""
2,https://www.npmjs.com/package/shebang-regex,shebang-regex,5,3234,0,2672,2021-08-13,Regular expression for matching a shebang line,""
```

### Columns Explained

| Column | Description | Example |
|--------|-------------|---------|
| `number` | Sequential row number | `1` |
| `npm_url` | Package URL on npmjs.com | `https://www.npmjs.com/package/lodash` |
| `package_name` | Full package name | `@scope/package-name` |
| `file_number` | Count of files in package | `18` |
| `unpacked_size` | Size when extracted (bytes) | `16803` |
| `dependencies` | Count of dependencies | `5` |
| `dependents` | Packages depending on this | `2672` |
| `latest_release_published_at` | Publish date (YYYY-MM-DD) | `2025-10-30` |
| `description` | Package description | `"A utility library..."` |
| `keywords` | Comma-separated keywords | `"util,helper,lodash"` |

## Checkpoint System

### First Run

```json
{
  "lastSequence": 112735702,
  "totalPackages": 5406114,
  "lastUpdate": "2025-11-12T21:45:00.000Z"
}
```

### Re-run Behavior

1. **Loads checkpoint** from previous run
2. **Fetches only changes** since `lastSequence`
3. **Merges new packages** with existing data
4. **Updates CSV** with new entries
5. **Saves new checkpoint**

## Architecture

### Three-Stage Pipeline

```
┌─────────────────────────────────────────────┐
│ STAGE 1: PARALLEL FETCH (100 workers)      │
│ ├─ Each worker: sequence range             │
│ ├─ Inline deduplication (Set)              │
│ └─ Global merge (conflict-free)            │
└─────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────┐
│ STAGE 2: METADATA ENRICHMENT                │
│ ├─ Batch processing (20 concurrent)        │
│ ├─ Fetch: /package-name                    │
│ ├─ Extract: description, keywords, deps    │
│ └─ Store: PACKAGE_METADATA Map             │
└─────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────┐
│ STAGE 3: CSV EXPORT                         │
│ ├─ Sort packages alphabetically            │
│ ├─ Write header + rows                     │
│ ├─ Proper CSV escaping                     │
│ └─ Result: npm.csv                         │
└─────────────────────────────────────────────┘
```

### Global State Management

```javascript
TOTAL_PACKAGES = new Set()           // All unique packages
PACKAGE_METADATA = new Map()         // packageName → metadata
CHECKPOINT = {                        // Resume state
  lastSequence: 0,
  totalPackages: 0,
  lastUpdate: null
}
```

## Performance

### Expected Times

| Operation | Time | Speed | Notes |
|-----------|------|-------|-------|
| **Fetch** | 2-3 hours | 1M+ pkgs/hour | 100 workers parallel |
| **Enrich** | 3-4 hours | 30K pkgs/hour | 20 concurrent requests |
| **Export** | 5-10 min | 1M rows/min | Streaming write |
| **Total** | ~6-8 hours | - | Complete pipeline |

### Memory Usage

- **Fetch phase**: ~500MB (Set + intermediate)
- **Enrich phase**: ~1GB (Map + fetch buffers)
- **Export phase**: ~100MB (streaming)
- **Peak**: ~1.2GB

### Disk Usage

- **npm.csv**: ~800MB (5.4M rows)
- **npm.checkpoint.json**: <1KB
- **Total**: ~800MB

## Configuration

### Environment Variables (Optional)

```bash
# Custom registry
NPM_REGISTRY=https://registry.npmjs.org node initialize_index.js

# Custom output location
OUTPUT_FILE=./data/packages.csv node initialize_index.js

# Adjust concurrency
ENRICH_CONCURRENCY=10 node initialize_index.js
```

### Built-in Configuration

```javascript
CONFIG = {
  registry: 'https://registry.npmmirror.com',
  workers: 100,                    // Parallel workers
  changesBatchSize: 10000,         // Records per fetch
  enrichConcurrency: 20,           // Concurrent enrichment
  outputFile: './npm.csv',         // Output filename
  checkpointFile: './npm.checkpoint.json',
  timeout: 60000,                  // HTTP timeout (ms)
  requestDelay: 5,                 // Delay between requests (ms)
  maxRetries: 3,                   // Retry attempts
}
```

## Error Handling

### Automatic Retry

- Network errors: 3 retries with exponential backoff
- Worker failures: Logged but don't block other workers
- Enrichment failures: Logged, package saved with empty metadata

### Resume on Failure

If the script crashes:

1. **Fetch phase**: Workers that completed are merged, checkpoint saved
2. **Enrich phase**: Re-run will re-enrich (idempotent)
3. **Export phase**: Re-run will regenerate CSV

## CSV Escaping

Proper RFC 4180 compliance:

```javascript
// Values with special chars are quoted
"lodash" → lodash
"a,b,c" → "a,b,c"
"say \"hi\"" → "say ""hi"""
```

## Examples

### Full Run Output

```
═══════════════════════════════════════════════════════
NPM Registry Complete Indexer - All-in-One Edition
═══════════════════════════════════════════════════════
Configuration:
  Registry: https://registry.npmmirror.com
  Workers: 100 parallel
  Output: npm.csv
═══════════════════════════════════════════════════════
[INIT] Registry max sequence: 112,735,702
[INIT] Registry doc count: 5,406,114
═══════════════════════════════════════════════════════
[STEP 1/3] FETCHING PACKAGES (100 workers)
═══════════════════════════════════════════════════════
[POOL] Starting 100 workers...
[Worker #0] START: seq 0 → 1,127,358
...
[POOL] ✓ Merge complete: 5,406,114 packages
═══════════════════════════════════════════════════════
[STEP 2/3] ENRICHING METADATA (5,406,114 packages)
═══════════════════════════════════════════════════════
[ENRICH] Progress: 50.0% (2703057/5406114)
...
[ENRICH] ✓ Complete: 5,395,230 enriched, 10,884 failed
═══════════════════════════════════════════════════════
[STEP 3/3] EXPORTING CSV
═══════════════════════════════════════════════════════
[CSV] ✓ Complete: 5,406,114 rows, 823.45 MB
═══════════════════════════════════════════════════════
✓✓✓ COMPLETE ✓✓✓
═══════════════════════════════════════════════════════
Duration: 387.23 minutes
Total packages: 5,406,114
Throughput: 13,968 packages/minute
Output: npm.csv
Checkpoint: seq=112735702 (for next sync)
```

### Incremental Sync Output

```
[CHECKPOINT] Loaded: seq=112735702, packages=5406114
[INIT] Registry max sequence: 112,850,000
[SYNC] Resuming from sequence: 112,735,702
[SYNC] Fetching changes: 112,735,702 → 112,850,000
...
[POOL] ✓ Merge complete: 1,234 new packages (total: 5,407,348)
...
✓✓✓ COMPLETE ✓✓✓
Duration: 12.34 minutes
Total packages: 5,407,348
New packages: 1,234
```

## Troubleshooting

### Slow Enrichment

**Problem**: Enrichment taking too long

**Solution**: Adjust `enrichConcurrency`

```bash
ENRICH_CONCURRENCY=50 node initialize_index.js
```

### Network Errors

**Problem**: Frequent network timeouts

**Solution**: 
1. Increase timeout: Edit `CONFIG.timeout` in code
2. Add delay: Edit `CONFIG.requestDelay` in code

### Memory Issues

**Problem**: Out of memory error

**Solution**:
1. Run with more memory: `node --max-old-space-size=4096 initialize_index.js`
2. Reduce worker count: Edit `CONFIG.workers` to `50`

## Technical Details

### Why 100 Workers?

- Registry has 112M sequences
- Each worker handles ~1.1M sequences
- Parallel processing reduces total time from 10+ hours to 2-3 hours

### Why Set for Deduplication?

- O(1) lookup time
- Native JavaScript, no external dependencies
- Memory efficient for 5.4M entries (~500MB)

### Why Checkpoint System?

- Resume on failure without re-fetching everything
- Enable incremental daily/hourly syncs
- Track state for monitoring

## License

MIT

## Credits

Created by Zeeeepa for efficient npm registry indexing.

