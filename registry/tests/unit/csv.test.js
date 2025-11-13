/**
 * Unit tests for csv.js
 * Tests CSV export functionality, filtering, and streaming
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import CSVExporter from '../../csv.js';
import RegistryDB from '../../db.js';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';

const TEST_DB_PATH = './tests/fixtures/test-csv.db';
const TEST_CSV_PATH = './tests/fixtures/test-output.csv';

describe('CSVExporter', () => {
  let db;
  let exporter;

  beforeEach(() => {
    // Clean up test files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (fs.existsSync(TEST_CSV_PATH)) {
      fs.unlinkSync(TEST_CSV_PATH);
    }

    // Setup test database with sample data
    db = new RegistryDB(TEST_DB_PATH);
    db.connect();
    
    // Insert test packages
    db.insertPackage('lodash', 'enriched');
    db.storeMetadata('lodash', {
      description: 'Lodash modular utilities.',
      keywords: 'modules, stdlib, util',
      latest_version: '4.17.21',
      publish_time: '2021-02-20T16:41:44.000Z',
      dependencies_count: 0,
      file_count: 1054,
      unpacked_size: 1413487
    });

    db.insertPackage('@babel/core', 'enriched');
    db.storeMetadata('@babel/core', {
      description: 'Babel compiler core.',
      keywords: 'babel, compiler',
      latest_version: '7.24.0',
      publish_time: '2024-02-28T15:08:36.000Z',
      dependencies_count: 15,
      file_count: 234,
      unpacked_size: 2450000
    });

    db.insertPackage('react', 'enriched');
    db.storeMetadata('react', {
      description: 'React is a JavaScript library for building user interfaces.',
      keywords: 'react',
      latest_version: '18.2.0',
      publish_time: '2022-06-14T21:00:24.000Z',
      dependencies_count: 2,
      file_count: 89,
      unpacked_size: 305000
    });

    exporter = new CSVExporter(TEST_DB_PATH);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    
    // Clean up test files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (fs.existsSync(TEST_CSV_PATH)) {
      fs.unlinkSync(TEST_CSV_PATH);
    }
  });

  describe('Basic Export', () => {
    test('should export all packages to CSV', async () => {
      await exporter.export({
        output: TEST_CSV_PATH
      });

      expect(fs.existsSync(TEST_CSV_PATH)).toBe(true);
      
      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      
      // Header + 3 packages
      expect(lines.length).toBe(4);
    });

    test('should include correct CSV headers', async () => {
      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      expect(records[0]).toHaveProperty('number');
      expect(records[0]).toHaveProperty('npm_url');
      expect(records[0]).toHaveProperty('package_name');
      expect(records[0]).toHaveProperty('file_number');
      expect(records[0]).toHaveProperty('unpacked_size');
      expect(records[0]).toHaveProperty('dependencies');
      expect(records[0]).toHaveProperty('latest_release_published_at');
      expect(records[0]).toHaveProperty('description');
      expect(records[0]).toHaveProperty('keywords');
    });

    test('should export data with correct values', async () => {
      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      const lodash = records.find(r => r.package_name === 'lodash');
      expect(lodash).toBeDefined();
      expect(lodash.description).toBe('Lodash modular utilities.');
      expect(lodash.unpacked_size).toBe('1413487');
      expect(lodash.dependencies).toBe('0');
    });
  });

  describe('Filtering', () => {
    test('should filter by published date (after)', async () => {
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          publishedAfter: '2022-01-01'
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should only include @babel/core and react
      expect(records.length).toBe(2);
      expect(records.some(r => r.package_name === 'lodash')).toBe(false);
    });

    test('should filter by published date (before)', async () => {
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          publishedBefore: '2022-01-01'
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should only include lodash
      expect(records.length).toBe(1);
      expect(records[0].package_name).toBe('lodash');
    });

    test('should filter by size range', async () => {
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          minSize: 1000000,
          maxSize: 3000000
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should include lodash and @babel/core
      expect(records.length).toBe(2);
      expect(records.some(r => r.package_name === 'react')).toBe(false);
    });

    test('should filter by dependencies count', async () => {
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          minDependencies: 1
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should include @babel/core and react (both have deps)
      expect(records.length).toBe(2);
      expect(records.some(r => r.package_name === 'lodash')).toBe(false);
    });

    test('should filter by state', async () => {
      // Add indexed package
      db.insertPackage('test-indexed', 'indexed');

      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          state: 'enriched'
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should only include enriched packages
      expect(records.length).toBe(3);
      expect(records.some(r => r.package_name === 'test-indexed')).toBe(false);
    });

    test('should apply multiple filters together', async () => {
      await exporter.export({
        output: TEST_CSV_PATH,
        filters: {
          publishedAfter: '2022-01-01',
          minSize: 2000000
        }
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should only include @babel/core
      expect(records.length).toBe(1);
      expect(records[0].package_name).toBe('@babel/core');
    });
  });

  describe('CSV Formatting', () => {
    test('should properly escape commas in descriptions', async () => {
      db.insertPackage('test-comma', 'enriched');
      db.storeMetadata('test-comma', {
        description: 'A package, with commas, in description',
        keywords: 'test',
        latest_version: '1.0.0',
        publish_time: '2023-01-01T00:00:00.000Z',
        dependencies_count: 0,
        file_count: 10,
        unpacked_size: 1000
      });

      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      const testPkg = records.find(r => r.package_name === 'test-comma');
      expect(testPkg.description).toBe('A package, with commas, in description');
    });

    test('should properly escape quotes in descriptions', async () => {
      db.insertPackage('test-quote', 'enriched');
      db.storeMetadata('test-quote', {
        description: 'A "quoted" description',
        keywords: 'test',
        latest_version: '1.0.0',
        publish_time: '2023-01-01T00:00:00.000Z',
        dependencies_count: 0,
        file_count: 10,
        unpacked_size: 1000
      });

      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      const testPkg = records.find(r => r.package_name === 'test-quote');
      expect(testPkg.description).toBe('A "quoted" description');
    });

    test('should handle newlines in descriptions', async () => {
      db.insertPackage('test-newline', 'enriched');
      db.storeMetadata('test-newline', {
        description: 'Line 1\nLine 2\nLine 3',
        keywords: 'test',
        latest_version: '1.0.0',
        publish_time: '2023-01-01T00:00:00.000Z',
        dependencies_count: 0,
        file_count: 10,
        unpacked_size: 1000
      });

      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      const testPkg = records.find(r => r.package_name === 'test-newline');
      // CSV should preserve newlines within quoted fields
      expect(testPkg.description).toContain('Line 1');
    });
  });

  describe('Row Numbering', () => {
    test('should number rows sequentially', async () => {
      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      expect(records[0].number).toBe('1');
      expect(records[1].number).toBe('2');
      expect(records[2].number).toBe('3');
    });
  });

  describe('NPM URL Generation', () => {
    test('should generate correct NPM URLs', async () => {
      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      const lodash = records.find(r => r.package_name === 'lodash');
      expect(lodash.npm_url).toBe('https://www.npmjs.com/package/lodash');

      const babel = records.find(r => r.package_name === '@babel/core');
      expect(babel.npm_url).toBe('https://www.npmjs.com/package/@babel/core');
    });
  });

  describe('Error Handling', () => {
    test('should handle empty database', async () => {
      // Create empty database
      const emptyDb = new RegistryDB('./tests/fixtures/empty.db');
      emptyDb.connect();
      emptyDb.close();

      const emptyExporter = new CSVExporter('./tests/fixtures/empty.db');
      
      await expect(
        emptyExporter.export({ output: TEST_CSV_PATH })
      ).resolves.not.toThrow();

      // Should create file with just header
      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(1); // Just header

      fs.unlinkSync('./tests/fixtures/empty.db');
    });

    test('should handle missing metadata gracefully', async () => {
      // Add package without metadata
      db.insertPackage('no-metadata', 'indexed');

      await exporter.export({
        output: TEST_CSV_PATH
      });

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const records = parse(content, { columns: true });

      // Should still export packages with metadata
      expect(records.length).toBeGreaterThan(0);
    });
  });

  describe('Filter Examples', () => {
    test('should provide filter examples', () => {
      const examples = CSVExporter.getFilterExamples();
      
      expect(examples).toBeDefined();
      expect(examples.length).toBeGreaterThan(0);
      expect(examples[0]).toHaveProperty('description');
      expect(examples[0]).toHaveProperty('command');
    });
  });
});

