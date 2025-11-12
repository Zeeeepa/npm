'use strict';

/**
 * NPM Package Metadata Enrichment
 * Fetches full metadata for packages and stores in PostgreSQL
 * 
 * Usage: node enrich.js [--db-config=./db-config.json] [--limit=100] [--rate=10]
 */

const fs = require('fs');
const urllib = require('urllib');
const { createConnection } = require('./lib/db-connection');

const logger = console;

// Configuration
const CONFIG = {
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  dbConfig: process.argv.find(arg => arg.startsWith('--db-config='))?.split('=')[1] || null,
  limit: parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1]) || 0,
  rateLimit: parseInt(process.argv.find(arg => arg.startsWith('--rate='))?.split('=')[1]) || 10,
  batchSize: 100,
  timeout: 60000,
  userAgent: 'npm-registry-enrich/4.0.0',
};

let DB_CONNECTION = null;

// Rate limiter
class RateLimiter {
  constructor(requestsPerSecond) {
    this.requestsPerSecond = requestsPerSecond;
    this.interval = 1000 / requestsPerSecond;
    this.lastRequest = 0;
  }

  async wait() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    if (timeSinceLastRequest < this.interval) {
      await new Promise(resolve => setTimeout(resolve, this.interval - timeSinceLastRequest));
    }
    this.lastRequest = Date.now();
  }
}

const RATE_LIMITER = new RateLimiter(CONFIG.rateLimit);

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

async function getUnenrichedPackages(limit) {
  const sql = `
    SELECT id, name 
    FROM packages 
    WHERE enriched_at IS NULL 
    ORDER BY seq 
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `;
  return await DB_CONNECTION.query(sql);
}

async function getEnrichmentStats() {
  const result = await DB_CONNECTION.query(`
    SELECT 
      COUNT(*) AS total,
      COUNT(enriched_at) AS enriched,
      COUNT(*) - COUNT(enriched_at) AS unenriched
    FROM packages
  `);
  return result[0];
}

async function updatePackageEnrichment(id, metadata) {
  await DB_CONNECTION.query(`
    UPDATE packages SET
      description = $1,
      keywords = $2,
      dependencies = $3,
      latest_version = $4,
      latest_release_published_at = $5,
      file_count = $6,
      unpacked_size = $7,
      enriched_at = CURRENT_TIMESTAMP,
      gmt_modified = CURRENT_TIMESTAMP
    WHERE id = $8
  `, [
    metadata.description,
    metadata.keywords,
    metadata.dependencies,
    metadata.latestVersion,
    metadata.latestReleasePublishedAt,
    metadata.fileCount,
    metadata.unpackedSize,
    id,
  ]);
}

// Fetch package metadata
async function fetchPackageMetadata(packageName) {
  await RATE_LIMITER.wait();

  const url = `${CONFIG.registry}/${encodeURIComponent(packageName).replace('%2F', '/')}`;

  try {
    const result = await urllib.request(url, {
      dataType: 'json',
      timeout: CONFIG.timeout,
      headers: { 'user-agent': CONFIG.userAgent },
      gzip: true,
    });

    if (result.status !== 200) {
      throw new Error(`HTTP ${result.status}`);
    }

    const data = result.data;

    // Extract latest version metadata
    const latestTag = data['dist-tags']?.latest;
    const latestVersion = latestTag ? data.versions?.[latestTag] : null;

    if (!latestVersion) {
      return {
        description: data.description || null,
        keywords: data.keywords || [],
        dependencies: null,
        latestVersion: null,
        latestReleasePublishedAt: null,
        fileCount: 0,
        unpackedSize: 0,
      };
    }

    // Extract data
    const dependencies = latestVersion.dependencies ? JSON.stringify(latestVersion.dependencies) : null;
    const keywords = Array.isArray(data.keywords) ? data.keywords : [];
    const publishedAt = data.time?.[latestTag] ? new Date(data.time[latestTag]) : null;
    const unpackedSize = latestVersion.dist?.unpackedSize || 0;

    // Count files (if available in dist)
    const fileCount = latestVersion.dist?.fileCount || 0;

    return {
      description: data.description || latestVersion.description || null,
      keywords,
      dependencies,
      latestVersion: latestTag,
      latestReleasePublishedAt: publishedAt,
      fileCount,
      unpackedSize,
    };
  } catch (err) {
    logger.error('[Enrich] Error fetching %s: %s', packageName, err.message);
    throw err;
  }
}

// Main enrichment function
async function main() {
  const startTime = Date.now();

  logger.log('═══════════════════════════════════════════════════════');
  logger.log('NPM Package Enrichment v4.0');
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('Registry: %s', CONFIG.registry);
  logger.log('Rate limit: %d req/sec', CONFIG.rateLimit);
  logger.log('Batch size: %d', CONFIG.batchSize);
  if (CONFIG.limit > 0) {
    logger.log('Limit: %d packages', CONFIG.limit);
  }
  logger.log('═══════════════════════════════════════════════════════');

  try {
    await initializeDatabase();

    // Get enrichment stats
    const stats = await getEnrichmentStats();
    logger.log('[Enrich] Total packages: %s', parseInt(stats.total).toLocaleString());
    logger.log('[Enrich] Already enriched: %s', parseInt(stats.enriched).toLocaleString());
    logger.log('[Enrich] Unenriched: %s', parseInt(stats.unenriched).toLocaleString());

    if (parseInt(stats.unenriched) === 0) {
      logger.log('[Enrich] ✓ All packages already enriched!');
      await DB_CONNECTION.disconnect();
      process.exit(0);
    }

    // Process in batches
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;

    while (true) {
      const packages = await getUnenrichedPackages(CONFIG.batchSize);
      
      if (packages.length === 0) break;

      logger.log('[Enrich] Processing batch of %d packages...', packages.length);

      for (const pkg of packages) {
        try {
          const metadata = await fetchPackageMetadata(pkg.name);
          await updatePackageEnrichment(pkg.id, metadata);
          totalSuccess++;
          
          if (totalSuccess % 100 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = totalSuccess / elapsed;
            const remaining = parseInt(stats.unenriched) - totalSuccess;
            const eta = remaining / rate / 60;
            
            logger.log('[Enrich] Progress: %d/%s (%.1f%%) | Rate: %.1f pkg/sec | ETA: %.1f min',
              totalSuccess,
              parseInt(stats.unenriched).toLocaleString(),
              (totalSuccess / parseInt(stats.unenriched) * 100),
              rate,
              eta);
          }
        } catch (err) {
          totalFailed++;
          logger.error('[Enrich] Failed: %s', pkg.name);
        }

        totalProcessed++;

        if (CONFIG.limit > 0 && totalProcessed >= CONFIG.limit) {
          logger.log('[Enrich] Reached limit of %d packages', CONFIG.limit);
          break;
        }
      }

      if (CONFIG.limit > 0 && totalProcessed >= CONFIG.limit) break;
    }

    await DB_CONNECTION.disconnect();

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    logger.log('═══════════════════════════════════════════════════════');
    logger.log('✓✓✓ ENRICHMENT COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('Duration: %s minutes', duration);
    logger.log('Processed: %d', totalProcessed);
    logger.log('Success: %d', totalSuccess);
    logger.log('Failed: %d', totalFailed);
    logger.log('═══════════════════════════════════════════════════════');

    process.exit(0);
  } catch (err) {
    logger.error('✗✗✗ ENRICHMENT FAILED ✗✗✗');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = main;

