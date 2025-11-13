/**
 * Unit tests for db.js
 * Tests database operations, schema, queries, and state management
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import RegistryDB from '../../db.js';
import fs from 'fs';
import path from 'path';

const TEST_DB_PATH = './tests/fixtures/test-db.db';

describe('RegistryDB', () => {
  let db;

  beforeEach(() => {
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    db = new RegistryDB(TEST_DB_PATH);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('Connection and Schema', () => {
    test('should connect to database successfully', () => {
      db.connect();
      expect(db.db).toBeDefined();
      expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
    });

    test('should initialize schema with all tables', () => {
      db.connect();
      
      const tables = db.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        ORDER BY name
      `).all();

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('packages');
      expect(tableNames).toContain('package_metadata');
      expect(tableNames).toContain('sync_checkpoint');
    });

    test('should have correct schema for packages table', () => {
      db.connect();
      
      const schema = db.db.prepare(`
        PRAGMA table_info(packages)
      `).all();

      const columnNames = schema.map(c => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('scope');
      expect(columnNames).toContain('state');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');
    });

    test('should have indexes on packages table', () => {
      db.connect();
      
      const indexes = db.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='index' AND tbl_name='packages'
      `).all();

      expect(indexes.length).toBeGreaterThan(0);
    });
  });

  describe('Package Operations', () => {
    beforeEach(() => {
      db.connect();
    });

    test('should insert package successfully', () => {
      const id = db.insertPackage('test-package', 'indexed');
      expect(id).toBeGreaterThan(0);

      const pkg = db.getPackage('test-package');
      expect(pkg).toBeDefined();
      expect(pkg.name).toBe('test-package');
      expect(pkg.state).toBe('indexed');
    });

    test('should extract scope from scoped package names', () => {
      const id = db.insertPackage('@babel/core', 'indexed');
      const pkg = db.getPackage('@babel/core');
      
      expect(pkg.scope).toBe('@babel');
      expect(pkg.name).toBe('@babel/core');
    });

    test('should handle non-scoped packages correctly', () => {
      const id = db.insertPackage('lodash', 'indexed');
      const pkg = db.getPackage('lodash');
      
      expect(pkg.scope).toBeNull();
      expect(pkg.name).toBe('lodash');
    });

    test('should not insert duplicate packages', () => {
      db.insertPackage('test-package', 'indexed');
      
      // Should not throw, should just skip
      expect(() => {
        db.insertPackage('test-package', 'indexed');
      }).not.toThrow();

      const count = db.getTotalPackages();
      expect(count).toBe(1);
    });

    test('should update package state', () => {
      const id = db.insertPackage('test-package', 'indexed');
      db.updatePackageState('test-package', 'synced');

      const pkg = db.getPackage('test-package');
      expect(pkg.state).toBe('synced');
    });

    test('should get packages by state', () => {
      db.insertPackage('package1', 'indexed');
      db.insertPackage('package2', 'synced');
      db.insertPackage('package3', 'enriched');
      db.insertPackage('package4', 'indexed');

      const indexed = db.getPackagesByState('indexed');
      expect(indexed.length).toBe(2);
      expect(indexed[0].name).toBe('package1');
      expect(indexed[1].name).toBe('package4');
    });

    test('should get total packages count', () => {
      db.insertPackage('package1', 'indexed');
      db.insertPackage('package2', 'synced');
      db.insertPackage('package3', 'enriched');

      const count = db.getTotalPackages();
      expect(count).toBe(3);
    });
  });

  describe('Metadata Operations', () => {
    beforeEach(() => {
      db.connect();
    });

    test('should store package metadata', () => {
      const packageId = db.insertPackage('lodash', 'indexed');
      
      const metadata = {
        description: 'Lodash modular utilities.',
        keywords: 'modules, stdlib, util',
        latest_version: '4.17.21',
        publish_time: '2021-02-20T16:41:44.000Z',
        dependencies_count: 0,
        file_count: 1054,
        unpacked_size: 1413487
      };

      db.storeMetadata('lodash', metadata);

      const stored = db.db.prepare(`
        SELECT * FROM package_metadata WHERE package_id = ?
      `).get(packageId);

      expect(stored).toBeDefined();
      expect(stored.description).toBe(metadata.description);
      expect(stored.unpacked_size).toBe(metadata.unpacked_size);
    });

    test('should update existing metadata', () => {
      const packageId = db.insertPackage('lodash', 'indexed');
      
      db.storeMetadata('lodash', {
        description: 'Old description',
        unpacked_size: 1000000
      });

      db.storeMetadata('lodash', {
        description: 'New description',
        unpacked_size: 1500000
      });

      const stored = db.db.prepare(`
        SELECT * FROM package_metadata WHERE package_id = ?
      `).get(packageId);

      expect(stored.description).toBe('New description');
      expect(stored.unpacked_size).toBe(1500000);
    });
  });

  describe('Checkpoint Operations', () => {
    beforeEach(() => {
      db.connect();
    });

    test('should get initial checkpoint', () => {
      const checkpoint = db.getCheckpoint();
      expect(checkpoint).toBeDefined();
      expect(checkpoint.last_sequence).toBe(0);
      expect(checkpoint.total_packages).toBe(0);
    });

    test('should update checkpoint', () => {
      db.updateCheckpoint(12345, 1000);

      const checkpoint = db.getCheckpoint();
      expect(checkpoint.last_sequence).toBe(12345);
      expect(checkpoint.total_packages).toBe(1000);
    });

    test('should maintain only one checkpoint row', () => {
      db.updateCheckpoint(100, 10);
      db.updateCheckpoint(200, 20);
      db.updateCheckpoint(300, 30);

      const checkpoints = db.db.prepare('SELECT * FROM sync_checkpoint').all();
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0].last_sequence).toBe(300);
    });
  });

  describe('Query Operations', () => {
    beforeEach(() => {
      db.connect();
      
      // Insert test data
      db.insertPackage('lodash', 'enriched');
      db.storeMetadata('lodash', {
        description: 'Lodash utilities',
        publish_time: '2021-02-20T16:41:44.000Z',
        unpacked_size: 1413487,
        dependencies_count: 0
      });

      db.insertPackage('react', 'enriched');
      db.storeMetadata('react', {
        description: 'React library',
        publish_time: '2024-02-20T16:41:44.000Z',
        unpacked_size: 305000,
        dependencies_count: 2
      });

      db.insertPackage('big-package', 'enriched');
      db.storeMetadata('big-package', {
        description: 'Big package',
        publish_time: '2023-06-15T10:00:00.000Z',
        unpacked_size: 5000000,
        dependencies_count: 50
      });
    });

    test('should query packages with date filter', () => {
      const results = db.queryPackages({
        publishedAfter: '2023-01-01'
      });

      expect(results.length).toBe(2); // react and big-package
    });

    test('should query packages with size filter', () => {
      const results = db.queryPackages({
        minSize: 1000000
      });

      expect(results.length).toBe(2); // lodash and big-package
    });

    test('should query packages with dependencies filter', () => {
      const results = db.queryPackages({
        minDependencies: 1
      });

      expect(results.length).toBe(2); // react and big-package
    });

    test('should query packages with state filter', () => {
      db.insertPackage('test-indexed', 'indexed');
      
      const results = db.queryPackages({
        state: 'enriched'
      });

      expect(results.length).toBe(3);
    });

    test('should query packages with multiple filters', () => {
      const results = db.queryPackages({
        publishedAfter: '2023-01-01',
        minSize: 300000,
        maxSize: 6000000
      });

      expect(results.length).toBe(1); // big-package only
    });

    test('should apply limit to query results', () => {
      const results = db.queryPackages({}, 2);
      expect(results.length).toBe(2);
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      db.connect();
    });

    test('should get accurate statistics', () => {
      db.insertPackage('package1', 'indexed');
      db.insertPackage('package2', 'synced');
      db.insertPackage('package3', 'enriched');
      db.insertPackage('package4', 'enriched');

      const stats = db.getStats();
      
      expect(stats.total).toBe(4);
      expect(stats.indexed).toBe(1);
      expect(stats.synced).toBe(1);
      expect(stats.enriched).toBe(2);
    });

    test('should handle empty database stats', () => {
      const stats = db.getStats();
      
      expect(stats.total).toBe(0);
      expect(stats.indexed).toBe(0);
      expect(stats.synced).toBe(0);
      expect(stats.enriched).toBe(0);
    });
  });

  describe('Batch Operations', () => {
    beforeEach(() => {
      db.connect();
    });

    test('should insert multiple packages in transaction', () => {
      const packages = [
        { name: 'package1', state: 'indexed' },
        { name: 'package2', state: 'indexed' },
        { name: 'package3', state: 'indexed' }
      ];

      packages.forEach(pkg => {
        db.insertPackage(pkg.name, pkg.state);
      });

      const count = db.getTotalPackages();
      expect(count).toBe(3);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid state gracefully', () => {
      db.connect();
      
      expect(() => {
        db.getPackagesByState('invalid-state');
      }).not.toThrow();
    });

    test('should handle non-existent package queries', () => {
      db.connect();
      
      const pkg = db.getPackage('non-existent');
      expect(pkg).toBeUndefined();
    });

    test('should handle metadata for non-existent package', () => {
      db.connect();
      
      expect(() => {
        db.storeMetadata('non-existent', {
          description: 'test'
        });
      }).not.toThrow();
    });
  });

  describe('Connection Management', () => {
    test('should close connection properly', () => {
      db.connect();
      expect(db.db).toBeDefined();
      
      db.close();
      expect(db.db).toBeNull();
    });

    test('should handle multiple close calls', () => {
      db.connect();
      
      db.close();
      expect(() => db.close()).not.toThrow();
    });
  });
});

