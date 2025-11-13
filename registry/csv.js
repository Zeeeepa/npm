/**
 * CSV Export Module with Filtering
 * Streams package data from SQLite to CSV with flexible filters
 */

import { stringify } from 'csv-stringify';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import RegistryDB from './db.js';

class CSVExporter {
  constructor(dbPath = null) {
    this.db = new RegistryDB(dbPath);
  }

  /**
   * Export packages to CSV with optional filters
   * @param {object} options - Export options
   * @param {object} options.filters - Filter criteria
   * @param {string} options.output - Output file path
   * @returns {Promise<object>} - Export statistics
   */
  async export(options = {}) {
    const {
      filters = {},
      output = './data/packages.csv'
    } = options;

    console.log('═══════════════════════════════════════════════════════');
    console.log('CSV EXPORT - Streaming from SQLite Database');
    console.log('═══════════════════════════════════════════════════════');
    console.log('[EXPORT] Output file:', output);
    console.log('[EXPORT] Filters:', JSON.stringify(filters, null, 2));
    console.log('═══════════════════════════════════════════════════════');

    this.db.connect();

    try {
      // Create streaming query
      const stmt = this.db.queryPackages(filters);
      
      // Create CSV writer
      const csvStringifier = stringify({
        header: true,
        columns: [
          { key: 'number', header: 'number' },
          { key: 'npm_url', header: 'npm_url' },
          { key: 'package_name', header: 'package_name' },
          { key: 'file_count', header: 'file_number' },
          { key: 'unpacked_size', header: 'unpacked_size' },
          { key: 'dependencies', header: 'dependencies' },
          { key: 'dependents', header: 'dependents' },
          { key: 'latest_release_published_at', header: 'latest_release_published_at' },
          { key: 'description', header: 'description' },
          { key: 'keywords', header: 'keywords' }
        ],
        quoted: true,
        quoted_empty: true
      });

      // Create write stream
      const writeStream = createWriteStream(output);

      // Progress tracking
      let rowCount = 0;
      let lastReport = Date.now();
      const startTime = Date.now();

      const progressTransform = new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
          rowCount++;
          
          // Report progress every 10k rows or 5 seconds
          const now = Date.now();
          if (rowCount % 10000 === 0 || now - lastReport > 5000) {
            const elapsed = (now - startTime) / 1000;
            const rate = Math.round(rowCount / elapsed);
            console.log(`[EXPORT] Progress: ${rowCount.toLocaleString()} rows (${rate}/s)`);
            lastReport = now;
          }

          callback(null, chunk);
        }
      });

      // Stream data through pipeline
      console.log('[EXPORT] Starting streaming export...');
      
      // Create readable stream from SQL query
      const readableStream = new Transform({
        objectMode: true,
        transform(callback) {
          try {
            const row = stmt.get();
            if (row) {
              this.push(row);
              callback();
            } else {
              this.push(null); // End stream
            }
          } catch (error) {
            callback(error);
          }
        }
      });

      // Iterate statement and push to stream
      const rows = stmt.iterate();
      const rowStream = Transform.from(async function* () {
        for (const row of rows) {
          yield row;
        }
      });

      await pipeline(
        rowStream,
        progressTransform,
        csvStringifier,
        writeStream
      );

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('═══════════════════════════════════════════════════════');
      console.log('✓✓✓ CSV EXPORT COMPLETE ✓✓✓');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`Duration: ${duration}s`);
      console.log(`Rows exported: ${rowCount.toLocaleString()}`);
      console.log(`Output: ${output}`);
      console.log('═══════════════════════════════════════════════════════');

      return {
        rowCount,
        duration: parseFloat(duration),
        output
      };
    } catch (error) {
      console.error('[EXPORT] Error during export:', error);
      throw error;
    } finally {
      this.db.close();
    }
  }

  /**
   * Get available filter examples
   * @returns {object} - Filter examples
   */
  static getFilterExamples() {
    return {
      lastYear: {
        description: 'Packages published in the last year',
        filters: {
          publishedAfter: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        }
      },
      largePackages: {
        description: 'Packages larger than 1MB',
        filters: {
          minSize: 1000000
        }
      },
      withDependencies: {
        description: 'Packages with 5-50 dependencies',
        filters: {
          minDependencies: 5,
          maxDependencies: 50
        }
      },
      scopedPackages: {
        description: 'Only scoped packages (e.g., @babel/core)',
        filters: {
          // Implementation would need scope NOT NULL check
        }
      },
      enrichedOnly: {
        description: 'Only fully enriched packages',
        filters: {
          state: 'enriched'
        }
      },
      noFilters: {
        description: 'Complete export - all packages',
        filters: {}
      }
    };
  }

  /**
   * Print filter examples
   */
  static printFilterExamples() {
    console.log('\n📋 Available Filter Examples:\n');
    const examples = CSVExporter.getFilterExamples();
    
    for (const [key, example] of Object.entries(examples)) {
      console.log(`\n${key}:`);
      console.log(`  ${example.description}`);
      console.log(`  Filters: ${JSON.stringify(example.filters, null, 2)}`);
    }
    console.log('\n');
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const exporter = new CSVExporter();
  
  // Parse CLI arguments for filters
  const args = process.argv.slice(2);
  let filters = {};
  let output = './data/packages.csv';

  // Simple argument parsing
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node csv.js [options]

Options:
  --output <file>              Output CSV file path (default: ./data/packages.csv)
  --published-after <date>     Filter packages published after date (YYYY-MM-DD)
  --published-before <date>    Filter packages published before date (YYYY-MM-DD)
  --min-size <bytes>           Filter packages with minimum size
  --max-size <bytes>           Filter packages with maximum size
  --min-deps <count>           Filter packages with minimum dependencies
  --max-deps <count>           Filter packages with maximum dependencies
  --state <state>              Filter by package state (indexed/synced/enriched)
  --examples                   Show filter examples

Examples:
  node csv.js
  node csv.js --output recent.csv --published-after 2024-01-01
  node csv.js --min-size 1000000 --max-deps 10
  node csv.js --examples
      `);
      process.exit(0);
    }

    if (arg === '--examples') {
      CSVExporter.printFilterExamples();
      process.exit(0);
    }

    if (arg === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    } else if (arg === '--published-after' && args[i + 1]) {
      filters.publishedAfter = args[i + 1];
      i++;
    } else if (arg === '--published-before' && args[i + 1]) {
      filters.publishedBefore = args[i + 1];
      i++;
    } else if (arg === '--min-size' && args[i + 1]) {
      filters.minSize = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--max-size' && args[i + 1]) {
      filters.maxSize = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--min-deps' && args[i + 1]) {
      filters.minDependencies = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--max-deps' && args[i + 1]) {
      filters.maxDependencies = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--state' && args[i + 1]) {
      filters.state = args[i + 1];
      i++;
    }
  }

  // Run export
  exporter.export({ filters, output })
    .then(stats => {
      console.log('\n✓ Export completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n✗ Export failed:', error);
      process.exit(1);
    });
}

export default CSVExporter;

