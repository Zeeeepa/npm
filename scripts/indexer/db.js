'use strict';

/**
 * SQLite Database Manager for NPM Registry Indexer
 * Provides global deduplication and persistent checkpointing
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class IndexDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.insertStmt = null;
    this.metaUpdateStmt = null;
  }

  initialize() {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database with WAL mode for better write performance
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packages (
        name TEXT PRIMARY KEY NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      ) WITHOUT ROWID;
    `);

    // Prepare statements
    this.insertStmt = this.db.prepare('INSERT OR IGNORE INTO packages (name) VALUES (?)');
    this.metaUpdateStmt = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

    console.log('[DB] Initialized at %s', this.dbPath);
    console.log('[DB] Current package count: %d', this.getCount());
  }

  /**
   * Insert packages in a batch transaction
   * @param {string[]} packages - Array of package names
   * @returns {number} - Number of new packages inserted
   */
  insertBatch(packages) {
    if (!packages || packages.length === 0) return 0;

    const insertMany = this.db.transaction((pkgs) => {
      let inserted = 0;
      for (const pkg of pkgs) {
        const result = this.insertStmt.run(pkg);
        inserted += result.changes;
      }
      return inserted;
    });

    return insertMany(packages);
  }

  /**
   * Get total package count
   */
  getCount() {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM packages').get();
    return result.count;
  }

  /**
   * Set metadata value
   */
  setMeta(key, value) {
    this.metaUpdateStmt.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  /**
   * Get metadata value
   */
  getMeta(key) {
    const result = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!result) return null;
    
    try {
      return JSON.parse(result.value);
    } catch {
      return result.value;
    }
  }

  /**
   * Export all packages sorted by rowid for consistent enumeration
   * @param {number} limit - Optional limit for partial export
   * @returns {Array<{name: string, seq: number}>}
   */
  exportPackages(limit = null) {
    // Note: Even WITHOUT ROWID tables in SQLite maintain insertion order via internal rowid
    // We'll use a row_number() window function for consistent ordering
    const sql = limit 
      ? `SELECT name, ROW_NUMBER() OVER (ORDER BY name) as seq FROM packages ORDER BY name LIMIT ?`
      : `SELECT name, ROW_NUMBER() OVER (ORDER BY name) as seq FROM packages ORDER BY name`;
    
    const stmt = limit ? this.db.prepare(sql) : this.db.prepare(sql);
    const rows = limit ? stmt.all(limit) : stmt.all();
    
    return rows;
  }

  /**
   * Stream export for large datasets (memory-efficient)
   */
  *exportPackagesStream(batchSize = 100000) {
    let offset = 0;
    while (true) {
      const batch = this.db.prepare(`
        SELECT name 
        FROM packages 
        ORDER BY name 
        LIMIT ? OFFSET ?
      `).all(batchSize, offset);
      
      if (batch.length === 0) break;
      
      yield batch;
      offset += batch.length;
    }
  }

  /**
   * Check if a package exists
   */
  hasPackage(name) {
    const result = this.db.prepare('SELECT 1 FROM packages WHERE name = ? LIMIT 1').get(name);
    return !!result;
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      console.log('[DB] Closed');
    }
  }

  /**
   * Checkpoint WAL to main database
   */
  checkpoint() {
    this.db.pragma('wal_checkpoint(PASSIVE)');
  }

  /**
   * Get database statistics
   */
  getStats() {
    const countResult = this.db.prepare('SELECT COUNT(*) as count FROM packages').get();
    const sizeResult = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();
    
    return {
      packageCount: countResult.count,
      dbSizeBytes: sizeResult.size,
      dbSizeMB: (sizeResult.size / 1024 / 1024).toFixed(2),
    };
  }
}

module.exports = IndexDB;

