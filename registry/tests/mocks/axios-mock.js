/**
 * Mock axios for testing without actual HTTP requests
 */

export class AxiosMock {
  constructor() {
    this.responses = new Map();
    this.requestHistory = [];
  }

  /**
   * Configure mock response for a URL
   */
  mockResponse(url, data, status = 200) {
    this.responses.set(url, { data, status });
  }

  /**
   * Mock GET request
   */
  async get(url, config = {}) {
    this.requestHistory.push({ method: 'GET', url, config });

    const response = this.responses.get(url);
    
    if (!response) {
      throw new Error(`No mock configured for URL: ${url}`);
    }

    if (response.status !== 200) {
      const error = new Error(`Request failed with status code ${response.status}`);
      error.response = { status: response.status, data: response.data };
      throw error;
    }

    return { data: response.data, status: response.status };
  }

  /**
   * Get request history
   */
  getRequestHistory() {
    return this.requestHistory;
  }

  /**
   * Reset mock
   */
  reset() {
    this.responses.clear();
    this.requestHistory = [];
  }
}

/**
 * Create mock registry responses
 */
export function createMockRegistryResponses() {
  return {
    root: {
      last_package: '@test/package',
      doc_count: 1000,
      update_seq: 5000
    },
    changes: {
      results: [
        {
          seq: 1,
          type: 'PACKAGE_VERSION_ADDED',
          id: 'test-package-1',
          changes: [{ version: '1.0.0' }]
        },
        {
          seq: 2,
          type: 'PACKAGE_VERSION_ADDED',
          id: '@scope/test-package-2',
          changes: [{ version: '2.0.0' }]
        },
        {
          seq: 3,
          type: 'PACKAGE_TAG_ADDED',
          id: 'test-package-1',
          changes: [{ tag: 'latest' }]
        }
      ]
    },
    packageMetadata: {
      'test-package-1': {
        name: 'test-package-1',
        description: 'Test package 1 description',
        keywords: ['test', 'package'],
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'test-package-1',
            version: '1.0.0',
            description: 'Test package 1 description',
            dependencies: {},
            dist: {
              unpackedSize: 10000,
              fileCount: 5
            }
          }
        },
        time: {
          '1.0.0': '2023-01-01T00:00:00.000Z'
        }
      },
      '@scope/test-package-2': {
        name: '@scope/test-package-2',
        description: 'Scoped test package',
        keywords: ['scoped', 'test'],
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': {
            name: '@scope/test-package-2',
            version: '2.0.0',
            description: 'Scoped test package',
            dependencies: {
              'test-dep': '^1.0.0'
            },
            dist: {
              unpackedSize: 50000,
              fileCount: 20
            }
          }
        },
        time: {
          '2.0.0': '2023-06-01T00:00:00.000Z'
        }
      }
    }
  };
}

export default AxiosMock;

