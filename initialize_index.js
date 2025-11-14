'use strict';

/**
 * NPM Registry Index Initializer - FIXED: No Duplicates Edition
 * Author: Zeeeepa (Fixed by Codegen)
 * Date: 2025-11-12 19:27:00 UTC
 * 
 * CRITICAL FIXES APPLIED:
 * ✅ Global deduplication Set prevents duplicate packages
 * ✅ Sequential numbering now correct (0-based indexing)
 * ✅ Workers coordinate through shared deduplication state
 * ✅ Validation reports duplicates if any slip through
 * 
 * Architecture:
 * - Worker Pool: Distributes sequence ranges across workers
 * - Global Deduplication: Single Set tracks all unique packages
 * - Sequential numbering: Packages numbered in discovery order (0-based)
 * - Incremental saving: Data saved after each batch with deduplication
 */

const fs = require('fs');
const path = require('path');
const urllib = require('urllib');
const co = require('co');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Registry
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  
  // Output
  outputDir: process.env.OUTPUT_DIR || './data',
  indexFile: 'package-index.json',
  metadataFile: 'index-metadata.json',
  checkpointFile: 'initialize-checkpoint.json',
  
  // PARALLEL WORKERS CONFIGURATION
  workers: parseInt(process.env.WORKERS) || 10, // Start conservative, scale up after validation
  changesBatchSize: 10000,
  writeBatchSize: 50000,
  
  // Network
  timeout: 60000,
  requestDelay: 10,
  maxRetries: 3,
  
  userAgent: 'npm-registry-indexer/4.0.0 (Zeeeepa; deduplicated; +https://github.com/zeeeepa/npm-indexer)',
};

const logger = console;

// ============================================================================
// Sequential Data Manager with Global Deduplication
// ============================================================================

class SequentialDataManager {
  constructor(outputDir, indexFile, writeBatchSize) {
    this.outputDir = outputDir;
    this.indexFile = indexFile;
    this.writeBatchSize = writeBatchSize;
    this.packageCount = 0;
    this.fileInitialized = false;
    this.batchBuffer = [];
    this.fileStream = null;
    
    // 🔥 CRITICAL FIX: Global deduplication Set
    this.globalPackageSet = new Set();
    
    // Statistics
    this.duplicatesRejected = 0;
  }

  async initialize() {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const indexPath = path.join(this.outputDir, this.indexFile);
    const metadataPath = path.join(this.outputDir, CONFIG.metadataFile);
    
    // Check if resuming from previous run
    if (fs.existsSync(indexPath) && fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        this.packageCount = metadata.totalPackages || 0;
        
        // Load existing packages into globalPackageSet for deduplication
        logger.log('[%s] [DATA MANAGER] Loading existing packages for deduplication...',
          new Date().toISOString());
        
        const existingData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        existingData.forEach(entry => {
          if (Array.isArray(entry) && entry.length >= 1) {
            this.globalPackageSet.add(entry[0]);
          }
        });
        
        logger.log('[%s] [DATA MANAGER] Resuming with %s packages (loaded %s into dedup set)',
          new Date().toISOString(), 
          this.packageCount.toLocaleString(),
          this.globalPackageSet.size.toLocaleString());
        
        // Open file in append mode
        this.fileStream = fs.createWriteStream(indexPath, { flags: 'a' });
        this.fileInitialized = true;
        return true;
      } catch (err) {
        logger.error('[%s] [DATA MANAGER] Error reading metadata: %s', 
          new Date().toISOString(), err.message);
      }
    }
    
    // Start a new file
    this.fileStream = fs.createWriteStream(indexPath, { flags: 'w' });
    this.fileStream.write('[\n');
    this.fileInitialized = true;
    logger.log('[%s] [DATA MANAGER] Starting fresh with global deduplication',
      new Date().toISOString());
    return false;
  }

  async addPackages(packages) {
    if (!this.fileInitialized) {
      throw new Error('DataManager not initialized');
    }

    // 🔥 CRITICAL FIX: Filter out duplicates BEFORE processing
    const newPackages = packages.filter(pkg => {
      if (this.globalPackageSet.has(pkg)) {
        this.duplicatesRejected++;
        return false;
      }
      this.globalPackageSet.add(pkg);
      return true;
    });
    
    if (newPackages.length === 0) {
      return; // All were duplicates
    }

    // Sort for consistent ordering
    newPackages.sort();
    
    for (const pkg of newPackages) {
      // Format: ["package-name", sequential-number]
      // 🔥 FIX: Use 0-based indexing (packageCount starts at 0)
      const entry = [pkg, this.packageCount];
      
      this.batchBuffer.push(entry);
      
      if (this.batchBuffer.length >= this.writeBatchSize) {
        await this.writeBatch();
      }
      
      this.packageCount++;
    }
  }

  async writeBatch() {
    if (this.batchBuffer.length === 0) return;
    
    return new Promise((resolve, reject) => {
      for (let i = 0; i < this.batchBuffer.length; i++) {
        const isFirst = (this.packageCount - this.batchBuffer.length === 0 && i === 0);
        const prefix = isFirst ? '  ' : ',\n  ';
        this.fileStream.write(prefix + JSON.stringify(this.batchBuffer[i]));
      }
      
      this.batchBuffer = [];
      
      this.fileStream.flush(() => {
        resolve();
      });
    });
  }

  async finalize() {
    await this.writeBatch();
    this.fileStream.write('\n]\n');
    
    return new Promise((resolve) => {
      this.fileStream.end(() => {
        logger.log('[%s] [DATA MANAGER] Final stats:',
          new Date().toISOString());
        logger.log('[%s]   - Unique packages saved: %s',
          new Date().toISOString(),
          this.packageCount.toLocaleString());
        logger.log('[%s]   - Duplicates rejected: %s',
          new Date().toISOString(),
          this.duplicatesRejected.toLocaleString());
        logger.log('[%s]   - Deduplication rate: %s%%',
          new Date().toISOString(),
          ((this.duplicatesRejected / (this.packageCount + this.duplicatesRejected)) * 100).toFixed(2));
        resolve();
      });
    });
  }

  getPackageCount() {
    return this.packageCount;
  }
  
  getDuplicatesRejected() {
    return this.duplicatesRejected;
  }
}

// ============================================================================
// WORKER: Fetch Sequence Range with Local Deduplication
// ============================================================================

async function fetchSequenceRange(workerId, startSeq, endSeq, registry, dataManager) {
  const localPackages = new Set(); // Local dedup within worker
  let since = startSeq;
  let requestCount = 0;
  let errors = 0;
  const maxErrors = 5;
  
  logger.log('[Worker #%d] START: seq %s → %s',
    workerId,
    startSeq.toLocaleString(),
    endSeq.toLocaleString());
  
  while (since < endSeq && errors < maxErrors) {
    // 🔥 FIX: Calculate remaining sequences and adjust limit
    const remainingSeqs = endSeq - since;
    const batchLimit = Math.min(CONFIG.changesBatchSize, remainingSeqs);
    
    const url = `${registry}/_changes?since=${since}&limit=${batchLimit}&include_docs=false`;
    
    try {
      const result = await urllib.request(url, {
        dataType: 'json',
        timeout: CONFIG.timeout,
        headers: {
          'user-agent': CONFIG.userAgent,
          'accept': 'application/json',
        },
        gzip: true,
        followRedirect: true,
      });
      
      if (result.status !== 200) {
        throw new Error(`HTTP ${result.status}`);
      }
      
      const data = result.data;
      const results = data.results || [];
      
      if (results.length === 0) {
        logger.log('[Worker #%d] No more results at seq %s', workerId, since);
        break;
      }
      
      // Extract packages (local dedup only)
      const batchPackages = [];
      
      for (const change of results) {
        const id = change.id;
        if (id && 
            !id.startsWith('_design/') && 
            !id.startsWith('_') && 
            id.length > 0 &&
            !localPackages.has(id)) {
          localPackages.add(id);
          batchPackages.push(id);
        }
      }
      
      // Send to dataManager for global deduplication and saving
      if (batchPackages.length > 0) {
        await dataManager.addPackages(batchPackages);
      }
      
      const newSeq = data.last_seq || (results.length > 0 ? results[results.length - 1].seq : since);
      
      // 🔥 FIX: Stop immediately if we've reached or exceeded endSeq
      if (newSeq >= endSeq) {
        logger.log('[Worker #%d] Reached target seq %s (actual: %s)', 
          workerId, endSeq, newSeq);
        since = endSeq;
        break;
      }
      
      since = newSeq;
      requestCount++;
      errors = 0;
      
      // Progress logging
      if (requestCount % 10 === 0) {
        const progress = Math.min(((since - startSeq) / (endSeq - startSeq) * 100), 100).toFixed(1);
        logger.log('[Worker #%d] %s%% | seq: %s | local packages: %d | requests: %d',
          workerId,
          progress,
          since.toLocaleString(),
          localPackages.size,
          requestCount);
      }
      
      await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
      
    } catch (err) {
      errors++;
      logger.error('[Worker #%d] Error at seq %s (attempt %d/%d): %s',
        workerId, since, errors, maxErrors, err.message);
      
      const delay = Math.min(1000 * Math.pow(2, errors), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  if (errors >= maxErrors) {
    logger.error('[Worker #%d] ✗ FAILED after %d errors', workerId, errors);
  } else {
    logger.log('[Worker #%d] ✓ DONE: %d local packages in %d requests',
      workerId,
      localPackages.size,
      requestCount);
  }
  
  return {
    workerId,
    localPackageCount: localPackages.size,
    startSeq,
    endSeq,
    finalSeq: since,
    requestCount,
    success: errors < maxErrors,
  };
}

// ============================================================================
// WORKER POOL
// ============================================================================

async function runWorkerPool(registry, workerCount, dataManager) {
  const poolStartTime = Date.now();
  
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  logger.log('[%s] WORKER POOL: Initializing %d parallel workers',
    new Date().toISOString(), workerCount);
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  
  // Get max sequence from registry
  logger.log('[%s] [POOL] Fetching registry metadata...', new Date().toISOString());
  
  const rootResult = await urllib.request(`${registry}/`, {
    dataType: 'json',
    timeout: 30000,
    headers: { 'user-agent': CONFIG.userAgent },
  });
  
  const maxSeq = (rootResult.data && rootResult.data.update_seq) || 0;
  
  logger.log('[%s] [POOL] Registry max sequence: %s',
    new Date().toISOString(),
    maxSeq.toLocaleString());
  
  // Calculate sequence ranges
  const seqPerWorker = Math.ceil(maxSeq / workerCount);
  
  logger.log('[%s] [POOL] Each worker handles ~%s sequences',
    new Date().toISOString(),
    seqPerWorker.toLocaleString());
  
  // Launch workers
  const workerPromises = [];
  
  for (let i = 0; i < workerCount; i++) {
    const startSeq = i * seqPerWorker;
    const endSeq = Math.min((i + 1) * seqPerWorker, maxSeq);
    
    if (startSeq >= maxSeq) break;
    
    workerPromises.push(
      fetchSequenceRange(i, startSeq, endSeq, registry, dataManager)
    );
  }
  
  logger.log('[%s] [POOL] Launched %d workers - RUNNING IN PARALLEL',
    new Date().toISOString(),
    workerPromises.length);
  
  // Wait for all workers
  const results = await Promise.all(workerPromises);
  
  const poolDuration = ((Date.now() - poolStartTime) / 1000 / 60).toFixed(2);
  
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  logger.log('[%s] [POOL] All workers completed in %s minutes',
    new Date().toISOString(),
    poolDuration);
  
  // Collect statistics
  let totalRequests = 0;
  let successfulWorkers = 0;
  let failedWorkers = 0;
  let totalLocalPackages = 0;
  
  for (const result of results) {
    if (result.success) {
      totalLocalPackages += result.localPackageCount;
      totalRequests += result.requestCount;
      successfulWorkers++;
    } else {
      failedWorkers++;
    }
  }
  
  logger.log('[%s] [POOL] ═══════════════════════════════════════',
    new Date().toISOString());
  logger.log('[%s] [POOL] Statistics:',
    new Date().toISOString());
  logger.log('[%s]   - Successful workers: %d/%d',
    new Date().toISOString(), successfulWorkers, workerPromises.length);
  logger.log('[%s]   - Failed workers: %d',
    new Date().toISOString(), failedWorkers);
  logger.log('[%s]   - Total API requests: %s',
    new Date().toISOString(), totalRequests.toLocaleString());
  logger.log('[%s]   - Total local packages (before global dedup): %s',
    new Date().toISOString(), totalLocalPackages.toLocaleString());
  logger.log('[%s]   - Unique packages saved: %s',
    new Date().toISOString(), dataManager.getPackageCount().toLocaleString());
  logger.log('[%s]   - Duplicates rejected: %s',
    new Date().toISOString(), dataManager.getDuplicatesRejected().toLocaleString());
  logger.log('[%s] [POOL] ═══════════════════════════════════════',
    new Date().toISOString());
  
  return {
    workers: workerPromises.length,
    successfulWorkers,
    failedWorkers,
    totalRequests,
    duration: poolDuration,
    totalLocalPackages,
    uniquePackagesSaved: dataManager.getPackageCount(),
    duplicatesRejected: dataManager.getDuplicatesRejected(),
  };
}

// ============================================================================
// VALIDATION
// ============================================================================

function validateOutput(outputPath) {
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  logger.log('[%s] VALIDATION: Checking output for duplicates and gaps',
    new Date().toISOString());
  
  try {
    const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const seen = new Set();
    const duplicates = [];
    const sequenceGaps = [];
    
    data.forEach((entry, idx) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        logger.warn('[VALIDATION] Invalid entry at index %d: %j', idx, entry);
        return;
      }
      
      const [pkg, num] = entry;
      
      // Check for duplicate package names
      if (seen.has(pkg)) {
        duplicates.push(pkg);
      }
      seen.add(pkg);
      
      // Check for sequence number gaps
      if (num !== idx) {
        sequenceGaps.push({ index: idx, expected: idx, got: num });
      }
    });
    
    const isValid = duplicates.length === 0 && sequenceGaps.length === 0;
    
    logger.log('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    logger.log('[%s] VALIDATION RESULTS:',
      new Date().toISOString());
    logger.log('[%s]   - Total entries: %s',
      new Date().toISOString(), data.length.toLocaleString());
    logger.log('[%s]   - Unique packages: %s',
      new Date().toISOString(), seen.size.toLocaleString());
    logger.log('[%s]   - Duplicates found: %d %s',
      new Date().toISOString(),
      duplicates.length,
      duplicates.length > 0 ? '❌' : '✅');
    
    if (duplicates.length > 0) {
      logger.log('[%s]   - First 10 duplicates: %j',
        new Date().toISOString(),
        duplicates.slice(0, 10));
    }
    
    logger.log('[%s]   - Sequence gaps: %d %s',
      new Date().toISOString(),
      sequenceGaps.length,
      sequenceGaps.length > 0 ? '❌' : '✅');
    
    if (sequenceGaps.length > 0 && sequenceGaps.length <= 10) {
      logger.log('[%s]   - Gap details: %j',
        new Date().toISOString(),
        sequenceGaps);
    }
    
    logger.log('[%s]   - Overall: %s',
      new Date().toISOString(),
      isValid ? '✅ VALID' : '❌ INVALID');
    logger.log('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    
    return {
      totalEntries: data.length,
      uniquePackages: seen.size,
      duplicates: duplicates.length,
      duplicateList: duplicates.slice(0, 10),
      sequenceGaps: sequenceGaps.length,
      isValid,
    };
  } catch (err) {
    logger.error('[%s] VALIDATION FAILED: %s', new Date().toISOString(), err.message);
    return { error: err.message };
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function initializeAsync() {
  const startTime = Date.now();
  
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  logger.log('[%s] NPM Registry Initializer - FIXED: No Duplicates Edition',
    new Date().toISOString());
  logger.log('[%s] Version: 4.0.0 (Codegen Fixed)',
    new Date().toISOString());
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  logger.log('[%s] Configuration:',
    new Date().toISOString());
  logger.log('[%s]   - Workers: %d parallel streams',
    new Date().toISOString(), CONFIG.workers);
  logger.log('[%s]   - Registry: %s',
    new Date().toISOString(), CONFIG.registry);
  logger.log('[%s]   - Deduplication: Global Set (ENABLED)',
    new Date().toISOString());
  logger.log('[%s] ═══════════════════════════════════════════════════════',
    new Date().toISOString());
  
  try {
    const dataManager = new SequentialDataManager(
      CONFIG.outputDir,
      CONFIG.indexFile,
      CONFIG.writeBatchSize
    );
    
    const isResuming = await dataManager.initialize();
    
    if (isResuming) {
      logger.log('[%s] Resuming from previous run...', new Date().toISOString());
    } else {
      logger.log('[%s] Starting new run...', new Date().toISOString());
    }
    
    // Run worker pool
    const poolResult = await runWorkerPool(CONFIG.registry, CONFIG.workers, dataManager);
    
    // Finalize
    await dataManager.finalize();
    
    // Validate output
    const indexPath = path.join(CONFIG.outputDir, CONFIG.indexFile);
    const validation = validateOutput(indexPath);
    
    // Save metadata
    const metadata = {
      timestamp: new Date().toISOString(),
      timestampUnix: Date.now(),
      totalPackages: dataManager.getPackageCount(),
      workers: poolResult.workers,
      successfulWorkers: poolResult.successfulWorkers,
      failedWorkers: poolResult.failedWorkers,
      totalRequests: poolResult.totalRequests,
      duplicatesRejected: poolResult.duplicatesRejected,
      validation,
      version: '4.0.0',
      method: 'Parallel workers with global deduplication Set',
      fixes: [
        'Global deduplication Set prevents duplicates',
        '0-based sequential numbering',
        'Workers respect sequence range limits',
        'Automatic validation on completion'
      ],
      duration: Date.now() - startTime,
      durationMinutes: ((Date.now() - startTime) / 1000 / 60).toFixed(2),
      workerDurationMinutes: poolResult.duration,
      createdBy: 'Zeeeepa (Fixed by Codegen)',
      registry: CONFIG.registry,
      dataFormat: '["package-name", sequential-number (0-based)]',
    };
    
    const metadataPath = path.join(CONFIG.outputDir, CONFIG.metadataFile);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    
    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(dataManager.getPackageCount() / parseFloat(totalDuration));
    
    logger.log('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    logger.log('[%s] ✓✓✓ INITIALIZATION COMPLETE ✓✓✓',
      new Date().toISOString());
    logger.log('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    logger.log('[%s] Duration: %s minutes',
      new Date().toISOString(), totalDuration);
    logger.log('[%s] Unique packages: %s',
      new Date().toISOString(), dataManager.getPackageCount().toLocaleString());
    logger.log('[%s] Duplicates rejected: %s',
      new Date().toISOString(), poolResult.duplicatesRejected.toLocaleString());
    logger.log('[%s] Throughput: %s packages/minute',
      new Date().toISOString(), throughput.toLocaleString());
    logger.log('[%s] Validation: %s',
      new Date().toISOString(), validation.isValid ? '✅ PASSED' : '❌ FAILED');
    logger.log('[%s] Output: %s',
      new Date().toISOString(), indexPath);
    logger.log('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    
    return {
      success: true,
      packages: dataManager.getPackageCount(),
      duration: totalDuration,
      throughput,
      validation,
      metadata,
    };
    
  } catch (err) {
    logger.error('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    logger.error('[%s] ✗✗✗ INITIALIZATION FAILED ✗✗✗',
      new Date().toISOString());
    logger.error('[%s] ═══════════════════════════════════════════════════════',
      new Date().toISOString());
    logger.error('[%s] Error: %s', new Date().toISOString(), err.message);
    logger.error('[%s] Stack: %s', new Date().toISOString(), err.stack);
    throw err;
  }
}

// Wrap for co compatibility
function* initialize() {
  return yield initializeAsync();
}

// ============================================================================
// Entry Point
// ============================================================================

if (require.main === module) {
  co(initialize)
    .then(result => {
      logger.log('[%s] Exiting with success', new Date().toISOString());
      process.exit(0);
    })
    .catch(err => {
      logger.error('[%s] Exiting with error', new Date().toISOString());
      process.exit(1);
    });
}

module.exports = initialize;

