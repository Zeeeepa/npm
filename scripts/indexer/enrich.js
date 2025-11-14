'use strict';

/**
 * NPM Package Enricher v2.0 - DEDUPLICATED & SMART UPDATES
 * Author: Zeeeepa
 * Date: 2025-11-13
 * 
 * CRITICAL FIXES:
 * - ✅ Deduplication: Each package appears only once
 * - ✅ Smart updates: Only fills missing/null/zero fields
 * - ✅ Preserves existing good data
 * - ✅ Atomic CSV rewrite (no corruption)
 * - ✅ Sorted alphabetically
 * - ✅ Sequential renumbering
 * 
 * HOW IT WORKS:
 * 1. Load ALL packages from CSV into memory (Map<name, data>)
 * 2. Identify packages needing enrichment
 * 3. Fetch metadata and smartly merge with existing data
 * 4. Write deduplicated, sorted CSV atomically
 * 
 * SMART UPDATE LOGIC:
 * - Only update if current value is: null, undefined, '', '0', 'N/A', or 0
 * - Preserve existing good values
 * - Merge new data intelligently
 */

const fs = require('fs');
const path = require('path');
const urllib = require('urllib');
const readline = require('readline');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  
  inputCsv: path.join(__dirname, 'npm.csv'),
  outputCsv: path.join(__dirname, 'npm.csv'),
  checkpointFile: path.join(__dirname, 'enrich-checkpoint.json'),
  
  workers: parseInt(process.env.ENRICH_WORKERS) || 10,
  timeout: 120000,
  maxRetries: 3,
  rateLimit: 10, // req/sec
  
  userAgent: 'npm-enricher/2.0.0-deduplicated (Zeeeepa)',
};

const logger = console;

// ============================================================================
// Rate Limiter
// ============================================================================

class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.tokens = maxPerSecond;
    this.lastRefill = Date.now();
  }

  async waitForToken() {
    while (this.tokens < 1) {
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
// Package Registry - Deduplication Core
// ============================================================================

class PackageRegistry {
  constructor() {
    this.packages = new Map(); // Map<packageName, packageData>
  }

  /**
   * Add or update package (deduplication + smart merge)
   */
  addOrUpdate(name, data) {
    if (this.packages.has(name)) {
      const existing = this.packages.get(name);
      const merged = this.smartMerge(existing, data);
      this.packages.set(name, merged);
    } else {
      this.packages.set(name, {
        name,
        ...data,
      });
    }
  }

  /**
   * Smart merge: Only update fields that are empty/missing
   */
  smartMerge(existing, newData) {
    const merged = { ...existing };

    // Helper: Check if value needs update
    const needsUpdate = (val) => {
      return val === null || 
             val === undefined || 
             val === '' || 
             val === '0' || 
             val === 'N/A' || 
             val === 0 ||
             val === 'unknown';
    };

    // Update each field intelligently
    for (const key of Object.keys(newData)) {
      if (needsUpdate(merged[key]) && !needsUpdate(newData[key])) {
        merged[key] = newData[key];
      }
    }

    return merged;
  }

  has(name) {
    return this.packages.has(name);
  }

  get(name) {
    return this.packages.get(name);
  }

  /**
   * Get all packages sorted alphabetically
   */
  getAllSorted() {
    const packages = Array.from(this.packages.values());
    packages.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return packages;
  }

  size() {
    return this.packages.size;
  }

  /**
   * Get packages needing enrichment
   */
  getNeedingEnrichment() {
    const needEnrichment = [];
    
    for (const pkg of this.packages.values()) {
      const needsIt = (
        !pkg.file_number || pkg.file_number === '0' || pkg.file_number === 'N/A'
      ) || (
        !pkg.unpacked_size || pkg.unpacked_size === '0' || pkg.unpacked_size === 'N/A'
      ) || (
        !pkg.description || pkg.description === ''
      );

      if (needsIt) {
        needEnrichment.push(pkg);
      }
    }

    return needEnrichment;
  }
}

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
        return null;
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
// CSV Loading
// ============================================================================

async function loadCSVIntoRegistry(csvPath, registry) {
  if (!fs.existsSync(csvPath)) {
    logger.log('[CSV] File not found: %s', csvPath);
    return 0;
  }

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let isHeader = true;
  let lineNumber = 0;
  let loadedCount = 0;

  for await (const line of rl) {
    lineNumber++;
    
    if (isHeader) {
      isHeader = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse CSV (simple parser)
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (char === '"') {
        if (inQuotes && trimmed[i + 1] === '"') {
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
      const packageData = {
        number: parseInt(values[0]) || lineNumber,
        npm_url: values[1],
        name: values[2],
        file_number: values[3] || '0',
        unpacked_size: values[4] || '0',
        dependencies: values[5] || '0',
        dependents: values[6] || '0',
        latest_release_published_at: values[7] || '',
        description: values[8] || '',
        keywords: values[9] || '',
      };

      registry.addOrUpdate(packageData.name, packageData);
      loadedCount++;
    }
  }

  logger.log('[CSV] Loaded %d packages into registry', loadedCount);
  logger.log('[CSV] Unique packages after deduplication: %d', registry.size());
  
  return loadedCount;
}

// ============================================================================
// Enrichment
// ============================================================================

async function enrichPackage(pkg, registry) {
  try {
    const url = `${CONFIG.registry}/${encodeURIComponent(pkg.name)}`;
    const data = await fetchWithRetry(url);

    if (!data) {
      return pkg; // Package not found
    }

    const distTags = data['dist-tags'] || {};
    const latestVersion = distTags.latest || Object.keys(data.versions || {})[0];
    
    if (!latestVersion) {
      return pkg;
    }

    const versionData = data.versions[latestVersion] || {};
    const dist = versionData.dist || {};
    const time = data.time || {};

    const newData = {
      file_number: dist.fileCount || pkg.file_number || '0',
      unpacked_size: dist.unpackedSize || pkg.unpacked_size || '0',
      dependencies: Object.keys(versionData.dependencies || {}).length || pkg.dependencies || '0',
      latest_release_published_at: time[latestVersion] || time.modified || pkg.latest_release_published_at || '',
      description: (versionData.description || pkg.description || '').replace(/[\r\n]+/g, ' ').substring(0, 500),
      keywords: Array.isArray(versionData.keywords) 
        ? versionData.keywords.join(', ').substring(0, 500)
        : (pkg.keywords || ''),
    };

    // Smart merge into registry
    registry.addOrUpdate(pkg.name, newData);

    return registry.get(pkg.name);
  } catch (err) {
    logger.error('[ENRICH] Error enriching %s: %s', pkg.name, err.message);
    return pkg;
  }
}

async function enrichBatch(packages, registry) {
  const promises = packages.map(pkg => enrichPackage(pkg, registry));
  return await Promise.all(promises);
}

// ============================================================================
// CSV Writing
// ============================================================================

async function writeCSV(registry, csvPath) {
  const tmpFile = csvPath + '.tmp';
  const stream = fs.createWriteStream(tmpFile);

  // Write header
  stream.write('number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords\n');

  // Get all packages sorted
  const packages = registry.getAllSorted();

  // Write packages with sequential numbering
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const rowNum = i + 1;

    const row = [
      rowNum,
      escapeCSV(pkg.npm_url || `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`),
      escapeCSV(pkg.name),
      escapeCSV(pkg.file_number),
      escapeCSV(pkg.unpacked_size),
      escapeCSV(pkg.dependencies),
      escapeCSV(pkg.dependents || '0'),
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
        // Backup original
        if (fs.existsSync(csvPath)) {
          fs.copyFileSync(csvPath, csvPath + '.backup');
        }
        
        // Atomic rename
        fs.renameSync(tmpFile, csvPath);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ============================================================================
// Checkpoint
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
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();
  
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('NPM Package Enricher v2.0 - DEDUPLICATED & SMART UPDATES');
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('Config:');
  logger.log('  Workers: %d', CONFIG.workers);
  logger.log('  Rate limit: %d req/sec', CONFIG.rateLimit);
  logger.log('  Input/Output: %s', CONFIG.inputCsv);
  logger.log('═══════════════════════════════════════════════════════');

  try {
    // Load checkpoint
    const checkpoint = loadCheckpoint();
    
    // Create registry
    const registry = new PackageRegistry();
    
    // Load existing CSV into registry (deduplication happens here)
    logger.log('[STEP 1/3] LOADING CSV INTO REGISTRY...');
    const loadedCount = await loadCSVIntoRegistry(CONFIG.inputCsv, registry);
    
    logger.log('[REGISTRY] Total unique packages: %d', registry.size());
    
    // Identify packages needing enrichment
    logger.log('[STEP 2/3] IDENTIFYING PACKAGES NEEDING ENRICHMENT...');
    const needsEnrichment = registry.getNeedingEnrichment();
    
    logger.log('[ENRICH] Total packages: %d', registry.size());
    logger.log('[ENRICH] Already enriched: %d', registry.size() - needsEnrichment.length);
    logger.log('[ENRICH] Need enrichment: %d', needsEnrichment.length);

    if (needsEnrichment.length === 0) {
      logger.log('[ENRICH] ✓ All packages already enriched!');
      
      // Still write CSV to ensure deduplication
      logger.log('[STEP 3/3] WRITING DEDUPLICATED CSV...');
      await writeCSV(registry, CONFIG.outputCsv);
      
      logger.log('═══════════════════════════════════════════════════════');
      logger.log('✓✓✓ COMPLETE (DEDUPLICATION ONLY) ✓✓✓');
      logger.log('═══════════════════════════════════════════════════════');
      logger.log('Total packages: %d', registry.size());
      logger.log('Duplicates removed: %d', loadedCount - registry.size());
      logger.log('═══════════════════════════════════════════════════════');
      
      return {
        success: true,
        enriched: 0,
        total: registry.size(),
        duplicatesRemoved: loadedCount - registry.size(),
      };
    }

    // Enrich in batches
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('[STEP 2/3] ENRICHING (%d packages)', needsEnrichment.length);
    logger.log('═══════════════════════════════════════════════════════');

    let enrichedCount = 0;
    const totalToEnrich = needsEnrichment.length;

    for (let i = 0; i < totalToEnrich; i += CONFIG.workers) {
      const endIdx = Math.min(i + CONFIG.workers, totalToEnrich);
      const batch = needsEnrichment.slice(i, endIdx);
      
      await enrichBatch(batch, registry);
      enrichedCount += batch.length;

      // Progress logging
      if (enrichedCount % 100 === 0 || enrichedCount === totalToEnrich) {
        const progress = ((enrichedCount / totalToEnrich) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
        const rate = Math.round(enrichedCount / ((Date.now() - startTime) / 1000 / 60));
        const remaining = Math.round((totalToEnrich - enrichedCount) / rate);

        logger.log('[ENRICH] %s%% | %d/%d | %s min | %d pkg/min | ETA: %d min',
          progress, enrichedCount, totalToEnrich, elapsed, rate, remaining);
      }

      // Save checkpoint every 1000
      if (enrichedCount % 1000 === 0) {
        checkpoint.enrichedCount = enrichedCount;
        saveCheckpoint(checkpoint);
      }
    }

    // Write deduplicated CSV
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('[STEP 3/3] WRITING DEDUPLICATED CSV');
    logger.log('═══════════════════════════════════════════════════════');
    
    await writeCSV(registry, CONFIG.outputCsv);
    
    logger.log('[CSV] Written to: %s', CONFIG.outputCsv);
    logger.log('[CSV] Total rows: %d', registry.size());

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    logger.log('═══════════════════════════════════════════════════════');
    logger.log('✓✓✓ COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('Duration: %s minutes', duration);
    logger.log('Enriched: %d packages', enrichedCount);
    logger.log('Total unique: %d packages', registry.size());
    logger.log('Duplicates removed: %d', loadedCount - registry.size());
    logger.log('Throughput: %d pkg/min', Math.round(enrichedCount / parseFloat(duration)));
    logger.log('═══════════════════════════════════════════════════════');

    return {
      success: true,
      enriched: enrichedCount,
      total: registry.size(),
      duplicatesRemoved: loadedCount - registry.size(),
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

