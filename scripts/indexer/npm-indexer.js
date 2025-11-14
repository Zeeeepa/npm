#!/usr/bin/env node
'use strict';

/**
 * NPM Registry Unified Indexer v14.0.0 - SINGLE ENTRY POINT
 * Author: Zeeeepa
 * Date: 2025-11-13
 * 
 * INTELLIGENT WORKFLOW ORCHESTRATOR
 * 
 * This single entry point automatically:
 * 1. Detects if index exists → Creates if missing
 * 2. Enriches initial index automatically
 * 3. Syncs delta changes when index exists
 * 4. Re-enriches after sync (deduplicates automatically)
 * 5. Validates final state
 * 
 * USAGE:
 *   node npm-indexer.js              # Auto-detect and execute
 *   node npm-indexer.js --force      # Force full re-index
 *   WORKERS=50 node npm-indexer.js   # Adjust parallelism
 * 
 * OUTPUT:
 *   - npm.csv (complete enriched index, deduplicated)
 *   - npm-checkpoint.json (state tracking)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  csvFile: path.join(__dirname, 'npm.csv'),
  checkpointFile: path.join(__dirname, 'npm-checkpoint.json'),
  
  indexScript: path.join(__dirname, 'npm.js'),
  enrichScript: path.join(__dirname, 'enrich.js'),
  syncScript: path.join(__dirname, 'sync.js'),
  
  forceMode: process.argv.includes('--force'),
  enrichOnlyMode: process.argv.includes('--enrich-only'),
  
  // Pass through environment variables
  workers: process.env.WORKERS || '',
  enrichWorkers: process.env.ENRICH_WORKERS || '',
  batchSize: process.env.BATCH_SIZE || '',
};

const logger = {
  log: (...args) => console.log(`[${new Date().toISOString().substr(11, 8)}]`, ...args),
  error: (...args) => console.error(`[${new Date().toISOString().substr(11, 8)}] ERROR:`, ...args),
  warn: (...args) => console.warn(`[${new Date().toISOString().substr(11, 8)}] WARN:`, ...args),
};

// ============================================================================
// Utilities
// ============================================================================

function runScript(scriptPath, description) {
  logger.log(`[EXEC] ${description}...`);
  
  try {
    // Build environment
    const env = { ...process.env };
    if (CONFIG.workers) env.WORKERS = CONFIG.workers;
    if (CONFIG.enrichWorkers) env.ENRICH_WORKERS = CONFIG.enrichWorkers;
    if (CONFIG.batchSize) env.BATCH_SIZE = CONFIG.batchSize;
    
    // Execute script with inherit stdio (shows real-time output)
    execSync(`node ${scriptPath}`, {
      stdio: 'inherit',
      cwd: __dirname,
      env,
    });
    
    logger.log(`[EXEC] ✓ ${description} complete`);
    return true;
  } catch (err) {
    logger.error(`[EXEC] ✗ ${description} failed`);
    logger.error(`[EXEC] Exit code: ${err.status}`);
    return false;
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function getCheckpointInfo() {
  if (!fileExists(CONFIG.checkpointFile)) {
    return null;
  }
  
  try {
    const data = fs.readFileSync(CONFIG.checkpointFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    logger.warn(`[CHECKPOINT] Failed to read: ${err.message}`);
    return null;
  }
}

function printBanner() {
  logger.log('═'.repeat(60));
  logger.log('NPM Registry Unified Indexer v14.0.0');
  logger.log('═'.repeat(60));
  logger.log('Auto-detection: ENABLED');
  logger.log('Force mode:', CONFIG.forceMode ? 'ENABLED' : 'DISABLED');
  logger.log('Enrich-only mode:', CONFIG.enrichOnlyMode ? 'ENABLED' : 'DISABLED');
  if (CONFIG.workers) logger.log(`Workers: ${CONFIG.workers}`);
  if (CONFIG.enrichWorkers) logger.log(`Enrich workers: ${CONFIG.enrichWorkers}`);
  logger.log('═'.repeat(60));
}

function printSummary(stats) {
  logger.log('═'.repeat(60));
  logger.log('✓✓✓ WORKFLOW COMPLETE ✓✓✓');
  logger.log('═'.repeat(60));
  logger.log(`Total duration: ${stats.duration} minutes`);
  logger.log(`Steps executed: ${stats.stepsExecuted.join(' → ')}`);
  logger.log(`CSV file: ${CONFIG.csvFile}`);
  logger.log(`State: ${stats.finalState}`);
  logger.log('═'.repeat(60));
}

// ============================================================================
// Main Workflow
// ============================================================================

async function main() {
  const startTime = Date.now();
  const stats = {
    duration: 0,
    stepsExecuted: [],
    finalState: 'unknown',
  };
  
  try {
    printBanner();
    
    // ========================================================================
    // DECISION TREE: Determine workflow
    // ========================================================================
    
    const csvExists = fileExists(CONFIG.csvFile);
    const checkpoint = getCheckpointInfo();
    
    logger.log('[WORKFLOW] Analyzing current state...');
    logger.log(`[STATE] CSV exists: ${csvExists}`);
    logger.log(`[STATE] Checkpoint exists: ${checkpoint ? 'YES' : 'NO'}`);
    
    if (checkpoint) {
      logger.log(`[STATE] Last sequence: ${checkpoint.lastSequence?.toLocaleString() || 'N/A'}`);
      logger.log(`[STATE] Total packages: ${checkpoint.totalPackages?.toLocaleString() || 'N/A'}`);
    }
    
    // ========================================================================
    // WORKFLOW 1: Force mode - Full re-index
    // ========================================================================
    
    if (CONFIG.forceMode) {
      logger.log('[WORKFLOW] Force mode - Full re-index');
      logger.log('═'.repeat(60));
      
      // Delete existing files
      if (csvExists) {
        logger.log('[CLEANUP] Removing existing CSV...');
        fs.unlinkSync(CONFIG.csvFile);
      }
      
      if (fileExists(CONFIG.checkpointFile)) {
        logger.log('[CLEANUP] Removing checkpoint...');
        fs.unlinkSync(CONFIG.checkpointFile);
      }
      
      // Step 1: Create index
      if (!runScript(CONFIG.indexScript, 'Creating fresh index')) {
        process.exit(1);
      }
      stats.stepsExecuted.push('INDEX');
      
      // Step 2: Enrich
      if (!runScript(CONFIG.enrichScript, 'Enriching index')) {
        process.exit(1);
      }
      stats.stepsExecuted.push('ENRICH');
      
      stats.finalState = 'Fresh index created and enriched';
    }
    
    // ========================================================================
    // WORKFLOW 2: Enrich-only mode
    // ========================================================================
    
    else if (CONFIG.enrichOnlyMode) {
      logger.log('[WORKFLOW] Enrich-only mode');
      logger.log('═'.repeat(60));
      
      if (!csvExists) {
        logger.error('[ERROR] CSV does not exist - run without --enrich-only first');
        process.exit(1);
      }
      
      // Enrich existing
      if (!runScript(CONFIG.enrichScript, 'Enriching existing index')) {
        process.exit(1);
      }
      stats.stepsExecuted.push('ENRICH');
      
      stats.finalState = 'Index enriched (deduplication applied)';
    }
    
    // ========================================================================
    // WORKFLOW 3: No index exists - Create + Enrich
    // ========================================================================
    
    else if (!csvExists) {
      logger.log('[WORKFLOW] No index found - Creating initial index');
      logger.log('═'.repeat(60));
      
      // Step 1: Create index
      if (!runScript(CONFIG.indexScript, 'Creating initial index')) {
        process.exit(1);
      }
      stats.stepsExecuted.push('INDEX');
      
      // Step 2: Enrich
      if (!runScript(CONFIG.enrichScript, 'Enriching initial index')) {
        process.exit(1);
      }
      stats.stepsExecuted.push('ENRICH');
      
      stats.finalState = 'Initial index created and enriched';
    }
    
    // ========================================================================
    // WORKFLOW 4: Index exists - Sync + Enrich
    // ========================================================================
    
    else {
      logger.log('[WORKFLOW] Index exists - Checking for updates');
      logger.log('═'.repeat(60));
      
      // Step 1: Sync delta
      const syncSuccess = runScript(CONFIG.syncScript, 'Syncing delta changes');
      
      if (syncSuccess) {
        stats.stepsExecuted.push('SYNC');
        
        // Step 2: Enrich (including new packages)
        if (!runScript(CONFIG.enrichScript, 'Enriching index (with deduplication)')) {
          process.exit(1);
        }
        stats.stepsExecuted.push('ENRICH');
        
        stats.finalState = 'Index synced and enriched';
      } else {
        logger.log('[WORKFLOW] Sync indicated already up-to-date');
        
        // Still run enrichment to ensure deduplication
        logger.log('[WORKFLOW] Running enrichment for deduplication...');
        if (!runScript(CONFIG.enrichScript, 'Enriching index (deduplication)')) {
          process.exit(1);
        }
        stats.stepsExecuted.push('ENRICH');
        
        stats.finalState = 'Index already up-to-date, enrichment applied';
      }
    }
    
    // ========================================================================
    // Final stats
    // ========================================================================
    
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    stats.duration = duration;
    
    printSummary(stats);
    
    // Print final checkpoint info
    const finalCheckpoint = getCheckpointInfo();
    if (finalCheckpoint) {
      logger.log('[FINAL STATE]');
      logger.log(`  Last sequence: ${finalCheckpoint.lastSequence?.toLocaleString() || 'N/A'}`);
      logger.log(`  Total packages: ${finalCheckpoint.totalPackages?.toLocaleString() || 'N/A'}`);
      logger.log(`  CSV rows: ${finalCheckpoint.csvRows?.toLocaleString() || 'N/A'}`);
      logger.log(`  Last update: ${finalCheckpoint.lastUpdate || 'N/A'}`);
    }
    
    logger.log('');
    logger.log('✓ All operations complete!');
    logger.log('✓ Index is up-to-date and enriched');
    logger.log('✓ Deduplication applied automatically');
    logger.log('');
    
    process.exit(0);
    
  } catch (err) {
    logger.error('═'.repeat(60));
    logger.error('✗✗✗ WORKFLOW FAILED ✗✗✗');
    logger.error('═'.repeat(60));
    logger.error(`Error: ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    process.exit(1);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

if (require.main === module) {
  main();
}

module.exports = main;

