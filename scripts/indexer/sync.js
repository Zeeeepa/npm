'use strict';

/**
 * NPM Registry Sync - Incremental Updates
 * Author: Zeeeepa
 * 
 * PURPOSE:
 * - Fetch packages that changed since last sync
 * - Read last sequence from `total.change_stream_seq`
 * - Update to current registry sequence
 * - Add new packages, update existing ones
 * 
 * USAGE:
 *   DB_URL=postgres://user:pass@localhost/cnpm node scripts/indexer/sync.js
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
// Schema Mapping Utilities (Same as initialize.js)
// ============================================================================

function extractScope(name) {
  if (name.startsWith('@')) {
    const parts = name.split('/');
    return parts[0].substring(1);
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
    description: null,
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
          'user-agent': 'npm-sync/1.0.0',
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
// Get Last Sync Sequence from Database
// ============================================================================

async function getLastSyncSeq(client) {
  const result = await client.query(`
    SELECT change_stream_seq FROM total WHERE total_id = 'global'
  `);
  
  if (result.rows.length === 0) {
    console.log('[%s] [SYNC] No previous sync found, starting from 0', new Date().toISOString());
    return 0;
  }
  
  const seq = result.rows[0].change_stream_seq;
  const seqNum = parseInt(seq, 10) || 0;
  console.log('[%s] [SYNC] Last sync sequence: %s', new Date().toISOString(), seqNum.toLocaleString());
  
  return seqNum;
}

// ============================================================================
// Fetch Changed Packages Since Last Sync
// ============================================================================

async function fetchChangedPackages(registry, sinceSeq) {
  console.log('[%s] [FETCH] Fetching changes since seq %s...', 
    new Date().toISOString(), sinceSeq.toLocaleString());
  
  const packages = new Set();
  
  // Get current max sequence
  const rootData = await fetchWithRetry(`${registry}/`);
  let maxSeq = rootData.update_seq || 0;
  if (typeof maxSeq === 'string') {
    const match = maxSeq.match(/^\d+/);
    maxSeq = match ? parseInt(match[0], 10) : 0;
  }
  
  console.log('[%s] [FETCH] Current max sequence: %s', 
    new Date().toISOString(), maxSeq.toLocaleString());
  
  if (sinceSeq >= maxSeq) {
    console.log('[%s] [FETCH] Already up to date!', new Date().toISOString());
    return {
      packages: [],
      finalSeq: maxSeq.toString(),
      totalRecordsSeen: 0,
      isUpToDate: true,
    };
  }
  
  let since = sinceSeq;
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
      const progress = Math.min(((since - sinceSeq) / (maxSeq - sinceSeq) * 100), 100).toFixed(1);
      console.log('[%s] [FETCH] %s%% | seq: %s | unique: %d | seen: %d | new: %d',
        new Date().toISOString(),
        progress,
        since.toLocaleString(),
        packages.size,
        totalRecordsSeen,
        newInBatch
      );
    }
    
    if (since >= maxSeq) break;
    
    if (CONFIG.requestDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
    }
  }
  
  console.log('[%s] [FETCH] ═══════════════════════════════════════', new Date().toISOString());
  console.log('[%s] [FETCH] Sync fetch complete!', new Date().toISOString());
  console.log('[%s] [FETCH] Total records seen: %s', new Date().toISOString(), totalRecordsSeen.toLocaleString());
  console.log('[%s] [FETCH] Unique changed packages: %s', new Date().toISOString(), packages.size.toLocaleString());
  console.log('[%s] [FETCH] Final sequence: %s', new Date().toISOString(), since.toLocaleString());
  console.log('[%s] [FETCH] ═══════════════════════════════════════', new Date().toISOString());
  
  return {
    packages: Array.from(packages).sort(),
    finalSeq: since.toString(),
    totalRecordsSeen,
    isUpToDate: false,
  };
}

// ============================================================================
// Update Database with Changed Packages
// ============================================================================

async function updatePackagesInDb(client, packages, finalSeq) {
  if (packages.length === 0) {
    console.log('[%s] [DB] No packages to update', new Date().toISOString());
    return 0;
  }
  
  console.log('[%s] [DB] Updating %d packages in database...', 
    new Date().toISOString(), packages.length);
  
  const startTime = Date.now();
  let updated = 0;
  
  // Batch upsert
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
      ON CONFLICT (package_id) DO UPDATE SET
        gmt_modified = CURRENT_TIMESTAMP
    `;
    
    try {
      await client.query(sql, values);
      updated += batch.length;
      
      if (updated % 10000 === 0 || updated === packages.length) {
        const progress = (updated / packages.length * 100).toFixed(1);
        console.log('[%s] [DB] Updated: %d/%d (%s%%)',
          new Date().toISOString(),
          updated,
          packages.length,
          progress
        );
      }
    } catch (err) {
      console.error('[%s] [DB] Error updating batch at %d: %s',
        new Date().toISOString(), i, err.message);
      throw err;
    }
  }
  
  // Update total table with new sequence and count
  const countResult = await client.query('SELECT COUNT(*) as count FROM packages');
  const totalCount = parseInt(countResult.rows[0].count, 10);
  
  await client.query(`
    UPDATE total SET
      package_count = $1,
      change_stream_seq = $2,
      gmt_modified = CURRENT_TIMESTAMP
    WHERE total_id = 'global'
  `, [totalCount, finalSeq]);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('[%s] [DB] ✓ All packages updated in %ss', new Date().toISOString(), duration);
  console.log('[%s] [DB] Total packages in database: %s', new Date().toISOString(), totalCount.toLocaleString());
  
  return updated;
}

// ============================================================================
// Main Function
// ============================================================================

async function sync() {
  const startTime = Date.now();
  
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Sync - Incremental Updates', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Configuration:', new Date().toISOString());
  console.log('[%s]   Database: %s', new Date().toISOString(), CONFIG.dbUrl);
  console.log('[%s]   Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  
  const client = new Client({ connectionString: CONFIG.dbUrl });
  
  try {
    await client.connect();
    console.log('[%s] [DB] ✓ Connected to database', new Date().toISOString());
    
    // Get last sync sequence
    const lastSeq = await getLastSyncSeq(client);
    
    // Fetch changed packages
    const fetchResult = await fetchChangedPackages(CONFIG.registry, lastSeq);
    
    if (fetchResult.isUpToDate) {
      console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
      console.log('[%s] ✓ ALREADY UP TO DATE', new Date().toISOString());
      console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
      return { success: true, packagesUpdated: 0, upToDate: true };
    }
    
    // Update database
    const updated = await updatePackagesInDb(client, fetchResult.packages, fetchResult.finalSeq);
    
    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ SYNC COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), totalDuration);
    console.log('[%s] Packages updated: %s', new Date().toISOString(), updated.toLocaleString());
    console.log('[%s] Sequence: %s → %s', new Date().toISOString(), lastSeq.toLocaleString(), fetchResult.finalSeq);
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    
    return {
      success: true,
      packagesUpdated: updated,
      fromSeq: lastSeq,
      toSeq: fetchResult.finalSeq,
      duration: totalDuration,
    };
    
  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ SYNC FAILED ✗✗✗', new Date().toISOString());
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
  sync()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = sync;

