/**
 * Database Layer for NPM Registry Indexer
 * SQLite-based persistent storage with complete package metadata
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class RegistryDB {
  constructor(dbPath = null) {
    this.dbPath = dbPath || join(__dirname, 'data', 'registry.db');
    this.db = null;
    this._ensureDataDir();
  }

  _ensureDataDir() {
    const dataDir = dirname(this.dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  /**
   * Initialize database connection and create schema
   */
  connect() {
    console.log('[DB] Connecting to database:', this.dbPath);
    
    this.db = new Database(this.dbPath);
    
    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('foreign_keys = ON');
    
    this._createSchema();
    
    console.log('[DB] Connected successfully');
    return this;
  }

  /**
   * Create database schema
   */
  _createSchema() {
    this.db.exec(`
      -- Core packages table
      CREATE TABLE IF NOT EXISTS packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        scope TEXT,
        state TEXT NOT NULL DEFAULT 'indexed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_packages_state ON packages(state);
      CREATE INDEX IF NOT EXISTS idx_packages_name ON packages(name);
      CREATE INDEX IF NOT EXISTS idx_packages_scope ON packages(scope);

      -- Enriched metadata table
      CREATE TABLE IF NOT EXISTS package_metadata (
        package_id INTEGER PRIMARY KEY,
        description TEXT,
        keywords TEXT,
        latest_version TEXT,
        publish_time TIMESTAMP,
        dependencies_count INTEGER DEFAULT 0,
        file_count INTEGER DEFAULT 0,
        unpacked_size INTEGER DEFAULT 0,
        npm_url TEXT,
        FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_metadata_publish_time ON package_metadata(publish_time);
      CREATE INDEX IF NOT EXISTS idx_metadata_unpacked_size ON package_metadata(unpacked_size);
      CREATE INDEX IF NOT EXISTS idx_metadata_dependencies ON package_metadata(dependencies_count);

      -- Sync checkpoint tracking
      CREATE TABLE IF NOT EXISTS sync_checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sequence INTEGER NOT NULL DEFAULT 0,
        last_sync_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_packages INTEGER DEFAULT 0
      );

      -- Insert initial checkpoint if not exists
      INSERT OR IGNORE INTO sync_checkpoint (id, last_sequence, total_packages)
      VALUES (1, 0, 0);
    `);

    console.log('[DB] Schema initialized');
  }

  /**
   * Insert package (or ignore if exists)
   * @param {string} name - Package name
   * @param {string} state - Package state (indexed/synced/enriched)
   * @returns {number|null} - Package ID or null if already exists
   */
  insertPackage(name, state = 'indexed') {
    const scope = name.startsWith('@') ? name.split('/')[0].substring(1) : '';
    
    try {
      const stmt = this.db.prepare(`
        INSERT INTO packages (name, scope, state)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO NOTHING
      `);
      
      const result = stmt.run(name, scope, state);
      
      if (result.changes > 0) {
        return result.lastInsertRowid;
      }
      
      // Package exists, get its ID
      const existing = this.db.prepare('SELECT id FROM packages WHERE name = ?').get(name);
      return existing ? existing.id : null;
    } catch (error) {
      console.error(`[DB] Error inserting package ${name}:`, error.message);
      return null;
    }
  }

  /**
   * Batch insert packages
   * @param {string[]} packageNames - Array of package names
   * @param {string} state - Package state
   * @returns {number} - Number of new packages inserted
   */
  insertPackagesBatch(packageNames, state = 'indexed') {
    const insert = this.db.transaction((names) => {
      let inserted = 0;
      const stmt = this.db.prepare(`
        INSERT INTO packages (name, scope, state)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO NOTHING
      `);

      for (const name of names) {
        const scope = name.startsWith('@') ? name.split('/')[0].substring(1) : '';
        const result = stmt.run(name, scope, state);
        inserted += result.changes;
      }

      return inserted;
    });

    return insert(packageNames);
  }

  /**
   * Update package state
   * @param {string} name - Package name
   * @param {string} newState - New state
   */
  updatePackageState(name, newState) {
    const stmt = this.db.prepare(`
      UPDATE packages 
      SET state = ?, updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `);
    
    return stmt.run(newState, name);
  }

  /**
   * Get package by name
   * @param {string} name - Package name
   * @returns {object|null} - Package record
   */
  getPackage(name) {
    return this.db.prepare(`
      SELECT p.*, m.*
      FROM packages p
      LEFT JOIN package_metadata m ON p.id = m.package_id
      WHERE p.name = ?
    `).get(name);
  }

  /**
   * Get packages by state
   * @param {string} state - Package state
   * @param {number} limit - Max number of records
   * @param {number} offset - Offset for pagination
   * @returns {array} - Array of package records
   */
  getPackagesByState(state, limit = 1000, offset = 0) {
    return this.db.prepare(`
      SELECT * FROM packages
      WHERE state = ?
      ORDER BY id
      LIMIT ? OFFSET ?
    `).all(state, limit, offset);
  }

  /**
   * Store enriched metadata for package
   * @param {number} packageId - Package ID
   * @param {object} metadata - Metadata object
   */
  storeMetadata(packageId, metadata) {
    const stmt = this.db.prepare(`
      INSERT INTO package_metadata (
        package_id, description, keywords, latest_version,
        publish_time, dependencies_count, file_count,
        unpacked_size, npm_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        description = excluded.description,
        keywords = excluded.keywords,
        latest_version = excluded.latest_version,
        publish_time = excluded.publish_time,
        dependencies_count = excluded.dependencies_count,
        file_count = excluded.file_count,
        unpacked_size = excluded.unpacked_size,
        npm_url = excluded.npm_url
    `);

    return stmt.run(
      packageId,
      metadata.description || null,
      metadata.keywords || null,
      metadata.latest_version || null,
      metadata.publish_time || null,
      metadata.dependencies_count || 0,
      metadata.file_count || 0,
      metadata.unpacked_size || 0,
      metadata.npm_url || `https://www.npmjs.com/package/${metadata.name || ''}`
    );
  }

  /**
   * Query packages with filters for CSV export
   * @param {object} filters - Filter options
   * @returns {Statement} - Prepared statement for streaming
   */
  queryPackages(filters = {}) {
    let whereConditions = [];
    let params = [];

    // Filter by publish date
    if (filters.publishedAfter) {
      whereConditions.push('m.publish_time >= ?');
      params.push(filters.publishedAfter);
    }
    
    if (filters.publishedBefore) {
      whereConditions.push('m.publish_time <= ?');
      params.push(filters.publishedBefore);
    }

    // Filter by size
    if (filters.minSize) {
      whereConditions.push('m.unpacked_size >= ?');
      params.push(filters.minSize);
    }

    if (filters.maxSize) {
      whereConditions.push('m.unpacked_size <= ?');
      params.push(filters.maxSize);
    }

    // Filter by dependencies
    if (filters.minDependencies !== undefined) {
      whereConditions.push('m.dependencies_count >= ?');
      params.push(filters.minDependencies);
    }

    if (filters.maxDependencies !== undefined) {
      whereConditions.push('m.dependencies_count <= ?');
      params.push(filters.maxDependencies);
    }

    // Filter by state
    if (filters.state) {
      whereConditions.push('p.state = ?');
      params.push(filters.state);
    }

    // Filter by scope
    if (filters.scope !== undefined) {
      if (filters.scope === null || filters.scope === '') {
        whereConditions.push('(p.scope IS NULL OR p.scope = "")');
      } else {
        whereConditions.push('p.scope = ?');
        params.push(filters.scope);
      }
    }

    const whereClause = whereConditions.length > 0 
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    const query = `
      SELECT 
        ROW_NUMBER() OVER (ORDER BY p.id) as number,
        p.name as package_name,
        m.npm_url,
        m.file_count,
        m.unpacked_size,
        m.dependencies_count as dependencies,
        0 as dependents,
        DATE(m.publish_time) as latest_release_published_at,
        m.description,
        m.keywords
      FROM packages p
      LEFT JOIN package_metadata m ON p.id = m.package_id
      ${whereClause}
      ORDER BY p.id
    `;

    return this.db.prepare(query).bind(...params);
  }

  /**
   * Get total package count
   * @returns {number} - Total packages
   */
  getTotalPackages() {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM packages').get();
    return result.count;
  }

  /**
   * Get package count by state
   * @param {string} state - Package state
   * @returns {number} - Package count
   */
  getPackageCountByState(state) {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM packages WHERE state = ?').get(state);
    return result.count;
  }

  /**
   * Get sync checkpoint
   * @returns {object} - Checkpoint data
   */
  getCheckpoint() {
    return this.db.prepare('SELECT * FROM sync_checkpoint WHERE id = 1').get();
  }

  /**
   * Update sync checkpoint
   * @param {number} sequence - New sequence number
   * @param {number} totalPackages - Total packages count
   */
  updateCheckpoint(sequence, totalPackages = null) {
    const stmt = this.db.prepare(`
      UPDATE sync_checkpoint
      SET last_sequence = ?,
          last_sync_at = CURRENT_TIMESTAMP,
          total_packages = COALESCE(?, total_packages)
      WHERE id = 1
    `);
    
    return stmt.run(sequence, totalPackages);
  }

  /**
   * Get statistics
   * @returns {object} - Database statistics
   */
  getStats() {
    const total = this.getTotalPackages();
    const indexed = this.getPackageCountByState('indexed');
    const synced = this.getPackageCountByState('synced');
    const enriched = this.getPackageCountByState('enriched');
    const checkpoint = this.getCheckpoint();

    return {
      total,
      indexed,
      synced,
      enriched,
      lastSequence: checkpoint.last_sequence,
      lastSync: checkpoint.last_sync_at
    };
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      console.log('[DB] Connection closed');
    }
  }
}

export default RegistryDB;

