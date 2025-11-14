'use strict';

/**
 * NPM Registry Index Initializer - v4.0.0
 * Author: Zeeeepa
 * Date: 2025-01-12
 * 
 * COMPLETE REWRITE - DUPLICATE-FREE ARCHITECTURE:
 * - Primary: Streaming /-/all endpoint with global SQLite deduplication
 * - Fallback: 100 parallel _changes workers with centralized SQLite dedup
 * - Guaranteed unique packages via SQLite PRIMARY KEY constraint
 * - Deterministic sequential numbering from consistent rowid order
 * - Resume-safe with persistent checkpoints
 * - Memory-efficient streaming for 5.4M+ packages
 * 
 * NO MORE DUPLICATES - NO MORE RACE CONDITIONS
 */

const fetchAll = require('./fetch_all');
const fetchChanges = require('./fetch_changes');

const CONFIG = {
  method: process.env.FETCH_METHOD || 'auto', // 'auto', 'all', 'changes'
  registry: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
};

async function initialize() {
  const startTime = Date.now();

  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] NPM Registry Index Initializer v4.0.0', new Date().toISOString());
  console.log('[%s] Author: Zeeeepa | Duplicate-Free Architecture', new Date().toISOString());
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
  console.log('[%s] Method: %s', new Date().toISOString(), CONFIG.method);
  console.log('[%s] Registry: %s', new Date().toISOString(), CONFIG.registry);
  console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

  try {
    let result;

    if (CONFIG.method === 'changes') {
      console.log('[%s] [INIT] Using parallel _changes workers (forced)', new Date().toISOString());
      result = await fetchChanges();
    } else if (CONFIG.method === 'all') {
      console.log('[%s] [INIT] Using streaming /-/all (forced)', new Date().toISOString());
      result = await fetchAll();
    } else {
      // Auto-detect: try /-/all first, fallback to _changes
      console.log('[%s] [INIT] Auto-detect: trying /-/all first...', new Date().toISOString());
      try {
        result = await fetchAll();
      } catch (err) {
        console.warn('[%s] [INIT] /-/all failed: %s', new Date().toISOString(), err.message);
        console.log('[%s] [INIT] Falling back to parallel _changes workers...', new Date().toISOString());
        result = await fetchChanges();
      }
    }

    const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] ✓✓✓ INITIALIZATION COMPLETE ✓✓✓', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Total duration: %s minutes', new Date().toISOString(), totalDuration);
    console.log('[%s] Unique packages: %s', new Date().toISOString(), result.totalPackages.toLocaleString());
    console.log('[%s] Database size: %s MB', new Date().toISOString(), result.dbSizeMB);
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.log('[%s] Next step: Run "npm run export" to generate JSON output', new Date().toISOString());
    console.log('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());

    return {
      success: true,
      totalDuration,
      ...result,
    };

  } catch (err) {
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] ✗✗✗ INITIALIZATION FAILED ✗✗✗', new Date().toISOString());
    console.error('[%s] ═══════════════════════════════════════════════════════', new Date().toISOString());
    console.error('[%s] Error: %s', new Date().toISOString(), err.message);
    console.error('[%s] Stack: %s', new Date().toISOString(), err.stack);
    throw err;
  }
}

// CLI entry point
if (require.main === module) {
  initialize()
    .then(() => {
      console.log('[%s] Exiting with success', new Date().toISOString());
      process.exit(0);
    })
    .catch(() => {
      console.error('[%s] Exiting with error', new Date().toISOString());
      process.exit(1);
    });
}

module.exports = initialize;

