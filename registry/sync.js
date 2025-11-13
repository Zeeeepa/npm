/**
 * Incremental Sync Module
 * Fetches delta updates from registry since last checkpoint
 */

import axios from 'axios';
import RegistryDB from './db.js';

const REGISTRY_URL = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 10000;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 60000;

class RegistrySync {
  constructor(dbPath = null) {
    this.db = new RegistryDB(dbPath);
    this.stats = {
      packagesAdded: 0,
      packagesUpdated: 0,
      totalChanges: 0,
      startSequence: 0,
      endSequence: 0
    };
  }

  /**
   * Fetch current registry sequence
   * @returns {Promise<number>} - Current max sequence
   */
  async getCurrentSequence() {
    try {
      const response = await axios.get(`${REGISTRY_URL}//`, {
        timeout: REQUEST_TIMEOUT
      });
      return response.data.update_seq;
    } catch (error) {
      console.error('[SYNC] Error fetching current sequence:', error.message);
      throw error;
    }
  }

  /**
   * Fetch changes since a specific sequence
   * @param {number} since - Starting sequence
   * @param {number} limit - Batch size
   * @returns {Promise<object>} - Changes data
   */
  async fetchChanges(since, limit = BATCH_SIZE) {
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
      console.warn(`[SYNC] Request failed, retrying...`);
      await this._sleep(2000);
      
      const response = await axios.get(`${REGISTRY_URL}/_changes`, {
        params: { since, limit, include_docs: false },
        timeout: REQUEST_TIMEOUT
      });
      return response.data;
    }
  }

  /**
   * Process and store changes
   * @param {array} results - Change results
   * @returns {Promise<void>}
   */
  async processChanges(results) {
    const packageNames = new Set();

    for (const change of results) {
      this.stats.totalChanges++;
      packageNames.add(change.id);

      // Update last sequence
      if (change.seq > this.stats.endSequence) {
        this.stats.endSequence = change.seq;
      }
    }

    // Store/update packages in database
    for (const name of packageNames) {
      const existing = this.db.getPackage(name);
      
      if (existing) {
        // Update existing package to 'synced' state
        this.db.updatePackageState(name, 'synced');
        this.stats.packagesUpdated++;
      } else {
        // Insert new package
        this.db.insertPackage(name, 'synced');
        this.stats.packagesAdded++;
      }
    }
  }

  /**
   * Run sync operation
   * @param {object} options - Sync options
   * @returns {Promise<object>} - Sync statistics
   */
  async run(options = {}) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('NPM Registry Sync - Incremental Updates');
    console.log('═══════════════════════════════════════════════════════');
    console.log('[CONFIG] Registry:', REGISTRY_URL);
    console.log('[CONFIG] Batch size:', BATCH_SIZE);
    console.log('═══════════════════════════════════════════════════════');

    const startTime = Date.now();

    // Connect to database
    this.db.connect();

    try {
      // Get last checkpoint
      const checkpoint = this.db.getCheckpoint();
      this.stats.startSequence = checkpoint.update_sequence;

      if (this.stats.startSequence === 0) {
        console.log('[ERROR] No checkpoint found. Run index.js first to create initial index.');
        this.db.close();
        process.exit(1);
      }

      console.log(`[SYNC] Last sync sequence: ${this.stats.startSequence.toLocaleString()}`);

      // Get current registry sequence
      const currentSequence = await this.getCurrentSequence();
      console.log(`[SYNC] Current registry sequence: ${currentSequence.toLocaleString()}`);

      if (currentSequence <= this.stats.startSequence) {
        console.log('[SYNC] Already up to date!');
        this.db.close();
        return {
          ...this.stats,
          upToDate: true
        };
      }

      const changesToSync = currentSequence - this.stats.startSequence;
      console.log(`[SYNC] Changes to sync: ${changesToSync.toLocaleString()}`);
      console.log('═══════════════════════════════════════════════════════');

      // Fetch changes in batches
      let currentSeq = this.stats.startSequence;
      let batchCount = 0;
      let lastReportTime = Date.now();

      while (currentSeq < currentSequence) {
        batchCount++;

        // Fetch batch
        const changesData = await this.fetchChanges(currentSeq, BATCH_SIZE);

        if (!changesData.results || changesData.results.length === 0) {
          break;
        }

        // Process changes
        await this.processChanges(changesData.results);

        // Update current sequence
        currentSeq = changesData.update_seq || this.stats.endSequence;

        // Progress reporting
        const now = Date.now();
        if (this.stats.totalChanges % 5000 === 0 || now - lastReportTime > 5000) {
          const progress = ((currentSeq - this.stats.startSequence) / changesToSync * 100).toFixed(1);
          console.log(
            `[SYNC] Batch ${batchCount} | ` +
            `Changes: ${this.stats.totalChanges.toLocaleString()} | ` +
            `Added: ${this.stats.packagesAdded.toLocaleString()} | ` +
            `Updated: ${this.stats.packagesUpdated.toLocaleString()} | ` +
            `Progress: ${progress}%`
          );
          lastReportTime = now;
        }

        // Small delay
        await this._sleep(10);
      }

      // Update checkpoint
      this.stats.endSequence = currentSeq;
      const totalPackages = this.db.getTotalPackages();
      this.db.updateCheckpoint(this.stats.endSequence, totalPackages);

      // Final statistics
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log('═══════════════════════════════════════════════════════');
      console.log('✓✓✓ SYNC COMPLETE ✓✓✓');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`Duration: ${duration}s`);
      console.log(`Changes processed: ${this.stats.totalChanges.toLocaleString()}`);
      console.log(`Packages added: ${this.stats.packagesAdded.toLocaleString()}`);
      console.log(`Packages updated: ${this.stats.packagesUpdated.toLocaleString()}`);
      console.log(`Sequence: ${this.stats.startSequence.toLocaleString()} → ${this.stats.endSequence.toLocaleString()}`);
      console.log(`Total packages in DB: ${totalPackages.toLocaleString()}`);
      console.log('═══════════════════════════════════════════════════════');
      console.log('\nNext steps:');
      console.log('  1. Run enrich.js to update metadata for new packages');
      console.log('  2. Run csv.js to export updated data');
      console.log('═══════════════════════════════════════════════════════');

      return this.stats;
    } catch (error) {
      console.error('[ERROR] Sync failed:', error);
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
  const sync = new RegistrySync();

  sync.run()
    .then((stats) => {
      if (stats.upToDate) {
        console.log('\n✓ Already up to date');
      } else {
        console.log('\n✓ Sync completed successfully');
      }
      process.exit(0);
    })
    .catch(error => {
      console.error('\n✗ Sync failed:', error);
      process.exit(1);
    });
}

export default RegistrySync;

