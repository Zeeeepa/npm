'use strict';

/**
 * NPM Registry CSV Exporter - Stream from Database
 * Author: Zeeeepa
 * 
 * PURPOSE:
 * - Stream all packages from PostgreSQL database
 * - Generate CSV with enriched metadata
 * - Memory efficient streaming (no loading entire dataset)
 * - Always confirms data from database (not from code logic)
 * 
 * CSV FORMAT:
 *   number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,
 *   latest_release_published_at,description,keywords
 * 
 * USAGE:
 *   DB_URL=postgres://user:pass@localhost/cnpm node scripts/indexer/export-csv.js
 *   
 *   Optional:
 *     OUTPUT_FILE=./packages.csv node scripts/indexer/export-csv.js
 */

const { Client } = require('pg');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const CONFIG = {
  dbUrl: process.env.DB_URL || 'postgres://localhost/cnpm',
  outputFile: process.env.OUTPUT_FILE || './data/packages.csv',
  batchSize: parseInt(process.env.EXPORT_BATCH_SIZE) || 1000,
};

// ============================================================================
// CSV Formatter
// ============================================================================

function escapeCSV(value) {
  if (value === null || value === undefined) {
    return '';
  }
  
  const str = String(value);
  
  // If contains comma, quotes, or newlines, wrap in quotes and escape internal quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  
  return str;
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ============================================================================
// Streaming CSV Writer Transform
// ============================================================================

class CSVWriterTransform extends Transform {
  constructor(options) {
    super({ ...options, objectMode: true });
    this.rowNumber = 0;
    this.headerWritten = false;
  }
  
  _transform(row, encoding, callback) {
    try {
      // Write header on first row
      if (!this.headerWritten) {
        const header = 'number,npm_url,package_name,file_number,unpacked_size,dependencies,dependents,latest_release_published_at,description,keywords\n';
        this.push(header);
        this.headerWritten = true;
      }
      
      this.rowNumber++;
      
      // Format CSV row
      const csvRow = [
        this.rowNumber,
        `https://www.npmjs.com/package/${encodeURIComponent(row.name)}`,
        escapeCSV(row.name),
        row.file_count || 0,
        row.unpacked_size || 0,
        row.dependencies_count || 0,
        row.dependents_count || 0,
        formatDate(row.publish_time),
        escapeCSV(row.description || ''),
        escapeCSV(row.keywords || ''),
      ].join(',') + '\n';
      
      this.push(csvRow);
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

// ============================================================================
// Streaming Database Reader
// ============================================================================

async function* streamPackagesFromDb(client) {
  const batchSize = CONFIG.batchSize;
  let offset = 0;
  let hasMore = true;
  
  while (hasMore) {
    // Query with LEFT JOIN to get enrichment data
    // Also compute dependents count with subquery
    const result = await client.query(`
      SELECT 
        p.name,
        e.file_count,
        e.unpacked_size,
        e.dependencies_count,
        e.publish_time,
        e.description,
        e.keywords,
        (
          SELECT COUNT(DISTINCT pd.package_version_id)
          FROM package_deps pd
          WHERE pd.name = p.name
        ) as dependents_count
      FROM packages p
      LEFT JOIN package_enrichment e ON p.package_id = e.package_id
      ORDER BY p.id
      LIMIT $1 OFFSET $2
    `, [batchSize, offset]);
    
    if (result.rows.length === 0) {
      hasMore = false;
      break;
    }
    
    for (const row of result.rows) {
      yield row;
    }
    
    offset += result.rows.length;
    
    // Progress logging
    if (offset % 10000 === 0) {
      console.log('[%s] [EXPORT] Streamed %d packages...',
        new Date().toISOString(), offset);
    }
  }
}

// ============================================================================
// Main Export Function
// ============================================================================

async function exportCSV() {
  const startTime = Date.now();
  
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry CSV Exporter - Stream from Database', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Configuration:', new Date().toISOString());
  console.log('[%s]   Database: %s', new Date().toISOString(), CONFIG.dbUrl);
  console.log('[%s]   Output file: %s', new Date().toISOString(), CONFIG.outputFile);
  console.log('[%s]   Batch size: %d', new Date().toISOString(), CONFIG.batchSize);
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  
  const client = new Client({ connectionString: CONFIG.dbUrl });
  
  try {
    await client.connect();
    console.log('[%s] [DB] ✓ Connected to database', new Date().toISOString());
    
    // Get total count for progress
    const countResult = await client.query('SELECT COUNT(*) as count FROM packages');
    const totalCount = parseInt(countResult.rows[0].count, 10);
    
    console.log('[%s] [EXPORT] Total packages to export: %s',
      new Date().toISOString(), totalCount.toLocaleString());
    
    // Ensure output directory exists
    const outputDir = require('path').dirname(CONFIG.outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Create write stream
    const writeStream = fs.createWriteStream(CONFIG.outputFile);
    const csvTransform = new CSVWriterTransform();
    
    console.log('[%s] [EXPORT] Starting streaming export...', new Date().toISOString());
    
    // Stream packages from database through CSV formatter to file
    const packagesGenerator = streamPackagesFromDb(client);
    
    // Manually pipe async generator through transform to write stream
    let rowCount = 0;
    for await (const row of packagesGenerator) {
      if (!csvTransform.write(row)) {
        // Wait for drain if buffer is full
        await new Promise(resolve => csvTransform.once('drain', resolve));
      }
      rowCount++;
    }
    
    csvTransform.end();
    
    // Pipe transform output to file
    await pipeline(csvTransform, writeStream);
    
    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const throughput = Math.round(rowCount / parseFloat(totalDuration));
    const fileSizeMB = (fs.statSync(CONFIG.outputFile).size / 1024 / 1024).toFixed(2);
    
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ CSV EXPORT COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Duration: %s minutes', new Date().toISOString(), totalDuration);
    console.log('[%s] Rows exported: %s', new Date().toISOString(), rowCount.toLocaleString());
    console.log('[%s] Throughput: %s rows/minute', new Date().toISOString(), throughput.toLocaleString());
    console.log('[%s] File size: %s MB', new Date().toISOString(), fileSizeMB);
    console.log('[%s] Output: %s', new Date().toISOString(), CONFIG.outputFile);
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    
    // Show sample of first 3 rows
    console.log('[%s] [SAMPLE] First 3 rows of CSV:', new Date().toISOString());
    const sample = fs.readFileSync(CONFIG.outputFile, 'utf8').split('\n').slice(0, 4).join('\n');
    console.log(sample);
    
    return {
      success: true,
      rowsExported: rowCount,
      fileSizeMB,
      duration: totalDuration,
      throughput,
      outputFile: CONFIG.outputFile,
    };
    
  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ CSV EXPORT FAILED ✗✗✗', new Date().toISOString());
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
  exportCSV()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = exportCSV;

