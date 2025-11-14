/**
 * Full npm registry indexer using CNPM Chinese mirror
 * CNPM contains ~5.4M packages (vs 3.7M on official npm)
 * Includes all official npm packages + Chinese community packages
 */

import RegistryDB from './db.js';
import axios from 'axios';

// CNPM Chinese mirror - best for complete package coverage
const REGISTRY_URL = 'https://r.cnpmjs.org';
const REGISTRY_API = 'https://registry.npmmirror.com';
const BATCH_SIZE = 1000;

console.log(`\n${'='.repeat(80)}`);
console.log('📦 NPM REGISTRY FULL INDEX - CNPM MIRROR (5.4M+ packages)');
console.log(`${'='.repeat(80)}`);
console.log(`🌏 Using CNPM Chinese mirror: ${REGISTRY_URL}`);
console.log(`📡 API endpoint: ${REGISTRY_API}`);
console.log(`${'='.repeat(80)}\n`);

async function runFullIndex() {
  const db = new RegistryDB('./npm-registry.db');
  db.connect();

  console.log('[INDEX] Starting full registry scan...\n');
  
  const allPackages = new Set();
  let recordCount = 0;
  let lastSeq = 0;

  try {
    // Get total registry size from CNPM
    const rootResponse = await axios.get(`${REGISTRY_API}/`, {
      timeout: 30000
    });
    
    const totalSequence = rootResponse.data.update_seq;
    const totalPackages = rootResponse.data.doc_count;
    
    console.log(`[INDEX] 📊 CNPM Registry Stats:`);
    console.log(`  - Total packages: ${totalPackages.toLocaleString()}`);
    console.log(`  - Update sequence: ${totalSequence.toLocaleString()}`);
    console.log(`  - Last package: ${rootResponse.data.last_package}`);
    console.log();

    // Fetch all changes from CNPM changes feed
    let since = 0;
    const startTime = Date.now();
    
    console.log('[INDEX] Fetching package changes from CNPM...\n');
    
    while (true) {
      const response = await axios.get(`${REGISTRY_URL}/_changes`, {
        params: {
          since,
          limit: BATCH_SIZE
        },
        timeout: 30000
      });

      if (!response.data.results || response.data.results.length === 0) {
        console.log('[INDEX] ✅ Reached end of changes feed');
        break;
      }

      // Collect all package names
      for (const change of response.data.results) {
        if (change.id && !change.id.startsWith('_design/')) {
          allPackages.add(change.id);
        }
        recordCount++;
        lastSeq = change.seq;
      }

      since = response.data.last_seq || lastSeq;
      
      const progress = (recordCount / totalSequence * 100).toFixed(1);
      const rate = Math.round(recordCount / ((Date.now() - startTime) / 1000));
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      
      console.log(`[FETCH] Batch ${Math.ceil(recordCount / BATCH_SIZE)} | Records: ${recordCount.toLocaleString()} | Unique: ${allPackages.size.toLocaleString()} | Progress: ${progress}% | Rate: ${rate}/s | Time: ${elapsed}min`);
    }

    console.log(`\n[INDEX] ✅ Fetch complete!`);
    console.log(`  Total records: ${recordCount.toLocaleString()}`);
    console.log(`  Unique packages: ${allPackages.size.toLocaleString()}`);
    console.log(`  Expected: ${totalPackages.toLocaleString()}`);
    console.log(`  Coverage: ${(allPackages.size / totalPackages * 100).toFixed(1)}%`);

    // Insert all packages into database
    console.log('\n[INDEX] Inserting packages into database...');
    
    let inserted = 0;
    const insertStart = Date.now();
    
    for (const packageName of allPackages) {
      db.insertPackage(packageName, 'indexed');
      inserted++;
      
      if (inserted % 10000 === 0) {
        const insertRate = Math.round(inserted / ((Date.now() - insertStart) / 1000));
        console.log(`[INSERT] ${inserted.toLocaleString()} packages | Rate: ${insertRate}/s`);
      }
    }

    // Update checkpoint
    db.updateCheckpoint(lastSeq, allPackages.size);

    // Show final stats
    const stats = db.getStats();
    const checkpoint = db.getCheckpoint();
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ INDEX COMPLETE!');
    console.log('='.repeat(80));
    console.log(`📦 Total packages indexed: ${stats.total.toLocaleString()}`);
    console.log(`📊 State breakdown:`);
    console.log(`   - Indexed: ${stats.indexed.toLocaleString()}`);
    console.log(`   - Synced: ${stats.synced.toLocaleString()}`);
    console.log(`   - Enriched: ${stats.enriched.toLocaleString()}`);
    console.log(`🔖 Checkpoint: sequence ${checkpoint.last_sequence.toLocaleString()}`);
    console.log(`⏱️  Total duration: ${totalTime} minutes`);
    console.log(`📈 Average rate: ${Math.round(recordCount / (totalTime * 60))}/s`);
    console.log('='.repeat(80));
    console.log('\n💡 Next steps:');
    console.log('   1. Run: node enrich.js --max-age 365  (to enrich recent packages)');
    console.log('   2. Run: node csv.js --state enriched   (to export to CSV)');
    console.log('   3. Run: node sync.js                   (for incremental updates)');

  } catch (error) {
    console.error('[INDEX] ❌ Error:', error.message);
    if (error.response) {
      console.error('[INDEX] Response status:', error.response.status);
      console.error('[INDEX] Response data:', error.response.data);
    }
    throw error;
  } finally {
    db.close();
  }
}

runFullIndex();

