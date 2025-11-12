'use strict';

/**
 * NPM Registry Enricher - Fetch Package Metadata
 * Author: Zeeeepa
 * 
 * PURPOSE:
 * - Fetch full metadata for all packages from registry
 * - Extract: description, keywords, dependencies, file counts, unpacked size
 * - Store in additional database tables for CSV export
 * - Process in batches for memory efficiency
 * 
 * USAGE:
 *   DB_URL=postgres://user:pass@localhost/cnpm node scripts/indexer/enrich.js
 */

const { Client } = require('pg');

const CONFIG = {
  dbUrl: process.env.DB_URL || 'postgres://localhost/cnpm',
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
  batchSize: parseInt(process.env.ENRICH_BATCH_SIZE) || 100,
  concurrency: parseInt(process.env.ENRICH_CONCURRENCY) || 10,
  timeout: 30000,
  maxRetries: 3,
  requestDelay: 50, // Delay between requests to avoid rate limiting
};

// ============================================================================
// Enrichment Schema (Simplified - stores computed metadata)
// ============================================================================

const ENRICH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS package_enrichment (
    id BIGSERIAL PRIMARY KEY,
    gmt_create timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    gmt_modified timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    package_id varchar(24) NOT NULL,
    description text DEFAULT NULL,
    keywords text DEFAULT NULL,
    latest_version varchar(256) DEFAULT NULL,
    publish_time timestamp(3) DEFAULT NULL,
    dependencies_count integer DEFAULT 0,
    file_count integer DEFAULT 0,
    unpacked_size bigint DEFAULT 0,
    CONSTRAINT package_enrichment_uk_package_id UNIQUE (package_id)
  )
`;

async function ensureEnrichmentSchema(client) {
  console.log('[%s] [SCHEMA] Ensuring enrichment schema exists...', new Date().toISOString());
  await client.query(ENRICH_SCHEMA);
  console.log('[%s] [SCHEMA] ✓ Enrichment table ready', new Date().toISOString());
}

// ============================================================================
// Registry API Fetcher
// ============================================================================

async function fetchPackageMetadata(packageName) {
  const url = `${CONFIG.registry}/${encodeURIComponent(packageName)}`;
  
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'npm-enricher/1.0.0',
          'accept': 'application/json',
        },
        signal: AbortSignal.timeout(CONFIG.timeout),
      });
      
      if (response.status === 404) {
        return null; // Package not found
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (err) {
      if (attempt < CONFIG.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('[%s] [FETCH] Failed to fetch %s after %d attempts: %s',
          new Date().toISOString(), packageName, CONFIG.maxRetries, err.message);
        return null;
      }
    }
  }
}

// ============================================================================
// Extract Metadata from Package Document
// ============================================================================

function extractEnrichmentData(pkgData) {
  if (!pkgData) return null;
  
  // Get latest version info
  const distTags = pkgData['dist-tags'] || {};
  const latestVersion = distTags.latest || Object.keys(pkgData.versions || {})[0];
  
  if (!latestVersion) return null;
  
  const versionData = pkgData.versions?.[latestVersion];
  if (!versionData) return null;
  
  // Extract metadata
  const description = versionData.description || pkgData.description || '';
  const keywords = versionData.keywords || pkgData.keywords || [];
  const keywordsStr = Array.isArray(keywords) ? keywords.join(',') : '';
  
  // Dependencies count
  const deps = versionData.dependencies || {};
  const devDeps = versionData.devDependencies || {};
  const dependenciesCount = Object.keys(deps).length + Object.keys(devDeps).length;
  
  // File info from dist
  const dist = versionData.dist || {};
  const unpackedSize = dist.unpackedSize || 0;
  const fileCount = dist.fileCount || 0;
  
  // Publish time
  const time = pkgData.time || {};
  const publishTime = time[latestVersion] || time.modified || time.created;
  
  return {
    description: description.substring(0, 10000), // Truncate if too long
    keywords: keywordsStr.substring(0, 1000),
    latestVersion,
    publishTime: publishTime ? new Date(publishTime) : null,
    dependenciesCount,
    fileCount,
    unpackedSize,
  };
}

// ============================================================================
// Batch Enrichment Processor
// ============================================================================

async function enrichBatch(client, packages) {
  const enriched = [];
  
  // Fetch metadata with concurrency control
  const promises = [];
  for (let i = 0; i < packages.length; i += CONFIG.concurrency) {
    const batch = packages.slice(i, i + CONFIG.concurrency);
    
    const batchPromises = batch.map(async (pkg) => {
      const metadata = await fetchPackageMetadata(pkg.name);
      const enrichment = extractEnrichmentData(metadata);
      
      if (enrichment) {
        return {
          package_id: pkg.package_id,
          ...enrichment,
        };
      }
      return null;
    });
    
    const results = await Promise.all(batchPromises);
    enriched.push(...results.filter(r => r !== null));
    
    // Add delay between concurrent batches
    if (i + CONFIG.concurrency < packages.length && CONFIG.requestDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
    }
  }
  
  if (enriched.length === 0) {
    return 0;
  }
  
  // Insert into database
  const values = [];
  const placeholders = [];
  let paramIndex = 1;
  
  for (const data of enriched) {
    placeholders.push(
      `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`
    );
    values.push(
      data.package_id,
      data.description,
      data.keywords,
      data.latestVersion,
      data.publishTime,
      data.dependenciesCount,
      data.fileCount,
      data.unpackedSize
    );
    paramIndex += 8;
  }
  
  const sql = `
    INSERT INTO package_enrichment (
      package_id, description, keywords, latest_version, publish_time,
      dependencies_count, file_count, unpacked_size
    )
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (package_id) DO UPDATE SET
      description = EXCLUDED.description,
      keywords = EXCLUDED.keywords,
      latest_version = EXCLUDED.latest_version,
      publish_time = EXCLUDED.publish_time,
      dependencies_count = EXCLUDED.dependencies_count,
      file_count = EXCLUDED.file_count,
      unpacked_size = EXCLUDED.unpacked_size,
      gmt_modified = CURRENT_TIMESTAMP
  `;
  
  await client.query(sql, values);
  
  return enriched.length;
}

// ============================================================================
// Main Enrichment Function
// ============================================================================

async function enrich() {
  const startTime = Date.now();
  
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Enricher - Fetch Metadata', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Configuration:', new Date().toISOString());
  console.log('[%s]   Database: %s', new Date().toISOString(), CONFIG.dbUrl);
  console.log('[%s]   Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s]   Batch size: %d', new Date().toISOString(), CONFIG.batchSize);
  console.log('[%s]   Concurrency: %d', new Date().toISOString(), CONFIG.concurrency);
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  
  const client = new Client({ connectionString: CONFIG.dbUrl });
  
  try {
    await client.connect();
    console.log('[%s] [DB] ✓ Connected to database', new Date().toISOString());
    
    // Ensure enrichment schema
    await ensureEnrichmentSchema(client);
    
    // Get total package count
    const countResult = await client.query('SELECT COUNT(*) as count FROM packages');
    const totalCount = parseInt(countResult.rows[0].count, 10);
    
    console.log('[%s] [ENRICH] Total packages to enrich: %s', 
      new Date().toISOString(), totalCount.toLocaleString());
    
    let processed = 0;
    let offset = 0;
    
    while (offset < totalCount) {
      // Fetch batch of packages
      const result = await client.query(
        'SELECT package_id, name FROM packages ORDER BY id LIMIT $1 OFFSET $2',
        [CONFIG.batchSize, offset]
      );
      
      if (result.rows.length === 0) break;
      
      // Enrich this batch
      const enriched = await enrichBatch(client, result.rows);
      processed += enriched;
      offset += result.rows.length;
      
      const progress = (offset / totalCount * 100).toFixed(1);
      const eta = ((Date.now() - startTime) / offset * (totalCount - offset) / 1000 / 60).toFixed(1);
      
      console.log('[%s] [ENRICH] Progress: %d/%d (%s%%) | Enriched: %d | ETA: %s min',
        new Date().toISOString(),
        offset,
        totalCount,
        progress,
        enriched,
        eta
      );
    }
    
    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(processed / parseFloat(totalDuration));
    
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ ENRICHMENT COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), totalDuration);
    console.log('[%s] Packages enriched: %s', new Date().toISOString(), processed.toLocaleString());
    console.log('[%s] Throughput: %s packages/minute', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    
    return {
      success: true,
      packagesEnriched: processed,
      duration: totalDuration,
      throughput,
    };
    
  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ ENRICHMENT FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);
    throw err;
  } finally {
    await client.end();
    console.log('[%s] [DB] ✓ Connection closed', new Date().toISOString());
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
  enrich()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = enrich;

