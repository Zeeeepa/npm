'use strict';

/**
 * NPM Package Enricher - Production Edition
 * Author: Zeeeepa
 * Date: 2025-11-13
 * 
 * PURPOSE:
 * - Reads npm.csv from same directory
 * - Enriches missing metadata for each package
 * - Upserts back to npm.csv atomically
 * - Maintains checkpoint with sequence for incremental updates
 * 
 * FEATURES:
 * - Rate-limited API calls (10 req/sec)
 * - Atomic CSV writes (tmp + rename)
 * - Checkpoint-based resume
 * - Progress tracking with ETA
 * - Error handling and retries
 * - Sequence tracking for future updates
 */

const fs = require('fs');
const path = require('path');
const urllib = require('urllib');
const readline = require('readline');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Registry
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  
  // Files (same directory)
  inputCsv: path.join(__dirname, 'npm.csv'),
  outputCsv: path.join(__dirname, 'npm.csv'), // Same file (upsert)
  checkpointFile: path.join(__dirname, 'enrich-checkpoint.json'),
  
  // Performance
  workers: parseInt(process.env.ENRICH_WORKERS) || 10,
  timeout: 120000,
  maxRetries: 3,
  
  // Rate limiting
  rateLimit: 10, // requests per second
  
  userAgent: 'npm-enricher/1.0.0 (Zeeeepa; +https://github.com/zeeeepa/npm)',
};

const logger = console;

// ============================================================================
// Rate Limiter (Token Bucket)
// ============================================================================

class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.tokens = maxPerSecond;
    this.lastRefill = Date.now();
  }

  async waitForToken() {
    while (this.tokens < 1) {
      // Refill tokens
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.maxPerSecond, this.tokens + elapsed * this.maxPerSecond);
      this.lastRefill = now;

      if (this.tokens < 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    this.tokens -= 1;
  }
}

const rateLimiter = new RateLimiter(CONFIG.rateLimit);

// ============================================================================
// Utilities
// ============================================================================

async function fetchWithRetry(url, options = {}) {
  let lastError;
  
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      await rateLimiter.waitForToken();
      
      const result = await urllib.request(url, {
        dataType: 'json',
        timeout: CONFIG.timeout,
        headers: {
          'user-agent': CONFIG.userAgent,
          'accept': 'application/json',
        },
        gzip: true,
        followRedirect: true,
        ...options,
      });

      if (result.status === 200) {
        return result.data;
      }

      if (result.status === 404) {
        return null; // Package not found
      }

      throw new Error(`HTTP ${result.status}`);
    } catch (err) {
      lastError = err;
      
      if (attempt < CONFIG.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

function escapeCSV(value) {
  if (value === null || value === undefined) {
    return '';
  }
  
  const str = String(value);
  
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  
  return str;
}

// ============================================================================
// Checkpoint Management
// ============================================================================

function loadCheckpoint() {
  if (fs.existsSync(CONFIG.checkpointFile)) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(CONFIG.checkpointFile, 'utf8'));
      logger.log('[CHECKPOINT] Loaded: %d packages enriched', checkpoint.enrichedCount);
      return checkpoint;
    } catch (err) {
      logger.error('[CHECKPOINT] Failed to load: %s', err.message);
    }
  }
  
  return {
    enrichedCount: 0,
    lastProcessedNumber: 0,
    startTime: Date.now(),
    errors: [],
  };
}

function saveCheckpoint(checkpoint) {
  try {
    const tmpFile = CONFIG.checkpointFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(checkpoint, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONFIG.checkpointFile);
  } catch (err) {
    logger.error('[CHECKPOINT] Failed to save: %s', err.message);
  }
}

// ============================================================================
// CSV Reading & Parsing
// ============================================================================

async function readCSV() {
  const packages = [];
  
  if (!fs.existsSync(CONFIG.inputCsv)) {
    throw new Error(`CSV not found: ${CONFIG.inputCsv}`);
  }

  const fileStream = fs.createReadStream(CONFIG.inputCsv);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let isHeader = true;
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    
    if (isHeader) {
      isHeader = false;
      continue;
    }

    // Parse CSV line (simple parser - handles basic cases)
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);

    if (values.length >= 3) {
      packages.push({
        number: parseInt(values[0]) || lineNumber,
        npm_url: values[1],
        package_name: values[2],
        file_number: values[3] || '0',
        unpacked_size: values[4] || '0',
        dependencies: values[5] || '0',
        dependents: values[6] || '0',
        latest_release_published_at: values[7] || '',
        description: values[8] || '',
        keywords: values[9] || '',
      });
    }
  }

  logger.log('[CSV] Loaded %d packages from %s', packages.length, CONFIG.inputCsv);
  return packages;
}

// ============================================================================
// Package Enrichment
// ============================================================================

async function enrichPackage(pkg) {
  try {
    // Skip if already enriched (has file_number > 0 or unpacked_size > 0)
    if ((pkg.file_number && pkg.file_number !== '0' && pkg.file_number !== 'N/A') ||
        (pkg.unpacked_size && pkg.unpacked_size !== '0' && pkg.unpacked_size !== 'N/A')) {
      return pkg; // Already enriched
    }

    const url = `${CONFIG.registry}/${encodeURIComponent(pkg.package_name)}`;
    const data = await fetchWithRetry(url);

    if (!data) {
      // Package not found or error
      return {
        ...pkg,
        file_number: 'N/A',
        unpacked_size: 'N/A',
        dependencies: '0',
        dependents: '0',
        latest_release_published_at: '',
        description: '',
        keywords: '',
      };
    }

    // Extract latest version
    const distTags = data['dist-tags'] || {};
    const latestVersion = distTags.latest || Object.keys(data.versions || {})[0];
    
    if (!latestVersion) {
      return {
        ...pkg,
        file_number: 'N/A',
        unpacked_size: 'N/A',
        dependencies: '0',
        dependents: '0',
      };
    }

    const versionData = data.versions[latestVersion] || {};
    const dist = versionData.dist || {};
    const time = data.time || {};

    // Extract metadata
    const fileCount = dist.fileCount || 0;
    const unpackedSize = dist.unpackedSize || 0;
    const dependencies = Object.keys(versionData.dependencies || {}).length;
    const publishTime = time[latestVersion] || time.modified || '';
    const description = (versionData.description || '').replace(/[\r\n]+/g, ' ').substring(0, 500);
    const keywords = Array.isArray(versionData.keywords) 
      ? versionData.keywords.join(', ').substring(0, 500)
      : '';

    return {
      ...pkg,
      file_number: String(fileCount),
      unpacked_size: String(unpackedSize),
      dependencies: String(dependencies),
      dependents: '0', // Would require separate API call
      latest_release_published_at: publishTime,
      description: description,
      keywords: keywords,
    };
  } catch (err) {
    logger.error('[ENRICH] Error enriching %s: %s', pkg.package_name, err.message);
    return pkg; // Return original on error
  }
}

// ============================================================================
// Batch Processing
// ============================================================================

async function enrichBatch(packages, startIdx, endIdx) {
  const batch = packages.slice(startIdx, endIdx);
  const promises = batch.map(pkg => enrichPackage(pkg));
  return await Promise.all(promises);
}

// ============================================================================
// CSV Writing
// ============================================================================

async function writeCSV(packages) {
  const tmpFile = CONFIG.outputCsv + '.tmp';
  const stream = fs.createWriteStream(tmpFile);

  // Write header
  stream.write('number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords\n');

  // Write packages
  for (const pkg of packages) {
    const row = [
      pkg.number,
      escapeCSV(pkg.npm_url),
      escapeCSV(pkg.package_name),
      escapeCSV(pkg.file_number),
      escapeCSV(pkg.unpacked_size),
      escapeCSV(pkg.dependencies),
      escapeCSV(pkg.dependents),
      escapeCSV(pkg.latest_release_published_at),
      escapeCSV(pkg.description),
      escapeCSV(pkg.keywords),
    ].join(',');

    stream.write(row + '\n');
  }

  // Close and rename atomically
  await new Promise((resolve, reject) => {
    stream.end(() => {
      try {
        fs.renameSync(tmpFile, CONFIG.outputCsv);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ============================================================================
// Main Enrichment Function
// ============================================================================

async function main() {
  const startTime = Date.now();
  
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('NPM Package Enricher');
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('Config:');
  logger.log('  Workers: %d', CONFIG.workers);
  logger.log('  Rate limit: %d req/sec', CONFIG.rateLimit);
  logger.log('  Input: %s', CONFIG.inputCsv);
  logger.log('  Output: %s (upsert)', CONFIG.outputCsv);
  logger.log('═══════════════════════════════════════════════════════');

  try {
    // Load checkpoint
    const checkpoint = loadCheckpoint();
    
    // Read CSV
    logger.log('[STEP 1/3] Reading CSV...');
    const packages = await readCSV();
    
    // Filter packages that need enrichment
    const needsEnrichment = packages.filter(pkg => {
      const needsIt = (pkg.file_number === '0' || pkg.file_number === 'N/A' || !pkg.file_number) &&
                      (pkg.unpacked_size === '0' || pkg.unpacked_size === 'N/A' || !pkg.unpacked_size);
      return needsIt && pkg.number > checkpoint.lastProcessedNumber;
    });

    logger.log('[ENRICH] Total packages: %d', packages.length);
    logger.log('[ENRICH] Already enriched: %d', packages.length - needsEnrichment.length);
    logger.log('[ENRICH] Need enrichment: %d', needsEnrichment.length);

    if (needsEnrichment.length === 0) {
      logger.log('[ENRICH] All packages already enriched!');
      return {
        success: true,
        enriched: 0,
        total: packages.length,
        duration: 0,
      };
    }

    // Process in batches
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('[STEP 2/3] ENRICHING (%d packages)', needsEnrichment.length);
    logger.log('═══════════════════════════════════════════════════════');

    let enrichedCount = 0;
    const totalToEnrich = needsEnrichment.length;

    for (let i = 0; i < totalToEnrich; i += CONFIG.workers) {
      const endIdx = Math.min(i + CONFIG.workers, totalToEnrich);
      const enrichedBatch = await enrichBatch(needsEnrichment, i, endIdx);

      // Update packages array with enriched data
      for (const enrichedPkg of enrichedBatch) {
        const idx = packages.findIndex(p => p.number === enrichedPkg.number);
        if (idx !== -1) {
          packages[idx] = enrichedPkg;
        }
      }

      enrichedCount += enrichedBatch.length;
      checkpoint.enrichedCount = enrichedCount;
      checkpoint.lastProcessedNumber = enrichedBatch[enrichedBatch.length - 1].number;

      // Save checkpoint every 1000 packages
      if (enrichedCount % 1000 === 0) {
        saveCheckpoint(checkpoint);
      }

      // Progress logging
      if (enrichedCount % 100 === 0 || enrichedCount === totalToEnrich) {
        const progress = ((enrichedCount / totalToEnrich) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
        const rate = Math.round(enrichedCount / ((Date.now() - startTime) / 1000 / 60));
        const remaining = Math.round((totalToEnrich - enrichedCount) / rate);

        logger.log('[ENRICH] %s%% | %d/%d | %s min | %d pkg/min | ETA: %d min',
          progress, enrichedCount, totalToEnrich, elapsed, rate, remaining);
      }
    }

    // Write enriched CSV
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('[STEP 3/3] WRITING CSV');
    logger.log('═══════════════════════════════════════════════════════');
    
    await writeCSV(packages);
    
    logger.log('[CSV] Written to: %s', CONFIG.outputCsv);
    logger.log('[CSV] Total rows: %d', packages.length);

    // Final checkpoint
    checkpoint.endTime = Date.now();
    checkpoint.duration = ((checkpoint.endTime - startTime) / 1000 / 60).toFixed(2);
    saveCheckpoint(checkpoint);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    logger.log('═══════════════════════════════════════════════════════');
    logger.log('✓✓✓ COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('Duration: %s minutes', duration);
    logger.log('Enriched: %d packages', enrichedCount);
    logger.log('Total: %d packages', packages.length);
    logger.log('Throughput: %d pkg/min', Math.round(enrichedCount / parseFloat(duration)));
    logger.log('═══════════════════════════════════════════════════════');

    return {
      success: true,
      enriched: enrichedCount,
      total: packages.length,
      duration: parseFloat(duration),
    };

  } catch (err) {
    logger.error('═══════════════════════════════════════════════════════');
    logger.error('✗✗✗ FAILED ✗✗✗');
    logger.error('═══════════════════════════════════════════════════════');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    throw err;
  }
}

// ============================================================================
// Entry Point
// ============================================================================

if (require.main === module) {
  main()
    .then(result => {
      logger.log('[EXIT] Success');
      process.exit(0);
    })
    .catch(err => {
      logger.error('[EXIT] Failed');
      process.exit(1);
    });
}

module.exports = main;

