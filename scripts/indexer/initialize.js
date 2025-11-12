'use strict';

/**
 * NPM Registry Initializer - Database Integration
 * Author: Zeeeepa
 * 
 * PURPOSE:
 * - Fetch ALL packages from registry (5.4M+)
 * - Sequential fetch with inline deduplication (no duplicate fetching)
 * - Auto-create PostgreSQL database tables if they don't exist
 * - Save packages to database with proper schema mapping
 * - Track last sequence number for sync.js to continue from
 * 
 * USAGE:
 *   DB_URL=postgres://user:pass@localhost/cnpm node scripts/indexer/initialize.js
 */

const { Client } = require('pg');
const crypto = require('crypto');

const CONFIG = {
  dbUrl: process.env.DB_URL || 'postgres://localhost/cnpm',
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  changesBatchSize: parseInt(process.env.CHANGES_BATCH_SIZE) || 10000,
  writeBatchSize: parseInt(process.env.WRITE_BATCH_SIZE) || 1000,
  timeout: 60000,
  requestDelay: 10,
  maxRetries: 3,
};

// ============================================================================
// Database Schema Management
// ============================================================================

const SCHEMA = {
  packages: `
    CREATE TABLE IF NOT EXISTS packages (
      id BIGSERIAL PRIMARY KEY,
      gmt_create timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      gmt_modified timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      package_id varchar(24) NOT NULL,
      is_private boolean NOT NULL DEFAULT false,
      name varchar(214) NOT NULL,
      scope varchar(214) NOT NULL,
      description varchar(10240) DEFAULT NULL,
      CONSTRAINT packages_uk_package_id UNIQUE (package_id),
      CONSTRAINT packages_uk_scope_name UNIQUE (scope, name)
    )
  `,
  total: `
    CREATE TABLE IF NOT EXISTS total (
      id BIGSERIAL PRIMARY KEY,
      total_id varchar(24) NOT NULL,
      gmt_create timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      gmt_modified timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      package_count bigint NOT NULL DEFAULT 0,
      change_stream_seq varchar(100) DEFAULT NULL,
      CONSTRAINT total_uk_total_id UNIQUE (total_id)
    )
  `,
};

async function ensureSchema(client) {
  console.log('[%s] [SCHEMA] Ensuring database schema exists...', new Date().toISOString());
  
  for (const [table, sql] of Object.entries(SCHEMA)) {
    try {
      await client.query(sql);
      console.log('[%s] [SCHEMA] ✓ Table %s ready', new Date().toISOString(), table);
    } catch (err) {
      console.error('[%s] [SCHEMA] ✗ Failed to create table %s: %s', 
        new Date().toISOString(), table, err.message);
      throw err;
    }
  }
}

// ============================================================================
// Schema Mapping Utilities
// ============================================================================

function extractScope(name) {
  if (name.startsWith('@')) {
    const parts = name.split('/');
    return parts[0].substring(1); // Remove @ prefix
  }
  return '';
}

function generatePackageId(name) {
  return crypto.createHash('sha1').update(name).digest('hex').substring(0, 24);
}

function mapPackageToDb(packageName) {
  return {
    package_id: generatePackageId(packageName),
    name: packageName,
    scope: extractScope(packageName),
    is_private: false,
    description: null, // Will be enriched later
  };
}

// ============================================================================
// Registry API Fetcher
// ============================================================================

async function fetchWithRetry(url, options = {}) {
  const maxRetries = options.maxRetries || CONFIG.maxRetries;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'npm-indexer/1.0.0',
          'accept': 'application/json',
        },
        signal: AbortSignal.timeout(CONFIG.timeout),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log('[%s] [FETCH] Retry %d/%d after %dms: %s', 
          new Date().toISOString(), attempt, maxRetries, delay, err.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

// ============================================================================
// Sequential Fetch with Inline Deduplication
// ============================================================================

async function fetchAllPackages(registry) {
  console.log('[%s] [FETCH] Starting sequential fetch with inline dedup...', new Date().toISOString());
  
  const packages = new Set();
  
  // Get max sequence
  const rootData = await fetchWithRetry(`${registry}/`);
  let maxSeq = rootData.update_seq || 0;
  if (typeof maxSeq === 'string') {
    const match = maxSeq.match(/^\d+/);
    maxSeq = match ? parseInt(match[0], 10) : 0;
  }
  
  console.log('[%s] [FETCH] Registry max sequence: %s', 
    new Date().toISOString(), maxSeq.toLocaleString());
  
  let since = 0;
  let requestCount = 0;
  let totalRecordsSeen = 0;
  
  while (since < maxSeq) {
    const url = `${registry}/_changes?since=${since}&limit=${CONFIG.changesBatchSize}&include_docs=false`;
    const data = await fetchWithRetry(url);
    
    const results = data.results || [];
    if (results.length === 0) break;
    
    let newInBatch = 0;
    for (const change of results) {
      const id = change.id;
      totalRecordsSeen++;
      
      if (id && !id.startsWith('_') && !packages.has(id)) {
        packages.add(id);
        newInBatch++;
      }
    }
    
    // Update sequence
    const lastSeq = data.last_seq || (results.length > 0 ? results[results.length - 1].seq : since);
    if (typeof lastSeq === 'string') {
      const match = lastSeq.match(/^\d+/);
      since = match ? parseInt(match[0], 10) : since + 1;
    } else {
      since = lastSeq;
    }
    
    requestCount++;
    
    if (requestCount % 10 === 0) {
      const progress = Math.min((since / maxSeq * 100), 100).toFixed(1);
      const dupeRate = ((totalRecordsSeen - packages.size) / totalRecordsSeen * 100).toFixed(1);
      console.log('[%s] [FETCH] %s%% | seq: %s | unique: %d | seen: %d | dupe: %s%% | new: %d',
        new Date().toISOString(),
        progress,
        since.toLocaleString(),
        packages.size,
        totalRecordsSeen,
        dupeRate,
        newInBatch
      );
    }
    
    if (since >= maxSeq) break;
    
    if (CONFIG.requestDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
    }
  }
  
  const duplicatesAvoided = totalRecordsSeen - packages.size;
  const efficiency = (packages.size / totalRecordsSeen * 100).toFixed(1);
  
  console.log('[%s] [FETCH] ═══════════════════════════════════════', new Date().toISOString());
  console.log('[%s] [FETCH] Complete!', new Date().toISOString());
  console.log('[%s] [FETCH] Total records seen: %s', new Date().toISOString(), totalRecordsSeen.toLocaleString());
  console.log('[%s] [FETCH] Unique packages: %s', new Date().toISOString(), packages.size.toLocaleString());
  console.log('[%s] [FETCH] Duplicates avoided: %s', new Date().toISOString(), duplicatesAvoided.toLocaleString());
  console.log('[%s] [FETCH] Fetch efficiency: %s%%', new Date().toISOString(), efficiency);
  console.log('[%s] [FETCH] Final sequence: %s', new Date().toISOString(), since.toLocaleString());
  console.log('[%s] [FETCH] ═══════════════════════════════════════', new Date().toISOString());
  
  return {
    packages: Array.from(packages).sort(),
    finalSeq: since.toString(),
    totalRecordsSeen,
    duplicatesAvoided,
    efficiency: parseFloat(efficiency),
  };
}

// ============================================================================
// Database Writer with Batching
// ============================================================================

async function writePackagesToDb(client, packages, finalSeq) {
  console.log('[%s] [DB] Writing %d packages to database...', 
    new Date().toISOString(), packages.length);
  
  const startTime = Date.now();
  let written = 0;
  
  // Batch insert
  for (let i = 0; i < packages.length; i += CONFIG.writeBatchSize) {
    const batch = packages.slice(i, i + CONFIG.writeBatchSize);
    
    const values = [];
    const placeholders = [];
    let paramIndex = 1;
    
    for (const packageName of batch) {
      const pkg = mapPackageToDb(packageName);
      placeholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`
      );
      values.push(pkg.package_id, pkg.name, pkg.scope, pkg.is_private, pkg.description);
      paramIndex += 5;
    }
    
    const sql = `
      INSERT INTO packages (package_id, name, scope, is_private, description)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (package_id) DO NOTHING
    `;
    
    try {
      await client.query(sql, values);
      written += batch.length;
      
      if (written % 10000 === 0 || written === packages.length) {
        const progress = (written / packages.length * 100).toFixed(1);
        console.log('[%s] [DB] Written: %d/%d (%s%%)',
          new Date().toISOString(),
          written,
          packages.length,
          progress
        );
      }
    } catch (err) {
      console.error('[%s] [DB] Error writing batch at %d: %s',
        new Date().toISOString(), i, err.message);
      throw err;
    }
  }
  
  // Update total table with final sequence
  await client.query(`
    INSERT INTO total (total_id, package_count, change_stream_seq)
    VALUES ('global', $1, $2)
    ON CONFLICT (total_id) DO UPDATE SET
      package_count = $1,
      change_stream_seq = $2,
      gmt_modified = CURRENT_TIMESTAMP
  `, [packages.length, finalSeq]);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('[%s] [DB] ✓ All packages written in %ss', new Date().toISOString(), duration);
  
  return written;
}

// ============================================================================
// Main Function
// ============================================================================

async function initialize() {
  const startTime = Date.now();
  
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Initializer - Database Integration', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Configuration:', new Date().toISOString());
  console.log('[%s]   Database: %s', new Date().toISOString(), CONFIG.dbUrl);
  console.log('[%s]   Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s]   Batch size: %d', new Date().toISOString(), CONFIG.changesBatchSize);
  console.log('[%s]   Write batch: %d', new Date().toISOString(), CONFIG.writeBatchSize);
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  
  const client = new Client({ connectionString: CONFIG.dbUrl });
  
  try {
    await client.connect();
    console.log('[%s] [DB] ✓ Connected to database', new Date().toISOString());
    
    // Ensure schema exists
    await ensureSchema(client);
    
    // Fetch all packages
    const fetchResult = await fetchAllPackages(CONFIG.registry);
    
    // Write to database
    const written = await writePackagesToDb(client, fetchResult.packages, fetchResult.finalSeq);
    
    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(written / parseFloat(totalDuration));
    
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ INITIALIZATION COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), totalDuration);
    console.log('[%s] Packages: %s', new Date().toISOString(), written.toLocaleString());
    console.log('[%s] Throughput: %s packages/minute', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] Fetch efficiency: %s%%', new Date().toISOString(), fetchResult.efficiency);
    console.log('[%s] Final sequence: %s (saved for sync)', new Date().toISOString(), fetchResult.finalSeq);
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    
    return {
      success: true,
      packagesWritten: written,
      finalSeq: fetchResult.finalSeq,
      duration: totalDuration,
      throughput,
    };
    
  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ INITIALIZATION FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);
    throw err;
  } finally {
    await client.end();
    console.log('[%s] [DB] ✓ Connection closed', new Date().toISOString());
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
  initialize()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = initialize;

