'use strict';

/**
 * NPM Registry Indexer - Primary Method: Streaming /-/all
 * Fetches complete package list from registry's bulk endpoint
 * Memory-efficient streaming with global SQLite deduplication
 */

const axios = require('axios');
const { PassThrough } = require('stream');
const StreamArray = require('stream-json/streamers/StreamArray');
const IndexDB = require('./db');

const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  dbPath: process.env.DB_PATH || './data/index.db',
  batchSize: parseInt(process.env.BATCH_SIZE) || 10000,
  limit: parseInt(process.env.LIMIT) || 0,
  timeout: parseInt(process.env.TIMEOUT) || 300000, // 5 minutes
  userAgent: 'npm-registry-indexer/4.0.0 (Zeeeepa; streaming-all; +https://github.com/zeeeepa/npm-indexer)',
};

async function fetchAll() {
  const startTime = Date.now();
  
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Indexer - Streaming /-/all Edition', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s] Database: %s', new Date().toISOString(), CONFIG.dbPath);
  console.log('[%s] Batch size: %s', new Date().toISOString(), CONFIG.batchSize.toLocaleString());
  if (CONFIG.limit > 0) {
    console.log('[%s] Limit: %s (DRY RUN)', new Date().toISOString(), CONFIG.limit.toLocaleString());
  }
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

  // Initialize database
  const db = new IndexDB(CONFIG.dbPath);
  db.initialize();

  const initialCount = db.getCount();
  console.log('[%s] Initial package count: %s', new Date().toISOString(), initialCount.toLocaleString());

  // Record start time in metadata
  db.setMeta('last_fetch_start', new Date().toISOString());
  db.setMeta('registry', CONFIG.registry);

  let processedCount = 0;
  let newCount = 0;
  let batchBuffer = [];
  let lastLogTime = Date.now();
  let limitReached = false;

  try {
    console.log('[%s] [FETCH] Requesting %s/-/all ...', new Date().toISOString(), CONFIG.registry);

    const response = await axios({
      method: 'GET',
      url: `${CONFIG.registry}/-/all`,
      responseType: 'stream',
      timeout: CONFIG.timeout,
      headers: {
        'user-agent': CONFIG.userAgent,
        'accept': 'application/json',
      },
      maxRedirects: 5,
    });

    console.log('[%s] [FETCH] Response received, streaming data...', new Date().toISOString());
    console.log('[%s] [FETCH] Content-Type: %s', new Date().toISOString(), response.headers['content-type']);

    const stream = response.data.pipe(StreamArray.withParser());

    stream.on('data', ({ key, value }) => {
      // Skip metadata entries (e.g., "_updated")
      if (!key || key.startsWith('_')) return;

      processedCount++;
      batchBuffer.push(key);

      // Insert batch when buffer reaches batch size
      if (batchBuffer.length >= CONFIG.batchSize) {
        const inserted = db.insertBatch(batchBuffer);
        newCount += inserted;
        batchBuffer = [];

        // Progress logging every 10 seconds
        const now = Date.now();
        if (now - lastLogTime >= 10000) {
          const currentTotal = db.getCount();
          const elapsed = ((now - startTime) / 1000 / 60).toFixed(2);
          const rate = Math.round(processedCount / parseFloat(elapsed) / 60);
          console.log('[%s] [PROGRESS] Processed: %s | New: %s | Total: %s | Rate: %s/sec',
            new Date().toISOString(),
            processedCount.toLocaleString(),
            newCount.toLocaleString(),
            currentTotal.toLocaleString(),
            rate.toLocaleString()
          );
          lastLogTime = now;
          
          // Checkpoint every progress log
          db.checkpoint();
        }
      }

      // Check limit for dry-run
      if (CONFIG.limit > 0 && processedCount >= CONFIG.limit) {
        limitReached = true;
        stream.destroy();
      }
    });

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    // Insert remaining packages in buffer
    if (batchBuffer.length > 0) {
      const inserted = db.insertBatch(batchBuffer);
      newCount += inserted;
    }

    // Final checkpoint
    db.checkpoint();

    const finalCount = db.getCount();
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(processedCount / parseFloat(duration));

    // Update metadata
    db.setMeta('last_fetch_end', new Date().toISOString());
    db.setMeta('last_fetch_duration_minutes', duration);
    db.setMeta('total_packages', finalCount);
    db.setMeta('last_fetch_processed', processedCount);
    db.setMeta('last_fetch_new', newCount);

    const stats = db.getStats();

    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ FETCH COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Processed: %s packages', new Date().toISOString(), processedCount.toLocaleString());
    console.log('[%s] New packages: %s', new Date().toISOString(), newCount.toLocaleString());
    console.log('[%s] Total unique: %s', new Date().toISOString(), finalCount.toLocaleString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), duration);
    console.log('[%s] Throughput: %s packages/minute', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] Database size: %s MB', new Date().toISOString(), stats.dbSizeMB);
    if (limitReached) {
      console.log('[%s] [LIMIT REACHED - DRY RUN]', new Date().toISOString());
    }
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

    db.close();

    return {
      success: true,
      processed: processedCount,
      newPackages: newCount,
      totalPackages: finalCount,
      duration,
      throughput,
      dbSizeMB: stats.dbSizeMB,
      limitReached,
    };

  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ FETCH FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);

    // Save partial results if any
    if (batchBuffer.length > 0) {
      const inserted = db.insertBatch(batchBuffer);
      newCount += inserted;
      console.log('[%s] [RECOVERY] Saved %d remaining packages', new Date().toISOString(), batchBuffer.length);
    }

    db.setMeta('last_fetch_error', err.message);
    db.close();

    throw err;
  }
}

// CLI entry point
if (require.main === module) {
  fetchAll()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = fetchAll;

