'use strict';

/**
 * NPM Registry Sync
 * Incrementally syncs new/updated packages from npm registry
 * 
 * Usage: node sync.js [--db-config=./db-config.json]
 */

const fs = require('fs');
const urllib = require('urllib');
const { createConnection } = require('./lib/db-connection');

const logger = console;

// Configuration
const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  dbConfig: process.argv.find(arg => arg.startsWith('--db-config='))?.split('=')[1] || null,
  changesBatchSize: 10000,
  timeout: 60000,
  userAgent: 'npm-registry-sync/4.0.0',
};

let DB_CONNECTION = null;

// Database helpers
async function initializeDatabase() {
  if (!CONFIG.dbConfig) {
    logger.error('[DB] No database config provided. Use --db-config=./db-config.json');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG.dbConfig, 'utf8'));
  DB_CONNECTION = createConnection('postgresql', config);
  await DB_CONNECTION.connect();
}

async function getSyncState() {
  const result = await DB_CONNECTION.query('SELECT change_stream_seq, package_count FROM total WHERE name = $1', ['global']);
  if (result.length === 0) {
    logger.error('[DB] Total table not initialized. Run initialize.js first.');
    process.exit(1);
  }
  return {
    lastSeq: parseInt(result[0].change_stream_seq) || 0,
    packageCount: parseInt(result[0].package_count) || 0,
  };
}

async function updateSyncState(newSeq, packageCount) {
  await DB_CONNECTION.query(`
    UPDATE total 
    SET change_stream_seq = $1,
        package_count = $2,
        last_sync_time = CURRENT_TIMESTAMP,
        gmt_modified = CURRENT_TIMESTAMP
    WHERE name = 'global'
  `, [newSeq, packageCount]);
}

async function upsertPackage(name, seq) {
  // Check if package exists
  const existing = await DB_CONNECTION.query('SELECT seq FROM packages WHERE name = $1', [name]);
  
  if (existing.length === 0) {
    // Insert new package
    await DB_CONNECTION.query(`
      INSERT INTO packages (seq, name, gmt_create, gmt_modified)
      VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (name) DO UPDATE SET gmt_modified = CURRENT_TIMESTAMP
    `, [seq, name]);
    return 'new';
  } else {
    // Update existing package
    await DB_CONNECTION.query(`
      UPDATE packages SET gmt_modified = CURRENT_TIMESTAMP WHERE name = $1
    `, [name]);
    return 'updated';
  }
}

async function getMaxSeq() {
  const result = await DB_CONNECTION.query('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM packages');
  return parseInt(result[0].max_seq) || 0;
}

// Main sync function
async function main() {
  const startTime = Date.now();

  logger.log('═══════════════════════════════════════════════════════');
  logger.log('NPM Registry Sync v4.0');
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('Registry: %s', CONFIG.registry);
  logger.log('═══════════════════════════════════════════════════════');

  try {
    await initializeDatabase();

    // Get current sync state
    const state = await getSyncState();
    logger.log('[Sync] Last sequence: %s', state.lastSeq.toLocaleString());
    logger.log('[Sync] Package count: %s', state.packageCount.toLocaleString());

    // Get current max sequence from registry
    const rootResult = await urllib.request(`${CONFIG.registry}/`, {
      dataType: 'json',
      timeout: 30000,
      headers: { 'user-agent': CONFIG.userAgent },
    });

    const currentMaxSeq = rootResult.data?.update_seq || 0;
    logger.log('[Sync] Current max sequence: %s', currentMaxSeq.toLocaleString());

    if (state.lastSeq >= currentMaxSeq) {
      logger.log('[Sync] ✓ Already up to date!');
      await DB_CONNECTION.disconnect();
      process.exit(0);
    }

    const changesToSync = currentMaxSeq - state.lastSeq;
    logger.log('[Sync] Changes to sync: %s', changesToSync.toLocaleString());

    // Fetch changes incrementally
    let since = state.lastSeq;
    let newPackages = 0;
    let updatedPackages = 0;
    let deletedPackages = 0;
    let requestCount = 0;
    let maxSeq = await getMaxSeq();

    while (since < currentMaxSeq) {
      const url = `${CONFIG.registry}/_changes?since=${since}&limit=${CONFIG.changesBatchSize}&include_docs=false`;

      const result = await urllib.request(url, {
        dataType: 'json',
        timeout: CONFIG.timeout,
        headers: { 'user-agent': CONFIG.userAgent },
        gzip: true,
      });

      const data = result.data;
      const results = data.results || [];

      if (results.length === 0) break;

      // Process each change
      for (const change of results) {
        const id = change.id;
        
        if (!id || id.startsWith('_') || id.length === 0) continue;

        if (change.deleted) {
          // Delete package
          await DB_CONNECTION.query('DELETE FROM packages WHERE name = $1', [id]);
          deletedPackages++;
        } else {
          // Upsert package
          const action = await upsertPackage(id, ++maxSeq);
          if (action === 'new') newPackages++;
          else updatedPackages++;
        }
      }

      since = data.last_seq || results[results.length - 1].seq;
      requestCount++;

      // Update sync state after each batch
      const currentPackageCount = state.packageCount + newPackages - deletedPackages;
      await updateSyncState(since, currentPackageCount);

      const progress = ((since - state.lastSeq) / (currentMaxSeq - state.lastSeq) * 100).toFixed(1);
      logger.log('[Sync] %s%% | seq: %s | new: %d, updated: %d, deleted: %d',
        progress, since.toLocaleString(), newPackages, updatedPackages, deletedPackages);
    }

    await DB_CONNECTION.disconnect();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.log('═══════════════════════════════════════════════════════');
    logger.log('✓✓✓ SYNC COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('Duration: %s seconds', duration);
    logger.log('New packages: %d', newPackages);
    logger.log('Updated packages: %d', updatedPackages);
    logger.log('Deleted packages: %d', deletedPackages);
    logger.log('Final sequence: %s', since.toLocaleString());
    logger.log('═══════════════════════════════════════════════════════');

    process.exit(0);
  } catch (err) {
    logger.error('✗✗✗ SYNC FAILED ✗✗✗');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = main;

