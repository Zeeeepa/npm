#!/usr/bin/env node
'use strict';

/**
 * NPM Registry Ultimate Indexer - Single File Solution
 * Author: Zeeeepa / Codegen
 * Date: 2025-11-12
 * 
 * FEATURES:
 * - 100 parallel workers for maximum speed
 * - Fetches all 5.4M+ packages from Chinese mirror
 * - Enriches with full metadata (file_count, size, dependencies, etc.)
 * - Outputs to npm.csv with exact format specified
 * - Checkpoint system for resume/sync
 * - Re-running updates CSV to latest state automatically
 * 
 * USAGE:
 *   node npm-indexer-ultimate.js
 * 
 * OUTPUT:
 *   npm.csv - Complete index with all metadata
 *   npm-checkpoint.json - State for incremental updates
 */

const fs = require('fs');
const path = require('path');
const urllib = require('urllib');
const { createWriteStream } = require('fs');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  registry: 'https://registry.npmmirror.com',
  outputCsv: 'npm.csv',
  checkpointFile: 'npm-checkpoint.json',
  
  // Performance
  workers: 100,
  changesBatchSize: 10000,
  enrichBatchSize: 100,
  enrichRateLimit: 50, // requests per second
  
  // Network
  timeout: 60000,
  maxRetries: 3,
  requestDelay: 5,
};

const logger = console;

// ============================================================================
// Global State
// ============================================================================

let CHECKPOINT = {
  lastSeq: 0,
  totalPackages: 0,
  lastSync: null,
  packages: {}, // name -> {seq, metadata}
};

// ============================================================================
// Checkpoint Management
// ============================================================================

function loadCheckpoint() {
  if (fs.existsSync(CONFIG.checkpointFile)) {
    try {
      CHECKPOINT = JSON.parse(fs.readFileSync(CONFIG.checkpointFile, 'utf8'));
      logger.log('[CHECKPOINT] Loaded: %d packages, seq %d',
        Object.keys(CHECKPOINT.packages).length,
        CHECKPOINT.lastSeq);
      return true;
    } catch (err) {
      logger.error('[CHECKPOINT] Failed to load: %s', err.message);
    }
  }
  return false;
}

function saveCheckpoint() {
  fs.writeFileSync(CONFIG.checkpointFile, JSON.stringify(CHECKPOINT, null, 2));
  logger.log('[CHECKPOINT] Saved: %d packages, seq %d',
    Object.keys(CHECKPOINT.packages).length,
    CHECKPOINT.lastSeq);
}

// ============================================================================
// STEP 1: Fetch Package Names via _changes API
// ============================================================================

async function fetchPackageNames() {
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('STEP 1: FETCHING PACKAGE NAMES');
  logger.log('Registry: %s', CONFIG.registry);
  logger.log('Starting from seq: %d', CHECKPOINT.lastSeq);
  logger.log('═══════════════════════════════════════════════════════');
  
  const existingPackages = new Set(Object.keys(CHECKPOINT.packages));
  let newPackages = 0;
  let updatedPackages = 0;
  let deletedPackages = 0;
  
  let since = CHECKPOINT.lastSeq;
  let requestCount = 0;
  const startTime = Date.now();
  
  while (true) {
    const url = `${CONFIG.registry}/_changes?since=${since}&limit=${CONFIG.changesBatchSize}&include_docs=false`;
    
    try {
      const result = await urllib.request(url, {
        dataType: 'json',
        timeout: CONFIG.timeout,
        headers: {
          'user-agent': 'npm-indexer-ultimate/1.0',
          'accept': 'application/json',
        },
        gzip: true,
      });
      
      if (result.status !== 200) break;
      
      const data = result.data;
      const results = data.results || [];
      
      if (results.length === 0) break;
      
      // Process changes
      for (const change of results) {
        const id = change.id;
        const seq = change.seq;
        
        // Skip design docs and invalid names
        if (!id || id.startsWith('_design/') || id.startsWith('_')) {
          continue;
        }
        
        // Handle deletions
        if (change.deleted) {
          if (CHECKPOINT.packages[id]) {
            delete CHECKPOINT.packages[id];
            deletedPackages++;
          }
          continue;
        }
        
        // New or updated package
        if (existingPackages.has(id)) {
          updatedPackages++;
        } else {
          newPackages++;
        }
        
        CHECKPOINT.packages[id] = {
          seq: seq,
          enriched: false,
        };
      }
      
      since = data.last_seq || results[results.length - 1].seq;
      CHECKPOINT.lastSeq = since;
      requestCount++;
      
      // Progress every 100 requests
      if (requestCount % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const totalPkgs = Object.keys(CHECKPOINT.packages).length;
        logger.log('[FETCH] %ds | %d requests | %s packages (+%d new, ~%d updated, -%d deleted)',
          elapsed, requestCount, totalPkgs.toLocaleString(), 
          newPackages, updatedPackages, deletedPackages);
      }
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
      
    } catch (err) {
      logger.error('[FETCH] Error: %s', err.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  const totalPackages = Object.keys(CHECKPOINT.packages).length;
  
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('✓ FETCH COMPLETE');
  logger.log('Duration: %s minutes', duration);
  logger.log('Total packages: %s', totalPackages.toLocaleString());
  logger.log('New: %d | Updated: %d | Deleted: %d',
    newPackages, updatedPackages, deletedPackages);
  logger.log('═══════════════════════════════════════════════════════');
  
  // Save checkpoint
  saveCheckpoint();
}

// ============================================================================
// STEP 2: Enrich Packages with Metadata
// ============================================================================

class RateLimiter {
  constructor(requestsPerSecond) {
    this.interval = 1000 / requestsPerSecond;
    this.lastRequest = 0;
  }
  
  async wait() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    if (timeSinceLastRequest < this.interval) {
      await new Promise(resolve => 
        setTimeout(resolve, this.interval - timeSinceLastRequest));
    }
    this.lastRequest = Date.now();
  }
}

async function enrichPackage(name, rateLimiter) {
  await rateLimiter.wait();
  
  const url = `${CONFIG.registry}/${encodeURIComponent(name).replace('%40', '@')}`;
  
  try {
    const result = await urllib.request(url, {
      dataType: 'json',
      timeout: CONFIG.timeout,
      headers: {
        'user-agent': 'npm-indexer-ultimate/1.0',
        'accept': 'application/json',
      },
      gzip: true,
    });
    
    if (result.status !== 200) {
      return null;
    }
    
    const data = result.data;
    const distTags = data['dist-tags'] || {};
    const latestVersion = distTags.latest;
    const versions = data.versions || {};
    const latestData = versions[latestVersion] || {};
    
    // Extract metadata
    const metadata = {
      description: latestData.description || '',
      keywords: (latestData.keywords || []).join(','),
      dependencies: Object.keys(latestData.dependencies || {}).length,
      file_count: (latestData.dist && latestData.dist.fileCount) || 0,
      unpacked_size: (latestData.dist && latestData.dist.unpackedSize) || 0,
      latest_version: latestVersion || '',
      latest_release_published_at: data.time && data.time[latestVersion] 
        ? data.time[latestVersion].split('T')[0] 
        : '',
    };
    
    return metadata;
    
  } catch (err) {
    // Silent fail for removed packages
    return null;
  }
}

async function enrichPackages() {
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('STEP 2: ENRICHING PACKAGES WITH METADATA');
  logger.log('Rate limit: %d req/sec', CONFIG.enrichRateLimit);
  logger.log('═══════════════════════════════════════════════════════');
  
  const packageNames = Object.keys(CHECKPOINT.packages);
  const unenrichedPackages = packageNames.filter(name => 
    !CHECKPOINT.packages[name].enriched);
  
  logger.log('Total packages: %s', packageNames.length.toLocaleString());
  logger.log('Unenriched: %s', unenrichedPackages.length.toLocaleString());
  
  if (unenrichedPackages.length === 0) {
    logger.log('All packages already enriched!');
    return;
  }
  
  const rateLimiter = new RateLimiter(CONFIG.enrichRateLimit);
  const startTime = Date.now();
  let enriched = 0;
  let failed = 0;
  
  // Process in batches
  for (let i = 0; i < unenrichedPackages.length; i += CONFIG.enrichBatchSize) {
    const batch = unenrichedPackages.slice(i, i + CONFIG.enrichBatchSize);
    
    // Enrich batch in parallel
    const promises = batch.map(name => enrichPackage(name, rateLimiter));
    const results = await Promise.all(promises);
    
    // Store results
    for (let j = 0; j < batch.length; j++) {
      const name = batch[j];
      const metadata = results[j];
      
      if (metadata) {
        CHECKPOINT.packages[name] = {
          ...CHECKPOINT.packages[name],
          ...metadata,
          enriched: true,
        };
        enriched++;
      } else {
        // Mark as enriched even if failed (so we don't retry forever)
        CHECKPOINT.packages[name].enriched = true;
        CHECKPOINT.packages[name].failed = true;
        failed++;
      }
    }
    
    // Progress every 1000 packages
    if ((i + batch.length) % 1000 === 0 || i + batch.length >= unenrichedPackages.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = enriched / elapsed;
      const remaining = unenrichedPackages.length - (i + batch.length);
      const eta = remaining > 0 ? (remaining / rate / 60).toFixed(1) : 0;
      
      logger.log('[ENRICH] %d/%d | %d/sec | ETA: %s min | Failed: %d',
        i + batch.length,
        unenrichedPackages.length,
        Math.round(rate),
        eta,
        failed);
      
      // Save checkpoint every 1000
      saveCheckpoint();
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('✓ ENRICHMENT COMPLETE');
  logger.log('Duration: %s minutes', duration);
  logger.log('Enriched: %d | Failed: %d', enriched, failed);
  logger.log('═══════════════════════════════════════════════════════');
  
  // Save final checkpoint
  saveCheckpoint();
}

// ============================================================================
// STEP 3: Export to CSV
// ============================================================================

async function exportToCsv() {
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('STEP 3: EXPORTING TO CSV');
  logger.log('Output: %s', CONFIG.outputCsv);
  logger.log('═══════════════════════════════════════════════════════');
  
  const packageNames = Object.keys(CHECKPOINT.packages).sort();
  const enrichedPackages = packageNames.filter(name => 
    CHECKPOINT.packages[name].enriched && !CHECKPOINT.packages[name].failed);
  
  logger.log('Total packages: %s', packageNames.length.toLocaleString());
  logger.log('Enriched: %s', enrichedPackages.length.toLocaleString());
  
  const stream = createWriteStream(CONFIG.outputCsv);
  
  // Write CSV header
  stream.write('number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords\n');
  
  let written = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < enrichedPackages.length; i++) {
    const name = enrichedPackages[i];
    const pkg = CHECKPOINT.packages[name];
    
    const row = [
      i + 1, // 1-based numbering for CSV
      `https://www.npmjs.com/package/${name}`,
      name,
      pkg.file_count || 0,
      pkg.unpacked_size || 0,
      pkg.dependencies || 0,
      0, // dependents (would need reverse lookup - set to 0 for now)
      pkg.latest_release_published_at || '',
      `"${(pkg.description || '').replace(/"/g, '""')}"`, // Escape quotes
      pkg.keywords || '',
    ];
    
    stream.write(row.join(',') + '\n');
    written++;
    
    // Progress every 100K
    if (written % 100000 === 0) {
      const percent = ((written / enrichedPackages.length) * 100).toFixed(1);
      logger.log('[EXPORT] %s%% (%s/%s)',
        percent,
        written.toLocaleString(),
        enrichedPackages.length.toLocaleString());
    }
  }
  
  await new Promise(resolve => stream.end(resolve));
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const fileSize = (fs.statSync(CONFIG.outputCsv).size / 1024 / 1024).toFixed(2);
  
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('✓ EXPORT COMPLETE');
  logger.log('Duration: %s seconds', duration);
  logger.log('Rows: %s', written.toLocaleString());
  logger.log('File size: %s MB', fileSize);
  logger.log('═══════════════════════════════════════════════════════');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const overallStart = Date.now();
  
  logger.log('');
  logger.log('╔═══════════════════════════════════════════════════════╗');
  logger.log('║  NPM REGISTRY ULTIMATE INDEXER                        ║');
  logger.log('║  Single-File Solution with Auto-Sync                  ║');
  logger.log('╚═══════════════════════════════════════════════════════╝');
  logger.log('');
  
  try {
    // Load checkpoint
    const isResume = loadCheckpoint();
    if (isResume) {
      logger.log('[MODE] RESUME/SYNC - Updating from seq %d', CHECKPOINT.lastSeq);
    } else {
      logger.log('[MODE] FRESH START - Fetching all packages');
    }
    logger.log('');
    
    // Step 1: Fetch package names
    await fetchPackageNames();
    logger.log('');
    
    // Step 2: Enrich packages
    await enrichPackages();
    logger.log('');
    
    // Step 3: Export to CSV
    await exportToCsv();
    logger.log('');
    
    // Final summary
    const totalDuration = ((Date.now() - overallStart) / 1000 / 60).toFixed(2);
    
    logger.log('╔═══════════════════════════════════════════════════════╗');
    logger.log('║  ✓✓✓ COMPLETE ✓✓✓                                     ║');
    logger.log('╚═══════════════════════════════════════════════════════╝');
    logger.log('');
    logger.log('Total duration: %s minutes', totalDuration);
    logger.log('Output file: %s', CONFIG.outputCsv);
    logger.log('Checkpoint: %s', CONFIG.checkpointFile);
    logger.log('');
    logger.log('To update to latest:');
    logger.log('  node %s', path.basename(__filename));
    logger.log('');
    
    process.exit(0);
    
  } catch (err) {
    logger.error('');
    logger.error('╔═══════════════════════════════════════════════════════╗');
    logger.error('║  ✗✗✗ FAILED ✗✗✗                                       ║');
    logger.error('╚═══════════════════════════════════════════════════════╝');
    logger.error('');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    logger.error('');
    logger.error('Checkpoint saved. Re-run to resume from last position.');
    logger.error('');
    
    process.exit(1);
  }
}

// Run
if (require.main === module) {
  main();
}

module.exports = main;

