'use strict';

/**
 * NPM Registry Initializer
 * Fetches all packages from npm registry, deduplicates, and saves to PostgreSQL
 * 
 * Usage: node initialize.js [--db-config=./db-config.json] [--workers=10]
 */

const fs = require('fs');
const urllib = require('urllib');
const { createConnection } = require('./lib/db-connection');

const logger = console;

// Configuration
const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  workers: parseInt(process.argv.find(arg => arg.startsWith('--workers='))?.split('=')[1]) || 10,
  dbConfig: process.argv.find(arg => arg.startsWith('--db-config='))?.split('=')[1] || null,
  changesBatchSize: 10000,
  writeBatchSize: 1000,
  timeout: 60000,
  requestDelay: 10,
  userAgent: 'npm-registry-indexer/4.0.0',
};

// Global deduplication Set (prevents duplicates across all workers)
const GLOBAL_PACKAGE_SET = new Set();
let PACKAGE_COUNTER = 0;
let DB_CONNECTION = null;

// Database helper functions
async function initializeDatabase() {
  if (!CONFIG.dbConfig) {
    logger.error('[DB] No database config provided. Use --db-config=./db-config.json');
    logger.error('[DB] Example config: {"host": "localhost", "database": "npm_registry", "user": "postgres", "password": "password"}');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG.dbConfig, 'utf8'));
  DB_CONNECTION = createConnection('postgresql', config);
  await DB_CONNECTION.connect();

  // Create schema if not exists
  const schemaSQL = fs.readFileSync('./schema.sql', 'utf8');
  await DB_CONNECTION.query(schemaSQL);
  
  logger.log('[DB] Schema initialized');
}

async function savePackageBatch(packages) {
  if (packages.length === 0) return;

  const records = packages.map(name => ({
    seq: PACKAGE_COUNTER++,
    name,
    gmt_create: new Date(),
    gmt_modified: new Date(),
  }));

  await DB_CONNECTION.batchInsert('packages', records, {
    columns: ['seq', 'name', 'gmt_create', 'gmt_modified'],
    onConflict: '(name) DO NOTHING',
  });

  logger.log('[DB] Inserted %d packages (total: %d)', packages.length, PACKAGE_COUNTER);
}

async function updateTotalStats(finalSeq) {
  await DB_CONNECTION.query(`
    UPDATE total 
    SET package_count = $1, 
        change_stream_seq = $2,
        gmt_modified = CURRENT_TIMESTAMP
    WHERE name = 'global'
  `, [PACKAGE_COUNTER, finalSeq]);
  
  logger.log('[DB] Updated total stats: packages=%d, seq=%d', PACKAGE_COUNTER, finalSeq);
}

// Worker function: fetch sequence range
async function fetchWorkerRange(workerId, startSeq, endSeq, registry) {
  const localPackages = [];
  let since = startSeq;
  let requestCount = 0;
  let errors = 0;
  const maxErrors = 5;

  logger.log('[Worker #%d] START: seq %s → %s', workerId, startSeq.toLocaleString(), endSeq.toLocaleString());

  while (since < endSeq && errors < maxErrors) {
    const url = `${registry}/_changes?since=${since}&limit=${CONFIG.changesBatchSize}&include_docs=false`;

    try {
      const result = await urllib.request(url, {
        dataType: 'json',
        timeout: CONFIG.timeout,
        headers: { 'user-agent': CONFIG.userAgent },
        gzip: true,
      });

      if (result.status !== 200) throw new Error(`HTTP ${result.status}`);

      const data = result.data;
      const results = data.results || [];

      if (results.length === 0) {
        logger.log('[Worker #%d] No more results at seq %s', workerId, since);
        break;
      }

      // Extract packages with inline deduplication
      const batchPackages = [];
      for (const change of results) {
        const id = change.id;
        if (id && !id.startsWith('_') && id.length > 0 && !GLOBAL_PACKAGE_SET.has(id)) {
          GLOBAL_PACKAGE_SET.add(id);
          batchPackages.push(id);
        }
      }

      // Save batch to database
      if (batchPackages.length > 0) {
        await savePackageBatch(batchPackages);
        localPackages.push(...batchPackages);
      }

      since = data.last_seq || results[results.length - 1].seq;
      requestCount++;
      errors = 0;

      // Progress logging
      if (requestCount % 10 === 0) {
        const progress = Math.min(((since - startSeq) / (endSeq - startSeq) * 100), 100).toFixed(1);
        logger.log('[Worker #%d] %s%% | seq: %s | local: %d', workerId, progress, since.toLocaleString(), localPackages.length);
      }

      if (since >= endSeq) break;

      await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));

    } catch (err) {
      errors++;
      logger.error('[Worker #%d] Error at seq %s: %s', workerId, since, err.message);
      const delay = Math.min(1000 * Math.pow(2, errors), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.log('[Worker #%d] ✓ DONE: %d packages', workerId, localPackages.length);
  return { workerId, packages: localPackages.length, finalSeq: since };
}

// Main function
async function main() {
  const startTime = Date.now();

  logger.log('═══════════════════════════════════════════════════════');
  logger.log('NPM Registry Initializer v4.0');
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('Workers: %d', CONFIG.workers);
  logger.log('Registry: %s', CONFIG.registry);
  logger.log('═══════════════════════════════════════════════════════');

  try {
    // Initialize database
    await initializeDatabase();

    // Get max sequence from registry
    const rootResult = await urllib.request(`${CONFIG.registry}/`, {
      dataType: 'json',
      timeout: 30000,
      headers: { 'user-agent': CONFIG.userAgent },
    });

    const maxSeq = rootResult.data?.update_seq || 0;
    logger.log('[Main] Registry max sequence: %s', maxSeq.toLocaleString());

    // Calculate ranges for workers
    const seqPerWorker = Math.ceil(maxSeq / CONFIG.workers);
    logger.log('[Main] Each worker handles ~%s sequences', seqPerWorker.toLocaleString());

    // Launch workers
    const workerPromises = [];
    for (let i = 0; i < CONFIG.workers; i++) {
      const startSeq = i * seqPerWorker;
      const endSeq = Math.min((i + 1) * seqPerWorker, maxSeq);
      if (startSeq >= maxSeq) break;
      workerPromises.push(fetchWorkerRange(i, startSeq, endSeq, CONFIG.registry));
    }

    logger.log('[Main] Launched %d workers', workerPromises.length);

    // Wait for all workers
    const results = await Promise.all(workerPromises);

    // Update total stats
    const finalSeq = Math.max(...results.map(r => r.finalSeq));
    await updateTotalStats(finalSeq);

    // Disconnect
    await DB_CONNECTION.disconnect();

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(PACKAGE_COUNTER / parseFloat(duration));

    logger.log('═══════════════════════════════════════════════════════');
    logger.log('✓✓✓ INITIALIZATION COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('Duration: %s minutes', duration);
    logger.log('Packages: %s', PACKAGE_COUNTER.toLocaleString());
    logger.log('Throughput: %s packages/minute', throughput.toLocaleString());
    logger.log('Final sequence: %s', finalSeq.toLocaleString());
    logger.log('═══════════════════════════════════════════════════════');

    process.exit(0);
  } catch (err) {
    logger.error('✗✗✗ INITIALIZATION FAILED ✗✗✗');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = main;

