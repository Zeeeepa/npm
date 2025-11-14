# Quick Start Guide

Get up and running with the NPM Registry Indexer in 5 minutes.

## 📦 Installation

```bash
cd registry
npm install
```

## 🚀 Basic Usage

### Step 1: Create Initial Index

Fetch all packages from npm registry (~15-20 minutes):

```bash
npm run index
```

**What happens:**
- Connects to registry.npmmirror.com
- Fetches all ~5.4M packages using _changes endpoint
- Deduplicates in-memory (40% efficiency)
- Stores in SQLite database (`data/registry.db`)
- Saves checkpoint for incremental sync

**Output:**
```
✓✓✓ INDEXING COMPLETE ✓✓✓
Duration: 15.23 minutes
Packages indexed: 5,405,992
```

### Step 2: Enrich Metadata

Add descriptions, keywords, dependencies, sizes (~2-3 hours):

```bash
npm run enrich
```

**What happens:**
- Fetches full metadata for each package
- Extracts: description, keywords, dependencies count, file count, unpacked size
- Processes with 10 concurrent requests
- Updates database with enriched data
- Changes package state to 'enriched'

**Output:**
```
✓✓✓ ENRICHMENT COMPLETE ✓✓✓
Duration: 120 minutes
Successfully enriched: 5,405,992
```

### Step 3: Export to CSV

Generate CSV with all metadata (~5-10 minutes):

```bash
npm run export
```

**What happens:**
- Streams data from SQLite database
- Generates CSV with proper escaping
- Output: `data/packages.csv` (~850MB)

**Output:**
```
✓✓✓ CSV EXPORT COMPLETE ✓✓✓
Rows exported: 5,405,992
Output: ./data/packages.csv
```

## 🔄 Daily Updates

After initial setup, sync daily:

```bash
# Fetch new packages
npm run sync

# Enrich new packages
npm run enrich

# Re-export CSV
npm run export
```

## 🎯 Filtered Exports

### Last Year Only

```bash
node csv.js --published-after 2024-01-01 --output recent.csv
```

### Large Packages

```bash
node csv.js --min-size 1000000 --output large.csv
```

### With Dependencies

```bash
node csv.js --min-deps 1 --max-deps 10 --output moderate.csv
```

## 📊 Check Status

```bash
# View database statistics
node -e "
const RegistryDB = require('./db.js').default;
const db = new RegistryDB();
db.connect();
console.log(db.getStats());
db.close();
"
```

## ⚡ Performance Tips

### Faster Enrichment

```bash
# Increase concurrency (watch for rate limits)
ENRICH_CONCURRENCY=20 npm run enrich
```

### Resume After Crash

```bash
# Enrichment automatically resumes
npm run enrich

# Or specify offset
node enrich.js --resume-from 100000
```

### Custom Registry

```bash
# Use different registry
NPM_REGISTRY=https://registry.npmjs.org npm run index
```

## 🆘 Common Issues

### "Database already contains packages"

Already indexed. Use `npm run sync` for updates.

### "No checkpoint found"

Run `npm run index` first.

### Out of memory

```bash
node --max-old-space-size=4096 enrich.js
```

### Slow network

```bash
REQUEST_TIMEOUT=120000 npm run enrich
```

## 📁 Output Files

```
registry/
└── data/
    ├── registry.db       # SQLite database (all data)
    ├── registry.db-wal   # Write-ahead log
    └── packages.csv      # CSV export
```

## 🎉 You're Done!

You now have:
- ✅ Complete npm registry index in SQLite
- ✅ Enriched metadata for all packages
- ✅ CSV export ready for analysis

**Next:** Explore filtering options with `node csv.js --help`

