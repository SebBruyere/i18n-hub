import type { Flat, Snapshot } from '../../api/_lib/format'

export type { Flat, Snapshot }

export interface Project {
  slug: string
  name: string
  baseLanguage: string
  languages: string[]
  currentVersion: number | null
  latestVersion: number | null
  keyCount: number
  hasUnpublished: boolean
  publishedAt: string | null
  createdAt: string
}

export interface KeyRow {
  key: string
  description: string
  values: Flat
}

export type TargetType = 'vercel_hook' | 'github_workflow' | 'webhook'

export interface TargetConfig {
  url?: string
  secret?: string
  owner?: string
  repo?: string
  workflow?: string
  ref?: string
  tokenEnv?: string
}

export interface DeployTarget {
  id: number
  name: string
  type: TargetType
  config: TargetConfig
  autoOnPublish: boolean
}

export interface ProjectDetail {
  project: Project
  keys: KeyRow[]
  live: { version: number; snapshot: Snapshot; createdAt: string } | null
  targets: DeployTarget[]
}

export interface Release {
  version: number
  note: string
  keyCount: number
  createdAt: string
  isLive: boolean
}

export interface DeployResult {
  targetId: number
  name: string
  ok: boolean
  status: number | null
  message: string
}

export interface DeployLog {
  id: number
  targetId: number | null
  name: string
  version: number | null
  ok: boolean
  status: number | null
  message: string
  createdAt: string
}

/** A recorded change to one translation: value null = cleared, previous null = it was empty. */
export interface HistoryEdit {
  key: string
  language: string
  value: string | null
  previous: string | null
  source: 'edit' | 'import' | 'add' | 'duplicate'
  changedAt: string
}

/** The value a release published for a key. */
export interface HistoryRelease {
  version: number
  createdAt: string
  language: string
  key: string
  value: string
}
