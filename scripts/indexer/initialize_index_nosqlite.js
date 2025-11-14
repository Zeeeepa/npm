'use strict';

/**
 * NPM Registry Index Initializer - v4.0 NO SQLITE
 * Author: Zeeeepa
 * Date: 2025-01-12
 * 
 * DUPLICATE-FREE ARCHITECTURE (In-Memory):
 * - 100 parallel _changes workers
 * - Each worker maintains local Set for dedup
 * - Global Set merge at end for cross-worker dedup
 * - Deterministic sequential numbering after merge
 * - Single atomic JSON write (no race conditions)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  outputDir: process.env.OUTPUT_DIR || './data',
  indexFile: 'package-index.json',
  metadataFile: 'index-metadata.json',
  workers: parseInt(process.env.WORKERS) || 100,
  changesBatchSize: parseInt(process.env.CHANGES_BATCH_SIZE) || 10000,
  timeout: parseInt(process.env.TIMEOUT) || 60000,
  requestDelay: parseInt(process.env.REQUEST_DELAY) || 10,
  maxRetries: 3,
  userAgent: 'npm-registry-indexer/4.0.0 (Zeeeepa; no-sqlite; +https://github.com/zeeeepa/npm-indexer)',
};

/**
 * Single worker that fetches a sequence range
 */
async function fetchSequenceRange(workerId, startSeq, endSeq, registry) {
  const packages = new Set();
  let since = startSeq;
  let requestCount = 0;
  let errors = 0;
  const maxErrors = 5;

  console.log('[Worker #%d] START: seq %s → %s', workerId, startSeq.toLocaleString(), endSeq.toLocaleString());

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

      // Extract package names (local dedup via Set)
      for (const change of results) {
        const id = change.id;
        if (id && !id.startsWith('_design/') && !id.startsWith('_') && id.length > 0) {
          packages.add(id);
        }
      }

      // Update sequence (handle string sequences)
      const lastSeq = data.last_seq || (results.length > 0 ? results[results.length - 1].seq : since);
      if (typeof lastSeq === 'string') {
        const match = lastSeq.match(/^\d+/);
        since = match ? parseInt(match[0], 10) : since + 1;
      } else {
        since = lastSeq;
      }

      requestCount++;
      errors = 0;

      // Progress logging every 10 requests
      if (requestCount % 10 === 0) {
        const progress = Math.min(((since - startSeq) / (endSeq - startSeq) * 100), 100).toFixed(1);
        console.log('[Worker #%d] %s%% | seq: %s | packages: %d | requests: %d',
          workerId, progress, since.toLocaleString(), packages.size, requestCount
        );
      }

      if (since >= endSeq) {
        console.log('[Worker #%d] Reached target seq %s', workerId, endSeq);
        break;
      }

      if (CONFIG.requestDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
      }

    } catch (err) {
      errors++;
      console.error('[Worker #%d] Error at seq %s (attempt %d/%d): %s',
        workerId, since, errors, maxErrors, err.message
      );

      const delay = Math.min(1000 * Math.pow(2, errors), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  if (errors >= maxErrors) {
    console.error('[Worker #%d] ✗ FAILED after %d errors', workerId, errors);
    return { workerId, packages: [], success: false, requestCount, finalSeq: since };
  } else {
    console.log('[Worker #%d] ✓ DONE: %d packages in %d requests (final seq: %s)',
      workerId, packages.size, requestCount, since.toLocaleString()
    );
    return { workerId, packages: Array.from(packages), success: true, requestCount, finalSeq: since };
  }
}

/**
 * Main initialization function
 */
async function initialize() {
  const startTime = Date.now();

  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Indexer v4.0 (No SQLite)', new Date().toISOString());
  console.log('[%s] Author: Zeeeepa | In-Memory Dedup', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s] Workers: %d', new Date().toISOString(), CONFIG.workers);
  console.log('[%s] Output: %s', new Date().toISOString(), path.join(CONFIG.outputDir, CONFIG.indexFile));
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

  try {
    // Get max sequence from registry
    console.log('[%s] [INIT] Fetching registry metadata...', new Date().toISOString());
    const rootResponse = await axios.get(`${CONFIG.registry}/`, {
      timeout: 30000,
      headers: { 'user-agent': CONFIG.userAgent },
    });

    let maxSeq = rootResponse.data?.update_seq || 0;
    if (typeof maxSeq === 'string') {
      const match = maxSeq.match(/^\d+/);
      maxSeq = match ? parseInt(match[0], 10) : 0;
    }

    console.log('[%s] [INIT] Registry max sequence: %s', new Date().toISOString(), maxSeq.toLocaleString());

    if (maxSeq === 0) {
      throw new Error('Invalid max sequence received from registry');
    }

    // Calculate sequence ranges for each worker
    const seqPerWorker = Math.ceil(maxSeq / CONFIG.workers);
    console.log('[%s] [INIT] Each worker handles ~%s sequences', new Date().toISOString(), seqPerWorker.toLocaleString());

    // Launch workers
    const workerPromises = [];
    for (let i = 0; i < CONFIG.workers; i++) {
      const startSeq = i * seqPerWorker;
      const endSeq = Math.min((i + 1) * seqPerWorker, maxSeq);

      if (startSeq >= maxSeq) break;

      workerPromises.push(fetchSequenceRange(i, startSeq, endSeq, CONFIG.registry));
    }

    console.log('[%s] [INIT] Launched %d workers - RUNNING IN PARALLEL', new Date().toISOString(), workerPromises.length);
    console.log('[%s] [INIT] Waiting for all workers to complete...', new Date().toISOString());

    // Wait for all workers
    const results = await Promise.all(workerPromises);

    // GLOBAL DEDUPLICATION: Merge all worker Sets
    console.log('[%s] [MERGE] Deduplicating packages across all workers...', new Date().toISOString());
    const globalPackages = new Set();
    let totalProcessed = 0;
    let totalRequests = 0;
    let successfulWorkers = 0;
    let failedWorkers = 0;

    for (const result of results) {
      if (result.success) {
        result.packages.forEach(pkg => globalPackages.add(pkg));
        totalProcessed += result.packages.length;
        totalRequests += result.requestCount;
        successfulWorkers++;
      } else {
        failedWorkers++;
      }
    }

    const uniquePackages = Array.from(globalPackages).sort();

    console.log('[%s] [MERGE] ═══════════════════════════════════════', new Date().toISOString());
    console.log('[%s] [MERGE] Workers: %d successful, %d failed', new Date().toISOString(), successfulWorkers, failedWorkers);
    console.log('[%s] [MERGE] Total processed: %s', new Date().toISOString(), totalProcessed.toLocaleString());
    console.log('[%s] [MERGE] Unique packages: %s', new Date().toISOString(), uniquePackages.length.toLocaleString());
    console.log('[%s] [MERGE] Duplicates removed: %s', new Date().toISOString(), (totalProcessed - uniquePackages.length).toLocaleString());
    console.log('[%s] [MERGE] Requests: %s', new Date().toISOString(), totalRequests.toLocaleString());
    console.log('[%s] [MERGE] ═══════════════════════════════════════', new Date().toISOString());

    // DETERMINISTIC ENUMERATION: Sequential numbering
    console.log('[%s] [EXPORT] Creating enumerated JSON...', new Date().toISOString());
    const enumerated = uniquePackages.map((name, index) => [name, index + 1]);

    // Ensure output directory exists
    if (!fs.existsSync(CONFIG.outputDir)) {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    // ATOMIC WRITE: Single write (no race conditions)
    const indexPath = path.join(CONFIG.outputDir, CONFIG.indexFile);
    fs.writeFileSync(indexPath, JSON.stringify(enumerated, null, 2), 'utf8');

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(totalProcessed / parseFloat(duration));
    const fileSizeMB = (fs.statSync(indexPath).size / 1024 / 1024).toFixed(2);

    // Save metadata
    const metadata = {
      timestamp: new Date().toISOString(),
      timestampUnix: Date.now(),
      totalPackages: uniquePackages.length,
      totalProcessed,
      duplicatesRemoved: totalProcessed - uniquePackages.length,
      workers: workerPromises.length,
      successfulWorkers,
      failedWorkers,
      totalRequests,
      version: '4.0.0-nosqlite',
      method: 'parallel-workers-inmemory-dedup',
      architecture: 'Worker Sets + Global Merge + Deterministic Sort',
      duration: Date.now() - startTime,
      durationMinutes: duration,
      throughputPerMinute: throughput,
      registry: CONFIG.registry,
      dataFormat: '["package-name", sequential-number]',
      fileSizeMB,
      firstPackage: uniquePackages[0],
      lastPackage: uniquePackages[uniquePackages.length - 1],
      createdBy: 'Zeeeepa',
    };

    const metadataPath = path.join(CONFIG.outputDir, CONFIG.metadataFile);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ INITIALIZATION COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), duration);
    console.log('[%s] Unique packages: %s', new Date().toISOString(), uniquePackages.length.toLocaleString());
    console.log('[%s] Duplicates removed: %s', new Date().toISOString(), (totalProcessed - uniquePackages.length).toLocaleString());
    console.log('[%s] Throughput: %s packages/minute', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] File size: %s MB', new Date().toISOString(), fileSizeMB);
    console.log('[%s] Output: %s', new Date().toISOString(), indexPath);
    console.log('[%s] Metadata: %s', new Date().toISOString(), metadataPath);
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

    return {
      success: true,
      uniquePackages: uniquePackages.length,
      totalProcessed,
      duplicatesRemoved: totalProcessed - uniquePackages.length,
      duration,
      throughput,
      fileSizeMB,
    };

  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ INITIALIZATION FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);
    throw err;
  }
}

// CLI entry point
if (require.main === module) {
  initialize()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = initialize;

