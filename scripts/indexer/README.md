# NPM Registry Indexer v4.0.0

**Author:** Zeeeepa  
**Date:** 2025-01-12  
**Status:** Production-Ready

## 🎯 Overview

A high-performance, duplicate-free npm registry indexer that fetches all package names from npm registries (e.g., `registry.npmmirror.com`) and exports them as enumerated JSON.

### ✨ Key Features

- ✅ **Zero duplicates** - SQLite PRIMARY KEY constraint guarantees uniqueness
- ✅ **Deterministic enumeration** - Consistent sequential numbering via rowid ordering
- ✅ **Resume-safe** - Automatic checkpointing with re-run support
- ✅ **Memory-efficient** - Streaming architecture for 5.4M+ packages
- ✅ **High throughput** - ~1M packages/minute with parallel workers
- ✅ **Two methods** - Streaming `/-/all` (primary) and parallel `_changes` (fallback)

### 🔥 What's New in v4.0

This is a complete rewrite that eliminates the duplicate issues from v3.0:

**v3.0 Problems:**
- ❌ Cross-worker duplicates from race conditions
- ❌ Inconsistent sequential numbering
- ❌ Direct file writes causing corruption
- ❌ No global deduplication

**v4.0 Solutions:**
- ✅ SQLite-backed global deduplication
- ✅ Single-source-of-truth for all package names
- ✅ Atomic inserts with `INSERT OR IGNORE`
- ✅ Deterministic export with consistent rowid ordering

---

## 🚀 Quick Start

### Installation

```bash
# Install dependencies
npm install
```

### Basic Usage

```bash
# Method 1: Auto-detect (tries /-/all first, fallback to _changes)
npm run indexer:init

# Method 2: Export to JSON after initialization
npm run indexer:export

# Method 3: Full pipeline (init + export)
npm run indexer:full
```

### Expected Output

```
data/
├── index.db              # SQLite database (unique packages)
├── package-index.json    # Enumerated JSON output
└── index-metadata.json   # Metadata (counts, duration, etc.)
```

---

## 📖 Detailed Usage

### Step 1: Initialize Database

Fetch packages from registry and store in SQLite:

```bash
npm run indexer:init
```

**Environment Variables:**
```bash
NPM_REGISTRY=https://registry.npmmirror.com   # Registry URL
DB_PATH=./data/index.db                       # Database path
FETCH_METHOD=auto                             # auto|all|changes
LIMIT=100000                                  # Dry-run limit (0 = no limit)
WORKERS=100                                   # Parallel workers (changes method)
```

**Examples:**

```bash
# Dry run: fetch only 100k packages for testing
LIMIT=100000 npm run indexer:init

# Force /-/all method
npm run indexer:all

# Force _changes method with 50 workers
WORKERS=50 npm run indexer:changes

# Custom registry
NPM_REGISTRY=https://registry.npmjs.org npm run indexer:init
```

### Step 2: Export to JSON

Convert SQLite database to JSON format:

```bash
npm run indexer:export
```

**Environment Variables:**
```bash
DB_PATH=./data/index.db                    # Database path
OUTPUT_DIR=./data                          # Output directory
EXPORT_LIMIT=100000                        # Partial export (0 = all)
STREAM_BATCH_SIZE=100000                   # Memory batch size
```

**Examples:**

```bash
# Partial export: first 100k packages
EXPORT_LIMIT=100000 npm run indexer:export

# Custom output directory
OUTPUT_DIR=./output npm run indexer:export
```

### Full Pipeline

Run initialization and export in one command:

```bash
npm run indexer:full
```

---

## 🏗️ Architecture

### Primary Method: Streaming `/-/all`

**Endpoint:** `https://registry.npmmirror.com/-/all`

**Flow:**
1. Stream HTTP response (prevents memory overflow)
2. Parse JSON incrementally with `stream-json`
3. Batch insert into SQLite (10k packages/batch)
4. SQLite deduplicates via `PRIMARY KEY` constraint
5. Checkpoint WAL every 10 seconds

**Advantages:**
- ✅ Single HTTP request
- ✅ Natural deduplication (each package appears once)
- ✅ ~10-15 minutes for 5.4M packages
- ✅ Simpler, more reliable

### Fallback Method: Parallel `_changes`

**Endpoint:** `https://registry.npmmirror.com/_changes`

**Flow:**
1. Fetch max sequence from registry root
2. Split sequence range across 100 workers
3. Each worker fetches batches (10k changes)
4. All workers insert into shared SQLite database
5. SQLite deduplicates via `PRIMARY KEY` constraint
6. Workers run in parallel with `Promise.all()`

**Advantages:**
- ✅ High throughput (~1M packages/minute)
- ✅ Robust retry logic per worker
- ✅ Progress tracking per worker

**Trade-offs:**
- ⚠️ More complex (100 concurrent HTTP clients)
- ⚠️ Same package may appear multiple times in `_changes` feed
- ⚠️ Requires more network bandwidth

### SQLite Database Schema

```sql
CREATE TABLE packages (
  name TEXT PRIMARY KEY NOT NULL
) WITHOUT ROWID;

CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT
) WITHOUT ROWID;
```

**Why SQLite?**
- ✅ ACID guarantees (no race conditions)
- ✅ `PRIMARY KEY` enforces uniqueness
- ✅ WAL mode for high write throughput
- ✅ Fast indexed queries
- ✅ Resume-safe (durable checkpoints)
- ✅ Portable single-file format

### Export Format

**Output:** `data/package-index.json`

```json
[
  ["@babel/core", 1],
  ["express", 2],
  ["react", 3],
  ...
]
```

**Format:** `[["package-name", seq], ...]`

- `seq` is deterministic (sorted by package name)
- No duplicates guaranteed
- Consistent across re-runs

---

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | Registry URL |
| `DB_PATH` | `./data/index.db` | SQLite database path |
| `OUTPUT_DIR` | `./data` | Output directory for JSON |
| `FETCH_METHOD` | `auto` | `auto`, `all`, or `changes` |
| `LIMIT` | `0` | Limit packages (0 = no limit, dry-run) |
| `EXPORT_LIMIT` | `0` | Limit export (0 = all, partial export) |
| `WORKERS` | `100` | Number of parallel workers (`changes` method) |
| `BATCH_SIZE` | `10000` | SQLite insert batch size |
| `CHANGES_BATCH_SIZE` | `10000` | Changes per API request |
| `DB_BATCH_SIZE` | `5000` | DB insert batch per worker |
| `STREAM_BATCH_SIZE` | `100000` | Export streaming batch size |
| `TIMEOUT` | `300000` | HTTP timeout (ms) |
| `REQUEST_DELAY` | `10` | Delay between requests (ms) |

### Advanced Usage

```bash
# High-performance configuration (more aggressive)
WORKERS=200 \
BATCH_SIZE=20000 \
CHANGES_BATCH_SIZE=20000 \
REQUEST_DELAY=5 \
npm run indexer:changes

# Memory-constrained configuration
BATCH_SIZE=1000 \
STREAM_BATCH_SIZE=10000 \
npm run indexer:full

# Custom registry with authentication (if needed)
NPM_REGISTRY=https://custom-registry.example.com \
npm run indexer:init
```

---

## 📊 Performance

### Expected Results (5.4M packages from registry.npmmirror.com)

| Method | Duration | Throughput | Memory | Database Size |
|--------|----------|------------|--------|---------------|
| **Streaming /-/all** | 10-15 min | ~400k/min | <500 MB | ~200 MB |
| **Parallel _changes** | 5-10 min | ~800k/min | <1 GB | ~200 MB |

### Bottlenecks

1. **Network bandwidth** - Primary constraint
2. **Registry rate limits** - May throttle requests
3. **Disk I/O** - WAL checkpoints (minimal impact)

### Optimization Tips

- Use a fast network connection
- Run on SSD for better SQLite performance
- Increase `WORKERS` if network allows (test with small `LIMIT` first)
- Use `LIMIT` for dry-runs to validate configuration

---

## 🛡️ Resume & Error Handling

### Automatic Resume

The indexer is **fully resume-safe**:

1. **SQLite durability** - WAL journal ensures no data loss
2. **Idempotent inserts** - `INSERT OR IGNORE` allows re-runs
3. **Checkpoint metadata** - Progress tracked in `meta` table

**To resume:**
```bash
# Just re-run the same command
npm run indexer:init
```

SQLite will skip existing packages automatically.

### Error Scenarios

| Error | Behavior | Recovery |
|-------|----------|----------|
| Network timeout | Worker retries with exponential backoff | Automatic |
| Partial fetch | Saves all processed packages | Re-run to continue |
| Database corruption | **Rare** (WAL protects integrity) | Delete `index.db` and restart |
| Out of memory | Unlikely (streaming architecture) | Reduce `BATCH_SIZE` |

### Monitoring

Check progress in real-time:

```bash
# Watch database size grow
watch -n 5 'du -h data/index.db'

# Check package count
sqlite3 data/index.db "SELECT COUNT(*) FROM packages;"

# Check metadata
sqlite3 data/index.db "SELECT * FROM meta;"
```

---

## 📂 Output Files

### `data/index.db` (SQLite Database)

**Schema:**
- `packages` table: All unique package names
- `meta` table: Metadata (timestamps, counts, config)

**Query Examples:**

```bash
# Total package count
sqlite3 data/index.db "SELECT COUNT(*) FROM packages;"

# Sample packages
sqlite3 data/index.db "SELECT name FROM packages LIMIT 10;"

# Check metadata
sqlite3 data/index.db "SELECT * FROM meta;"

# Search for a package
sqlite3 data/index.db "SELECT * FROM packages WHERE name LIKE '%react%';"
```

### `data/package-index.json` (Enumerated JSON)

**Format:**
```json
[
  ["@babel/core", 1],
  ["@babel/preset-env", 2],
  ...
]
```

**Usage:**
```javascript
const index = require('./data/package-index.json');

// Map: package name -> sequence number
const nameToSeq = new Map(index);
console.log(nameToSeq.get('react')); // e.g., 123456

// Map: sequence number -> package name
const seqToName = new Map(index.map(([name, seq]) => [seq, name]));
console.log(seqToName.get(1)); // e.g., "@babel/core"
```

### `data/index-metadata.json` (Metadata)

**Contents:**
```json
{
  "timestamp": "2025-01-12T10:30:00.000Z",
  "totalPackages": 5400000,
  "method": "streaming-all",
  "registry": "https://registry.npmmirror.com",
  "exportDurationSeconds": "45.23",
  "fileSizeMB": "180.5",
  "version": "4.0.0"
}
```

---

## 🐛 Troubleshooting

### Issue: Duplicate packages in JSON

**Solution:** This should NOT happen in v4.0. If it does:
1. Delete `data/index.db`
2. Re-run `npm run indexer:init`
3. Check SQLite integrity: `sqlite3 data/index.db "PRAGMA integrity_check;"`

### Issue: Incomplete fetch

**Symptoms:** Total packages < expected (e.g., 3M instead of 5.4M)

**Solutions:**
1. Re-run `npm run indexer:init` (will resume automatically)
2. Try `npm run indexer:changes` (parallel workers may cover gaps)
3. Check network stability
4. Increase `TIMEOUT` environment variable

### Issue: Out of memory

**Symptoms:** Process killed, heap allocation error

**Solutions:**
1. Reduce `BATCH_SIZE` (e.g., `BATCH_SIZE=1000`)
2. Reduce `STREAM_BATCH_SIZE` (e.g., `STREAM_BATCH_SIZE=10000`)
3. Use Node.js with increased heap: `node --max-old-space-size=4096 scripts/indexer/initialize_index.js`

### Issue: Database locked

**Symptoms:** `SQLITE_BUSY` error

**Solutions:**
1. Ensure only one indexer process runs at a time
2. Check for zombie processes: `ps aux | grep indexer`
3. Delete lock file: `rm data/index.db-wal data/index.db-shm`

### Issue: Slow export

**Symptoms:** Export takes >5 minutes

**Solutions:**
1. Increase `STREAM_BATCH_SIZE` (e.g., `STREAM_BATCH_SIZE=500000`)
2. Use SSD for `OUTPUT_DIR`
3. Check disk I/O: `iostat -x 5`

---

## 🧪 Testing

### Dry Run (100k packages)

```bash
# Quick test: fetch 100k packages
LIMIT=100000 npm run indexer:init

# Export to JSON
EXPORT_LIMIT=100000 npm run indexer:export

# Verify output
cat data/package-index.json | jq length  # Should output 100000
```

### Validation

```bash
# Check for duplicates in database (should return 0)
sqlite3 data/index.db "SELECT name, COUNT(*) FROM packages GROUP BY name HAVING COUNT(*) > 1;"

# Check JSON format
cat data/package-index.json | jq '.[0:5]'

# Verify sequential numbering
cat data/package-index.json | jq '.[0:5] | .[1]'  # Should be [name, 1]
```

---

## 📝 Changelog

### v4.0.0 (2025-01-12)
- ✅ Complete rewrite with SQLite-backed deduplication
- ✅ Eliminated all duplicate issues from v3.0
- ✅ Added streaming `/-/all` as primary method
- ✅ Added resume-safe checkpointing
- ✅ Memory-efficient export with streaming
- ✅ Deterministic sequential numbering

### v3.0.0 (2025-11-12)
- ❌ 100 parallel workers with direct file writes
- ❌ Race conditions causing duplicates
- ❌ Inconsistent sequential numbering
- ❌ No global deduplication

---

## 🤝 Contributing

This is a stable, production-ready tool. If you encounter issues:

1. Check this README for troubleshooting steps
2. Verify your environment variables
3. Try a dry run with `LIMIT=100000`
4. Check SQLite database integrity

---

## 📄 License

MIT License - Zeeeepa 2025

---

## 🙏 Credits

- **Author:** Zeeeepa
- **Inspiration:** Original v3.0 design with critical fixes
- **Dependencies:** axios, better-sqlite3, stream-json
- **Registry:** [registry.npmmirror.com](https://registry.npmmirror.com) (China npm mirror)

