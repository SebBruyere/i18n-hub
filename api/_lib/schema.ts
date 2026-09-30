/**
 * Idempotent schema. Applied automatically on the first request of each cold
 * start (see db.ts), so a fresh Neon database needs no manual migration.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    base_language TEXT NOT NULL,
    languages JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_version INT,
    content_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS translation_keys (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS translations (
    key_id INT NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, language)
  )`,
  `CREATE TABLE IF NOT EXISTS releases (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    snapshot JSONB NOT NULL,
    key_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS deploy_targets (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('vercel_hook', 'github_workflow', 'webhook')),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    auto_on_publish BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS deploy_logs (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_id INT REFERENCES deploy_targets(id) ON DELETE SET NULL,
    target_name TEXT NOT NULL,
    version INT,
    ok BOOLEAN NOT NULL,
    status INT,
    message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS deploy_logs_project_idx ON deploy_logs (project_id, created_at DESC)`,
]
