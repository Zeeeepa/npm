/**
 * Metadata Enrichment Module
 * Fetches full package metadata and stores in database
 */

import axios from 'axios';
import RegistryDB from './db.js';

const REGISTRY_URL = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const BATCH_SIZE = parseInt(process.env.ENRICH_BATCH_SIZE) || 100;
const CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY) || 10;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000;
const REQUEST_DELAY = parseInt(process.env.REQUEST_DELAY) || 5;

class MetadataEnricher {
  constructor(dbPath = null) {
    this.db = new RegistryDB(dbPath);
    this.stats = {
      total: 0,
      enriched: 0,
      failed: 0,
      skipped: 0
    };
  }

  /**
   * Fetch package metadata from registry
   * @param {string} packageName - Package name
   * @returns {Promise<object|null>} - Package metadata or null
   */
  async fetchPackageMetadata(packageName) {
    try {
      const response = await axios.get(
        `${REGISTRY_URL}/${encodeURIComponent(packageName)}`,
        {
          timeout: REQUEST_TIMEOUT,
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`[ENRICH] Package not found: ${packageName}`);
        return null;
      }
      
      // Retry once for network errors
      try {
        await this._sleep(1000);
        const response = await axios.get(
          `${REGISTRY_URL}/${encodeURIComponent(packageName)}`,
          { timeout: REQUEST_TIMEOUT }
        );
        return response.data;
      } catch (retryError) {
        console.error(`[ENRICH] Failed to fetch ${packageName}:`, retryError.message);
        return null;
      }
    }
  }

  /**
   * Extract metadata from package data
   * @param {object} packageData - Raw package data
   * @param {string} packageName - Package name
   * @returns {object} - Extracted metadata
   */
  extractMetadata(packageData, packageName) {
    if (!packageData) {
      return {
        name: packageName,
        description: null,
        keywords: null,
        latest_version: null,
        publish_time: null,
        dependencies_count: 0,
        file_count: 0,
        unpacked_size: 0,
        npm_url: `https://www.npmjs.com/package/${packageName}`
      };
    }

    // Get latest version info
    const distTags = packageData['dist-tags'] || {};
    const latestVersion = distTags.latest;
    
    const versions = packageData.versions || {};
    const latestVersionData = latestVersion ? versions[latestVersion] : null;

    // Extract fields
    const description = packageData.description || latestVersionData?.description || null;
    const keywords = packageData.keywords || latestVersionData?.keywords || [];
    const keywordsStr = Array.isArray(keywords) ? keywords.join(',') : '';

    // Publish time
    const time = packageData.time || {};
    const publishTime = latestVersion && time[latestVersion] 
      ? time[latestVersion] 
      : time.modified || time.created || null;

    // Dependencies count
    const dependencies = latestVersionData?.dependencies || {};
    const dependenciesCount = Object.keys(dependencies).length;

    // File count and size
    const dist = latestVersionData?.dist || {};
    const fileCount = dist.fileCount || 0;
    const unpackedSize = dist.unpackedSize || 0;

    return {
      name: packageName,
      description: description ? description.substring(0, 10000) : null, // Limit length
      keywords: keywordsStr.substring(0, 1000) || null, // Limit length
      latest_version: latestVersion || null,
      publish_time: publishTime,
      dependencies_count: dependenciesCount,
      file_count: fileCount,
      unpacked_size: unpackedSize,
      npm_url: `https://www.npmjs.com/package/${packageName}`
    };
  }

  /**
   * Check if package meets age criteria
   * @param {object} packageData - Full package data from registry
   * @param {number} maxAgeDays - Maximum age in days (0 = no filter)
   * @returns {boolean} - True if package meets criteria
   */
  checkPackageAge(packageData, maxAgeDays) {
    if (maxAgeDays === 0) return true; // No age filter
    
    try {
      const latestVersion = packageData['dist-tags']?.latest;
      if (!latestVersion || !packageData.time?.[latestVersion]) {
        return false; // Skip if no publish date
      }
      
      const publishDate = new Date(packageData.time[latestVersion]);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
      
      return publishDate >= cutoffDate;
    } catch (error) {
      return false;
    }
  }

  /**
   * Enrich single package
   * @param {object} pkg - Package record
   * @param {number} maxAgeDays - Maximum age filter (0 = no filter)
   * @returns {Promise<boolean>} - Success status
   */
  async enrichPackage(pkg, maxAgeDays = 0) {
    try {
      // Fetch package metadata
      const packageData = await this.fetchPackageMetadata(pkg.name);
      
      // Check age filter if specified
      if (maxAgeDays > 0 && !this.checkPackageAge(packageData, maxAgeDays)) {
        this.stats.skipped++;
        return false; // Skip old packages
      }
      
      // Extract metadata
      const metadata = this.extractMetadata(packageData, pkg.name);
      
      // Store metadata
      this.db.storeMetadata(pkg.id, metadata);
      
      // Update package state to enriched
      this.db.updatePackageState(pkg.name, 'enriched');
      
      this.stats.enriched++;
      return true;
    } catch (error) {
      console.error(`[ENRICH] Error enriching ${pkg.name}:`, error.message);
      this.stats.failed++;
      return false;
    }
  }

  /**
   * Enrich packages in batches with concurrency control
   * @param {array} packages - Array of package records
   * @param {number} maxAgeDays - Maximum age filter (0 = no filter)
   * @returns {Promise<void>}
   */
  async enrichBatch(packages, maxAgeDays = 0) {
    const promises = [];
    
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      
      // Add to promises pool
      const promise = this.enrichPackage(pkg, maxAgeDays).then(() => {
        // Small delay between requests
        return this._sleep(REQUEST_DELAY);
      });
      
      promises.push(promise);

      // Wait when reaching concurrency limit
      if (promises.length >= CONCURRENCY) {
        await Promise.race(promises);
        // Remove completed promises
        const settled = await Promise.allSettled(promises);
        promises.length = 0;
        promises.push(...settled.filter(p => p.status === 'pending').map(p => p.value));
      }
    }

    // Wait for remaining promises
    await Promise.allSettled(promises);
  }

  /**
   * Run enrichment process
   * @param {object} options - Enrichment options
   * @returns {Promise<object>} - Enrichment statistics
   */
  async run(options = {}) {
    const {
      targetStates = ['indexed', 'synced'],
      resumeFrom = 0,
      maxAgeDays = 0  // 0 = no filter, >0 = only packages published within last N days
    } = options;

    console.log('═══════════════════════════════════════════════════════');
    console.log('NPM Registry Enricher - Metadata Collection');
    console.log('═══════════════════════════════════════════════════════');
    console.log('[CONFIG] Registry:', REGISTRY_URL);
    console.log('[CONFIG] Batch size:', BATCH_SIZE);
    console.log('[CONFIG] Concurrency:', CONCURRENCY);
    console.log('[CONFIG] Target states:', targetStates.join(', '));
    if (maxAgeDays > 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
      console.log(`[CONFIG] Age filter: ${maxAgeDays} days (packages after ${cutoffDate.toISOString().split('T')[0]})`);
    } else {
      console.log('[CONFIG] Age filter: DISABLED (all packages)');
    }
    console.log('═══════════════════════════════════════════════════════');

    const startTime = Date.now();

    // Connect to database
    this.db.connect();

    try {
      // Count packages to enrich
      let totalToEnrich = 0;
      for (const state of targetStates) {
        totalToEnrich += this.db.getPackageCountByState(state);
      }

      if (totalToEnrich === 0) {
        console.log('[ENRICH] No packages to enrich!');
        console.log('[ENRICH] All packages are already enriched or database is empty.');
        this.db.close();
        return this.stats;
      }

      console.log(`[ENRICH] Total packages to enrich: ${totalToEnrich.toLocaleString()}`);
      console.log('═══════════════════════════════════════════════════════');

      // Process in batches
      let offset = resumeFrom;
      let lastReportTime = Date.now();
      let batchCount = 0;

      while (offset < totalToEnrich) {
        batchCount++;

        // Fetch batch (try each state)
        let batch = [];
        for (const state of targetStates) {
          const stateBatch = this.db.getPackagesByState(state, BATCH_SIZE, 0);
          batch = batch.concat(stateBatch);
          if (batch.length >= BATCH_SIZE) break;
        }

        if (batch.length === 0) {
          break;
        }

        // Enrich batch
        await this.enrichBatch(batch, maxAgeDays);

        this.stats.total += batch.length;
        offset += batch.length;

        // Progress reporting
        const now = Date.now();
        if (now - lastReportTime > 5000 || this.stats.total % (BATCH_SIZE * 5) === 0) {
          const elapsed = (now - startTime) / 1000;
          const rate = Math.round(this.stats.total / elapsed);
          const progress = ((this.stats.total / totalToEnrich) * 100).toFixed(1);
          const eta = totalToEnrich > this.stats.total 
            ? ((totalToEnrich - this.stats.total) / rate / 60).toFixed(1)
            : 0;

          console.log(
            `[ENRICH] Batch ${batchCount} | ` +
            `Progress: ${this.stats.total.toLocaleString()}/${totalToEnrich.toLocaleString()} (${progress}%) | ` +
            `Enriched: ${this.stats.enriched.toLocaleString()} | ` +
            `Failed: ${this.stats.failed.toLocaleString()} | ` +
            `Rate: ${rate}/s | ` +
            `ETA: ${eta} min`
          );

          lastReportTime = now;
        }
      }

      // Final statistics
      const duration = ((Date.now() - startTime) / 60000).toFixed(2);
      const dbStats = this.db.getStats();

      console.log('═══════════════════════════════════════════════════════');
      console.log('✓✓✓ ENRICHMENT COMPLETE ✓✓✓');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`Duration: ${duration} minutes`);
      console.log(`Packages processed: ${this.stats.total.toLocaleString()}`);
      console.log(`Successfully enriched: ${this.stats.enriched.toLocaleString()}`);
      console.log(`Failed: ${this.stats.failed.toLocaleString()}`);
      console.log(`Success rate: ${((this.stats.enriched / this.stats.total) * 100).toFixed(1)}%`);
      console.log('\nDatabase state:');
      console.log(`  Total packages: ${dbStats.total.toLocaleString()}`);
      console.log(`  Indexed: ${dbStats.indexed.toLocaleString()}`);
      console.log(`  Synced: ${dbStats.synced.toLocaleString()}`);
      console.log(`  Enriched: ${dbStats.enriched.toLocaleString()}`);
      console.log('═══════════════════════════════════════════════════════');
      console.log('\nNext steps:');
      console.log('  1. Run csv.js to export enriched data to CSV');
      console.log('  2. Use filters to export specific subsets');
      console.log('═══════════════════════════════════════════════════════');

      return this.stats;
    } catch (error) {
      console.error('[ERROR] Enrichment failed:', error);
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
  const enricher = new MetadataEnricher();

  // Parse CLI arguments
  const args = process.argv.slice(2);
  let options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node enrich.js [options]

Options:
  --resume-from <offset>    Resume from specific offset (default: 0)
  --max-age <days>          Only enrich packages published within last N days (default: 0 = all)
  --help, -h                Show this help message

Environment Variables:
  NPM_REGISTRY              Registry URL (default: https://registry.npmmirror.com)
  ENRICH_BATCH_SIZE         Batch size (default: 100)
  ENRICH_CONCURRENCY        Concurrent requests (default: 10)
  REQUEST_TIMEOUT           Request timeout in ms (default: 30000)
  REQUEST_DELAY             Delay between requests in ms (default: 5)

Examples:
  node enrich.js
  node enrich.js --resume-from 10000
  node enrich.js --max-age 365
  ENRICH_CONCURRENCY=20 node enrich.js
      `);
      process.exit(0);
    }

    if (args[i] === '--resume-from' && args[i + 1]) {
      options.resumeFrom = parseInt(args[i + 1]);
      i++;
    }
  }

  enricher.run(options)
    .then(() => {
      console.log('\n✓ Enrichment completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n✗ Enrichment failed:', error);
      process.exit(1);
    });
}

export default MetadataEnricher;
