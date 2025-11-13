/**
 * Initial Registry Indexer
 * Fetches complete npm registry from _changes endpoint
 */

import axios from 'axios';
import RegistryDB from './db.js';

const REGISTRY_URL = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 10000;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 60000;

class RegistryIndexer {
  constructor(dbPath = null) {
    this.db = new RegistryDB(dbPath);
    this.seenPackages = new Set();
    this.stats = {
      totalRecords: 0,
      uniquePackages: 0,
      duplicatesAvoided: 0,
      lastSequence: 0
    };
  }

  /**
   * Fetch registry metadata
   * @returns {Promise<object>} - Registry metadata
   */
  async fetchRegistryInfo() {
    console.log('[INIT] Fetching registry metadata...');
    
    try {
      const response = await axios.get(`${REGISTRY_URL}/`, {
        timeout: REQUEST_TIMEOUT
      });

      const { update_seq } = response.data;
      
      console.log(`[INIT] Registry max sequence: ${update_seq.toLocaleString()}`);
      console.log(`[INIT] Registry doc count: ${response.data.doc_count.toLocaleString()}`);

      
      return { maxSequence: update_seq };
    } catch (error) {
      console.error('[INIT] Error fetching registry info:', error.message);
      throw error;
    }
  }

  /**
   * Fetch changes from registry
   * @param {number} since - Starting sequence number
   * @param {number} limit - Batch size
   * @returns {Promise<object>} - Changes data
   */
  async fetchChanges(since = 0, limit = BATCH_SIZE) {
    try {
      const response = await axios.get(`${REGISTRY_URL}/_changes`, {
        params: {
          since,
          limit,
          include_docs: false
        },
        timeout: REQUEST_TIMEOUT
      });

      return response.data;
    } catch (error) {
      // Retry logic
      console.warn(`[FETCH] Request failed for sequence ${since}, retrying...`);
      await this._sleep(2000);
      
      try {
        const response = await axios.get(`${REGISTRY_URL}/_changes`, {
          params: { since, limit, include_docs: false },
          timeout: REQUEST_TIMEOUT
        });
        return response.data;
      } catch (retryError) {
        console.error(`[FETCH] Retry failed for sequence ${since}:`, retryError.message);
        throw retryError;
      }
    }
  }

  /**
   * Process changes and deduplicate
   * @param {array} results - Changes results
   * @returns {number} - Number of new unique packages
   */
  processChanges(results) {
    let newPackages = 0;

    for (const change of results) {
      this.stats.totalRecords++;
      
      const packageName = change.id;
      
      if (!this.seenPackages.has(packageName)) {
        this.seenPackages.add(packageName);
        newPackages++;
        this.stats.uniquePackages++;
      } else {
        this.stats.duplicatesAvoided++;
      }

      // Update last sequence
      if (change.seq > this.stats.lastSequence) {
        this.stats.lastSequence = change.seq;
      }
    }

    return newPackages;
  }

  /**
   * Store packages in database
   * @param {Set} packages - Set of package names
   * @returns {Promise<number>} - Number of packages stored
   */
  async storePackages(packages) {
    const packageArray = Array.from(packages);
    
    if (packageArray.length === 0) {
      return 0;
    }

    const inserted = this.db.insertPackagesBatch(packageArray, 'indexed');
    return inserted;
  }

  /**
   * Run full index operation
   * @returns {Promise<object>} - Indexing statistics
   */
  async run() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('NPM Registry Indexer - Initial Full Index');
    console.log('═══════════════════════════════════════════════════════');
    console.log('[CONFIG] Registry:', REGISTRY_URL);
    console.log('[CONFIG] Batch size:', BATCH_SIZE);
    console.log('═══════════════════════════════════════════════════════');

    const startTime = Date.now();

    // Connect to database
    this.db.connect();

    // Check if already indexed
    const checkpoint = this.db.getCheckpoint();
    if (checkpoint.update_sequence > 0) {
      console.log(`[WARN] Database already contains ${checkpoint.total_packages} packages`);
      console.log('[WARN] Last sequence:', checkpoint.update_sequence);
      console.log('[WARN] Use sync.js for incremental updates');
      console.log('[WARN] To re-index, delete the database file and run again');
      
      const stats = this.db.getStats();
      console.log('\nCurrent database statistics:');
      console.log('  Total packages:', stats.total);
      console.log('  Indexed:', stats.indexed);
      console.log('  Synced:', stats.synced);
      console.log('  Enriched:', stats.enriched);
      
      this.db.close();
      return stats;
    }

    try {
      // Fetch registry info
      const { maxSequence } = await this.fetchRegistryInfo();

      // Fetch changes in batches
      let currentSequence = 0;
      let batchCount = 0;
      let lastReportTime = Date.now();

      console.log('═══════════════════════════════════════════════════════');
      console.log('[STEP 1/2] FETCHING PACKAGES');
      console.log('═══════════════════════════════════════════════════════');

      while (currentSequence < maxSequence) {
        batchCount++;
        
        // Fetch batch
        const changesData = await this.fetchChanges(currentSequence, BATCH_SIZE);
        
        if (!changesData.results || changesData.results.length === 0) {
          break;
        }

        // Process and deduplicate
        const newPackages = this.processChanges(changesData.results);

        // Update sequence
        currentSequence = changesData.update_seq || this.stats.lastSequence;

        // Progress reporting (every 50k records or 10 seconds)
        const now = Date.now();
        if (this.stats.totalRecords % 50000 === 0 || now - lastReportTime > 10000) {
          const elapsed = (now - startTime) / 1000;
          const rate = Math.round(this.stats.totalRecords / elapsed);
          const progress = ((currentSequence / maxSequence) * 100).toFixed(1);
          
          console.log(
            `[FETCH] Batch ${batchCount} | ` +
            `Records: ${this.stats.totalRecords.toLocaleString()} | ` +
            `Unique: ${this.stats.uniquePackages.toLocaleString()} | ` +
            `Progress: ${progress}% | ` +
            `Rate: ${rate.toLocaleString()}/s`
          );
          
          lastReportTime = now;
        }

        // Small delay to avoid overwhelming the registry
        await this._sleep(10);
      }

      console.log('═══════════════════════════════════════════════════════');
      console.log('[FETCH] Complete!');
      console.log(`[FETCH] Total records seen: ${this.stats.totalRecords.toLocaleString()}`);
      console.log(`[FETCH] Unique packages: ${this.stats.uniquePackages.toLocaleString()}`);
      console.log(`[FETCH] Duplicates avoided: ${this.stats.duplicatesAvoided.toLocaleString()}`);
      console.log(`[FETCH] Deduplication efficiency: ${((this.stats.uniquePackages / this.stats.totalRecords) * 100).toFixed(1)}%`);
      console.log('═══════════════════════════════════════════════════════');

      // Store in database
      console.log('[STEP 2/2] STORING IN DATABASE');
      console.log('═══════════════════════════════════════════════════════');
      
      const storeStartTime = Date.now();
      const inserted = await this.storePackages(this.seenPackages);
      const storeDuration = ((Date.now() - storeStartTime) / 1000).toFixed(2);
      
      console.log(`[DB] Stored ${inserted.toLocaleString()} packages in ${storeDuration}s`);

      // Update checkpoint
      this.db.updateCheckpoint(this.stats.lastSequence, this.stats.uniquePackages);
      console.log(`[DB] Checkpoint updated: sequence=${this.stats.lastSequence}`);

      // Final statistics
      const totalDuration = ((Date.now() - startTime) / 60000).toFixed(2);
      
      console.log('═══════════════════════════════════════════════════════');
      console.log('✓✓✓ INDEXING COMPLETE ✓✓✓');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`Duration: ${totalDuration} minutes`);
      console.log(`Packages indexed: ${this.stats.uniquePackages.toLocaleString()}`);
      console.log(`Final sequence: ${this.stats.lastSequence.toLocaleString()}`);
      console.log(`Throughput: ${Math.round(this.stats.uniquePackages / (totalDuration * 60)).toLocaleString()} packages/second`);
      console.log('═══════════════════════════════════════════════════════');
      console.log('\nNext steps:');
      console.log('  1. Run sync.js for incremental updates');
      console.log('  2. Run enrich.js to add metadata');
      console.log('  3. Run csv.js to export to CSV');
      console.log('═══════════════════════════════════════════════════════');

      return this.stats;
    } catch (error) {
      console.error('[ERROR] Indexing failed:', error);
      throw error;
    } finally {
      this.db.close();
    }
  }

  /**
   * Sleep helper
   * @param {number} ms - Milliseconds to sleep
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const indexer = new RegistryIndexer();
  
  indexer.run()
    .then(() => {
      console.log('\n✓ Indexing completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n✗ Indexing failed:', error);
      process.exit(1);
    });
}

export default RegistryIndexer;

