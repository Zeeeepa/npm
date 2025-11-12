'use strict';

/**
 * NPM Registry Ultra-Fast Indexer - 10 Minute Edition
 * Author: Zeeeepa
 * Date: 2025-11-12
 * 
 * BREAKTHROUGH PERFORMANCE:
 * - 100 parallel workers processing HUGE batches
 * - Target: Complete 5.4M packages in ~10 minutes
 * - Strategy: Fetch ALL package names first (fast), enrich later (optional)
 * - Smart batch sizing: 50K records per worker fetch
 * - Aggressive parallelism: No delays, max throughput
 * 
 * OUTPUT: npm.csv (5.4M+ lines, basic data fast, enrichment optional)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// Ultra-Performance Configuration
// ============================================================================

const CONFIG = {
  registry: 'https://registry.npmmirror.com',
  workers: 100,
  changesBatchSize: 50000,        // HUGE batches: 50K per request
  enrichConcurrency: 100,         // Aggressive concurrency
  outputFile: path.join(__dirname, 'npm.csv'),
  checkpointFile: path.join(__dirname, 'npm.checkpoint.json'),
  timeout: 120000,                // 2 minute timeout
  requestDelay: 0,                // NO DELAYS - maximum speed
  maxRetries: 2,                  // Fewer retries for speed
  skipEnrichment: false,          // Set true to skip enrichment for 10min target
};

const logger = console;

// ============================================================================
// Global State
// ============================================================================

let TOTAL_PACKAGES = new Set();
let PACKAGE_METADATA = new Map();
let CHECKPOINT = {
  lastSequence: 0,
  totalPackages: 0,
  lastUpdate: null,
};

// ============================================================================
// Utilities
// ============================================================================

async function fetchWithRetry(url, maxRetries = CONFIG.maxRetries) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'npm-indexer-ultra/1.0.0',
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
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  
  throw lastError;
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0];
}

// ============================================================================
// Checkpoint Management
// ============================================================================

function loadCheckpoint() {
  if (fs.existsSync(CONFIG.checkpointFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG.checkpointFile, 'utf8'));
      CHECKPOINT = data;
      logger.log('[CHECKPOINT] Loaded: seq=%s, packages=%d',
        CHECKPOINT.lastSequence,
        CHECKPOINT.totalPackages
      );
      return true;
    } catch (err) {
      logger.error('[CHECKPOINT] Load error: %s', err.message);
    }
  }
  return false;
}

function saveCheckpoint(seq, totalPackages) {
  CHECKPOINT.lastSequence = seq;
  CHECKPOINT.totalPackages = totalPackages;
  CHECKPOINT.lastUpdate = new Date().toISOString();
  
  try {
    fs.writeFileSync(CONFIG.checkpointFile, JSON.stringify(CHECKPOINT, null, 2), 'utf8');
  } catch (err) {
    logger.error('[CHECKPOINT] Save error: %s', err.message);
  }
}

// ============================================================================
// Ultra-Fast Worker: Process HUGE Batches
// ============================================================================

async function fetchSequenceRange(workerId, startSeq, endSeq) {
  const packages = new Set();
  let since = startSeq;
  let requestCount = 0;
  let errors = 0;
  const maxErrors = 3;
  
  const totalRange = endSeq - startSeq;
  
  while (since < endSeq && errors < maxErrors) {
    const url = `${CONFIG.registry}/_changes?since=${since}&limit=${CONFIG.changesBatchSize}&include_docs=false`;
    
    try {
      const data = await fetchWithRetry(url);
      const results = data.results || [];
      
      if (results.length === 0) break;
      
      // Fast bulk insert
      for (const change of results) {
        const id = change.id;
        if (id && !id.startsWith('_') && !id.startsWith('design/')) {
          packages.add(id);
        }
      }
      
      since = data.last_seq || results[results.length - 1].seq;
      requestCount++;
      errors = 0;
      
      // Progress every 5 requests (not every 10)
      if (requestCount % 5 === 0) {
        const progress = Math.min((since - startSeq) / totalRange * 100, 100).toFixed(1);
        logger.log('[Worker #%d] %s%% | seq: %s | pkgs: %d | reqs: %d',
          workerId, progress, since.toLocaleString(), packages.size, requestCount);
      }
      
      if (since >= endSeq) break;
      
      // NO DELAY - maximum speed
      
    } catch (err) {
      errors++;
      logger.error('[Worker #%d] Error: %s (attempt %d/%d)',
        workerId, err.message, errors, maxErrors);
      
      if (errors < maxErrors) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  logger.log('[Worker #%d] ✓ DONE: %d packages in %d requests (seq: %s → %s)',
    workerId, packages.size, requestCount, startSeq.toLocaleString(), since.toLocaleString());
  
  return {
    workerId,
    packages: Array.from(packages),
    success: errors < maxErrors,
    finalSeq: since,
  };
}

// ============================================================================
// Ultra-Fast Worker Pool
// ============================================================================

async function runWorkerPool(startSeq, maxSeq) {
  const poolStart = Date.now();
  const workerCount = CONFIG.workers;
  const seqPerWorker = Math.ceil((maxSeq - startSeq) / workerCount);
  
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  logger.log('[POOL] Ultra-Fast Mode: %d workers × 50K batch size', workerCount);
  logger.log('[POOL] Target: ~10 minutes for 5.4M packages');
  logger.log('[POOL] Range: %s → %s (%s sequences)',
    startSeq.toLocaleString(),
    maxSeq.toLocaleString(),
    (maxSeq - startSeq).toLocaleString()
  );
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  
  const workerPromises = [];
  
  for (let i = 0; i < workerCount; i++) {
    const workerStart = startSeq + (i * seqPerWorker);
    const workerEnd = Math.min(workerStart + seqPerWorker, maxSeq);
    
    if (workerStart >= maxSeq) break;
    
    workerPromises.push(fetchSequenceRange(i, workerStart, workerEnd));
  }
  
  logger.log('[POOL] Launched %d workers - ALL PARALLEL, NO DELAYS', workerPromises.length);
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  
  // Wait for ALL workers
  const results = await Promise.all(workerPromises);
  
  const poolDuration = ((Date.now() - poolStart) / 1000 / 60).toFixed(2);
  
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  logger.log('[POOL] All workers complete in %s minutes', poolDuration);
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  
  // Global merge with deduplication
  let totalNewPackages = 0;
  let successfulWorkers = 0;
  let totalRequests = 0;
  
  for (const result of results) {
    if (result.success) {
      totalRequests += result.packages.length;
      for (const pkg of result.packages) {
        if (!TOTAL_PACKAGES.has(pkg)) {
          TOTAL_PACKAGES.add(pkg);
          totalNewPackages++;
        }
      }
      successfulWorkers++;
    }
  }
  
  const throughput = Math.round(TOTAL_PACKAGES.size / parseFloat(poolDuration));
  
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  logger.log('[POOL] MERGE COMPLETE');
  logger.log('[POOL]   New packages: %s', totalNewPackages.toLocaleString());
  logger.log('[POOL]   Total unique: %s', TOTAL_PACKAGES.size.toLocaleString());
  logger.log('[POOL]   Successful workers: %d/%d', successfulWorkers, workerPromises.length);
  logger.log('[POOL]   Throughput: %s packages/minute', throughput.toLocaleString());
  logger.log('[POOL] ═══════════════════════════════════════════════════');
  
  return {
    newPackages: totalNewPackages,
    totalPackages: TOTAL_PACKAGES.size,
    successfulWorkers,
    duration: poolDuration,
    throughput,
  };
}

// ============================================================================
// Optional Fast Enrichment (Batch Mode)
// ============================================================================

async function enrichPackageFast(packageName) {
  try {
    const url = `${CONFIG.registry}/${encodeURIComponent(packageName)}`;
    const data = await fetchWithRetry(url);
    
    const distTags = data['dist-tags'] || {};
    const latestVersion = distTags.latest || Object.keys(data.versions || {})[0];
    
    if (!latestVersion) return null;
    
    const versionData = data.versions?.[latestVersion];
    if (!versionData) return null;
    
    const deps = versionData.dependencies || {};
    const devDeps = versionData.devDependencies || {};
    
    return {
      description: (versionData.description || data.description || '').substring(0, 10000),
      keywords: (Array.isArray(versionData.keywords) ? versionData.keywords.join(',') : '').substring(0, 1000),
      latestVersion,
      publishTime: (data.time || {})[latestVersion],
      dependenciesCount: Object.keys(deps).length + Object.keys(devDeps).length,
      fileCount: (versionData.dist || {}).fileCount || 0,
      unpackedSize: (versionData.dist || {}).unpackedSize || 0,
    };
  } catch (err) {
    return null;
  }
}

async function enrichAllPackagesFast() {
  const packages = Array.from(TOTAL_PACKAGES);
  const total = packages.length;
  
  logger.log('[ENRICH] ═══════════════════════════════════════════════════');
  logger.log('[ENRICH] Starting fast enrichment: %d packages', total);
  logger.log('[ENRICH] Concurrency: %d parallel requests', CONFIG.enrichConcurrency);
  logger.log('[ENRICH] ═══════════════════════════════════════════════════');
  
  const enrichStart = Date.now();
  let enriched = 0;
  let failed = 0;
  
  for (let i = 0; i < total; i += CONFIG.enrichConcurrency) {
    const batch = packages.slice(i, i + CONFIG.enrichConcurrency);
    
    const promises = batch.map(async (pkg) => {
      const metadata = await enrichPackageFast(pkg);
      if (metadata) {
        PACKAGE_METADATA.set(pkg, metadata);
        return true;
      }
      return false;
    });
    
    const results = await Promise.all(promises);
    enriched += results.filter(r => r).length;
    failed += results.filter(r => !r).length;
    
    if ((i + CONFIG.enrichConcurrency) % 5000 === 0 || i + CONFIG.enrichConcurrency >= total) {
      const progress = Math.min((i + CONFIG.enrichConcurrency) / total * 100, 100).toFixed(1);
      const elapsed = ((Date.now() - enrichStart) / 1000 / 60).toFixed(1);
      const rate = Math.round((i + CONFIG.enrichConcurrency) / ((Date.now() - enrichStart) / 1000 / 60));
      const eta = ((total - i - CONFIG.enrichConcurrency) / rate).toFixed(1);
      
      logger.log('[ENRICH] %s%% | Done: %d/%d | OK: %d | Fail: %d | Rate: %d/min | ETA: %smin',
        progress, i + CONFIG.enrichConcurrency, total, enriched, failed, rate, eta);
    }
  }
  
  const enrichDuration = ((Date.now() - enrichStart) / 1000 / 60).toFixed(2);
  
  logger.log('[ENRICH] ═══════════════════════════════════════════════════');
  logger.log('[ENRICH] ✓ Complete in %s minutes', enrichDuration);
  logger.log('[ENRICH]   Enriched: %s', enriched.toLocaleString());
  logger.log('[ENRICH]   Failed: %s', failed.toLocaleString());
  logger.log('[ENRICH] ═══════════════════════════════════════════════════');
}

// ============================================================================
// Ultra-Fast CSV Export (Streaming)
// ============================================================================

async function exportToCSV() {
  const exportStart = Date.now();
  logger.log('[CSV] ═══════════════════════════════════════════════════');
  logger.log('[CSV] Exporting to: %s', CONFIG.outputFile);
  
  const packages = Array.from(TOTAL_PACKAGES).sort();
  const writeStream = fs.createWriteStream(CONFIG.outputFile, { encoding: 'utf8' });
  
  // Write header
  writeStream.write('number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords\n');
  
  let rowNumber = 0;
  const batchSize = 1000;
  let buffer = '';
  
  for (const pkg of packages) {
    rowNumber++;
    
    const metadata = PACKAGE_METADATA.get(pkg) || {};
    
    const row = [
      rowNumber,
      `https://www.npmjs.com/package/${encodeURIComponent(pkg)}`,
      escapeCSV(pkg),
      metadata.fileCount || 0,
      metadata.unpackedSize || 0,
      metadata.dependenciesCount || 0,
      0,
      formatDate(metadata.publishTime),
      escapeCSV(metadata.description || ''),
      escapeCSV(metadata.keywords || ''),
    ].join(',') + '\n';
    
    buffer += row;
    
    // Flush buffer every 1000 rows
    if (rowNumber % batchSize === 0) {
      writeStream.write(buffer);
      buffer = '';
      
      if (rowNumber % 100000 === 0) {
        const progress = (rowNumber / packages.length * 100).toFixed(1);
        logger.log('[CSV] %s%% | Rows: %s/%s',
          progress, rowNumber.toLocaleString(), packages.length.toLocaleString());
      }
    }
  }
  
  // Write remaining buffer
  if (buffer) {
    writeStream.write(buffer);
  }
  
  writeStream.end();
  
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
  
  const fileSizeMB = (fs.statSync(CONFIG.outputFile).size / 1024 / 1024).toFixed(2);
  const exportDuration = ((Date.now() - exportStart) / 1000).toFixed(1);
  
  logger.log('[CSV] ═══════════════════════════════════════════════════');
  logger.log('[CSV] ✓ Complete in %s seconds', exportDuration);
  logger.log('[CSV]   Rows: %s', rowNumber.toLocaleString());
  logger.log('[CSV]   Size: %s MB', fileSizeMB);
  logger.log('[CSV] ═══════════════════════════════════════════════════');
  
  // Show sample
  const sample = fs.readFileSync(CONFIG.outputFile, 'utf8').split('\n').slice(0, 6).join('\n');
  logger.log('[CSV] Sample output:\n%s', sample);
}

// ============================================================================
// Main Execution
// ============================================================================

let startTime;

async function main() {
  startTime = Date.now();
  
  logger.log('═══════════════════════════════════════════════════════════════');
  logger.log('NPM Registry ULTRA-FAST Indexer - 10 Minute Target');
  logger.log('═══════════════════════════════════════════════════════════════');
  logger.log('Configuration:');
  logger.log('  Registry: %s', CONFIG.registry);
  logger.log('  Workers: %d parallel (NO DELAYS)', CONFIG.workers);
  logger.log('  Batch size: %s records per request', CONFIG.changesBatchSize.toLocaleString());
  logger.log('  Enrichment: %s', CONFIG.skipEnrichment ? 'SKIP (fastest)' : `YES (${CONFIG.enrichConcurrency} concurrent)`);
  logger.log('  Output: %s', CONFIG.outputFile);
  logger.log('═══════════════════════════════════════════════════════════════');
  
  try {
    // Load checkpoint
    const hasCheckpoint = loadCheckpoint();
    
    // Get registry info
    logger.log('[INIT] Fetching registry metadata...');
    const rootData = await fetchWithRetry(`${CONFIG.registry}/`);
    const maxSeq = rootData.update_seq || 0;
    const docCount = rootData.doc_count || 0;
    
    logger.log('[INIT] Registry: %s sequences, %s packages',
      maxSeq.toLocaleString(), docCount.toLocaleString());
    
    // Determine start sequence
    const startSeq = hasCheckpoint ? CHECKPOINT.lastSequence : 0;
    
    if (hasCheckpoint && startSeq >= maxSeq) {
      logger.log('[SYNC] Already up to date!');
      process.exit(0);
    }
    
    // STEP 1: Ultra-Fast Fetch with 100 workers
    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log('[STEP 1/3] ULTRA-FAST FETCH (%d workers, 50K batches)', CONFIG.workers);
    logger.log('═══════════════════════════════════════════════════════════════');
    
    const poolResult = await runWorkerPool(startSeq, maxSeq);
    
    // Save checkpoint
    saveCheckpoint(maxSeq, poolResult.totalPackages);
    
    // STEP 2: Optional Fast Enrichment
    if (!CONFIG.skipEnrichment) {
      logger.log('═══════════════════════════════════════════════════════════════');
      logger.log('[STEP 2/3] FAST ENRICHMENT (%d concurrent)', CONFIG.enrichConcurrency);
      logger.log('═══════════════════════════════════════════════════════════════');
      
      await enrichAllPackagesFast();
    } else {
      logger.log('═══════════════════════════════════════════════════════════════');
      logger.log('[STEP 2/3] ENRICHMENT SKIPPED (maximum speed mode)');
      logger.log('═══════════════════════════════════════════════════════════════');
    }
    
    // STEP 3: Fast CSV Export
    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log('[STEP 3/3] CSV EXPORT');
    logger.log('═══════════════════════════════════════════════════════════════');
    
    await exportToCSV();
    
    // Final summary
    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(poolResult.totalPackages / parseFloat(totalDuration));
    
    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log('✓✓✓ COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log('Total Duration: %s minutes', totalDuration);
    logger.log('Total Packages: %s', poolResult.totalPackages.toLocaleString());
    logger.log('Throughput: %s packages/minute', throughput.toLocaleString());
    logger.log('Output: %s', CONFIG.outputFile);
    logger.log('Checkpoint: seq=%s', maxSeq.toLocaleString());
    logger.log('═══════════════════════════════════════════════════════════════');
    
    if (parseFloat(totalDuration) <= 10) {
      logger.log('🚀 TARGET ACHIEVED: Complete in under 10 minutes!');
    } else if (parseFloat(totalDuration) <= 15) {
      logger.log('⚡ EXCELLENT: Complete in under 15 minutes!');
    } else {
      logger.log('✓ Complete! Run with skipEnrichment:true for <10 min target');
    }
    
    logger.log('═══════════════════════════════════════════════════════════════');
    
    process.exit(0);
    
  } catch (err) {
    logger.error('═══════════════════════════════════════════════════════════════');
    logger.error('✗✗✗ FAILED ✗✗✗');
    logger.error('═══════════════════════════════════════════════════════════════');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    process.exit(1);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

if (require.main === module) {
  main();
}

module.exports = main;

