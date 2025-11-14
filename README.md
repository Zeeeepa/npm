# NPM Registry Indexer - Ultimate Single-File Solution

Complete NPM package index generator with automatic sync capabilities.

## 🚀 Quick Start

```bash
npm install
node npm-indexer-ultimate.js
```

That's it! The script will:
1. Fetch all 5.4M+ packages from Chinese mirror (registry.npmmirror.com)
2. Enrich with complete metadata
3. Export to `npm.csv` with all fields
4. Save checkpoint for incremental updates

## 📋 Requirements

- Node.js 12+
- Dependencies: `urllib`

```bash
npm install urllib
```

## 📊 Output Format

### npm.csv

Exact CSV format with 10 columns:

```csv
number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords
1,https://www.npmjs.com/package/@storybook/preact,@storybook/preact,18,16803,0,117,2025-10-30,"Storybook Preact renderer: Develop, document, and test UI components in isolation"
2,https://www.npmjs.com/package/shebang-regex,shebang-regex,5,3234,0,2672,2021-08-13,Regular expression for matching a shebang line
...
```

### npm-checkpoint.json

State file enabling incremental updates:

```json
{
  "lastSeq": 1234567,
  "totalPackages": 5400000,
  "lastSync": "2025-11-12T22:00:00Z",
  "packages": {
    "package-name": {
      "seq": 12345,
      "description": "...",
      "keywords": "...",
      "dependencies": 5,
      "file_count": 42,
      "unpacked_size": 524288,
      "latest_version": "1.2.3",
      "latest_release_published_at": "2025-11-12",
      "enriched": true
    }
  }
}
```

## ⚡ Performance

### First Run (Fresh Start)

| Phase | Duration | Details |
|-------|----------|---------|
| **Fetch** | 10-15 min | Fetches all 5.4M package names via `_changes` API |
| **Enrich** | 6-8 hours | Fetches metadata at 50 req/sec (rate limited) |
| **Export** | 5 min | Writes complete CSV file |
| **Total** | ~8 hours | Can be interrupted and resumed anytime |

### Subsequent Runs (Sync/Update)

| Phase | Duration | Details |
|-------|----------|---------|
| **Fetch** | 1-2 min | Only fetches NEW/UPDATED packages |
| **Enrich** | 5-10 min | Only enriches NEW packages (~100-500 per week) |
| **Export** | 5 min | Re-exports complete CSV |
| **Total** | ~10 min | Keeps your index up-to-date |

## 🔄 Auto-Sync Workflow

### How It Works

1. **First Run**: Creates `npm-checkpoint.json` with current state
2. **Checkpoint Tracks**:
   - Last sequence number from `_changes` API
   - All package names and their metadata
   - Enrichment status for each package
3. **Second Run**: 
   - Loads checkpoint
   - Fetches only changes since `lastSeq`
   - Enriches only unenriched packages
   - Exports updated CSV

### Example Workflow

```bash
# Week 1: Initial index
node npm-indexer-ultimate.js
# → Creates npm.csv with 5.4M packages

# Week 2: Update to latest
node npm-indexer-ultimate.js
# → Updates npm.csv with ~100 new packages
# → Takes ~10 minutes instead of 8 hours

# Automate with cron (daily sync)
0 2 * * * cd /path/to/npm && /usr/bin/node npm-indexer-ultimate.js >> sync.log 2>&1
```

## 🎯 Features

### ✅ Zero Duplicates Guaranteed

- Global `Set()` deduplication
- Single sequential writer
- Validates on export

### ✅ Complete Metadata

- file_count
- unpacked_size  
- dependencies (count)
- latest_version
- latest_release_published_at
- description (with proper quote escaping)
- keywords

### ✅ Resumable

- Checkpoint saved after each phase
- Press Ctrl+C anytime
- Re-run to continue from exact position

### ✅ Incremental Sync

- Tracks last sequence number
- Only fetches new/updated packages
- Re-running automatically syncs to latest

## 🛠️ Configuration

Edit `CONFIG` object in `npm-indexer-ultimate.js`:

```javascript
const CONFIG = {
  registry: 'https://registry.npmmirror.com',  // Mirror URL
  outputCsv: 'npm.csv',                        // Output file
  checkpointFile: 'npm-checkpoint.json',       // State file
  
  workers: 100,                    // Not currently used (single-threaded _changes)
  changesBatchSize: 10000,        // Packages per _changes request
  enrichBatchSize: 100,           // Parallel enrichment batch
  enrichRateLimit: 50,            // Requests per second (safe limit)
  
  timeout: 60000,                 // Request timeout (ms)
  maxRetries: 3,                  // Retry failed requests
  requestDelay: 5,                // Delay between requests (ms)
};
```

## 📈 Monitoring Progress

The script outputs real-time progress:

```
STEP 1: FETCHING PACKAGE NAMES
[FETCH] 36s | 100 requests | 100,000 packages (+100000 new, ~0 updated, -0 deleted)
[FETCH] 72s | 200 requests | 200,000 packages (+200000 new, ~0 updated, -0 deleted)
...

STEP 2: ENRICHING PACKAGES  
[ENRICH] 1000/5400000 | 50/sec | ETA: 108.0 min | Failed: 3
[ENRICH] 2000/5400000 | 50/sec | ETA: 107.5 min | Failed: 5
...

STEP 3: EXPORTING TO CSV
[EXPORT] 10.0% (500,000/5,400,000)
[EXPORT] 20.0% (1,000,000/5,400,000)
...
```

## 🚨 Troubleshooting

### Script Interrupted

No problem! Just re-run:

```bash
node npm-indexer-ultimate.js
```

It will automatically resume from the checkpoint.

### Out of Memory

If enriching 5.4M packages uses too much RAM, you can:

1. **Run in batches**: Edit `enrichBatchSize` to smaller value
2. **Use streaming**: Process in chunks and clear memory
3. **Use database**: Switch to PostgreSQL backend (see `initialize.js`)

### Rate Limited

If you see HTTP 429 errors:

1. **Reduce rate**: Lower `enrichRateLimit` (try 20 instead of 50)
2. **Add delay**: Increase `requestDelay` to 100ms

### Missing Packages

Some packages may return HTTP 422 (unpublished/removed). These are marked as `failed` in the checkpoint but still counted. This is normal.

## 📝 CSV Validation

Verify your CSV file:

```bash
# Count total lines (should be 5.4M + 1 header)
wc -l npm.csv

# Check for duplicates in package names  
cut -d, -f3 npm.csv | tail -n +2 | sort | uniq -d | wc -l
# Expected: 0 (zero duplicates)

# Sample first 10 packages
head -11 npm.csv

# File size (expect ~200-300 MB)
du -h npm.csv
```

## 🔧 Alternative Approaches

### Multi-Script Modular Pipeline

For more flexibility, see the 4-script pipeline:

```bash
node initialize.js    # Fetch package names (PostgreSQL)
node enrich.js        # Enrich metadata
node export-csv.js    # Export to CSV
```

See `WORKFLOW.md` for details.

### Different Registry

Change `CONFIG.registry` to use a different mirror:

- Official: `https://registry.npmjs.org` (slower)
- China: `https://registry.npmmirror.com` (fast, recommended)
- Other mirrors: Search "npm registry mirror"

## 📚 Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  npm-indexer-ultimate.js (Single File)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │ Load Checkpoint   │
                    │ (if exists)       │
                    └─────────┬─────────┘
                              │
                ┌─────────────┴──────────────┐
         Fresh Start             Resume/Sync
         (lastSeq=0)             (lastSeq=12345)
                │                            │
                └─────────────┬──────────────┘
                              │
                    ┌─────────▼──────────────────┐
                    │ PHASE 1: Fetch Package     │
                    │ Names via _changes API     │
                    │                            │
                    │ Registry: npmmirror.com    │
                    │ since=CHECKPOINT.lastSeq   │
                    │ limit=10000                │
                    └─────────┬──────────────────┘
                              │
                ┌─────────────▼──────────────────┐
                │ Global Dedup Set              │
                │ CHECKPOINT.packages {}        │
                │ - New packages added          │
                │ - Updated packages overwrite  │
                │ - Deleted packages removed    │
                └─────────┬────────────────────┘
                          │
                ┌─────────▼────────────────┐
                │ Save Checkpoint          │
                │ - lastSeq updated        │
                │ - All packages + metadata│
                └─────────┬────────────────┘
                          │
                ┌─────────▼──────────────────────┐
                │ PHASE 2: Enrich Packages       │
                │ (Only unenriched)              │
                │                                │
                │ For each package:              │
                │ - GET /{packageName}           │
                │ - Extract metadata             │
                │ - Rate limit: 50 req/sec       │
                │ - Mark enriched when done      │
                └─────────┬──────────────────────┘
                          │
                ┌─────────▼──────────────────┐
                │ Save Checkpoint            │
                │ (Progress every 1000 pkg)  │
                └─────────┬──────────────────┘
                          │
                ┌─────────▼──────────────────┐
                │ PHASE 3: Export to CSV      │
                │                            │
                │ For each enriched package: │
                │ - Generate row with        │
                │   10 columns               │
                │ - Escape special chars     │
                │ - Stream to npm.csv        │
                └─────────┬──────────────────┘
                          │
                ┌─────────▼──────────────────┐
                │ Save Final Checkpoint      │
                │ Output: npm.csv (ready!)   │
                └─────────────────────────────┘
```

## 🤝 Contributing

Issues and PRs welcome!

## 📄 License

MIT

## 👤 Authors

- **Zeeeepa** - Original concept
- **Codegen AI** - Implementation & optimization

---

**Questions?** Open an issue or check the code comments in `npm-indexer-ultimate.js`.

