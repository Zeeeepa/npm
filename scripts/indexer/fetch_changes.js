'use strict';

/**
 * NPM Registry Indexer - Fallback Method: Parallel _changes Workers
 * Uses 100 parallel workers with centralized SQLite deduplication
 * This is the fallback if /-/all is unavailable
 */

const axios = require('axios');
const IndexDB = require('./db');

const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  dbPath: process.env.DB_PATH || './data/index.db',
  workers: parseInt(process.env.WORKERS) || 100,
  changesBatchSize: parseInt(process.env.CHANGES_BATCH_SIZE) || 10000,
  dbBatchSize: parseInt(process.env.DB_BATCH_SIZE) || 5000,
  timeout: parseInt(process.env.TIMEOUT) || 60000,
  requestDelay: parseInt(process.env.REQUEST_DELAY) || 10,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  userAgent: 'npm-registry-indexer/4.0.0 (Zeeeepa; parallel-changes; +https://github.com/zeeeepa/npm-indexer)',
};

/**
 * Single worker that fetches a sequence range
 */
async function fetchSequenceRange(workerId, startSeq, endSeq, registry, db) {
  let since = startSeq;
  let requestCount = 0;
  let errors = 0;
  let processedInWorker = 0;
  let insertedInWorker = 0;
  const maxErrors = 5;
  let batchBuffer = [];

  console.log('[Worker #%d] START: seq %s → %s', workerId, startSeq.toLocaleString(), endSeq.toLocaleString());

  const flushBatch = () => {
    if (batchBuffer.length === 0) return 0;
    const inserted = db.insertBatch(batchBuffer);
    insertedInWorker += inserted;
    batchBuffer = [];
    return inserted;
  };

  try {
    while (since < endSeq && errors < maxErrors) {
      const url = `${registry}/_changes?since=${since}&limit=${CONFIG.changesBatchSize}&include_docs=false`;

      try {
        const response = await axios.get(url, {
          timeout: CONFIG.timeout,
          headers: {
            'user-agent': CONFIG.userAgent,
            'accept': 'application/json',
          },
          maxRedirects: 5,
        });

        const data = response.data;
        const results = data.results || [];

        if (results.length === 0) {
          console.log('[Worker #%d] No more results at seq %s', workerId, since);
          break;
        }

        // Extract package names
        for (const change of results) {
          const id = change.id;
          if (id && !id.startsWith('_design/') && !id.startsWith('_') && id.length > 0) {
            processedInWorker++;
            batchBuffer.push(id);

            // Flush batch when buffer reaches batch size
            if (batchBuffer.length >= CONFIG.dbBatchSize) {
              flushBatch();
            }
          }
        }

        // Update sequence
        const lastSeq = data.last_seq || (results.length > 0 ? results[results.length - 1].seq : since);
        
        // Handle string sequences (parse leading number)
        if (typeof lastSeq === 'string') {
          const match = lastSeq.match(/^\d+/);
          since = match ? parseInt(match[0], 10) : since + 1;
        } else {
          since = lastSeq;
        }

        requestCount++;
        errors = 0; // Reset error counter on success

        // Progress logging every 10 requests
        if (requestCount % 10 === 0) {
          const progress = Math.min(((since - startSeq) / (endSeq - startSeq) * 100), 100).toFixed(1);
          console.log('[Worker #%d] %s%% | seq: %s | processed: %d | inserted: %d | requests: %d',
            workerId, progress, since.toLocaleString(), processedInWorker, insertedInWorker, requestCount
          );
        }

        if (since >= endSeq) {
          console.log('[Worker #%d] Reached target seq %s', workerId, endSeq);
          break;
        }

        // Minimal delay to avoid overwhelming server
        if (CONFIG.requestDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
        }

      } catch (err) {
        errors++;
        console.error('[Worker #%d] Error at seq %s (attempt %d/%d): %s',
          workerId, since, errors, maxErrors, err.message
        );

        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, errors), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Flush remaining batch
    flushBatch();

    if (errors >= maxErrors) {
      console.error('[Worker #%d] ✗ FAILED after %d errors', workerId, errors);
      return { workerId, success: false, processedInWorker, insertedInWorker, requestCount, finalSeq: since };
    } else {
      console.log('[Worker #%d] ✓ DONE: processed %d, inserted %d in %d requests (final seq: %s)',
        workerId, processedInWorker, insertedInWorker, requestCount, since.toLocaleString()
      );
      return { workerId, success: true, processedInWorker, insertedInWorker, requestCount, finalSeq: since };
    }

  } catch (err) {
    console.error('[Worker #%d] ✗ FATAL ERROR: %s', workerId, err.message);
    // Try to flush remaining batch
    try { flushBatch(); } catch {}
    return { workerId, success: false, processedInWorker, insertedInWorker, requestCount, finalSeq: since };
  }
}

/**
 * Main orchestrator for parallel workers
 */
async function fetchChanges() {
  const startTime = Date.now();

  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Indexer - Parallel _changes Edition', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s] Workers: %d', new Date().toISOString(), CONFIG.workers);
  console.log('[%s] Database: %s', new Date().toISOString(), CONFIG.dbPath);
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

  // Initialize database
  const db = new IndexDB(CONFIG.dbPath);
  db.initialize();

  const initialCount = db.getCount();
  console.log('[%s] Initial package count: %s', new Date().toISOString(), initialCount.toLocaleString());

  try {
    // Get max sequence from registry
    console.log('[%s] [POOL] Fetching registry metadata...', new Date().toISOString());
    const rootResponse = await axios.get(`${CONFIG.registry}/`, {
      timeout: 30000,
      headers: { 'user-agent': CONFIG.userAgent },
    });

    let maxSeq = rootResponse.data?.update_seq || 0;
    
    // Handle string sequence
    if (typeof maxSeq === 'string') {
      const match = maxSeq.match(/^\d+/);
      maxSeq = match ? parseInt(match[0], 10) : 0;
    }

    console.log('[%s] [POOL] Registry max sequence: %s', new Date().toISOString(), maxSeq.toLocaleString());

    if (maxSeq === 0) {
      throw new Error('Invalid max sequence received from registry');
    }

    // Calculate sequence ranges for each worker
    const seqPerWorker = Math.ceil(maxSeq / CONFIG.workers);
    console.log('[%s] [POOL] Each worker handles ~%s sequences', new Date().toISOString(), seqPerWorker.toLocaleString());

    // Launch workers
    const workerPromises = [];
    for (let i = 0; i < CONFIG.workers; i++) {
      const startSeq = i * seqPerWorker;
      const endSeq = Math.min((i + 1) * seqPerWorker, maxSeq);

      if (startSeq >= maxSeq) break;

      workerPromises.push(fetchSequenceRange(i, startSeq, endSeq, CONFIG.registry, db));
    }

    console.log('[%s] [POOL] Launched %d workers - RUNNING IN PARALLEL', new Date().toISOString(), workerPromises.length);

    // Wait for all workers to complete
    const results = await Promise.all(workerPromises);

    // Aggregate results
    let totalProcessed = 0;
    let totalInserted = 0;
    let totalRequests = 0;
    let successfulWorkers = 0;
    let failedWorkers = 0;

    for (const result of results) {
      totalProcessed += result.processedInWorker || 0;
      totalInserted += result.insertedInWorker || 0;
      totalRequests += result.requestCount || 0;
      if (result.success) {
        successfulWorkers++;
      } else {
        failedWorkers++;
      }
    }

    // Final checkpoint
    db.checkpoint();

    const finalCount = db.getCount();
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(totalProcessed / parseFloat(duration));

    // Update metadata
    db.setMeta('last_fetch_end', new Date().toISOString());
    db.setMeta('last_fetch_duration_minutes', duration);
    db.setMeta('total_packages', finalCount);
    db.setMeta('last_fetch_method', 'parallel_changes');
    db.setMeta('last_fetch_workers', CONFIG.workers);

    const stats = db.getStats();

    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ FETCH COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Workers: %d successful, %d failed', new Date().toISOString(), successfulWorkers, failedWorkers);
    console.log('[%s] Processed: %s packages', new Date().toISOString(), totalProcessed.toLocaleString());
    console.log('[%s] Inserted (new): %s', new Date().toISOString(), totalInserted.toLocaleString());
    console.log('[%s] Total unique: %s', new Date().toISOString(), finalCount.toLocaleString());
    console.log('[%s] Requests: %s', new Date().toISOString(), totalRequests.toLocaleString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), duration);
    console.log('[%s] Throughput: %s packages/minute', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] Database size: %s MB', new Date().toISOString(), stats.dbSizeMB);
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

    db.close();

    return {
      success: true,
      workers: workerPromises.length,
      successfulWorkers,
      failedWorkers,
      processed: totalProcessed,
      inserted: totalInserted,
      totalPackages: finalCount,
      requests: totalRequests,
      duration,
      throughput,
      dbSizeMB: stats.dbSizeMB,
    };

  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ FETCH FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);

    db.close();
    throw err;
  }
}

// CLI entry point
if (require.main === module) {
  fetchChanges()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = fetchChanges;

