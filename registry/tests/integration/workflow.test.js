/**
 * Integration tests for complete workflow
 * Tests end-to-end indexing, syncing, enriching, and exporting
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import RegistryDB from '../../db.js';
import CSVExporter from '../../csv.js';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const TEST_DB_PATH = './tests/fixtures/integration-test.db';
const TEST_CSV_PATH = './tests/fixtures/integration-output.csv';

describe('Complete Workflow Integration', () => {
  let db;

  beforeEach(() => {
    // Clean up test files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (fs.existsSync(TEST_CSV_PATH)) {
      fs.unlinkSync(TEST_CSV_PATH);
    }

    db = new RegistryDB(TEST_DB_PATH);
    db.connect();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (fs.existsSync(TEST_CSV_PATH)) {
      fs.unlinkSync(TEST_CSV_PATH);
    }
  });

  describe('Index → Enrich → Export Workflow', () => {
    test('should complete full workflow successfully', async () => {
      // Step 1: Index packages
      const packages = [
        'lodash',
        '@babel/core',
        'react',
        'vue',
        'express'
      ];

      packages.forEach(name => {
        db.insertPackage(name, 'indexed');
      });

      let stats = db.getStats();
      expect(stats.total).toBe(5);
      expect(stats.indexed).toBe(5);

      // Step 2: Simulate enrichment
      packages.forEach(name => {
        db.storeMetadata(name, {
          description: `Description for ${name}`,
          keywords: `keywords for ${name}`,
          latest_version: '1.0.0',
          publish_time: '2023-01-01T00:00:00.000Z',
          dependencies_count: Math.floor(Math.random() * 10),
          file_count: Math.floor(Math.random() * 100),
          unpacked_size: Math.floor(Math.random() * 1000000)
        });
        
        db.updatePackageState(name, 'enriched');
      });

      stats = db.getStats();
      expect(stats.enriched).toBe(5);

      // Step 3: Export to CSV
      const exporter = new CSVExporter(TEST_DB_PATH);
      await exporter.export({
        output: TEST_CSV_PATH
      });

      expect(fs.existsSync(TEST_CSV_PATH)).toBe(true);

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      expect(records.length).toBe(5);
      expect(records.every(r => r.description)).toBe(true);
    });

    test('should handle partial enrichment workflow', async () => {
      // Index packages
      db.insertPackage('package1', 'indexed');
      db.insertPackage('package2', 'indexed');
      db.insertPackage('package3', 'indexed');

      // Enrich only some packages
      db.storeMetadata('package1', {
        description: 'Package 1',
        latest_version: '1.0.0',
        publish_time: '2023-01-01T00:00:00.000Z'
      });
      db.updatePackageState('package1', 'enriched');

      db.storeMetadata('package2', {
        description: 'Package 2',
        latest_version: '2.0.0',
        publish_time: '2023-02-01T00:00:00.000Z'
      });
      db.updatePackageState('package2', 'enriched');

      // Export only enriched packages
      const exporter = new CSVExporter(TEST_DB_PATH);
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          state: 'enriched'
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      expect(records.length).toBe(2);
      expect(records.some(r => r.package_name === 'package3')).toBe(false);
    });
  });

  describe('Index → Sync → Enrich Workflow', () => {
    test('should handle incremental sync workflow', async () => {
      // Initial index
      db.insertPackage('package1', 'indexed');
      db.insertPackage('package2', 'indexed');
      db.updateCheckpoint(100, 2);

      let stats = db.getStats();
      expect(stats.total).toBe(2);

      // Simulate sync (new packages)
      db.insertPackage('package3', 'indexed');
      db.insertPackage('package4', 'indexed');
      
      // Update existing packages to synced
      db.updatePackageState('package1', 'synced');
      db.updatePackageState('package2', 'synced');
      
      db.updateCheckpoint(200, 4);

      stats = db.getStats();
      expect(stats.total).toBe(4);
      expect(stats.synced).toBe(2);
      expect(stats.indexed).toBe(2);

      const checkpoint = db.getCheckpoint();
      expect(checkpoint.last_sequence).toBe(200);
      expect(checkpoint.total_packages).toBe(4);
    });
  });

  describe('State Transitions', () => {
    test('should track package state transitions correctly', async () => {
      const packageName = 'test-package';

      // Start: indexed
      db.insertPackage(packageName, 'indexed');
      let pkg = db.getPackage(packageName);
      expect(pkg.state).toBe('indexed');

      // Transition: indexed → synced
      db.updatePackageState(packageName, 'synced');
      pkg = db.getPackage(packageName);
      expect(pkg.state).toBe('synced');

      // Transition: synced → enriched
      db.storeMetadata(packageName, {
        description: 'Test package',
        latest_version: '1.0.0'
      });
      db.updatePackageState(packageName, 'enriched');
      pkg = db.getPackage(packageName);
      expect(pkg.state).toBe('enriched');
    });

    test('should handle bulk state transitions', async () => {
      // Create packages in different states
      const packages = [
        { name: 'pkg1', state: 'indexed' },
        { name: 'pkg2', state: 'indexed' },
        { name: 'pkg3', state: 'indexed' },
        { name: 'pkg4', state: 'indexed' },
        { name: 'pkg5', state: 'indexed' }
      ];

      packages.forEach(pkg => {
        db.insertPackage(pkg.name, pkg.state);
      });

      // Transition all to synced
      packages.forEach(pkg => {
        db.updatePackageState(pkg.name, 'synced');
      });

      const stats = db.getStats();
      expect(stats.synced).toBe(5);
      expect(stats.indexed).toBe(0);

      // Transition some to enriched
      db.updatePackageState('pkg1', 'enriched');
      db.updatePackageState('pkg2', 'enriched');

      const newStats = db.getStats();
      expect(newStats.enriched).toBe(2);
      expect(newStats.synced).toBe(3);
    });
  });

  describe('Query and Export Integration', () => {
    test('should query and export with complex filters', async () => {
      // Create diverse dataset
      const testData = [
        {
          name: 'old-small',
          publishTime: '2020-01-01T00:00:00.000Z',
          size: 100000,
          deps: 0
        },
        {
          name: 'old-large',
          publishTime: '2020-06-01T00:00:00.000Z',
          size: 5000000,
          deps: 20
        },
        {
          name: 'new-small',
          publishTime: '2024-01-01T00:00:00.000Z',
          size: 50000,
          deps: 2
        },
        {
          name: 'new-large',
          publishTime: '2024-06-01T00:00:00.000Z',
          size: 8000000,
          deps: 50
        }
      ];

      testData.forEach(pkg => {
        db.insertPackage(pkg.name, 'enriched');
        db.storeMetadata(pkg.name, {
          description: `Package ${pkg.name}`,
          publish_time: pkg.publishTime,
          unpacked_size: pkg.size,
          dependencies_count: pkg.deps,
          latest_version: '1.0.0'
        });
      });

      // Export with filters: new AND large
      const exporter = new CSVExporter(TEST_DB_PATH);
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          publishedAfter: '2023-01-01',
          minSize: 1000000
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should only include 'new-large'
      expect(records.length).toBe(1);
      expect(records[0].package_name).toBe('new-large');
    });
  });

  describe('Checkpoint Management', () => {
    test('should maintain checkpoint across workflow steps', async () => {
      // Initial index
      db.updateCheckpoint(1000, 100);

      let checkpoint = db.getCheckpoint();
      expect(checkpoint.last_sequence).toBe(1000);
      expect(checkpoint.total_packages).toBe(100);

      // After sync
      db.updateCheckpoint(2000, 150);

      checkpoint = db.getCheckpoint();
      expect(checkpoint.last_sequence).toBe(2000);
      expect(checkpoint.total_packages).toBe(150);

      // Checkpoint should persist across reconnects
      db.close();
      db = new RegistryDB(TEST_DB_PATH);
      db.connect();

      checkpoint = db.getCheckpoint();
      expect(checkpoint.last_sequence).toBe(2000);
      expect(checkpoint.total_packages).toBe(150);
    });
  });

  describe('Error Recovery', () => {
    test('should recover from partial enrichment', async () => {
      // Index packages
      db.insertPackage('pkg1', 'indexed');
      db.insertPackage('pkg2', 'indexed');
      db.insertPackage('pkg3', 'indexed');

      // Partially enrich
      db.storeMetadata('pkg1', {
        description: 'Package 1',
        latest_version: '1.0.0'
      });
      db.updatePackageState('pkg1', 'enriched');

      // Query for packages needing enrichment
      const needsEnrichment = db.getPackagesByState('indexed');
      expect(needsEnrichment.length).toBe(2);

      // Complete enrichment
      needsEnrichment.forEach(pkg => {
        db.storeMetadata(pkg.name, {
          description: `Package ${pkg.name}`,
          latest_version: '1.0.0'
        });
        db.updatePackageState(pkg.name, 'enriched');
      });

      const stats = db.getStats();
      expect(stats.enriched).toBe(3);
      expect(stats.indexed).toBe(0);
    });

    test('should handle database reconnection', async () => {
      // Insert data
      db.insertPackage('test-pkg', 'indexed');
      
      // Close and reopen
      db.close();
      db = new RegistryDB(TEST_DB_PATH);
      db.connect();

      // Data should persist
      const pkg = db.getPackage('test-pkg');
      expect(pkg).toBeDefined();
      expect(pkg.name).toBe('test-pkg');
    });
  });

  describe('Performance Considerations', () => {
    test('should handle batch inserts efficiently', () => {
      const startTime = Date.now();

      // Insert 1000 packages
      for (let i = 0; i < 1000; i++) {
        db.insertPackage(`package-${i}`, 'indexed');
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete in reasonable time (< 5 seconds)
      expect(duration).toBeLessThan(5000);

      const count = db.getTotalPackages();
      expect(count).toBe(1000);
    });

    test('should query large datasets efficiently', () => {
      // Insert 500 packages with metadata
      for (let i = 0; i < 500; i++) {
        db.insertPackage(`package-${i}`, 'enriched');
        db.storeMetadata(`package-${i}`, {
          description: `Package ${i}`,
          publish_time: `2023-${(i % 12) + 1}-01T00:00:00.000Z`,
          unpacked_size: i * 1000,
          dependencies_count: i % 10,
          latest_version: '1.0.0'
        });
      }

      const startTime = Date.now();

      const results = db.queryPackages({
        publishedAfter: '2023-06-01',
        minSize: 100000
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Query should be fast (< 1 second)
      expect(duration).toBeLessThan(1000);
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

