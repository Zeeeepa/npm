# Test Suite Documentation

Comprehensive test suite for the NPM Registry Indexer.

## 📁 Structure

```
tests/
├── unit/               # Unit tests for individual modules
│   ├── db.test.js     # Database operations
│   └── csv.test.js    # CSV export functionality
├── integration/        # Integration tests for workflows
│   └── workflow.test.js
├── mocks/             # Mock utilities
│   └── axios-mock.js  # HTTP request mocking
├── fixtures/          # Test data and sample files
│   └── sample-packages.json
├── setup.js           # Jest setup configuration
└── README.md          # This file
```

## 🧪 Running Tests

### All Tests
```bash
npm test
```

### Unit Tests Only
```bash
npm run test:unit
```

### Integration Tests Only
```bash
npm run test:integration
```

### Watch Mode (for development)
```bash
npm run test:watch
```

### Coverage Report
```bash
npm run test:coverage
```

## 📊 Test Coverage

### Database Module (db.js)
- ✅ Connection and schema initialization
- ✅ Package CRUD operations
- ✅ Metadata storage and retrieval
- ✅ Checkpoint management
- ✅ Query operations with filters
- ✅ State management
- ✅ Statistics generation
- ✅ Batch operations
- ✅ Error handling

### CSV Export Module (csv.js)
- ✅ Basic CSV export
- ✅ Header generation
- ✅ Data formatting
- ✅ Filtering (date, size, dependencies, state)
- ✅ Multiple filter combinations
- ✅ CSV escaping (commas, quotes, newlines)
- ✅ Row numbering
- ✅ NPM URL generation
- ✅ Empty database handling
- ✅ Missing metadata handling

### Integration Tests
- ✅ Complete Index → Enrich → Export workflow
- ✅ Incremental sync workflow
- ✅ State transitions (indexed → synced → enriched)
- ✅ Complex query and export scenarios
- ✅ Checkpoint management across steps
- ✅ Error recovery and reconnection
- ✅ Performance benchmarks

## 🎯 Test Scenarios

### Unit Tests

#### Database Tests
1. **Schema Tests**: Verify table structure and indexes
2. **CRUD Tests**: Insert, read, update packages
3. **Metadata Tests**: Store and retrieve enrichment data
4. **Query Tests**: Filter packages by various criteria
5. **Checkpoint Tests**: Track sync state
6. **State Tests**: Manage package lifecycle states

#### CSV Tests
1. **Export Tests**: Generate CSV files correctly
2. **Filter Tests**: Apply single and multiple filters
3. **Format Tests**: Proper CSV escaping and formatting
4. **Edge Cases**: Empty database, missing data

### Integration Tests

#### Workflow Tests
1. **Full Pipeline**: Index → Enrich → Export
2. **Incremental Sync**: Handle new packages
3. **Partial Enrichment**: Resume interrupted operations
4. **State Transitions**: Track package lifecycle
5. **Complex Queries**: Multiple filters combined
6. **Performance**: Handle large datasets

## 🔧 Test Configuration

### Jest Configuration (jest.config.js)
- ES modules support
- Test timeout: 30 seconds
- Coverage thresholds: TBD
- Test environment: Node.js

### Environment Variables
Tests use isolated test environment:
- `NODE_ENV=test`
- `DB_PATH=./tests/fixtures/test.db`

### Test Databases
All tests use temporary databases in `tests/fixtures/`:
- Automatically cleaned before each test
- Isolated from production data
- Deleted after test completion

## 📝 Writing Tests

### Unit Test Template
```javascript
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import ModuleName from '../../module.js';

describe('ModuleName', () => {
  let instance;

  beforeEach(() => {
    // Setup
    instance = new ModuleName();
  });

  afterEach(() => {
    // Cleanup
  });

  describe('Feature Name', () => {
    test('should do something', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = instance.method(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

### Integration Test Template
```javascript
import { describe, test, expect } from '@jest/globals';

describe('Workflow Integration', () => {
  test('should complete workflow successfully', async () => {
    // Step 1: Setup
    // Step 2: Execute workflow
    // Step 3: Verify results
    // Step 4: Cleanup
  });
});
```

## 🐛 Debugging Tests

### Run Single Test File
```bash
npm test tests/unit/db.test.js
```

### Run Single Test Case
```bash
npm test -- -t "should insert package successfully"
```

### Verbose Output
```bash
npm test -- --verbose
```

### Debug Mode
```bash
node --inspect-brk node_modules/.bin/jest tests/unit/db.test.js
```

## 📈 Performance Benchmarks

### Database Operations
- **Batch Insert (1000 packages)**: < 5 seconds
- **Query with Filters (500 packages)**: < 1 second
- **CSV Export (1000 packages)**: < 3 seconds

### Expected Test Duration
- **Unit Tests**: ~5 seconds
- **Integration Tests**: ~10 seconds
- **Full Suite**: ~15 seconds

## ✅ CI/CD Integration

### GitHub Actions Example
```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
      - run: npm run test:coverage
```

## 🔍 Test Maintenance

### Adding New Tests
1. Create test file in appropriate directory
2. Follow naming convention: `*.test.js`
3. Use descriptive test names
4. Include setup/teardown logic
5. Clean up test artifacts

### Updating Tests
- Keep tests focused and atomic
- Update when API changes
- Maintain coverage levels
- Document complex test scenarios

### Test Data
- Use fixtures for reusable test data
- Keep test data minimal
- Document fixture structure
- Version control test data

## 🎓 Best Practices

1. **Test Independence**: Each test should run in isolation
2. **Cleanup**: Always clean up test databases and files
3. **Descriptive Names**: Use clear test descriptions
4. **Arrange-Act-Assert**: Follow AAA pattern
5. **Edge Cases**: Test boundary conditions
6. **Error Cases**: Test error handling
7. **Performance**: Include performance benchmarks
8. **Documentation**: Comment complex test logic

## 🚀 Future Test Additions

- [ ] End-to-end tests with real registry API (optional)
- [ ] Load testing for large datasets (>1M packages)
- [ ] Stress testing for concurrent operations
- [ ] Security testing for SQL injection
- [ ] Memory leak detection
- [ ] Browser compatibility (if applicable)
- [ ] Accessibility testing (if applicable)

## 📞 Support

For test-related questions or issues:
1. Check test logs for error details
2. Review test documentation
3. Run tests in verbose mode
4. Check GitHub Issues

