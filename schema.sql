-- Minimal NPM Registry Schema
-- Only essential tables for initialize → sync → enrich → export-csv workflow

-- Core packages table with enrichment fields
CREATE TABLE IF NOT EXISTS packages (
  id BIGSERIAL PRIMARY KEY,
  gmt_create TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  gmt_modified TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seq INTEGER NOT NULL,
  name VARCHAR(214) NOT NULL,
  description TEXT,
  keywords TEXT[],
  dependencies JSONB,
  latest_version VARCHAR(100),
  latest_release_published_at TIMESTAMP(3),
  file_count INTEGER DEFAULT 0,
  unpacked_size BIGINT DEFAULT 0,
  dependents_count INTEGER DEFAULT 0,
  enriched_at TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS packages_uk_name ON packages (name);
CREATE UNIQUE INDEX IF NOT EXISTS packages_uk_seq ON packages (seq);
CREATE INDEX IF NOT EXISTS packages_idx_enriched_at ON packages (enriched_at);
CREATE INDEX IF NOT EXISTS packages_idx_gmt_modified ON packages (gmt_modified);

COMMENT ON TABLE packages IS 'npm packages with enrichment metadata';
COMMENT ON COLUMN packages.seq IS 'sequential package number (0-based)';
COMMENT ON COLUMN packages.name IS 'package name (may include scope like @org/pkg)';
COMMENT ON COLUMN packages.description IS 'package description from latest version';
COMMENT ON COLUMN packages.keywords IS 'array of keywords';
COMMENT ON COLUMN packages.dependencies IS 'dependencies object from latest version';
COMMENT ON COLUMN packages.latest_version IS 'latest version number';
COMMENT ON COLUMN packages.latest_release_published_at IS 'publish time of latest version';
COMMENT ON COLUMN packages.file_count IS 'number of files in package';
COMMENT ON COLUMN packages.unpacked_size IS 'total unpacked size in bytes';
COMMENT ON COLUMN packages.dependents_count IS 'number of packages depending on this';
COMMENT ON COLUMN packages.enriched_at IS 'timestamp when metadata was fetched';

-- Total/sync state table (single row)
CREATE TABLE IF NOT EXISTS total (
  name VARCHAR(50) PRIMARY KEY DEFAULT 'global',
  gmt_modified TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  package_count BIGINT NOT NULL DEFAULT 0,
  change_stream_seq BIGINT NOT NULL DEFAULT 0,
  last_sync_time TIMESTAMP(3),
  CONSTRAINT check_single_row CHECK (name = 'global')
);

COMMENT ON TABLE total IS 'global state tracking';
COMMENT ON COLUMN total.package_count IS 'total number of packages';
COMMENT ON COLUMN total.change_stream_seq IS 'last processed sequence from npm _changes API';
COMMENT ON COLUMN total.last_sync_time IS 'last time sync.js was run';

-- Initialize total row
INSERT INTO total (name, package_count, change_stream_seq)
VALUES ('global', 0, 0)
ON CONFLICT (name) DO NOTHING;
