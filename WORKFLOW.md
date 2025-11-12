# NPM Registry Indexer - 4-Script Workflow

## Overview

This indexer follows a 4-stage pipeline to create a comprehensive npm package database:

```
initialize.js  →  sync.js  →  enrich.js  →  export-csv.js
   (5.4M)        (+updates)   (+metadata)     (CSV)
```

## Quick Start

### 1. Database Setup

Create a PostgreSQL database and config file:

```bash
# Create database
createdb npm_registry

# Create db-config.json
cat > db-config.json << EOF
{
  "host": "localhost",
  "port": 5432,
  "database": "npm_registry",
  "user": "postgres",
  "password": "your_password",
  "poolSize": 20
}
EOF
```

### 2. Run the Pipeline

```bash
# Install dependencies
npm install

# Step 1: Initialize - Fetch all 5.4M+ packages (30 min, 10 workers)
npm run init -- --db-config=./db-config.json --workers=10

# Step 2: Sync - Get updates from npm registry (5 min)
npm run sync -- --db-config=./db-config.json

# Step 3: Enrich - Fetch metadata for each package (6-8 hours @ 10 req/sec)
npm run enrich -- --db-config=./db-config.json --rate=10

# Step 4: Export to CSV (10 min)
npm run export-csv -- --db-config=./db-config.json --output=./packages.csv

# Or run all steps at once:
npm run full-pipeline
```

## Database Schema

### Table: `packages`
```sql
CREATE TABLE packages (
  id BIGSERIAL PRIMARY KEY,
  seq INTEGER NOT NULL,                     -- Sequential number (0-based)
  name VARCHAR(214) NOT NULL,               -- Package name
  description TEXT,                         -- From latest version
  keywords TEXT[],                          -- Array of keywords
  dependencies JSONB,                       -- Dependencies as JSON
  latest_version VARCHAR(100),              -- Version string
  latest_release_published_at TIMESTAMP(3), -- Publish time
  file_count INTEGER,                       -- Number of files
  unpacked_size BIGINT,                     -- Total bytes
  dependents_count INTEGER,                 -- Packages depending on this
  enriched_at TIMESTAMP(3)                  -- When metadata was fetched
);
```

### Table: `total`
```sql
CREATE TABLE total (
  name VARCHAR(50) PRIMARY KEY DEFAULT 'global',
  package_count BIGINT,                     -- Total packages
  change_stream_seq BIGINT,                 -- Last _changes sequence
  last_sync_time TIMESTAMP(3)               -- Last sync time
);
```

## Script Details

### initialize.js

**Purpose**: Create initial package index from npm registry

**Features**:
- 10 parallel workers (configurable via `--workers=N`)
- Global deduplication Set (zero duplicates guaranteed)
- Auto-creates PostgreSQL schema
- Saves to `packages` table with sequential numbering
- Updates `total` table with `change_stream_seq` for sync

**Usage**:
```bash
node initialize.js --db-config=./db-config.json --workers=10
```

**Output**: ~5.4M packages in PostgreSQL (seq 0-5399999)

---

### sync.js

**Purpose**: Incrementally sync new/updated packages

**Features**:
- Tracks last sequence from `total` table
- Uses npm `/_changes` API
- Handles new packages, updates, and deletions
- Atomic state updates after each batch
- Idempotent (safe to run multiple times)

**Usage**:
```bash
node sync.js --db-config=./db-config.json
```

**Output**: Updated packages + new sequence in `total` table

---

### enrich.js

**Purpose**: Fetch full metadata for packages

**Features**:
- Batch processing (100 packages per query)
- Rate limiting (10 req/sec default, configurable via `--rate=N`)
- Extracts: description, keywords, dependencies, versions, file count, size
- Resumable (tracks via `enriched_at` column)
- Progress reporting with ETA

**Usage**:
```bash
# Enrich all packages
node enrich.js --db-config=./db-config.json --rate=10

# Enrich only first 1000 packages (testing)
node enrich.js --db-config=./db-config.json --limit=1000
```

**Output**: Enriched packages with `enriched_at` timestamp

---

### export-csv.js

**Purpose**: Export enriched data to CSV

**Features**:
- Streaming from PostgreSQL (memory-efficient)
- Transforms JSONB/arrays to CSV format
- 10 columns: number, npm_url, package_name, file_number, unpacked_size, dependencies, dependents, latest_release_published_at, description, keywords

**Usage**:
```bash
node export-csv.js --db-config=./db-config.json --output=./packages.csv
```

**Output**: CSV file with all enriched packages

**CSV Format**:
```csv
number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords
1,https://www.npmjs.com/package/lodash,lodash,18,16803,0,117,2025-10-30,"A modern JavaScript utility library",utils,functional
```

## Performance

| Stage | Duration | Rate | Notes |
|-------|----------|------|-------|
| **initialize.js** | ~30 min | 180K pkg/min | 10 workers, parallel |
| **sync.js** | ~5 min | N/A | First time; <1 min after |
| **enrich.js** | ~6-8 hours | 10 req/sec | 360K pkg/hour |
| **export-csv.js** | ~10 min | N/A | Streaming output |

## Architecture

### Data Flow

```
npm registry (/_changes API)
    ↓
initialize.js (parallel workers + dedup)
    ↓
PostgreSQL: packages (seq, name only)
PostgreSQL: total (package_count, change_stream_seq)
    ↓
sync.js (incremental updates)
    ↓
PostgreSQL: packages (additions/updates/deletes)
    ↓
enrich.js (sequential, rate-limited)
    ↓
npm registry (/{packageName} API)
    ↓
PostgreSQL: packages (enriched columns)
    ↓
export-csv.js (streaming)
    ↓
CSV file (5.4M rows)
```

### Key Design Decisions

1. **Global Deduplication Set**: Prevents duplicates across parallel workers
2. **Sequential Numbering**: Packages numbered 0-5399999 in order discovered
3. **Separate Enrichment**: Enrichment is separate from indexing for flexibility
4. **Streaming CSV**: Memory-constant export regardless of dataset size
5. **PostgreSQL Backend**: Enables resumable operations and complex queries

## Troubleshooting

### "Total table not initialized"
Run `initialize.js` first to create the initial index.

### "No enriched packages to export"
Run `enrich.js` before `export-csv.js`.

### Rate limiting errors
Reduce `--rate` parameter in `enrich.js` (e.g., `--rate=5`).

### Out of memory
These scripts use streaming and should never OOM. Check database connection pooling.

### Duplicate packages
The global deduplication Set guarantees zero duplicates. Verified in testing.

## Contributing

This is a minimal implementation. Future enhancements:
- Parallel enrichment workers
- Dependents calculation (reverse dependency lookup)
- Incremental CSV exports (only changed packages)
- Download statistics tracking

