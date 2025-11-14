'use strict';

/**
 * NPM Registry Index Exporter
 * Exports SQLite database to JSON format: [["package-name", seq], ...]
 * Uses streaming to handle large datasets efficiently
 */

const fs = require('fs');
const path = require('path');
const IndexDB = require('./db');

const CONFIG = {
  dbPath: process.env.DB_PATH || './data/index.db',
  outputDir: process.env.OUTPUT_DIR || './data',
  indexFile: 'package-index.json',
  metadataFile: 'index-metadata.json',
  exportLimit: parseInt(process.env.EXPORT_LIMIT) || 0,
  streamBatchSize: parseInt(process.env.STREAM_BATCH_SIZE) || 100000,
};

async function exportJSON() {
  const startTime = Date.now();

  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Index Exporter', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Database: %s', new Date().toISOString(), CONFIG.dbPath);
  console.log('[%s] Output: %s', new Date().toISOString(), path.join(CONFIG.outputDir, CONFIG.indexFile));
  if (CONFIG.exportLimit > 0) {
    console.log('[%s] Export limit: %s (PARTIAL EXPORT)', new Date().toISOString(), CONFIG.exportLimit.toLocaleString());
  }
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

  // Initialize database
  const db = new IndexDB(CONFIG.dbPath);
  db.initialize();

  const totalCount = db.getCount();
  console.log('[%s] Total packages in database: %s', new Date().toISOString(), totalCount.toLocaleString());

  if (totalCount === 0) {
    console.error('[%s] ✗ Database is empty, nothing to export', new Date().toISOString());
    db.close();
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  const indexPath = path.join(CONFIG.outputDir, CONFIG.indexFile);
  const metadataPath = path.join(CONFIG.outputDir, CONFIG.metadataFile);

  try {
    // Open write stream
    const writeStream = fs.createWriteStream(indexPath, { encoding: 'utf8' });
    writeStream.write('[\n');

    let exportedCount = 0;
    let isFirst = true;

    console.log('[%s] [EXPORT] Streaming packages from database...', new Date().toISOString());

    // Stream packages in batches
    for (const batch of db.exportPackagesStream(CONFIG.streamBatchSize)) {
      for (const row of batch) {
        exportedCount++;

        // Format: ["package-name", seq]
        const entry = [row.name, exportedCount];
        const prefix = isFirst ? '  ' : ',\n  ';
        writeStream.write(prefix + JSON.stringify(entry));
        isFirst = false;

        // Check export limit
        if (CONFIG.exportLimit > 0 && exportedCount >= CONFIG.exportLimit) {
          console.log('[%s] [EXPORT] Limit reached: %s', new Date().toISOString(), CONFIG.exportLimit.toLocaleString());
          break;
        }
      }

      // Progress logging
      if (exportedCount % 500000 === 0) {
        const progress = ((exportedCount / totalCount) * 100).toFixed(1);
        console.log('[%s] [EXPORT] Progress: %s%% (%s / %s)',
          new Date().toISOString(),
          progress,
          exportedCount.toLocaleString(),
          totalCount.toLocaleString()
        );
      }

      if (CONFIG.exportLimit > 0 && exportedCount >= CONFIG.exportLimit) {
        break;
      }
    }

    // Close JSON array
    writeStream.write('\n]\n');
    writeStream.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const throughput = Math.round(exportedCount / parseFloat(duration));

    // Get file size
    const stats = fs.statSync(indexPath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);

    // Get database metadata
    const dbMeta = {
      lastFetchStart: db.getMeta('last_fetch_start'),
      lastFetchEnd: db.getMeta('last_fetch_end'),
      lastFetchDuration: db.getMeta('last_fetch_duration_minutes'),
      lastFetchMethod: db.getMeta('last_fetch_method'),
      registry: db.getMeta('registry'),
    };

    // Create metadata file
    const metadata = {
      timestamp: new Date().toISOString(),
      timestampUnix: Date.now(),
      totalPackages: exportedCount,
      totalInDatabase: totalCount,
      partial: CONFIG.exportLimit > 0,
      exportLimit: CONFIG.exportLimit || null,
      version: '4.0.0',
      method: 'sqlite-streaming-export',
      dataFormat: '["package-name", sequential-number]',
      exportDurationSeconds: duration,
      exportThroughput: throughput,
      fileSizeMB,
      ...dbMeta,
      createdBy: 'Zeeeepa',
      source: 'npm-registry-indexer',
    };

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ EXPORT COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Exported: %s packages', new Date().toISOString(), exportedCount.toLocaleString());
    console.log('[%s] Duration: %s seconds', new Date().toISOString(), duration);
    console.log('[%s] Throughput: %s packages/second', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] File size: %s MB', new Date().toISOString(), fileSizeMB);
    console.log('[%s] Output: %s', new Date().toISOString(), indexPath);
    console.log('[%s] Metadata: %s', new Date().toISOString(), metadataPath);
    if (CONFIG.exportLimit > 0) {
      console.log('[%s] [PARTIAL EXPORT - LIMIT: %s]', new Date().toISOString(), CONFIG.exportLimit.toLocaleString());
    }
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

    db.close();

    return {
      success: true,
      exported: exportedCount,
      totalInDatabase: totalCount,
      duration,
      throughput,
      fileSizeMB,
      outputPath: indexPath,
      metadataPath,
    };

  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ EXPORT FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);

    db.close();
    throw err;
  }
}

// CLI entry point
if (require.main === module) {
  exportJSON()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = exportJSON;

