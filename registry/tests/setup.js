/**
 * Jest test setup
 * Configure test environment and global utilities
 */

import fs from 'fs';
import path from 'path';

// Clean up test databases before each test
beforeEach(() => {
  const testDbPath = path.join(process.cwd(), 'tests', 'fixtures', 'test.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
});

// Clean up test databases after all tests
afterAll(() => {
  const testDbPath = path.join(process.cwd(), 'tests', 'fixtures', 'test.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
});

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DB_PATH = './tests/fixtures/test.db';

