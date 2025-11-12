'use strict';

/**
 * NPM Package CSV Exporter
 * Streams enriched package data from PostgreSQL to CSV
 * 
 * Usage: node export-csv.js [--db-config=./db-config.json] [--output=./npm-packages.csv]
 */

const fs = require('fs');
const { createConnection } = require('./lib/db-connection');
const { createObjectCsvWriter } = require('csv-writer');

const logger = console;

// Configuration
const CONFIG = {
  dbConfig: process.argv.find(arg => arg.startsWith('--db-config='))?.split('=')[1] || null,
  output: process.argv.find(arg => arg.startsWith('--output='))?.split('=')[1] || './npm-packages.csv',
};

let DB_CONNECTION = null;

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

// Stream packages from database
async function* streamPackages() {
  const batchSize = 1000;
  let offset = 0;

  while (true) {
    const packages = await DB_CONNECTION.query(`
      SELECT 
        seq,
        name,
        description,
        keywords,
        dependencies,
        latest_version,
        latest_release_published_at,
        file_count,
        unpacked_size,
        dependents_count,
        enriched_at
      FROM packages
      WHERE enriched_at IS NOT NULL
      ORDER BY seq
      LIMIT ${batchSize} OFFSET ${offset}
    `);

    if (packages.length === 0) break;

    for (const pkg of packages) {
      yield pkg;
    }

    offset += batchSize;
  }
}

// Transform package data for CSV
function transformPackage(pkg) {
  // Generate npm URL
  const npmUrl = `https://www.npmjs.com/package/${pkg.name}`;

  // Count dependencies
  const dependenciesCount = pkg.dependencies ? Object.keys(JSON.parse(pkg.dependencies)).length : 0;

  // Format keywords
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.join(',') : '';

  // Format date
  const publishedAt = pkg.latest_release_published_at 
    ? new Date(pkg.latest_release_published_at).toISOString().split('T')[0]
    : '';

  return {
    number: pkg.seq + 1, // 1-based for CSV
    npm_url: npmUrl,
    package_name: pkg.name,
    file_number: pkg.file_count || 0,
    unpacked_size: pkg.unpacked_size || 0,
    dependencies: dependenciesCount,
    dependents: pkg.dependents_count || 0,
    latest_release_published_at: publishedAt,
    description: (pkg.description || '').replace(/[\r\n]+/g, ' ').trim(),
    keywords: keywords,
  };
}

// Main export function
async function main() {
  const startTime = Date.now();

  logger.log('═══════════════════════════════════════════════════════');
  logger.log('NPM Package CSV Exporter v4.0');
  logger.log('═══════════════════════════════════════════════════════');
  logger.log('Output: %s', CONFIG.output);
  logger.log('═══════════════════════════════════════════════════════');

  try {
    await initializeDatabase();

    // Get total count
    const countResult = await DB_CONNECTION.query('SELECT COUNT(*) AS count FROM packages WHERE enriched_at IS NOT NULL');
    const totalPackages = parseInt(countResult[0].count);
    logger.log('[Export] Total enriched packages: %s', totalPackages.toLocaleString());

    if (totalPackages === 0) {
      logger.log('[Export] No enriched packages to export. Run enrich.js first.');
      await DB_CONNECTION.disconnect();
      process.exit(0);
    }

    // Initialize CSV writer
    const csvWriter = createObjectCsvWriter({
      path: CONFIG.output,
      header: [
        { id: 'number', title: 'number' },
        { id: 'npm_url', title: 'npm_url' },
        { id: 'package_name', title: 'package_name' },
        { id: 'file_number', title: 'file_number' },
        { id: 'unpacked_size', title: 'unpacked_size' },
        { id: 'dependencies', title: 'dependencies' },
        { id: 'dependents', title: 'dependents' },
        { id: 'latest_release_published_at', title: 'latest_release_published_at' },
        { id: 'description', title: 'description' },
        { id: 'keywords', title: 'keywords' },
      ],
    });

    // Stream and write packages
    let exported = 0;
    const batch = [];
    const batchSize = 100;

    for await (const pkg of streamPackages()) {
      batch.push(transformPackage(pkg));

      if (batch.length >= batchSize) {
        await csvWriter.writeRecords(batch);
        exported += batch.length;
        batch.length = 0;

        if (exported % 10000 === 0) {
          const progress = (exported / totalPackages * 100).toFixed(1);
          logger.log('[Export] Progress: %d/%s (%s%%)', exported, totalPackages.toLocaleString(), progress);
        }
      }
    }

    // Write remaining records
    if (batch.length > 0) {
      await csvWriter.writeRecords(batch);
      exported += batch.length;
    }

    await DB_CONNECTION.disconnect();

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const fileSize = fs.statSync(CONFIG.output).size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.log('═══════════════════════════════════════════════════════');
    logger.log('✓✓✓ EXPORT COMPLETE ✓✓✓');
    logger.log('═══════════════════════════════════════════════════════');
    logger.log('Duration: %s minutes', duration);
    logger.log('Exported: %d packages', exported);
    logger.log('File size: %s MB', fileSizeMB);
    logger.log('Output: %s', CONFIG.output);
    logger.log('═══════════════════════════════════════════════════════');

    process.exit(0);
  } catch (err) {
    logger.error('✗✗✗ EXPORT FAILED ✗✗✗');
    logger.error('Error: %s', err.message);
    logger.error('Stack: %s', err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = main;

