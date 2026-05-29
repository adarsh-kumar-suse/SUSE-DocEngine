import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { google } from "googleapis";
import { Octokit } from "@octokit/rest";
import * as admin from "firebase-admin";
import multer from "multer";
import axios from "axios";
import fs from "fs";
import os from "os";
import { spawnSync } from "child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import {
  CANONICAL_TEMPLATE_SOURCE,
  applyVariableReplacements,
  buildBaseName,
  buildCanonicalTemplateMain,
  buildReferenceDocInfoContent as buildProfileDocInfoContent,
  buildReferenceMainAdoc,
  buildReferenceVarsData as buildProfileVarsData,
  buildReferenceVarsFileContent as buildProfileVarsFileContent,
  buildReplacementCandidatesFromAttributes,
  buildTemplateFirstBody,
  getCanonicalCommonAssets,
  parseAdocAttributes,
  resolveDocTokenMode,
  resolveReferenceProfile,
  toDocTypePrefix,
  type ReplacementCandidate,
  type ReferenceProfile,
} from "./src/lib/referenceProfiles.ts";

dotenv.config();
const firebaseAdmin = ((admin as unknown as { default?: typeof admin }).default || admin) as typeof admin;

type AuthProvider = "google" | "local";

type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
};

type LocalUserRecord = SessionUser & {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
};

type SessionRecord = SessionUser & {
  token: string;
  createdAt: string;
  expiresAt: string;
};

type JobRecord = {
  id: string;
  userId: string;
  projectId?: string;
  pipelineId?: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  [key: string]: unknown;
};

type MemberRole = "owner" | "editor" | "viewer";
type WorkItemType = "task" | "bug" | "story";
type WorkItemState = "open" | "in_progress" | "review" | "done";

type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  owner_user_id: string;
  is_personal: number;
  workspace_path: string | null;
  git_repo: string | null;
  git_provider: string;
  git_default_branch: string;
  created_at: string;
  updated_at: string;
};

type UserSettingsRow = {
  user_id: string;
  github_token: string | null;
  default_repo: string | null;
  updated_at: string;
};

type ProjectMemberRow = {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRole;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
};

type ProjectInviteRow = {
  id: string;
  project_id: string;
  email: string;
  invited_by_user_id: string;
  role: MemberRole;
  token: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  accepted_by_user_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

type AuthedRequest = Request & { authUser?: SessionUser };

type ApiErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

type ReferenceContext = {
  baseName: string;
  docTypePrefix: string;
  docTokenMode: "doctitle" | "title";
  profileId: string;
  profileFallbackUsed: boolean;
  namingPattern: string;
  suseProductSlug: string;
  suseProductDisplay: string;
  partnerSlug: string;
  partnerDisplay: string;
  partnerProductSlug: string;
  partnerProductDisplay: string;
  pipelineName: string;
};

type RefsetupDocType = "gs" | "rc";

type RefsetupStructureInput = {
  doctype: RefsetupDocType;
  suseProducts: string[];
  partnerKey: string;
  partnerProduct?: string;
  distinctiveText?: string;
};

type PartnerPresetDefinition = {
  partnerKey: string;
  label: string;
  doctype: RefsetupDocType | null;
  sourceUrl: string;
  sourceFileName: string;
  templatePath: string;
  comingSoon: boolean;
};

type PipelineWorkspaceRecord = {
  doctype: RefsetupDocType;
  suseProducts: string[];
  partnerName: string;
  partnerProduct: string;
  distinctiveText: string;
  documentbase: string;
  dcFileName: string;
  partnerFolder: string;
  rootPath: string;
  mainAdocPath: string;
  varsPath: string;
  docinfoPath: string;
  presetPartnerKey: string;
  createdAt: string;
};

// Initialize Data Storage
const configuredDataDir = (process.env.DATA_DIR || "data").trim();
const DATA_DIR = path.isAbsolute(configuredDataDir)
  ? configuredDataDir
  : path.join(process.cwd(), configuredDataDir);
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const COLLAB_DB_FILE = path.join(DATA_DIR, "app.db");
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "sd_session";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 7);
const DEFAULT_APP_URL = process.env.APP_URL || "http://localhost:3000";
const SUPER_ADMIN_USERNAME = (process.env.SUPER_ADMIN_USERNAME || "admin").trim().toLowerCase();
const ADMIN_SUPERUSER_ENABLED = (process.env.ADMIN_SUPERUSER || "true").toLowerCase() !== "false";
const PIPELINE_RESET_CONFIRMATION = "RESET PIPELINE DATA";
const PARTNER_TEMPLATE_REGISTRY_FILE = path.join(
  process.cwd(),
  "common",
  "partner-presets",
  "partner-template-registry.json",
);
const PIPELINE_FILE_EDIT_ALLOWLIST = [".adoc", ".xml", ".json", ".txt", ".md"] as const;
const CORS_ORIGIN_LIST = (process.env.CORS_ORIGINS || `${DEFAULT_APP_URL},http://localhost:3000,http://127.0.0.1:3000`)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

let collaborationDb: DatabaseSync | null = null;
const inviteRateTracker = new Map<string, { windowStartMs: number; count: number }>();

const nowIso = () => new Date().toISOString();
const createRecordId = (prefix: string) => `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
const normalizeEmail = (value: string) => normalizeIdentifier(value);
const isValidMemberRole = (value: string): value is MemberRole =>
  value === "owner" || value === "editor" || value === "viewer";
const isValidWorkItemType = (value: string): value is WorkItemType =>
  value === "task" || value === "bug" || value === "story";
const isValidWorkItemState = (value: string): value is WorkItemState =>
  value === "open" || value === "in_progress" || value === "review" || value === "done";
const isValidGitHubRepo = (value: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test((value || "").trim());

const requireGitHubRepo = (value: unknown, field = "gitRepo") => {
  const trimmed = requireString(value, field);
  if (!isValidGitHubRepo(trimmed)) {
    throw asApiError(400, "INVALID_INPUT", `${field} must use owner/repo format.`);
  }
  return trimmed;
};

const toProjectSlug = (value: string, fallback: string) => {
  const slug = (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
};

const openCollaborationDb = () => {
  if (collaborationDb) return collaborationDb;

  collaborationDb = new DatabaseSync(COLLAB_DB_FILE);
  collaborationDb.exec("PRAGMA foreign_keys = ON;");
  collaborationDb.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      username TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT NOT NULL,
      is_personal INTEGER NOT NULL DEFAULT 0,
      workspace_path TEXT,
      git_repo TEXT,
      git_provider TEXT NOT NULL DEFAULT 'github',
      git_default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      github_token TEXT,
      default_repo TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, user_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_invites (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      email TEXT NOT NULL,
      invited_by_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      accepted_by_user_id TEXT,
      accepted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_pipelines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      base_job_id TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      latest_version_no INTEGER NOT NULL DEFAULT 0,
      head_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, slug),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pipeline_versions (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      created_by_user_id TEXT NOT NULL,
      parent_version_id TEXT,
      base_version_id TEXT,
      source_job_id TEXT,
      change_summary TEXT,
      content_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'working',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(pipeline_id, version_no),
      FOREIGN KEY(pipeline_id) REFERENCES project_pipelines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS merge_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      source_version_id TEXT NOT NULL,
      target_version_id TEXT,
      source_branch_id TEXT,
      target_branch_id TEXT,
      source_commit_id TEXT,
      target_commit_id TEXT,
      linked_work_item_id TEXT,
      created_by_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      approval_user_id TEXT,
      approved_at TEXT,
      merged_by_user_id TEXT,
      merged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(pipeline_id) REFERENCES project_pipelines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_branches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      base_version_id TEXT,
      head_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(pipeline_id, name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(pipeline_id) REFERENCES project_pipelines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pipeline_commits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      message TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      linked_work_item_id TEXT,
      git_sha TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(pipeline_id) REFERENCES project_pipelines(id) ON DELETE CASCADE,
      FOREIGN KEY(branch_id) REFERENCES project_branches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'task',
      state TEXT NOT NULL DEFAULT 'open',
      created_by_user_id TEXT NOT NULL,
      assignee_user_id TEXT,
      pipeline_id TEXT,
      branch_id TEXT,
      merge_request_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_activity (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS migration_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    collaborationDb.exec("ALTER TABLE projects ADD COLUMN git_repo TEXT;");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE projects ADD COLUMN git_provider TEXT DEFAULT 'github';");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE projects ADD COLUMN git_default_branch TEXT DEFAULT 'main';");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE merge_requests ADD COLUMN source_branch_id TEXT;");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE merge_requests ADD COLUMN target_branch_id TEXT;");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE merge_requests ADD COLUMN source_commit_id TEXT;");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE merge_requests ADD COLUMN target_commit_id TEXT;");
  } catch {}
  try {
    collaborationDb.exec("ALTER TABLE merge_requests ADD COLUMN linked_work_item_id TEXT;");
  } catch {}
  collaborationDb.exec("CREATE INDEX IF NOT EXISTS idx_project_branches_project ON project_branches(project_id);");
  collaborationDb.exec("CREATE INDEX IF NOT EXISTS idx_project_branches_pipeline ON project_branches(pipeline_id);");
  collaborationDb.exec("CREATE INDEX IF NOT EXISTS idx_pipeline_commits_pipeline ON pipeline_commits(pipeline_id);");
  collaborationDb.exec("CREATE INDEX IF NOT EXISTS idx_pipeline_commits_branch ON pipeline_commits(branch_id);");
  collaborationDb.exec("CREATE INDEX IF NOT EXISTS idx_project_work_items_project ON project_work_items(project_id);");
  collaborationDb.exec("CREATE INDEX IF NOT EXISTS idx_project_work_items_state ON project_work_items(project_id, state);");

  return collaborationDb;
};

const withDbTransaction = <T>(callback: (db: DatabaseSync) => T): T => {
  const db = openCollaborationDb();
  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    const result = callback(db);
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
};

const enforceInviteRateLimit = (userId: string) => {
  const nowMs = Date.now();
  const windowMs = 60 * 1000;
  const maxInvitesPerWindow = 10;
  const record = inviteRateTracker.get(userId);
  if (!record || nowMs - record.windowStartMs > windowMs) {
    inviteRateTracker.set(userId, { windowStartMs: nowMs, count: 1 });
    return;
  }
  if (record.count >= maxInvitesPerWindow) {
    throw asApiError(429, "INVITE_RATE_LIMITED", "Too many invites. Please retry in a minute.");
  }
  record.count += 1;
  inviteRateTracker.set(userId, record);
};

const ensureJsonFile = <T>(filePath: string, initialValue: T) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialValue, null, 2));
  }
};

ensureJsonFile(JOBS_FILE, []);
ensureJsonFile(USERS_FILE, []);
ensureJsonFile(SESSIONS_FILE, []);

const readJsonFile = <T>(filePath: string, fallback: T): T => {
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
};

const writeJsonFile = <T>(filePath: string, data: T) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// Helper to read/write local jobs
const getLocalJobs = (): JobRecord[] => readJsonFile<JobRecord[]>(JOBS_FILE, []);

const saveLocalJobs = (jobs: JobRecord[]) => writeJsonFile(JOBS_FILE, jobs);

const getLocalUsers = (): LocalUserRecord[] => readJsonFile<LocalUserRecord[]>(USERS_FILE, []);
const saveLocalUsers = (users: LocalUserRecord[]) => writeJsonFile(USERS_FILE, users);

const getSessions = (): SessionRecord[] => readJsonFile<SessionRecord[]>(SESSIONS_FILE, []);
const saveSessions = (sessions: SessionRecord[]) => writeJsonFile(SESSIONS_FILE, sessions);

const normalizeIdentifier = (value: string) => (value || "").trim().toLowerCase();

const upsertUserProfile = (user: SessionUser, username?: string) => {
  const db = openCollaborationDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO user_profiles (id, email, display_name, provider, username, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       provider = excluded.provider,
       username = COALESCE(excluded.username, user_profiles.username),
       updated_at = excluded.updated_at`,
  ).run(user.id, normalizeEmail(user.email), user.displayName || user.email, user.provider, username || null, now, now);
};

const upsertLocalUsersInProfiles = () => {
  const users = getLocalUsers();
  users.forEach((user) => {
    upsertUserProfile(
      { id: user.id, email: user.email, displayName: user.displayName, provider: user.provider },
      user.username,
    );
  });
};

const isSuperAdminUser = (userId: string) => {
  if (!ADMIN_SUPERUSER_ENABLED) return false;
  const admin = getLocalUsers().find((user) => normalizeIdentifier(user.username) === SUPER_ADMIN_USERNAME);
  return Boolean(admin && admin.id === userId);
};

const getMemberRoleForProject = (projectId: string, userId: string): MemberRole | null => {
  const db = openCollaborationDb();
  const row = db
    .prepare(
      `SELECT role
       FROM project_members
       WHERE project_id = ? AND user_id = ? AND status = 'active'`,
    )
    .get(projectId, userId) as { role: string } | undefined;
  if (!row || !isValidMemberRole(row.role)) return null;
  return row.role;
};

const requireProjectRole = (
  userId: string,
  projectId: string,
  acceptedRoles: MemberRole[],
) => {
  if (isSuperAdminUser(userId)) return "owner";
  const role = getMemberRoleForProject(projectId, userId);
  if (!role || !acceptedRoles.includes(role)) {
    throw asApiError(403, "FORBIDDEN", "You do not have access to this project.");
  }
  return role;
};

const getPersonalProjectForUser = (userId: string): ProjectRow | null => {
  const db = openCollaborationDb();
  const row = db
    .prepare(
      `SELECT id, name, slug, description, owner_user_id, is_personal, workspace_path, git_repo, git_provider, git_default_branch, created_at, updated_at
       FROM projects
       WHERE owner_user_id = ? AND is_personal = 1
       LIMIT 1`,
    )
    .get(userId) as ProjectRow | undefined;
  return row || null;
};

const createProjectWithOwner = (
  owner: SessionUser,
  input: {
    name: string;
    description?: string;
    slug?: string;
    isPersonal?: boolean;
    gitRepo?: string | null;
    gitProvider?: string;
    defaultBranch?: string;
  },
) => {
  const db = openCollaborationDb();
  const now = nowIso();
  const projectId = createRecordId("prj");
  const baseSlug = toProjectSlug(input.slug || input.name, `${toProjectSlug(owner.displayName || owner.email, "user")}-project`);
  let slug = baseSlug;
  let idx = 2;
  while (
    db.prepare("SELECT 1 FROM projects WHERE slug = ? LIMIT 1").get(slug) as { 1: number } | undefined
  ) {
    slug = `${baseSlug}-${idx}`;
    idx += 1;
  }

  const description = (input.description || "").trim();
  const isPersonal = input.isPersonal ? 1 : 0;
  const gitRepo = (input.gitRepo || "").trim() || null;
  if (!isPersonal && !gitRepo) {
    throw asApiError(400, "INVALID_INPUT", "gitRepo is required to create a collaboration project.");
  }
  if (gitRepo && !isValidGitHubRepo(gitRepo)) {
    throw asApiError(400, "INVALID_INPUT", "gitRepo must use owner/repo format.");
  }
  const gitProvider = (input.gitProvider || "github").trim().toLowerCase() || "github";
  const defaultBranch = (input.defaultBranch || "main").trim() || "main";
  withDbTransaction((tx) => {
    tx.prepare(
      `INSERT INTO projects (id, name, slug, description, owner_user_id, is_personal, git_repo, git_provider, git_default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, input.name.trim(), slug, description, owner.id, isPersonal, gitRepo, gitProvider, defaultBranch, now, now);
    tx.prepare(
      `INSERT INTO project_members (id, project_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    ).run(createRecordId("pm"), projectId, owner.id, now, now);
  });
  return projectId;
};

const getUserSettings = (userId: string): UserSettingsRow => {
  const db = openCollaborationDb();
  const row = db
    .prepare("SELECT user_id, github_token, default_repo, updated_at FROM user_settings WHERE user_id = ? LIMIT 1")
    .get(userId) as UserSettingsRow | undefined;
  return (
    row || {
      user_id: userId,
      github_token: null,
      default_repo: null,
      updated_at: nowIso(),
    }
  );
};

const upsertUserSettings = (userId: string, payload: { githubToken?: string; defaultRepo?: string }) => {
  const current = getUserSettings(userId);
  const nextToken =
    payload.githubToken !== undefined ? (payload.githubToken.trim() || null) : (current.github_token || null);
  const nextRepo =
    payload.defaultRepo !== undefined ? (payload.defaultRepo.trim() || null) : (current.default_repo || null);
  openCollaborationDb()
    .prepare(
      `INSERT INTO user_settings (user_id, github_token, default_repo, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         github_token = excluded.github_token,
         default_repo = excluded.default_repo,
         updated_at = excluded.updated_at`,
    )
    .run(userId, nextToken, nextRepo, nowIso());
};

const ensurePersonalProjectForUser = (user: SessionUser) => {
  const existing = getPersonalProjectForUser(user.id);
  if (existing) return existing.id;
  const userSettings = getUserSettings(user.id);
  return createProjectWithOwner(user, {
    name: `${user.displayName || user.email} personal project`,
    description: "Default personal workspace",
    slug: `${toProjectSlug(user.displayName || user.email, "user")}-personal`,
    isPersonal: true,
    gitRepo: userSettings.default_repo || null,
    gitProvider: "github",
    defaultBranch: "main",
  });
};

const setProjectWorkspacePath = (projectId: string, workspacePath: string) => {
  const db = openCollaborationDb();
  db.prepare("UPDATE projects SET workspace_path = ?, updated_at = ? WHERE id = ?").run(
    workspacePath,
    nowIso(),
    projectId,
  );
};

const createPipelineVersion = (
  pipelineId: string,
  userId: string,
  payload: {
    sourceJobId?: string | null;
    parentVersionId?: string | null;
    baseVersionId?: string | null;
    changeSummary?: string | null;
    content: unknown;
    status: "working" | "published" | "merged";
  },
) => {
  const db = openCollaborationDb();
  const pipelineRow = db
    .prepare("SELECT latest_version_no FROM project_pipelines WHERE id = ?")
    .get(pipelineId) as { latest_version_no: number } | undefined;
  if (!pipelineRow) {
    throw asApiError(404, "NOT_FOUND", "Pipeline not found.");
  }
  const now = nowIso();
  const versionNo = Number(pipelineRow.latest_version_no || 0) + 1;
  const versionId = createRecordId("ver");
  const contentJson = JSON.stringify(payload.content ?? {});
  withDbTransaction((tx) => {
    tx.prepare(
      `INSERT INTO pipeline_versions
       (id, pipeline_id, version_no, created_by_user_id, parent_version_id, base_version_id, source_job_id, change_summary, content_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      versionId,
      pipelineId,
      versionNo,
      userId,
      payload.parentVersionId || null,
      payload.baseVersionId || null,
      payload.sourceJobId || null,
      payload.changeSummary || null,
      contentJson,
      payload.status,
      now,
      now,
    );
    tx.prepare(
      "UPDATE project_pipelines SET latest_version_no = ?, head_version_id = ?, updated_at = ? WHERE id = ?",
    ).run(versionNo, versionId, now, pipelineId);
  });
  return { versionId, versionNo };
};

const ensurePipelineForJob = (job: JobRecord, actorUserId: string) => {
  const db = openCollaborationDb();
  const existing = db
    .prepare("SELECT id FROM project_pipelines WHERE base_job_id = ? LIMIT 1")
    .get(job.id) as { id: string } | undefined;
  if (existing) return existing.id;
  if (!job.projectId) return null;
  const project = getProjectById(job.projectId);
  const defaultBranch = (project?.git_default_branch || "main").trim() || "main";

  const now = nowIso();
  const pipelineId = createRecordId("pl");
  const title = String(job.googleDocTitle || job.id);
  const baseSlug = toProjectSlug(title, `pipeline-${job.id.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`);
  let slug = baseSlug;
  let idx = 2;
  while (
    db.prepare("SELECT 1 FROM project_pipelines WHERE project_id = ? AND slug = ? LIMIT 1").get(job.projectId, slug) as
      | { 1: number }
      | undefined
  ) {
    slug = `${baseSlug}-${idx}`;
    idx += 1;
  }

  withDbTransaction((tx) => {
    tx.prepare(
      `INSERT INTO project_pipelines
       (id, project_id, name, slug, created_by_user_id, base_job_id, default_branch, latest_version_no, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(pipelineId, job.projectId, title, slug, actorUserId, job.id, defaultBranch, now, now);
  });

  const initialVersion = createPipelineVersion(pipelineId, actorUserId, {
    sourceJobId: job.id,
    parentVersionId: null,
    baseVersionId: null,
    changeSummary: "Initial version from job migration",
    content: {
      asciiDocContent: typeof job.asciiDocContent === "string" ? job.asciiDocContent : "",
      metadata: typeof job.metadata === "object" ? job.metadata : {},
    },
    status: "published",
  });
  const defaultBranchId = createRecordId("br");
  db.prepare(
    `INSERT OR IGNORE INTO project_branches
     (id, project_id, pipeline_id, name, created_by_user_id, base_version_id, head_version_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    defaultBranchId,
    job.projectId,
    pipelineId,
    defaultBranch,
    actorUserId,
    initialVersion.versionId,
    initialVersion.versionId,
    nowIso(),
    nowIso(),
  );

  return pipelineId;
};

const recordProjectActivity = (
  projectId: string,
  actorUserId: string,
  eventType: string,
  payload: Record<string, unknown>,
) => {
  const db = openCollaborationDb();
  db.prepare(
    `INSERT INTO project_activity (id, project_id, actor_user_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(createRecordId("act"), projectId, actorUserId, eventType, JSON.stringify(payload || {}), nowIso());
};

const getDefaultBranchRecord = (projectId: string, pipelineId: string) => {
  const db = openCollaborationDb();
  const pipeline = db
    .prepare("SELECT default_branch, head_version_id FROM project_pipelines WHERE id = ? AND project_id = ?")
    .get(pipelineId, projectId) as { default_branch: string; head_version_id: string | null } | undefined;
  if (!pipeline) return null;
  const branchName = (pipeline.default_branch || "main").trim() || "main";
  let branch = db
    .prepare("SELECT id, name, base_version_id, head_version_id FROM project_branches WHERE pipeline_id = ? AND name = ?")
    .get(pipelineId, branchName) as
    | { id: string; name: string; base_version_id: string | null; head_version_id: string | null }
    | undefined;
  if (!branch) {
    const branchId = createRecordId("br");
    db.prepare(
      `INSERT INTO project_branches
       (id, project_id, pipeline_id, name, created_by_user_id, base_version_id, head_version_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'system', ?, ?, 'active', ?, ?)`,
    ).run(branchId, projectId, pipelineId, branchName, pipeline.head_version_id || null, pipeline.head_version_id || null, nowIso(), nowIso());
    branch = db
      .prepare("SELECT id, name, base_version_id, head_version_id FROM project_branches WHERE id = ?")
      .get(branchId) as { id: string; name: string; base_version_id: string | null; head_version_id: string | null } | undefined;
  }
  return branch || null;
};

const normalizeVersionFiles = (rawContent: unknown): Record<string, string> => {
  if (typeof rawContent === "string") {
    return { "adoc/main.adoc": rawContent };
  }
  if (!rawContent || typeof rawContent !== "object") {
    return { "content.json": JSON.stringify(rawContent ?? null, null, 2) };
  }

  const content = rawContent as Record<string, unknown>;
  const files = new Map<string, string>();
  const pushFile = (filePath: string, value: unknown) => {
    if (value === undefined) return;
    if (typeof value === "string") {
      files.set(filePath, value);
      return;
    }
    files.set(filePath, JSON.stringify(value ?? null, null, 2));
  };

  if (typeof content.adoc === "string") {
    pushFile("adoc/main.adoc", content.adoc);
  }
  if (typeof content.asciiDocContent === "string") {
    pushFile("adoc/main.adoc", content.asciiDocContent);
  }
  if (content.metadata !== undefined) {
    pushFile("metadata.json", content.metadata);
  }
  if (content.files && typeof content.files === "object" && !Array.isArray(content.files)) {
    for (const [filePath, value] of Object.entries(content.files as Record<string, unknown>)) {
      const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
      if (!normalized) continue;
      pushFile(normalized, value);
    }
  }

  if (files.size === 0) {
    for (const [key, value] of Object.entries(content)) {
      if (["adoc", "asciiDocContent", "metadata", "files"].includes(key)) continue;
      const suffix = typeof value === "string" ? "txt" : "json";
      pushFile(`content/${key}.${suffix}`, value);
    }
  }

  if (files.size === 0) {
    pushFile("content.json", content);
  }

  return Object.fromEntries(files.entries());
};

const countChangedDiffLines = (diffText: string) =>
  diffText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .filter((line) => !line.startsWith("+++") && !line.startsWith("---")).length;

const buildUnifiedDiff = (leftText: string, rightText: string, label: string) => {
  if (leftText === rightText) return "";
  const left = leftText.split(/\r?\n/);
  const right = rightText.split(/\r?\n/);
  const maxLinesForLcs = 600;
  if (left.length > maxLinesForLcs || right.length > maxLinesForLcs) {
    return `--- a/${label}\n+++ b/${label}\n@@\n-<content too large for inline diff>\n+<content too large for inline diff>`;
  }

  const m = left.length;
  const n = right.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: string[] = [`--- a/${label}`, `+++ b/${label}`, "@@"];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (left[i] === right[j]) {
      rows.push(` ${left[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push(`-${left[i]}`);
      i += 1;
    } else {
      rows.push(`+${right[j]}`);
      j += 1;
    }
  }
  while (i < m) {
    rows.push(`-${left[i]}`);
    i += 1;
  }
  while (j < n) {
    rows.push(`+${right[j]}`);
    j += 1;
  }
  return rows.join("\n");
};

const isGitConflictMessage = (message: string) =>
  /non-fast-forward|fetch first|rejected|conflict|failed to push|cannot lock ref|unmerged/i.test(message || "");

const resolvePipelineAsciiTargetPath = (
  pipeline: { id: string; slug: string; base_job_id: string | null },
  workspacePath: string,
) => {
  const workspaceRoot = path.resolve(workspacePath);
  if (pipeline.base_job_id) {
    const baseJob = getLocalJobs().find((job) => job.id === pipeline.base_job_id);
    const raw = typeof baseJob?.asciiDocPath === "string" ? baseJob.asciiDocPath.trim() : "";
    if (raw) {
      const candidate = path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
      const resolvedCandidate = path.resolve(candidate);
      if (resolvedCandidate.startsWith(workspaceRoot)) {
        return resolvedCandidate;
      }
    }
  }
  return path.join(workspaceRoot, ".suse-docengine", "pipelines", `${pipeline.slug || pipeline.id}.adoc`);
};

const getProjectById = (projectId: string): ProjectRow | null => {
  const db = openCollaborationDb();
  const row = db
    .prepare(
      `SELECT id, name, slug, description, owner_user_id, is_personal, workspace_path, git_repo, git_provider, git_default_branch, created_at, updated_at
       FROM projects
       WHERE id = ?`,
    )
    .get(projectId) as ProjectRow | undefined;
  return row || null;
};

const listProjectsForUser = (userId: string) => {
  const db = openCollaborationDb();
  if (isSuperAdminUser(userId)) {
    const rows = db
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.slug,
           p.description,
           p.owner_user_id,
           p.is_personal,
           p.workspace_path,
           p.git_repo,
           p.git_provider,
           p.git_default_branch,
           p.created_at,
           p.updated_at,
           COALESCE(pm.role, 'owner') AS role,
           COALESCE(COUNT(pl.id), 0) AS pipeline_count
         FROM projects p
         LEFT JOIN project_members pm
           ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'active'
         LEFT JOIN project_pipelines pl ON pl.project_id = p.id
         GROUP BY p.id, pm.role
         ORDER BY p.is_personal DESC, p.updated_at DESC`,
      )
      .all(userId) as Array<ProjectRow & { role: MemberRole; pipeline_count: number }>;
    return rows;
  }

  const rows = db
    .prepare(
      `SELECT
         p.id,
         p.name,
         p.slug,
         p.description,
         p.owner_user_id,
         p.is_personal,
         p.workspace_path,
         p.git_repo,
         p.git_provider,
         p.git_default_branch,
         p.created_at,
         p.updated_at,
         pm.role,
         COALESCE(COUNT(pl.id), 0) AS pipeline_count
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       LEFT JOIN project_pipelines pl ON pl.project_id = p.id
       WHERE pm.user_id = ? AND pm.status = 'active'
       GROUP BY p.id, pm.role
       ORDER BY p.is_personal DESC, p.updated_at DESC`,
    )
    .all(userId) as Array<ProjectRow & { role: MemberRole; pipeline_count: number }>;
  return rows;
};

const resolveProjectWorkspacePath = (projectId: string): string | null => {
  const project = getProjectById(projectId);
  if (!project) return null;
  if (project.workspace_path && project.workspace_path.trim()) {
    const candidate = project.workspace_path.trim();
    return path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
  }

  const jobs = getLocalJobs()
    .filter((job) => job.projectId === projectId)
    .map((job) => String(job.outputFolderPath || "").trim())
    .filter(Boolean);
  if (jobs.length === 0) return null;
  const candidate = jobs[0];
  return path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
};

const migrateExistingJobsToProjects = () => {
  const db = openCollaborationDb();
  const migration = db
    .prepare("SELECT value FROM migration_state WHERE key = 'jobs_personal_projects_v1' LIMIT 1")
    .get() as { value: string } | undefined;
  if (migration?.value === "done") return;

  const usersById = new Map(
    getLocalUsers().map((user) => [
      user.id,
      {
        id: user.id,
        email: user.email,
        displayName: user.displayName || user.username || user.email,
        provider: user.provider,
      } satisfies SessionUser,
    ]),
  );

  const jobs = getLocalJobs();
  let changed = false;
  jobs.forEach((job) => {
    const owner = usersById.get(job.userId);
    if (!owner) return;
    const projectId = job.projectId || ensurePersonalProjectForUser(owner);
    if (!job.projectId) {
      job.projectId = projectId;
      changed = true;
    }
    const pipelineId = ensurePipelineForJob(job, owner.id);
    if (pipelineId && !job.pipelineId) {
      job.pipelineId = pipelineId;
      changed = true;
    }
  });
  if (changed) saveLocalJobs(jobs);

  db.prepare(
    `INSERT INTO migration_state (key, value, updated_at)
     VALUES ('jobs_personal_projects_v1', 'done', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(nowIso());
};

const hashPassword = (password: string, salt?: string) => {
  const appliedSalt = salt || randomBytes(16).toString("hex");
  const hash = scryptSync(password, appliedSalt, 64).toString("hex");
  return { salt: appliedSalt, hash };
};

const verifyPassword = (password: string, salt: string, expectedHash: string) => {
  const { hash } = hashPassword(password, salt);
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
};

const pruneExpiredSessions = () => {
  const now = Date.now();
  const sessions = getSessions();
  const active = sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  if (active.length !== sessions.length) {
    saveSessions(active);
  }
  return active;
};

const createSession = (user: SessionUser): SessionRecord => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const session: SessionRecord = {
    token: randomBytes(48).toString("hex"),
    createdAt,
    expiresAt,
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    provider: user.provider,
  };
  const sessions = pruneExpiredSessions();
  sessions.push(session);
  saveSessions(sessions);
  return session;
};

const clearSession = (token?: string) => {
  if (!token) return;
  const sessions = getSessions().filter((session) => session.token !== token);
  saveSessions(sessions);
};

const getSessionUserByToken = (token?: string): SessionUser | null => {
  if (!token) return null;
  const sessions = pruneExpiredSessions();
  const found = sessions.find((session) => session.token === token);
  if (!found) return null;
  return {
    id: found.id,
    email: found.email,
    displayName: found.displayName,
    provider: found.provider,
  };
};

const asApiError = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  payload: { code, message, details } satisfies ApiErrorPayload,
});

const sendApiError = (res: Response, status: number, code: string, message: string, details?: unknown) =>
  res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });

const logEvent = (event: string, details: Record<string, unknown>) => {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
    }),
  );
};

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

const cookieSecureDefault = DEFAULT_APP_URL.startsWith("https://");
const cookieSecure = parseBoolean(process.env.SESSION_COOKIE_SECURE, cookieSecureDefault);
const cookieSameSite = ((process.env.SESSION_COOKIE_SAMESITE || "lax").toLowerCase() as "lax" | "strict" | "none");

const setSessionCookie = (res: Response, token: string) => {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
};

const clearSessionCookie = (res: Response) => {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    path: "/",
  });
};

const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const sessionUser = getSessionUserByToken(token);
  if (!sessionUser) {
    return sendApiError(res, 401, "AUTH_REQUIRED", "Authentication required.");
  }
  req.authUser = sessionUser;
  return next();
};

const requireString = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) {
    throw asApiError(400, "INVALID_INPUT", `${field} is required.`);
  }
  return value.trim();
};

const getAuthUser = (req: AuthedRequest): SessionUser => {
  if (!req.authUser) throw asApiError(401, "AUTH_REQUIRED", "Authentication required.");
  return req.authUser;
};

const getFirebaseProjectId = (): string | undefined => {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return parsed?.projectId as string | undefined;
  } catch {
    return undefined;
  }
};

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const initializeFirebaseAdmin = () => {
  if (firebaseAdmin.apps.length > 0) return;
  const projectId = getFirebaseProjectId();
  if (projectId) {
    firebaseAdmin.initializeApp({ projectId });
    return;
  }
  firebaseAdmin.initializeApp();
};

const seedAdminUser = () => {
  const users = getLocalUsers();
  let adminUser = users.find((user) => normalizeIdentifier(user.username) === SUPER_ADMIN_USERNAME);
  if (!adminUser) {
    const now = nowIso();
    const password = hashPassword("admin123");
    adminUser = {
      id: `local-admin-${Date.now()}`,
      email: "admin@local",
      displayName: "System Admin",
      provider: "local",
      username: SUPER_ADMIN_USERNAME,
      passwordSalt: password.salt,
      passwordHash: password.hash,
      createdAt: now,
    };
    users.push(adminUser);
    saveLocalUsers(users);
  }
  upsertUserProfile(
    {
      id: adminUser.id,
      email: adminUser.email,
      displayName: adminUser.displayName,
      provider: adminUser.provider,
    },
    adminUser.username,
  );
  ensurePersonalProjectForUser({
    id: adminUser.id,
    email: adminUser.email,
    displayName: adminUser.displayName,
    provider: adminUser.provider,
  });
};

const resetPipelineDataStore = () => {
  const removed: string[] = [];
  const root = process.cwd();
  const clearTargets = [
    path.join(DATA_DIR, "jobs.json"),
    path.join(DATA_DIR, "users.json"),
    path.join(DATA_DIR, "sessions.json"),
    path.join(DATA_DIR, "app.db"),
    path.join(DATA_DIR, "extractions"),
    path.join(DATA_DIR, "media"),
    path.join(DATA_DIR, "pipeline-temp"),
    path.join(DATA_DIR, "pipeline-snapshots"),
    path.join(root, "document"),
    path.join(root, "references"),
    path.join(root, "reference"),
    path.join(root, "pipeline-temp"),
    path.join(root, "pipeline-snapshots"),
  ];

  try {
    collaborationDb?.close();
  } catch {
    // ignore close failures; file removal below is best effort
  } finally {
    collaborationDb = null;
  }

  clearTargets.forEach((targetPath) => {
    if (!isPathWithin(targetPath, root) && !isPathWithin(targetPath, DATA_DIR)) {
      return;
    }
    if (!fs.existsSync(targetPath)) return;
    fs.rmSync(targetPath, { recursive: true, force: true });
    removed.push(path.relative(root, targetPath).replace(/\\/g, "/"));
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonFile(JOBS_FILE, []);
  writeJsonFile(USERS_FILE, []);
  writeJsonFile(SESSIONS_FILE, []);
  openCollaborationDb();
  seedAdminUser();
  upsertLocalUsersInProfiles();
  migrateExistingJobsToProjects();
  return removed;
};

  const toAsciiCell = (value: string) => (value || "").replace(/\r?\n/g, " +\n").trim();

const copyExtractionAssetsToProject = (metadata: any, projectDir: string) => {
    if (!metadata?.sections?.length) return;

    metadata.sections.forEach((section: any) => {
      section.blocks?.forEach((block: any) => {
        if (block.type !== "image") return;

        const relativeAssetPath = (block.media_target_path || block.asset_path || "").replace(/\\/g, "/");
        if (!relativeAssetPath) return;

        const sourcePath = path.join(DATA_DIR, relativeAssetPath);
        const destinationPath = path.join(projectDir, relativeAssetPath);

        if (!fs.existsSync(sourcePath)) return;

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
      });
    });
  };

const titleCaseToSentenceCase = (value: string) => {
  const input = (value || "").trim();
  if (!input) return input;
  return input.charAt(0).toUpperCase() + input.slice(1);
};

const mediaSubfolderForExtension = (extensionRaw: string) => {
  const extension = (extensionRaw || "").replace(/^\./, "").toLowerCase();
  if (extension === "svg") return "svg";
  if (extension === "jpg" || extension === "jpeg" || extension === "jpe") return "jpg";
  return "png";
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeExtractedText = (value: string) =>
  (value || "")
    .replace(/Â®/g, "®")
    .replace(/Â/g, "")
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, "\"")
    .replace(/â€/g, "\"")
    .replace(/â€"/g, "\"")
    .replace(/â€¦/g, "...")
    .replace(/â€“/g, "-")
    .replace(/â€”/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const toDisplayNameFromSlug = (value: string, fallback: string) => {
  const raw = (value || "").trim();
  if (!raw) return fallback;
  if (/[A-Z]/.test(raw) || /\s/.test(raw)) return raw.replace(/\s+/g, " ").trim();

  const acronyms = new Map<string, string>([
    ["ai", "AI"],
    ["api", "API"],
    ["clearml", "ClearML"],
    ["cpu", "CPU"],
    ["gpu", "GPU"],
    ["k3s", "K3s"],
    ["ml", "ML"],
    ["mlops", "MLOps"],
    ["openchoreo", "OpenChoreo"],
    ["rke", "RKE"],
    ["rke2", "RKE2"],
    ["suse", "SUSE"],
    ["trd", "TRD"],
    ["wso2", "WSO2"],
  ]);

  return raw
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      const acronym = acronyms.get(lower);
      if (acronym) return acronym;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
};

const normalizeForCompare = (value: string) =>
  normalizeExtractedText((value || "").toLowerCase()).replace(/[^a-z0-9]+/g, "");

const buildReferenceContext = (
  jobRecord: JobRecord | undefined,
  metadata: any,
  baseNameFallback?: string,
): ReferenceContext => {
  const projectSetup =
    typeof jobRecord?.projectSetup === "object" && jobRecord?.projectSetup
      ? (jobRecord.projectSetup as Record<string, unknown>)
      : {};
  const rawSuseProduct = String(
    projectSetup.suseProduct ||
      metadata?.suse_product_display ||
      metadata?.suse_product_slug ||
      "SUSE AI",
  );
  const rawPartnerName = String(
    projectSetup.partnerName ||
      metadata?.partner_display ||
      metadata?.partner_slug ||
      "clearml",
  );
  const rawPartnerProduct = String(
    projectSetup.partnerProduct ||
      metadata?.partner_product_display ||
      metadata?.partner_product_slug ||
      "clearml",
  );
  const rawDocType = String(projectSetup.documentType || metadata?.doc_type || "reference");
  const requestedProfileId = String(
    projectSetup.profileId ||
      metadata?.profileId ||
      metadata?.reference_profile?.profileId ||
      "",
  ).trim();

  const suseProductSlug = toSlug(rawSuseProduct, "suse-ai");
  const partnerSlug = toSlug(rawPartnerName, "clearml");
  const partnerProductSlug = toSlug(rawPartnerProduct, "clearml");
  const docTypePrefix = toDocTypePrefix(rawDocType);
  const profileResolution = resolveReferenceProfile(rawPartnerName, requestedProfileId);
  const resolvedProfile = profileResolution.profile;
  const baseName =
    baseNameFallback ||
    buildBaseName({
      profile: resolvedProfile,
      docTypePrefix,
      suseProductSlug,
      partnerProductSlug,
    });
  const pipelineName = String(
    metadata?.source_name ||
      (typeof jobRecord?.googleDocTitle === "string" ? jobRecord.googleDocTitle : "") ||
      "",
  ).trim();

  return {
    baseName,
    docTypePrefix,
    docTokenMode: resolveDocTokenMode(docTypePrefix),
    profileId: resolvedProfile.id,
    profileFallbackUsed: profileResolution.fallbackUsed,
    namingPattern: resolvedProfile.namingPattern,
    suseProductSlug,
    suseProductDisplay: toDisplayNameFromSlug(rawSuseProduct, "SUSE AI"),
    partnerSlug,
    partnerDisplay: toDisplayNameFromSlug(rawPartnerName, "Partner"),
    partnerProductSlug,
    partnerProductDisplay: toDisplayNameFromSlug(rawPartnerProduct, "Partner Product"),
    pipelineName,
  };
};

const resolveProfileForContext = (context: ReferenceContext): ReferenceProfile =>
  resolveReferenceProfile(context.partnerSlug, context.profileId).profile;

const getReplacementCandidatesForContext = (context: ReferenceContext) => {
  const profile = resolveProfileForContext(context);
  const varsMap = buildProfileVarsData(context, profile, context.pipelineName);
  return buildReplacementCandidatesFromAttributes(new Map<string, string>(Object.entries(varsMap)));
};

const applyCoreVariableReferences = (
  value: string,
  context: ReferenceContext,
  candidatesOverride?: ReplacementCandidate[],
) => {
  const source = normalizeExtractedText(value || "");
  if (!source) return "";
  if (/^\s*:[A-Za-z0-9._-]+:\s*/.test(source)) return source;

  const profileCandidates = candidatesOverride || getReplacementCandidatesForContext(context);
  const withProfileVariables = applyReplacementsInUnprotectedSegments(source, profileCandidates);
  const replacementPairs: Array<{ literal: string; token: string }> = [
    {
      literal: `${context.suseProductDisplay} and ${context.partnerProductDisplay}`,
      token: "{suse-product} and {partner-product}",
    },
    { literal: context.suseProductDisplay, token: "{suse-product}" },
    { literal: context.partnerProductDisplay, token: "{partner-product}" },
    { literal: context.partnerDisplay, token: "{partner}" },
  ];

  const uniquePairs = replacementPairs.filter((pair, index, allPairs) => {
    if (!pair.literal) return false;
    return (
      index ===
      allPairs.findIndex(
        (candidate) =>
          normalizeForCompare(candidate.literal) === normalizeForCompare(pair.literal) &&
          candidate.token === pair.token,
      )
    );
  });

  uniquePairs.sort((a, b) => b.literal.length - a.literal.length);

  const coreCandidates = uniquePairs.map((pair) => ({ literal: pair.literal, token: pair.token }));
  const output = applyReplacementsInUnprotectedSegments(withProfileVariables, coreCandidates);
  if (!validateSnippetRenderSafety(output)) {
    return source;
  }
  return output;
};

const buildReferenceVarsFileContent = (
  context: ReferenceContext,
  sourceDocumentTitle?: string,
) => {
  const profile = resolveProfileForContext(context);
  const baseVars = buildProfileVarsData(context, profile, sourceDocumentTitle);
  const lines = Object.keys(baseVars)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `:${key}: ${baseVars[key] ?? ""}`);
  return `// Generated by profile: ${profile.id}\n${lines.join("\n")}\n`;
};

const buildReferenceDocInfoContent = (context: ReferenceContext) => {
  const profile = resolveProfileForContext(context);
  return buildProfileDocInfoContent(context, profile);
};

const syncReferenceVarsFile = (
  varsPath: string,
  context: ReferenceContext,
  sourceDocumentTitle?: string,
) => {
  const preset = readPartnerPresetRegistry().find(
    (entry) => entry.partnerKey === String(context.partnerSlug || "").trim().toLowerCase() && !entry.comingSoon,
  );
  if (preset) {
    const canonical = getPartnerPresetTemplateContent(preset);
    const current = fs.existsSync(varsPath) ? fs.readFileSync(varsPath, "utf8") : "";
    // Migrate old synthetic profile-generated vars to canonical partner template.
    // Preserve user-edited vars once they diverge from generated placeholder output.
    const shouldReplaceWithCanonical =
      !current ||
      /^\s*\/\/\s*Generated by profile:/m.test(current);
    if (shouldReplaceWithCanonical) {
      writeWorkspaceNormalizedFile(varsPath, canonical);
      return;
    }
  }
  const content = buildReferenceVarsFileContent(context, sourceDocumentTitle);
  writeWorkspaceNormalizedFile(varsPath, content);
};

const guessCodeLanguage = (text: string) => {
  const source = (text || "").trim();
  if (!source) return "text";
  if (/^\s*[{[]/.test(source)) return "json";
  if (/^\s*[a-zA-Z0-9_.-]+\s*:\s*.+/m.test(source)) return "yaml";
  if (/^(kubectl|helm|docker|curl|cat|echo|ls|cd|git)\b/m.test(source)) return "console";
  return "text";
};

const slugifyPhrase = (value: string, fallback: string) => {
  const slug = (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
};

const buildImageFileName = (sectionHeading: string, caption: string, index: number, ext: string) => {
  const seed = caption || sectionHeading || `image-${index}`;
  const slug = slugifyPhrase(seed, `image-${index}`);
  return `${slug}.${ext}`;
};

const relabelProjectImages = (metadata: any, projectDir: string) => {
  const mapping: Array<{ source_id: string; output_path: string; referenced_as: string }> = [];
  const warnings: string[] = [];
  if (!metadata?.sections?.length) return { mapping, warnings };

  let imageCounter = 0;
  metadata.sections.forEach((section: any, sectionIdx: number) => {
    const sectionHeading = section?.heading || `section-${sectionIdx + 1}`;
    section.blocks?.forEach((block: any, blockIdx: number) => {
      if (block.type !== "image") return;
      imageCounter += 1;
      const currentPath = (block.media_target_path || block.asset_path || "").replace(/\\/g, "/");
      if (!currentPath) {
        warnings.push(`image block ${sectionIdx + 1}.${blockIdx + 1} missing asset path`);
        return;
      }
      const srcAbs = path.join(projectDir, currentPath);
      if (!fs.existsSync(srcAbs)) {
        warnings.push(`missing image asset: ${currentPath}`);
        return;
      }

      const ext = path.extname(currentPath).replace(".", "").toLowerCase() || "png";
      const subFolder = mediaSubfolderForExtension(ext);
      const fileName = buildImageFileName(sectionHeading, block.caption || "", imageCounter, ext);
      const newRelativePath = path.join("media", "src", subFolder, fileName).replace(/\\/g, "/");
      const destAbs = path.join(projectDir, newRelativePath);
      if (!fs.existsSync(destAbs)) {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(srcAbs, destAbs);
      }
      block.media_target_path = newRelativePath;
      block.asset_path = newRelativePath;
      mapping.push({
        source_id: String(block.source_id || block.position?.source_order || `image-${imageCounter}`),
        output_path: newRelativePath,
        referenced_as: `image::${fileName}[title="${block.caption || fileName}", ${block.caption || fileName}, scaledwidth="90%", align="center"]`,
      });
    });
  });

  return { mapping, warnings };
};

const runPythonExtraction = (inputDocPath: string, assetsDir: string, assetsPrefix: string) => {
  const scriptPath = path.join(process.cwd(), "backend", "extract_structured.py");
  const venvPythonWindows = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
  const venvPythonUnix = path.join(process.cwd(), ".venv", "bin", "python");
  const attempts = [
    { command: venvPythonWindows, args: [scriptPath, inputDocPath, assetsDir, assetsPrefix] },
    { command: venvPythonUnix, args: [scriptPath, inputDocPath, assetsDir, assetsPrefix] },
    { command: "python", args: [scriptPath, inputDocPath, assetsDir, assetsPrefix] },
    { command: "py", args: ["-3", scriptPath, inputDocPath, assetsDir, assetsPrefix] },
    { command: "python3", args: [scriptPath, inputDocPath, assetsDir, assetsPrefix] },
  ];

  let lastError = "Python runtime is not available. Checked the project virtualenv and common PATH launchers.";
  const attemptErrors: string[] = [];

  for (const attempt of attempts) {
    if ((attempt.command === venvPythonWindows || attempt.command === venvPythonUnix) && !fs.existsSync(attempt.command)) {
      attemptErrors.push(`${attempt.command}: not found`);
      continue;
    }

    const result = spawnSync(attempt.command, attempt.args, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      lastError = result.error.message;
      attemptErrors.push(`${attempt.command}: ${result.error.message}`);
      continue;
    }

    if (result.status === 0) {
      const output = (result.stdout || "").trim();
      if (!output) {
        throw new Error("Python extraction returned empty output.");
      }
      try {
        return JSON.parse(output);
      } catch (parseError: any) {
        throw new Error(`Failed to parse Python extraction output: ${parseError.message}`);
      }
    }

    lastError = (result.stderr || result.stdout || "Python extraction failed.").trim();
    attemptErrors.push(`${attempt.command}: ${lastError}`);
  }

  throw new Error(`${lastError}\nTried: ${attemptErrors.join(" | ")}`);
};

const saveExtractedDataToFile = (
  data: any,
  originalName: string,
  subfolder?: string,
  customName?: string,
  suseProduct?: string,
  partnerProduct?: string
) => {
  const folder = subfolder || "extractions";
  const extractionsDir = path.join(DATA_DIR, folder);
  if (!fs.existsSync(extractionsDir)) {
    fs.mkdirSync(extractionsDir, { recursive: true });
  }
  const timestamp = Date.now();
  let finalName = "";

  if (customName) {
    // Custom name provided by user
    finalName = customName.toLowerCase().endsWith(".json") ? customName : `${customName}.json`;
    finalName = finalName.replace(/[^a-z0-9._\-]/gi, "_");
  } else if (suseProduct && partnerProduct) {
    // Use product-based naming pattern
    const safeSuse = toSlug(suseProduct, "suse");
    const safePartner = toSlug(partnerProduct, "partner");
    finalName = `${safeSuse}-${safePartner}-${timestamp}.json`;
  } else {
    // Generic extraction name (used during initial upload)
    finalName = `extraction-${timestamp}.json`;
  }

  const extractionPath = path.join(extractionsDir, finalName);
  fs.writeFileSync(extractionPath, JSON.stringify(data, null, 2));
  console.log(`Saved structured extraction to ${extractionPath}`);
  return path.join(folder, finalName);
};

const renameExtractionFile = (
  oldPath: string,
  newFilename: string,
  suseProduct?: string,
  partnerProduct?: string
): string | null => {
  // Construct final name
  let finalName = "";
  const timestamp = Date.now();

  if (newFilename && newFilename.trim()) {
    // Custom name provided
    finalName = newFilename.toLowerCase().endsWith(".json") ? newFilename : `${newFilename}.json`;
    finalName = finalName.replace(/[^a-z0-9._\-]/gi, "_");
  } else if (suseProduct && partnerProduct) {
    // Use product-based naming
    const safeSuse = toSlug(suseProduct, "suse");
    const safePartner = toSlug(partnerProduct, "partner");
    finalName = `${safeSuse}-${safePartner}-${timestamp}.json`;
  } else {
    return null; // No renaming needed
  }

  try {
    const oldFullPath = path.join(DATA_DIR, oldPath);
    const folder = path.dirname(oldFullPath);
    const newFullPath = path.join(folder, finalName);

    if (!fs.existsSync(oldFullPath)) {
      console.warn(`Old extraction file not found: ${oldFullPath}`);
      return null;
    }

    if (oldFullPath !== newFullPath) {
      // Rename the file
      fs.renameSync(oldFullPath, newFullPath);
      console.log(`Renamed extraction file from ${oldPath} to ${path.join(path.dirname(oldPath), finalName)}`);
    }

    return path.join(path.dirname(oldPath), finalName);
  } catch (error) {
    console.error("Failed to rename extraction file:", error);
    return null;
  }
};

const toSlug = (value: string, fallback: string) => {
  const cleaned = (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
};

const REFSETUP_SUSE_PRODUCTS: Array<{ code: string; slug: string; label: string }> = [
  { code: "sles", slug: "sles", label: "SUSE Linux Enterprise Server" },
  { code: "slessap", slug: "slessap", label: "SUSE Linux Enterprise Server for SAP applications" },
  { code: "slehpc", slug: "slehpc", label: "SUSE Linux Enterprise High Performance Computing" },
  { code: "slmicro", slug: "slmicro", label: "SUSE Linux Micro" },
  { code: "slelp", slug: "slelp", label: "SUSE Linux Enterprise Live Patching" },
  { code: "slert", slug: "slert", label: "SUSE Linux Enterprise Real Time" },
  { code: "sleha", slug: "sleha", label: "SUSE Linux Enterprise for High Availability" },
  { code: "slebci", slug: "slebci", label: "SUSE Linux Enterprise Base Container Images" },
  { code: "smlm", slug: "smlm", label: "SUSE Multi-Linux Manager Manager" },
  { code: "rancher", slug: "rancher", label: "SUSE Rancher Prime" },
  { code: "sto", slug: "storage", label: "SUSE Storage" },
  { code: "sec", slug: "security", label: "SUSE Security" },
  { code: "obs", slug: "observability", label: "SUSE Observability" },
  { code: "virt", slug: "virtualization", label: "SUSE Virtualization" },
  { code: "edge", slug: "edge", label: "SUSE Edge" },
  { code: "telco", slug: "telco", label: "SUSE Telco" },
  { code: "ai", slug: "ai", label: "SUSE AI" },
  { code: "rke", slug: "rke", label: "Rancher Kubernetes Engine" },
  { code: "rke2", slug: "rke2", label: "Rancher Kubernetes Engine 2" },
  { code: "k3s", slug: "k3s", label: "K3s" },
];

const REFSETUP_SUSE_PRODUCT_INDEX = new Map(
  REFSETUP_SUSE_PRODUCTS.map((entry) => [entry.code, entry]),
);

let partnerPresetRegistryCache: PartnerPresetDefinition[] | null = null;

const normalizeRefsetupValue = (value: string) =>
  (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 _-]+/g, "")
    .replace(/\s+/g, " ");

const compactRefsetupToken = (value: string, fallback: string) => {
  const token = normalizeRefsetupValue(value).replace(/\s+/g, "");
  return token || fallback;
};

const hyphenatedRefsetupToken = (value: string) => normalizeRefsetupValue(value).replace(/\s+/g, "-");

const parseRefsetupStructureInput = (payload: unknown): RefsetupStructureInput => {
  const body = (payload || {}) as Record<string, unknown>;
  const doctypeRaw = String(body.doctype || "").trim().toLowerCase();
  if (doctypeRaw !== "gs" && doctypeRaw !== "rc") {
    throw asApiError(400, "INVALID_INPUT", "doctype must be gs or rc.");
  }
  const rawProducts = Array.isArray(body.suseProducts)
    ? body.suseProducts
    : typeof body.suseProducts === "string"
      ? String(body.suseProducts)
          .split(/[,\s]+/)
          .filter(Boolean)
      : [];
  const codes = rawProducts
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (codes.length === 0) {
    throw asApiError(400, "INVALID_INPUT", "At least one SUSE product is required.");
  }
  const invalidCodes = codes.filter((code) => !REFSETUP_SUSE_PRODUCT_INDEX.has(code));
  if (invalidCodes.length > 0) {
    throw asApiError(400, "INVALID_INPUT", `Unsupported SUSE product code(s): ${invalidCodes.join(", ")}`);
  }
  const uniqueCodes = Array.from(new Set(codes));
  const partnerKey = requireString(body.partnerKey, "partnerKey").toLowerCase();
  const preset = getPartnerPresetDefinition(partnerKey);
  if (preset.doctype && preset.doctype !== doctypeRaw) {
    throw asApiError(
      400,
      "INVALID_INPUT",
      `Partner '${preset.partnerKey}' only supports doctype '${preset.doctype}'.`,
    );
  }
  const partnerProduct = typeof body.partnerProduct === "string" ? body.partnerProduct.trim() : "";
  const distinctiveText = typeof body.distinctiveText === "string" ? body.distinctiveText.trim() : "";
  return {
    doctype: doctypeRaw,
    suseProducts: uniqueCodes,
    partnerKey: preset.partnerKey,
    partnerProduct,
    distinctiveText,
  };
};

const getRefsetupSuseSlug = (codes: string[]) =>
  codes
    .map((code) => REFSETUP_SUSE_PRODUCT_INDEX.get(code)?.slug || code)
    .filter(Boolean)
    .join("-");

const buildRefsetupDocumentBase = (input: RefsetupStructureInput) => {
  const suseSlug = getRefsetupSuseSlug(input.suseProducts);
  const partnerNameToken = compactRefsetupToken(input.partnerKey, "partner");
  const partnerProductToken = input.partnerProduct ? `-${compactRefsetupToken(input.partnerProduct, "product")}` : "";
  const distinctiveSuffix = input.distinctiveText ? `_${hyphenatedRefsetupToken(input.distinctiveText)}` : "";
  return `${input.doctype}_suse-${suseSlug}_${partnerNameToken}${partnerProductToken}${distinctiveSuffix}`;
};

const readPartnerPresetRegistry = () => {
  if (partnerPresetRegistryCache) return partnerPresetRegistryCache;
  if (!fs.existsSync(PARTNER_TEMPLATE_REGISTRY_FILE)) {
    throw asApiError(500, "PIPELINE_PRESET_REGISTRY_MISSING", "Partner preset registry file is missing.");
  }
  const rawRegistryText = fs.readFileSync(PARTNER_TEMPLATE_REGISTRY_FILE, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(rawRegistryText) as {
    partners?: unknown;
  };
  const entries = Array.isArray(parsed?.partners) ? parsed.partners : [];
  const sanitized: PartnerPresetDefinition[] = entries
    .map((entryRaw) => {
      const entry = (entryRaw || {}) as Record<string, unknown>;
      const partnerKey = String(entry.partnerKey || "")
        .trim()
        .toLowerCase();
      const label = String(entry.label || "").trim();
      const doctypeValue = entry.doctype;
      const doctype =
        doctypeValue === "rc" || doctypeValue === "gs"
          ? doctypeValue
          : doctypeValue === null || doctypeValue === ""
            ? null
            : null;
      const sourceUrl = String(entry.sourceUrl || "").trim();
      const sourceFileName = String(entry.sourceFileName || "").trim();
      const templatePath = String(entry.templatePath || "").trim().replace(/\\/g, "/");
      const comingSoon = Boolean(entry.comingSoon);
      if (!partnerKey || !label) return null;
      return {
        partnerKey,
        label,
        doctype,
        sourceUrl,
        sourceFileName,
        templatePath,
        comingSoon,
      } as PartnerPresetDefinition;
    })
    .filter((entry): entry is PartnerPresetDefinition => Boolean(entry));
  if (sanitized.length === 0) {
    throw asApiError(500, "PIPELINE_PRESET_REGISTRY_INVALID", "Partner preset registry has no valid entries.");
  }
  partnerPresetRegistryCache = sanitized;
  return partnerPresetRegistryCache;
};

const listPartnerPresetDefinitions = () => readPartnerPresetRegistry().map((entry) => ({ ...entry }));

const getPartnerPresetDefinition = (partnerKeyRaw: string, opts?: { allowComingSoon?: boolean }) => {
  const partnerKey = String(partnerKeyRaw || "")
    .trim()
    .toLowerCase();
  if (!partnerKey) {
    throw asApiError(400, "INVALID_INPUT", "partnerKey is required.");
  }
  const preset = readPartnerPresetRegistry().find((entry) => entry.partnerKey === partnerKey);
  if (!preset) {
    throw asApiError(400, "INVALID_INPUT", `Unsupported partnerKey '${partnerKey}'.`);
  }
  const allowComingSoon = Boolean(opts?.allowComingSoon);
  if (preset.comingSoon && !allowComingSoon) {
    throw asApiError(400, "INVALID_INPUT", `'${partnerKey}' is coming soon and is not supported yet.`);
  }
  return preset;
};

const getPartnerPresetTemplateContent = (preset: PartnerPresetDefinition) => {
  const templateAbs = path.join(process.cwd(), preset.templatePath);
  const resolved = path.resolve(templateAbs);
  if (!resolved.startsWith(`${path.resolve(process.cwd())}${path.sep}`)) {
    throw asApiError(500, "PIPELINE_PRESET_TEMPLATE_INVALID", "Partner template path is outside repository root.");
  }
  if (!preset.templatePath || !fs.existsSync(templateAbs)) {
    throw asApiError(
      500,
      "PIPELINE_PRESET_TEMPLATE_MISSING",
      `Template file is missing for partner '${preset.partnerKey}'.`,
    );
  }
  return fs.readFileSync(templateAbs, "utf8");
};

const buildRefsetupStructurePreview = (input: RefsetupStructureInput) => {
  const preset = getPartnerPresetDefinition(input.partnerKey);
  const partnerFolder = preset.partnerKey;
  const documentbase = buildRefsetupDocumentBase(input);
  const rootPath = path.join("references", partnerFolder).replace(/\\/g, "/");
  const dcFileName = `DC-${documentbase}`;
  return {
    input: {
      ...input,
      partnerProduct: input.partnerProduct || "",
      distinctiveText: input.distinctiveText || "",
    },
    presetPartnerKey: preset.partnerKey,
    partnerFolder,
    documentbase,
    dcFileName,
    rootPath,
    tree: [
      `references/${partnerFolder}`,
      `references/${partnerFolder}/${dcFileName}`,
      `references/${partnerFolder}/adoc/${documentbase}.adoc`,
      `references/${partnerFolder}/adoc/${documentbase}-docinfo.xml`,
      `references/${partnerFolder}/adoc/${documentbase}-vars.adoc`,
      `references/${partnerFolder}/adoc/common_docinfo_vars.adoc`,
      `references/${partnerFolder}/adoc/common_gfdl1.2_i.adoc`,
      `references/${partnerFolder}/adoc/common_sbp_legal_notice.adoc`,
      `references/${partnerFolder}/adoc/common_trd_legal_notice.adoc`,
      `references/${partnerFolder}/media/src/png/`,
      `references/${partnerFolder}/media/src/svg/`,
      `references/${partnerFolder}/images -> media`,
    ],
  };
};

const isPathWithin = (candidatePath: string, parentPath: string) => {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
};

const resolveWorkspaceRootForJob = (job: JobRecord): string => {
  const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
  const workspacePath = typeof workspaceRecord.rootPath === "string" && workspaceRecord.rootPath.trim()
    ? workspaceRecord.rootPath.trim()
    : typeof job.outputFolderPath === "string"
      ? String(job.outputFolderPath).trim()
      : "";
  if (!workspacePath) {
    throw asApiError(400, "INVALID_STATE", "Pipeline workspace is not configured.");
  }
  const rootAbs = path.resolve(path.join(process.cwd(), workspacePath));
  if (!isPathWithin(rootAbs, process.cwd())) {
    throw asApiError(403, "FORBIDDEN", "Workspace path is outside repository root.");
  }
  return rootAbs;
};

const resolveWorkspaceFilePath = (workspaceRootAbs: string, relativePathRaw: string) => {
  const normalized = String(relativePathRaw || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) {
    throw asApiError(400, "INVALID_INPUT", "path is required.");
  }
  if (normalized.includes("..")) {
    throw asApiError(400, "INVALID_INPUT", "Path traversal is not allowed.");
  }
  const targetAbs = path.resolve(path.join(workspaceRootAbs, normalized));
  if (!isPathWithin(targetAbs, workspaceRootAbs)) {
    throw asApiError(403, "FORBIDDEN", "Path is outside workspace root.");
  }
  const baseName = path.basename(targetAbs);
  const ext = path.extname(targetAbs).toLowerCase();
  const extensionAllowed = PIPELINE_FILE_EDIT_ALLOWLIST.includes(ext as (typeof PIPELINE_FILE_EDIT_ALLOWLIST)[number]);
  const dcAllowed = baseName.startsWith("DC-");
  if (!extensionAllowed && !dcAllowed) {
    throw asApiError(400, "INVALID_INPUT", "File type is not editable.");
  }
  return { normalized, targetAbs };
};

const normalizeLf = (content: string) => String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const stripDocinfoXmlDeclaration = (content: string) => normalizeLf(content).replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*\n?/i, "");

const sanitizeAdocPlaceholders = (content: string) => {
  const source = normalizeLf(content);
  return source
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*\[([^\[\]]+)\]\s*$/);
      if (!match) return line;
      const inner = match[1].trim();
      if (!inner) return line;
      // Only rewrite obvious placeholder-like attribute lines.
      if (/^add content here$/i.test(inner)) return "Add content here.";
      if (/^this content will be added during publication$/i.test(inner)) return "This content will be added during publication.";
      return line;
    })
    .join("\n");
};

const normalizeWorkspaceFileContent = (absPath: string, rawContent: string) => {
  const base = path.basename(absPath);
  const ext = path.extname(absPath).toLowerCase();
  let normalized = normalizeLf(rawContent);
  if (base.startsWith("DC-")) {
    return normalized;
  }
  if (base.endsWith("-docinfo.xml") || ext === ".xml") {
    normalized = stripDocinfoXmlDeclaration(normalized);
    return normalized;
  }
  if (ext === ".adoc") {
    normalized = sanitizeAdocPlaceholders(normalized);
    return normalized;
  }
  return normalized;
};

const writeWorkspaceNormalizedFile = (absPath: string, content: string) => {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const normalized = normalizeWorkspaceFileContent(absPath, content);
  fs.writeFileSync(absPath, normalized);
  return normalized;
};

const collectAttributeRefs = (content: string) => {
  const refs = new Set<string>();
  const source = String(content || "");
  for (const match of source.matchAll(/\{([A-Za-z0-9._-]+)\}/g)) {
    refs.add(match[1]);
  }
  return refs;
};

const buildCompatAliasValue = (key: string, attrs: Map<string, string>, context?: ReferenceContext) => {
  const get = (name: string) => attrs.get(name) || "";
  const pick = (...names: string[]) => names.map((name) => get(name)).find(Boolean) || "";
  const table: Record<string, string> = {
    partner: pick("partner", "partner-brand") || context?.partnerDisplay || "Partner",
    "suse-product":
      pick("suse-product", "srancher", "sai", "sai-long", "sai-brand") || context?.suseProductDisplay || "SUSE",
    "suse-product-long":
      pick("suse-product-long", "srancher-long", "sai-long", "sai-brand") || context?.suseProductDisplay || "SUSE",
    "suse-product-brand": pick("suse-product-brand", "srancher-brand", "sai-brand"),
    "suse-product-provider": pick("suse-product-provider", "srancher-provider", "sai-provider", "suse", "suse-brand") || "SUSE",
    "partner-product": pick("partner-product", "ws", "cml") || context?.partnerProductDisplay || context?.partnerDisplay || "Partner product",
    "partner-product-long":
      pick("partner-product-long", "ws-long", "cml-long") || context?.partnerProductDisplay || context?.partnerDisplay || "Partner product",
    "partner-provider": pick("partner-provider", "ws-provider", "cml-provider") || context?.partnerDisplay || "",
    "partner-website": pick("partner-website", "ws-website", "cml-website"),
    disclaimer:
      pick("disclaimer") ||
      "This document is for informational purposes only. SUSE and partner product behavior can change between releases.",
    "rev2-date": pick("rev2-date", "rev1-date"),
    "rev2-description": pick("rev2-description", "rev1-description", "description"),
    comp1: pick("comp1", "suse-product", "srancher", "sai") || context?.suseProductDisplay || "",
    "comp1-long": pick("comp1-long", "suse-product-long", "srancher-long", "sai-long") || context?.suseProductDisplay || "",
    "comp1-version1": pick("comp1-version1", "srancher-version1", "sai-version"),
    "comp1-provider": pick("comp1-provider", "srancher-provider", "sai-provider") || "SUSE",
    comp2: pick("comp2", "partner-product", "ws", "cml") || context?.partnerProductDisplay || "",
    "comp2-long": pick("comp2-long", "partner-product-long", "ws-long", "cml-long") || context?.partnerProductDisplay || "",
    "comp2-version1":
      pick("comp2-version1", "ws-version1", "cml-version", "partner-version1", "partner-product-version", "cml-k8s-version-min") ||
      "latest",
    "comp2-provider": pick("comp2-provider", "partner-provider", "ws-provider", "cml-provider") || context?.partnerDisplay || "",
    "sai-version": pick("sai-version", "srancher-version1"),
    "sai-provider": pick("sai-provider", "srancher-provider", "suse-brand") || "SUSE",
    "sai-brand": pick("sai-brand", "srancher-brand", "suse-product"),
    "sai-long": pick("sai-long", "srancher-long", "suse-product-long"),
    sai: pick("sai", "srancher", "suse-product"),
    "sai-website": pick("sai-website", "srancher-website"),
    "cml-version":
      pick("cml-version", "ws-version1", "partner-version1", "partner-product-version", "cml-k8s-version-min") || "latest",
    "cml-provider": pick("cml-provider", "ws-provider", "partner-provider"),
    "cml-brand": pick("cml-brand", "ws-brand", "partner-product"),
    "cml-long": pick("cml-long", "ws-long", "partner-product-long"),
    cml: pick("cml", "ws", "partner-product"),
    "cml-website": pick("cml-website", "ws-website", "partner-website"),
  };
  const mapped = table[key];
  if (typeof mapped === "string") return mapped;
  return "";
};

const ensureVarsCompatibilityAliases = (args: {
  varsAbsPath: string;
  mainAdocAbsPath?: string;
  docinfoAbsPath?: string;
  context?: ReferenceContext;
}) => {
  if (!fs.existsSync(args.varsAbsPath)) return { added: 0 };
  const varsRaw = fs.readFileSync(args.varsAbsPath, "utf8");
  const varsNormalized = normalizeWorkspaceFileContent(args.varsAbsPath, varsRaw);
  if (varsNormalized !== varsRaw) {
    fs.writeFileSync(args.varsAbsPath, varsNormalized);
  }
  const markerStart = "// stage3-auto-compat-aliases-start";
  const markerEnd = "// stage3-auto-compat-aliases-end";
  const withoutOldBlock = varsNormalized.replace(
    new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}\\n?`, "g"),
    "",
  ).trimEnd();
  const attrs = parseAdocAttributes(withoutOldBlock);
  const refs = new Set<string>();
  if (args.mainAdocAbsPath && fs.existsSync(args.mainAdocAbsPath)) {
    collectAttributeRefs(fs.readFileSync(args.mainAdocAbsPath, "utf8")).forEach((key) => refs.add(key));
  }
  if (args.docinfoAbsPath && fs.existsSync(args.docinfoAbsPath)) {
    collectAttributeRefs(fs.readFileSync(args.docinfoAbsPath, "utf8")).forEach((key) => refs.add(key));
  }
  [
    "partner",
    "suse-product",
    "suse-product-long",
    "suse-product-provider",
    "partner-product",
    "partner-product-long",
    "partner-provider",
    "comp1",
    "comp1-long",
    "comp1-version1",
    "comp1-provider",
    "comp2",
    "comp2-long",
    "comp2-version1",
    "comp2-provider",
    "sai",
    "sai-long",
    "sai-brand",
    "sai-version",
    "cml",
    "cml-long",
    "cml-provider",
    "cml-version",
  ].forEach((key) => refs.add(key));
  const toAdd: Array<{ key: string; value: string }> = [];
  Array.from(refs)
    .sort((a, b) => a.localeCompare(b))
    .forEach((key) => {
      if ((attrs.get(key) || "").trim()) return;
      const value = buildCompatAliasValue(key, attrs, args.context);
      if (value === "") return;
      toAdd.push({ key, value });
      attrs.set(key, value);
    });
  if (toAdd.length === 0) return { added: 0 };
  const block = [
    "",
    markerStart,
    ...toAdd.map((item) => `:${item.key}: ${item.value}`),
    markerEnd,
    "",
  ].join("\n");
  fs.writeFileSync(args.varsAbsPath, `${withoutOldBlock}${block}`);
  return { added: toAdd.length };
};

const migrateWorkspaceForDapsSafety = (job: JobRecord, workspaceRootAbs: string) => {
  const workspace = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
  const mainRel = String(workspace.mainAdocPath || "").replace(/\\/g, "/");
  const varsRel = String(workspace.varsPath || "").replace(/\\/g, "/");
  const docinfoRel = String(workspace.docinfoPath || "").replace(/\\/g, "/");
  const mainAbs = mainRel ? path.join(process.cwd(), mainRel) : "";
  const varsAbs = varsRel ? path.join(process.cwd(), varsRel) : "";
  const docinfoAbs = docinfoRel ? path.join(process.cwd(), docinfoRel) : "";
  let normalizedFiles = 0;
  [mainAbs, varsAbs, docinfoAbs].filter(Boolean).forEach((absPath) => {
    if (!fs.existsSync(absPath)) return;
    if (!isPathWithin(absPath, workspaceRootAbs)) return;
    const raw = fs.readFileSync(absPath, "utf8");
    const next = normalizeWorkspaceFileContent(absPath, raw);
    if (next !== raw) {
      fs.writeFileSync(absPath, next);
      normalizedFiles += 1;
    }
  });
  let compatAliasesAdded = 0;
  if (varsAbs && fs.existsSync(varsAbs)) {
    const context = buildReferenceContext(job, typeof job.metadata === "object" ? job.metadata : {}, workspace.documentbase);
    compatAliasesAdded = ensureVarsCompatibilityAliases({
      varsAbsPath: varsAbs,
      mainAdocAbsPath: mainAbs || undefined,
      docinfoAbsPath: docinfoAbs || undefined,
      context,
    }).added;
  }
  return { normalizedFiles, compatAliasesAdded };
};

const diffAdocAttributeMaps = (before: Map<string, string>, after: Map<string, string>) => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  after.forEach((_value, key) => {
    if (!before.has(key)) {
      added.push(key);
      return;
    }
    if ((before.get(key) || "") !== (after.get(key) || "")) {
      changed.push(key);
    }
  });
  before.forEach((_value, key) => {
    if (!after.has(key)) {
      removed.push(key);
    }
  });
  return { added, removed, changed };
};

const maybeRewriteMainAdocUsingVars = (
  job: JobRecord,
  workspaceRootAbs: string,
  varsContentBeforeSave: string,
  varsContentAfterSave: string,
) => {
  const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
  const mainRelativePath = String(workspaceRecord.mainAdocPath || "").replace(/\\/g, "/");
  if (!mainRelativePath) {
    return { rewritten: false, changedKeys: 0, addedKeys: 0, removedKeys: 0 };
  }
  const mainAbsPath = path.join(process.cwd(), mainRelativePath);
  if (!isPathWithin(mainAbsPath, workspaceRootAbs) || !fs.existsSync(mainAbsPath)) {
    return { rewritten: false, changedKeys: 0, addedKeys: 0, removedKeys: 0 };
  }

  const beforeAttrs = parseAdocAttributes(varsContentBeforeSave);
  const afterAttrs = parseAdocAttributes(varsContentAfterSave);
  const diff = diffAdocAttributeMaps(beforeAttrs, afterAttrs);
  const candidates = buildReplacementCandidatesFromAttributes(afterAttrs);
  if (candidates.length === 0) {
    return {
      rewritten: false,
      changedKeys: diff.changed.length,
      addedKeys: diff.added.length,
      removedKeys: diff.removed.length,
    };
  }

  const originalMain = fs.readFileSync(mainAbsPath, "utf8");
  const rewrittenMain = applyReplacementsInUnprotectedSegments(originalMain, candidates);
  if (!validateSnippetRenderSafety(rewrittenMain) || rewrittenMain === originalMain) {
    return {
      rewritten: false,
      changedKeys: diff.changed.length,
      addedKeys: diff.added.length,
      removedKeys: diff.removed.length,
    };
  }
  fs.writeFileSync(mainAbsPath, rewrittenMain);
  return {
    rewritten: true,
    changedKeys: diff.changed.length,
    addedKeys: diff.added.length,
    removedKeys: diff.removed.length,
    content: rewrittenMain,
  };
};

const validateRefsetupStructure = (input: RefsetupStructureInput) => {
  const preview = buildRefsetupStructurePreview(input);
  const commonRoot = ensureCanonicalCommonSourceAssets();
  const templatesRoot = path.join(commonRoot, "templates");
  const commonAdocRoot = path.join(commonRoot, "adoc");
  const requiredFiles = [
    path.join(templatesRoot, "template_DC"),
    path.join(templatesRoot, "template_docinfo"),
    path.join(templatesRoot, "template_vars"),
    path.join(templatesRoot, `template_main-${preview.input.doctype}`),
    path.join(commonAdocRoot, "common_docinfo_vars.adoc"),
    path.join(commonAdocRoot, "common_gfdl1.2_i.adoc"),
    path.join(commonAdocRoot, "common_sbp_legal_notice.adoc"),
    path.join(commonAdocRoot, "common_trd_legal_notice.adoc"),
  ];

  const missingRequirements = requiredFiles
    .filter((targetPath) => !fs.existsSync(targetPath))
    .map((targetPath) => path.relative(process.cwd(), targetPath).replace(/\\/g, "/"));

  const rootDirAbs = path.join(process.cwd(), preview.rootPath);
  const collisions: string[] = [];
  if (fs.existsSync(rootDirAbs)) {
    const existingCandidates = [
      path.join(rootDirAbs, preview.dcFileName),
      path.join(rootDirAbs, "adoc", `${preview.documentbase}.adoc`),
      path.join(rootDirAbs, "adoc", `${preview.documentbase}-docinfo.xml`),
      path.join(rootDirAbs, "adoc", `${preview.documentbase}-vars.adoc`),
    ];
    existingCandidates.forEach((candidate) => {
      if (fs.existsSync(candidate)) {
        collisions.push(path.relative(process.cwd(), candidate).replace(/\\/g, "/"));
      }
    });
  }

  return {
    ok: missingRequirements.length === 0 && collisions.length === 0,
    preview,
    missingRequirements,
    collisions,
  };
};

const createRefsetupWorkspace = (input: RefsetupStructureInput) => {
  const validation = validateRefsetupStructure(input);
  if (!validation.ok) {
    throw asApiError(400, "INVALID_STATE", "Structure validation failed.", {
      missingRequirements: validation.missingRequirements,
      collisions: validation.collisions,
    });
  }
  const { preview } = validation;
  const preset = getPartnerPresetDefinition(preview.input.partnerKey);
  const commonRoot = ensureCanonicalCommonSourceAssets();
  const templatesRoot = path.join(commonRoot, "templates");
  const commonAdocRoot = path.join(commonRoot, "adoc");
  const commonImagesRoot = path.join(commonRoot, "images", "src", "svg");
  const rootDirAbs = path.join(process.cwd(), preview.rootPath);
  const adocDir = path.join(rootDirAbs, "adoc");
  const mediaDir = path.join(rootDirAbs, "media");
  const pngDir = path.join(mediaDir, "src", "png");
  const svgDir = path.join(mediaDir, "src", "svg");
  const imagesPath = path.join(rootDirAbs, "images");

  [rootDirAbs, adocDir, pngDir, svgDir].forEach((dirPath) => fs.mkdirSync(dirPath, { recursive: true }));
  if (!fs.existsSync(imagesPath)) {
    try {
      fs.symlinkSync(mediaDir, imagesPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      fs.mkdirSync(path.join(imagesPath, "src", "png"), { recursive: true });
      fs.mkdirSync(path.join(imagesPath, "src", "svg"), { recursive: true });
    }
  }

  const dcPath = path.join(rootDirAbs, preview.dcFileName);
  const mainAdocPath = path.join(adocDir, `${preview.documentbase}.adoc`);
  const varsPath = path.join(adocDir, `${preview.documentbase}-vars.adoc`);
  const docinfoPath = path.join(adocDir, `${preview.documentbase}-docinfo.xml`);
  const manifestPath = path.join(rootDirAbs, "manifest.json");

  const dcTemplate = fs.readFileSync(path.join(templatesRoot, "template_DC"), "utf8");
  writeWorkspaceNormalizedFile(
    dcPath,
    ensureDcFailureLevelError(dcTemplate.replace(/MAIN="template_main"/g, `MAIN="${preview.documentbase}.adoc"`)),
  );
  writeWorkspaceNormalizedFile(docinfoPath, fs.readFileSync(path.join(templatesRoot, "template_docinfo"), "utf8"));
  writeWorkspaceNormalizedFile(varsPath, getPartnerPresetTemplateContent(preset));
  let mainTemplate = fs.readFileSync(path.join(templatesRoot, `template_main-${preview.input.doctype}`), "utf8");
  mainTemplate = mainTemplate.replace(/include::\.\/template_vars\[\]/g, `include::./${preview.documentbase}-vars.adoc[]`);
  writeWorkspaceNormalizedFile(mainAdocPath, mainTemplate);
  ensureVarsCompatibilityAliases({
    varsAbsPath: varsPath,
    mainAdocAbsPath: mainAdocPath,
    docinfoAbsPath: docinfoPath,
  });

  const sharedFiles = [
    "common_docinfo_vars.adoc",
    "common_gfdl1.2_i.adoc",
    "common_sbp_legal_notice.adoc",
    "common_trd_legal_notice.adoc",
  ];
  sharedFiles.forEach((fileName) => {
    const sourcePath = path.join(commonAdocRoot, fileName);
    ensureCommonFileInProject(adocDir, sourcePath, fileName);
  });

  const suseLogoSource = path.join(commonImagesRoot, "suse.svg");
  const suseLogoTarget = path.join(svgDir, "suse.svg");
  if (!fs.existsSync(suseLogoTarget)) {
    try {
      const relativeTarget = path.relative(path.dirname(suseLogoTarget), suseLogoSource);
      fs.symlinkSync(relativeTarget, suseLogoTarget, "file");
    } catch {
      fs.copyFileSync(suseLogoSource, suseLogoTarget);
    }
  }

  const manifest = {
    generated_by: "pipeline-structure-builder-v1",
    doc_type: preview.input.doctype,
    base_name: preview.documentbase,
    partner_slug: preview.partnerFolder,
    suse_products: preview.input.suseProducts,
    main_dc_file: preview.dcFileName,
    main_adoc_file: `adoc/${preview.documentbase}.adoc`,
    vars_file: `adoc/${preview.documentbase}-vars.adoc`,
    docinfo_file: `adoc/${preview.documentbase}-docinfo.xml`,
    media_dir: "media/src",
    reference_profile: {
      profileId: resolveReferenceProfile(preview.partnerFolder, "").profile.id,
      presetPartnerKey: preset.partnerKey,
    },
    template_source: CANONICAL_TEMPLATE_SOURCE,
    generated_at: nowIso(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    ...preview,
    mainAdocPath: path.join(preview.rootPath, "adoc", `${preview.documentbase}.adoc`).replace(/\\/g, "/"),
    varsPath: path.join(preview.rootPath, "adoc", `${preview.documentbase}-vars.adoc`).replace(/\\/g, "/"),
    docinfoPath: path.join(preview.rootPath, "adoc", `${preview.documentbase}-docinfo.xml`).replace(/\\/g, "/"),
    manifestPath: path.join(preview.rootPath, "manifest.json").replace(/\\/g, "/"),
  };
};

const ensureFile = (filePath: string, content: string) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
};

const writeFileEnsuringParent = (filePath: string, content: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const isPlaceholderCommonFile = (content: string) => {
  const source = (content || "").trim();
  if (!source) return true;
  return (
    source.includes("placeholder for local rendering") ||
    source === ":doc-type: Technical Reference Document"
  );
};

const ensureCanonicalCommonSourceAssets = () => {
  const commonRoot = path.join(process.cwd(), "common");
  const assets = getCanonicalCommonAssets();
  Object.entries(assets).forEach(([relativePath, content]) => {
    const fullPath = path.join(commonRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      writeFileEnsuringParent(fullPath, content);
      return;
    }
    try {
      const current = fs.readFileSync(fullPath, "utf8");
      if (isPlaceholderCommonFile(current)) {
        writeFileEnsuringParent(fullPath, content);
      }
    } catch {
      writeFileEnsuringParent(fullPath, content);
    }
  });
  return commonRoot;
};

const ensureDcFailureLevelError = (dcContentRaw: string) => {
  const dcContent = dcContentRaw || "";
  if (/^\s*ADOC_FAILURE_LEVEL\s*=\s*/m.test(dcContent)) {
    return dcContent;
  }
  if (/ADOC_ATTRIBUTES="--attribute env-daps=1"/.test(dcContent)) {
    return dcContent.replace(
      /ADOC_ATTRIBUTES="--attribute env-daps=1"/,
      'ADOC_ATTRIBUTES="--attribute env-daps=1"\n\n# Treat warnings as non-fatal during AsciiDoc to DocBook conversion.\nADOC_FAILURE_LEVEL=ERROR',
    );
  }
  return `${dcContent.trimEnd()}\n\nADOC_FAILURE_LEVEL=ERROR\n`;
};

const ensureCommonFileInProject = (
  projectAdocDir: string,
  sourceCommonAdocPath: string,
  destinationName: string,
) => {
  const destinationPath = path.join(projectAdocDir, destinationName);
  const sourceContent = fs.readFileSync(sourceCommonAdocPath, "utf8");
  const shouldReplace =
    !fs.existsSync(destinationPath) ||
    (() => {
      try {
        return isPlaceholderCommonFile(fs.readFileSync(destinationPath, "utf8"));
      } catch {
        return true;
      }
    })();

  const trySymlink = () => {
    if (process.platform === "win32") return false;
    try {
      if (fs.existsSync(destinationPath)) {
        fs.unlinkSync(destinationPath);
      }
      const relativeTarget = path.relative(path.dirname(destinationPath), sourceCommonAdocPath);
      fs.symlinkSync(relativeTarget, destinationPath, "file");
      return true;
    } catch {
      return false;
    }
  };

  if (shouldReplace) {
    if (!trySymlink()) {
      writeFileEnsuringParent(destinationPath, sourceContent);
    }
  }
  return destinationPath;
};

const getSafeReplacementRanges = (source: string): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  const capture = (regex: RegExp) => {
    for (const match of source.matchAll(regex)) {
      const index = match.index ?? -1;
      if (index >= 0) {
        ranges.push({ start: index, end: index + match[0].length });
      }
    }
  };

  // Existing attribute refs.
  capture(/\{[A-Za-z0-9._-]+\}/g);
  // Attribute definition lines.
  capture(/^[ \t]*:[A-Za-z0-9._-]+:\s.*$/gm);
  // Macro syntaxes.
  capture(/link:[^\s\[]+\[[^\]]*\]/g);
  capture(/xref:[^\s\[]+\[[^\]]*\]/g);
  capture(/image::[^\[]+\[[^\]]*\]/g);
  capture(/include::[^\[]+\[[^\]]*\]/g);
  // Raw URLs.
  capture(/\bhttps?:\/\/[^\s\]]+/g);

  return ranges.sort((a, b) => a.start - b.start);
};

const applyReplacementsInUnprotectedSegments = (source: string, candidates: ReplacementCandidate[]) => {
  if (!source) return source;
  const ranges = getSafeReplacementRanges(source);
  if (ranges.length === 0) {
    return applyVariableReplacements(source, candidates);
  }

  let cursor = 0;
  const chunks: string[] = [];
  for (const range of ranges) {
    if (range.start > cursor) {
      const plain = source.slice(cursor, range.start);
      chunks.push(applyVariableReplacements(plain, candidates));
    }
    chunks.push(source.slice(range.start, range.end));
    cursor = range.end;
  }
  if (cursor < source.length) {
    chunks.push(applyVariableReplacements(source.slice(cursor), candidates));
  }
  return chunks.join("");
};

const validateSnippetRenderSafety = (content: string) => {
  const lines = (content || "").split(/\r?\n/);
  for (const line of lines) {
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    if (open !== close) return false;
    if (line.includes("{{") || line.includes("}}")) return false;
    if (/\{[^\}\n\]]*\]/.test(line)) return false;
  }
  return true;
};

const validateAdocRenderSafety = (content: string) => {
  const issues: string[] = [];
  const lines = (content || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    if (open !== close) issues.push(`line ${lineNo}: brace imbalance`);
    if (line.includes("{{") || line.includes("}}")) issues.push(`line ${lineNo}: nested brace token`);
    if (/\{[^\}\n\]]*\]/.test(line)) issues.push(`line ${lineNo}: malformed attribute reference`);
  });
  return { safe: issues.length === 0, issues };
};

const createReferenceScaffold = (
  partnerNameRaw?: string,
  suseProductRaw?: string,
  partnerProductRaw?: string,
  documentTypeRaw?: string,
  profileIdRaw?: string,
) => {
  const commonRoot = ensureCanonicalCommonSourceAssets();
  const templatesRoot = path.join(commonRoot, "templates");
  const commonAdocRoot = path.join(commonRoot, "adoc");
  const commonImagesRoot = path.join(commonRoot, "images", "src", "svg");

  const partnerName = toSlug(partnerNameRaw || "clearml", "clearml");
  const suseProduct = toSlug(suseProductRaw || "suse-ai", "suse-ai");
  const partnerProduct = toSlug(partnerProductRaw || "clearml", "clearml");
  const docTypePrefix = toDocTypePrefix(documentTypeRaw);
  const profileResolution = resolveReferenceProfile(partnerNameRaw || partnerName, profileIdRaw);
  const profile = profileResolution.profile;
  const suseProductDisplay = toDisplayNameFromSlug(suseProductRaw || suseProduct, "SUSE AI");
  const partnerDisplay = toDisplayNameFromSlug(partnerNameRaw || partnerName, "Partner");
  const partnerProductDisplay = toDisplayNameFromSlug(partnerProductRaw || partnerProduct, "Partner Product");
  const baseName = buildBaseName({
    profile,
    docTypePrefix,
    suseProductSlug: suseProduct,
    partnerProductSlug: partnerProduct,
  });
  const scaffoldContext: ReferenceContext = {
    baseName,
    docTypePrefix,
    docTokenMode: resolveDocTokenMode(docTypePrefix),
    profileId: profile.id,
    profileFallbackUsed: profileResolution.fallbackUsed,
    namingPattern: profile.namingPattern,
    suseProductSlug: suseProduct,
    suseProductDisplay,
    partnerSlug: partnerName,
    partnerDisplay,
    partnerProductSlug: partnerProduct,
    partnerProductDisplay,
    pipelineName: `${suseProductDisplay} and ${partnerProductDisplay}`,
  };

  const rootDir = path.join(process.cwd(), "references", partnerName);
  const adocDir = path.join(rootDir, "adoc");
  const mediaDir = path.join(rootDir, "media");
  const srcDir = path.join(mediaDir, "src");
  const pngDir = path.join(srcDir, "png");
  const svgDir = path.join(srcDir, "svg");
  const imagesLink = path.join(rootDir, "images");

  [adocDir, mediaDir, pngDir, svgDir].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(imagesLink)) {
    try {
      fs.symlinkSync(mediaDir, imagesLink, process.platform === "win32" ? "junction" : "dir");
    } catch {
      const fallbackImagesDir = path.join(rootDir, "images", "src");
      fs.mkdirSync(path.join(fallbackImagesDir, "png"), { recursive: true });
      fs.mkdirSync(path.join(fallbackImagesDir, "svg"), { recursive: true });
    }
  }

  const dcFile = path.join(rootDir, `DC-${baseName}`);
  const manifestFile = path.join(rootDir, "manifest.json");
  const adocFile = path.join(adocDir, `${baseName}.adoc`);
  const docInfoFile = path.join(adocDir, `${baseName}-docinfo.xml`);
  const varsFile = path.join(adocDir, `${baseName}-vars.adoc`);

  const templateDcPath = path.join(templatesRoot, "template_DC");
  const templateDocInfoPath = path.join(templatesRoot, "template_docinfo");
  const templateVarsPath = path.join(templatesRoot, "template_vars");
  const templateMainPath = path.join(
    templatesRoot,
    docTypePrefix === "gs" ? "template_main-gs" : "template_main-rc",
  );

  const dcContent = fs
    .readFileSync(templateDcPath, "utf8")
    .replace(/MAIN="template_main"/g, `MAIN="${baseName}.adoc"`);
  writeWorkspaceNormalizedFile(dcFile, ensureDcFailureLevelError(dcContent));

  fs.writeFileSync(
    manifestFile,
    JSON.stringify(
      {
        base_name: baseName,
        doc_type: docTypePrefix,
        partner_slug: partnerName,
        suse_product_slug: suseProduct,
        main_dc_file: `DC-${baseName}`,
        main_adoc_file: `adoc/${baseName}.adoc`,
        vars_file: `adoc/${baseName}-vars.adoc`,
        docinfo_file: `adoc/${baseName}-docinfo.xml`,
        media_dir: "media/src",
        generated_from: {
          source_type: "google_doc_json",
          source_document_title: "",
        },
        reference_profile: {
          profileId: profile.id,
          fallbackUsed: profileResolution.fallbackUsed,
          docTokenMode: scaffoldContext.docTokenMode,
          namingPattern: scaffoldContext.namingPattern,
        },
        template_source: CANONICAL_TEMPLATE_SOURCE,
        images: [],
        warnings: [],
      },
      null,
      2,
    ),
  );

  let migrationApplied = false;
  const mappedCommonFiles: Array<[string, string]> = [
    ["common_docinfo_vars.adoc", path.join(commonAdocRoot, "common_docinfo_vars.adoc")],
    ["common_gfdl1.2_i.adoc", path.join(commonAdocRoot, "common_gfdl1.2_i.adoc")],
    ["common_sbp_legal_notice.adoc", path.join(commonAdocRoot, "common_sbp_legal_notice.adoc")],
    ["common_trd_legal_notice.adoc", path.join(commonAdocRoot, "common_trd_legal_notice.adoc")],
  ];
  mappedCommonFiles.forEach(([name, sourcePath]) => {
    const targetPath = path.join(adocDir, name);
    const before =
      fs.existsSync(targetPath) && isPlaceholderCommonFile(fs.readFileSync(targetPath, "utf8"));
    ensureCommonFileInProject(adocDir, sourcePath, name);
    if (before) migrationApplied = true;
  });

  const commonLogoPath = path.join(commonImagesRoot, "suse.svg");
  const projectLogoPath = path.join(svgDir, "suse.svg");
  if (!fs.existsSync(projectLogoPath)) {
    let linked = false;
    if (process.platform !== "win32") {
      try {
        const relativeTarget = path.relative(path.dirname(projectLogoPath), commonLogoPath);
        fs.symlinkSync(relativeTarget, projectLogoPath, "file");
        linked = true;
      } catch {
        linked = false;
      }
    }
    if (!linked) {
      fs.copyFileSync(commonLogoPath, projectLogoPath);
    }
  }

  const templateMainRaw = fs.existsSync(templateMainPath)
    ? fs.readFileSync(templateMainPath, "utf8")
    : buildCanonicalTemplateMain(docTypePrefix === "gs" ? "gs" : "rc");
  const titleLineToken =
    scaffoldContext.docTokenMode === "title"
      ? "{title}: {subtitle}"
      : "{doctitle}: {docsubtitle}";
  const mainContent = templateMainRaw
    .replace(/include::\.\/template_vars\[\]/g, `include::./${baseName}-vars.adoc[]`)
    .replace(/^= \{doctitle\}: \{docsubtitle\}$/m, `= ${titleLineToken}`);
  writeWorkspaceNormalizedFile(adocFile, mainContent);

  let docInfoContent = fs.readFileSync(templateDocInfoPath, "utf8");
  const docTypeMeta = docTypePrefix === "gs" ? "Getting Started" : "Reference Configuration";
  docInfoContent = docInfoContent.replace(
    /<meta name="type">[^<]*<\/meta>/,
    `<meta name="type">${docTypeMeta}</meta>`,
  );
  if (scaffoldContext.docTokenMode === "title") {
    docInfoContent = docInfoContent
      .replace(/<dm:product>\{doctitle\}<\/dm:product>/g, "<dm:product>{title}</dm:product>")
      .replace(/<title>\{doctitle\}<\/title>/g, "<title>{title}</title>")
      .replace(/<subtitle>\{docsubtitle\}<\/subtitle>/g, "<subtitle>{subtitle}</subtitle>");
  }
  writeWorkspaceNormalizedFile(docInfoFile, docInfoContent);

  const varsTemplate = fs.readFileSync(templateVarsPath, "utf8");
  const generatedVars = buildReferenceVarsFileContent(scaffoldContext, scaffoldContext.pipelineName);
  writeWorkspaceNormalizedFile(varsFile, `${varsTemplate.trim()}\n\n${generatedVars}`);
  ensureVarsCompatibilityAliases({
    varsAbsPath: varsFile,
    mainAdocAbsPath: adocFile,
    docinfoAbsPath: docInfoFile,
    context: scaffoldContext,
  });

  return {
    partnerName,
    suseProduct,
    partnerProduct,
    docTypePrefix,
    baseName,
    rootPath: path.join("references", partnerName),
    profileId: profile.id,
    fallbackUsed: profileResolution.fallbackUsed,
    docTokenMode: scaffoldContext.docTokenMode,
    namingPattern: scaffoldContext.namingPattern,
    templateSource: CANONICAL_TEMPLATE_SOURCE,
    migrationApplied,
    files: [
      `DC-${baseName}`,
      "manifest.json",
      "images -> media",
      "media/src/png",
      "media/src/svg",
      "adoc/common_docinfo_vars.adoc",
      "adoc/common_gfdl1.2_i.adoc",
      "adoc/common_sbp_legal_notice.adoc",
      "adoc/common_trd_legal_notice.adoc",
      `adoc/${baseName}.adoc`,
      `adoc/${baseName}-docinfo.xml`,
      `adoc/${baseName}-vars.adoc`,
    ],
  };
};

const getJobsForUser = (userId: string) => getLocalJobs().filter((job) => job.userId === userId);
const findJobIndexForUser = (jobs: JobRecord[], userId: string, jobId: string) =>
  jobs.findIndex((job) => job.id === jobId && job.userId === userId);

const runDapsRender = (dcDirectory: string, dcFileName: string, format: "html" | "pdf") => {
  const localAsciidoctorPath = path.join(process.cwd(), "scripts");
  const renderEnv = {
    ...process.env,
    PATH: `${localAsciidoctorPath}${path.delimiter}${process.env.PATH || ""}`,
  };

  const check = spawnSync("daps", ["--version"], {
    cwd: dcDirectory,
    encoding: "utf8",
    timeout: 10000,
    env: renderEnv,
  });
  if (check.error || check.status !== 0) {
    return {
      ok: false as const,
      code: "DAPS_NOT_FOUND",
      message: "daps not found",
      details: check.error?.message || check.stderr || check.stdout || "",
    };
  }

  const startedAt = Date.now();
  const run = spawnSync("daps", ["-d", dcFileName, format], {
    cwd: dcDirectory,
    encoding: "utf8",
    timeout: 300000,
    env: renderEnv,
  });
  if (run.error || run.status !== 0) {
    const details = run.error?.message || run.stderr || run.stdout || "";
    const lower = String(details).toLowerCase();
    const missingDocbookConverter =
      lower.includes("missing converter for backend 'docbook5'") ||
      lower.includes("@asciidoctor/docbook-converter");
    const phase = lower.includes("docbook") || lower.includes("xml")
      ? "docbook_parse"
      : lower.includes("dc-") || lower.includes("config")
        ? "dc_parse"
        : "render";
    const hints: string[] = [];
    if (phase === "dc_parse") hints.push("DC file");
    if (phase === "docbook_parse") hints.push("docinfo xml", "main adoc", "vars adoc");
    return {
      ok: false as const,
      code: "DAPS_RENDER_FAILED",
      message: missingDocbookConverter
        ? "DAPS render failed: missing Asciidoctor DocBook converter for docbook5 output."
        : "DAPS render failed",
      details,
      phase,
      hints: missingDocbookConverter
        ? [...hints, "npm install", "@asciidoctor/docbook-converter"]
        : hints,
    };
  }

  return {
    ok: true as const,
    startedAt,
    stdout: run.stdout || "",
    stderr: run.stderr || "",
  };
};

const findLatestRenderedArtifact = (
  dcDirectory: string,
  extension: "html" | "pdf",
  earliestMtimeMs: number,
) => {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(`.${extension}`)) {
        files.push(fullPath);
      }
    }
  };
  visit(dcDirectory);

  const candidates = files
    .map((filePath) => ({
      filePath,
      stat: fs.statSync(filePath),
    }))
    .filter((item) => item.stat.mtimeMs >= earliestMtimeMs - 3000)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  return candidates.length > 0 ? candidates[0].filePath : null;
};

const isPathAllowedForUser = (userId: string, relativePath: string) => {
  const safePath = relativePath.replace(/\\/g, "/");
  const jobs = getJobsForUser(userId);
  return jobs.some((job) => (job.localExtractionPath as string | undefined)?.replace(/\\/g, "/") === safePath);
};

// Initialize Firebase Admin (Optional, usually uses standard Firebase in this env)
// But for backend logic, admin is better if service account is available.
// If not, we'll use the environment provided config.

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const trustedOrigins = new Set(CORS_ORIGIN_LIST);
  const allowAllOriginsInDev = process.env.NODE_ENV !== "production";

  openCollaborationDb();
  seedAdminUser();
  upsertLocalUsersInProfiles();
  migrateExistingJobsToProjects();
  initializeFirebaseAdmin();

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || trustedOrigins.has(origin) || allowAllOriginsInDev) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not allowed by CORS policy.`));
      },
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const requestId = randomBytes(8).toString("hex");
    (req as Request & { requestId?: string }).requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  // Security headers tuned for local/dev and VM HTTP usage.
  // Public-IP HTTP origins are not "potentially trustworthy", so COOP/OAC can
  // trigger browser warnings and break dev behavior inconsistently.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
    }),
  );

  // API Routes
  app.get("/api/health", async (req, res) => {
    res.json({ 
      status: "ok", 
      timestamp: new Date().toISOString(),
      pythonBackend: "disabled"
    });
  });

  app.post("/api/auth/google", async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId;
    const expectedProjectId = getFirebaseProjectId() || null;
    try {
      const idToken = requireString(req.body?.idToken, "idToken");
      const tokenPayload = decodeJwtPayload(idToken);
      const tokenProjectId = typeof tokenPayload?.aud === "string" ? tokenPayload.aud : null;
      // Do not enforce revocation check in local/dev login flow.
      // `checkRevoked=true` requires privileged backend calls that depend on
      // ADC/quota-project setup and causes local 403 errors in many setups.
      const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
      if (!decoded.uid || !decoded.email) {
        return sendApiError(res, 401, "GOOGLE_AUTH_INVALID", "Google token did not include required claims.");
      }

      const verified = {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name || decoded.email,
      };

      const user: SessionUser = {
        id: verified.uid,
        email: verified.email,
        displayName: verified.name,
        provider: "google",
      };
      upsertUserProfile(user);
      ensurePersonalProjectForUser(user);
      const session = createSession(user);
      setSessionCookie(res, session.token);
      logEvent("auth.google.success", {
        requestId,
        userId: user.id,
        source: "admin",
        expectedProjectId,
        tokenProjectId,
      });
      return res.json({ user });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Google authentication failed.";
      const tokenPayload = decodeJwtPayload(String(req.body?.idToken || ""));
      const tokenProjectId = typeof tokenPayload?.aud === "string" ? tokenPayload.aud : null;
      const tokenIssuer = typeof tokenPayload?.iss === "string" ? tokenPayload.iss : null;
      logEvent("auth.google.failed", {
        requestId,
        reason: message,
        expectedProjectId,
        tokenProjectId,
        tokenIssuer,
      });
      return sendApiError(
        res,
        401,
        "GOOGLE_AUTH_FAILED",
        message,
        {
          requestId,
          expectedProjectId,
          tokenProjectId,
          tokenIssuer,
        },
      );
    }
  });

  app.post("/api/auth/signup", (req, res) => {
    try {
      const email = normalizeIdentifier(requireString(req.body?.email, "email"));
      const password = requireString(req.body?.password, "password");
      const usernameInput = req.body?.username ? requireString(req.body?.username, "username") : email.split("@")[0];
      const username = normalizeIdentifier(usernameInput);
      const displayName = (req.body?.displayName as string | undefined)?.trim() || username;

      if (password.length < 6) {
        return sendApiError(res, 400, "WEAK_PASSWORD", "Password must be at least 6 characters.");
      }

      const users = getLocalUsers();
      const exists = users.some(
        (user) => normalizeIdentifier(user.email) === email || normalizeIdentifier(user.username) === username,
      );
      if (exists) {
        return sendApiError(res, 409, "USER_EXISTS", "A user with this email or username already exists.");
      }

      const passwordState = hashPassword(password);
      const now = new Date().toISOString();
      const user: LocalUserRecord = {
        id: `local-${Date.now()}-${randomBytes(4).toString("hex")}`,
        email,
        displayName,
        provider: "local",
        username,
        passwordSalt: passwordState.salt,
        passwordHash: passwordState.hash,
        createdAt: now,
      };
      users.push(user);
      saveLocalUsers(users);
      upsertUserProfile(
        {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          provider: user.provider,
        },
        user.username,
      );
      ensurePersonalProjectForUser({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        provider: user.provider,
      });
      const session = createSession(user);
      setSessionCookie(res, session.token);
      logEvent("auth.signup.success", {
        requestId: (req as Request & { requestId?: string }).requestId,
        userId: user.id,
        provider: user.provider,
      });
      return res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          provider: user.provider,
          username: user.username,
        },
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Signup failed.";
      return sendApiError(res, 500, "SIGNUP_FAILED", message);
    }
  });

  app.post("/api/auth/login", (req, res) => {
    try {
      const identifier = normalizeIdentifier(requireString(req.body?.identifier, "identifier"));
      const password = requireString(req.body?.password, "password");
      const users = getLocalUsers();
      const matched = users.find(
        (user) =>
          normalizeIdentifier(user.email) === identifier || normalizeIdentifier(user.username) === identifier,
      );
      if (!matched || !verifyPassword(password, matched.passwordSalt, matched.passwordHash)) {
        return sendApiError(res, 401, "INVALID_CREDENTIALS", "Invalid username/email or password.");
      }
      upsertUserProfile(
        {
          id: matched.id,
          email: matched.email,
          displayName: matched.displayName,
          provider: matched.provider,
        },
        matched.username,
      );
      ensurePersonalProjectForUser({
        id: matched.id,
        email: matched.email,
        displayName: matched.displayName,
        provider: matched.provider,
      });
      const session = createSession(matched);
      setSessionCookie(res, session.token);
      logEvent("auth.login.success", {
        requestId: (req as Request & { requestId?: string }).requestId,
        userId: matched.id,
        provider: matched.provider,
      });
      return res.json({
        user: {
          id: matched.id,
          email: matched.email,
          displayName: matched.displayName,
          provider: matched.provider,
          username: matched.username,
        },
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Login failed.";
      return sendApiError(res, 500, "LOGIN_FAILED", message);
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const user = getSessionUserByToken(token);
    clearSession(token);
    clearSessionCookie(res);
    logEvent("auth.logout", {
      requestId: (req as Request & { requestId?: string }).requestId,
      userId: user?.id || null,
    });
    res.json({ success: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const user = getSessionUserByToken(token);
    if (!user) {
      return sendApiError(res, 401, "AUTH_REQUIRED", "Authentication required.");
    }
    return res.json({ user });
  });

  app.get("/api/user/settings", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const settings = getUserSettings(authUser.id);
      return res.json({
        githubToken: settings.github_token || "",
        defaultRepo: settings.default_repo || "",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load user settings.";
      return sendApiError(res, 500, "USER_SETTINGS_FETCH_FAILED", message);
    }
  });

  app.put("/api/user/settings", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const githubToken = typeof req.body?.githubToken === "string" ? req.body.githubToken : undefined;
      const defaultRepo = typeof req.body?.defaultRepo === "string" ? req.body.defaultRepo : undefined;
      if (defaultRepo !== undefined && defaultRepo.trim() && !isValidGitHubRepo(defaultRepo.trim())) {
        return sendApiError(res, 400, "INVALID_INPUT", "defaultRepo must use owner/repo format.");
      }
      upsertUserSettings(authUser.id, { githubToken, defaultRepo });
      const settings = getUserSettings(authUser.id);
      return res.json({
        githubToken: settings.github_token || "",
        defaultRepo: settings.default_repo || "",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to save user settings.";
      return sendApiError(res, 500, "USER_SETTINGS_UPDATE_FAILED", message);
    }
  });

  app.get("/api/projects", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      ensurePersonalProjectForUser(authUser);
      const projects = listProjectsForUser(authUser.id).map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        role: project.role,
        isAdminOverride: isSuperAdminUser(authUser.id) && getMemberRoleForProject(project.id, authUser.id) === null,
        isPersonal: Boolean(project.is_personal),
        ownerUserId: project.owner_user_id,
        workspacePath: project.workspace_path,
        gitRepo: (project as ProjectRow).git_repo || null,
        gitProvider: (project as ProjectRow).git_provider || "github",
        gitDefaultBranch: (project as ProjectRow).git_default_branch || "main",
        pipelineCount: Number(project.pipeline_count || 0),
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      }));
      return res.json(projects);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to list projects.";
      return sendApiError(res, 500, "PROJECT_LIST_FAILED", message);
    }
  });

  app.post("/api/projects", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const name = requireString(req.body?.name, "name");
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      const isPersonal = Boolean(req.body?.isPersonal);
      const ownerSettings = getUserSettings(authUser.id);
      const gitRepoSource =
        typeof req.body?.gitRepo === "string" && req.body.gitRepo.trim()
          ? req.body.gitRepo
          : ownerSettings.default_repo || "";
      const gitRepo = isPersonal ? (gitRepoSource.trim() || null) : requireGitHubRepo(gitRepoSource, "gitRepo");
      const gitDefaultBranch =
        typeof req.body?.gitDefaultBranch === "string" && req.body.gitDefaultBranch.trim()
          ? req.body.gitDefaultBranch.trim()
          : "main";
      const projectId = createProjectWithOwner(authUser, {
        name,
        description,
        gitRepo,
        isPersonal,
        gitProvider: "github",
        defaultBranch: gitDefaultBranch,
      });
      recordProjectActivity(projectId, authUser.id, "project.created", { name, gitRepo, gitDefaultBranch });
      const created = getProjectById(projectId);
      return res.status(201).json(created);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to create project.";
      return sendApiError(res, 500, "PROJECT_CREATE_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      const role = requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");
      return res.json({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        role,
        isAdminOverride: isSuperAdminUser(authUser.id) && getMemberRoleForProject(projectId, authUser.id) === null,
        ownerUserId: project.owner_user_id,
        isPersonal: Boolean(project.is_personal),
        workspacePath: project.workspace_path,
        gitRepo: project.git_repo || null,
        gitProvider: project.git_provider || "github",
        gitDefaultBranch: project.git_default_branch || "main",
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to fetch project.";
      return sendApiError(res, 500, "PROJECT_FETCH_FAILED", message);
    }
  });

  app.patch("/api/projects/:projectId", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      const role = requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const updates: string[] = [];
      const values: unknown[] = [];
      const now = nowIso();

      if (typeof req.body?.workspacePath === "string" && req.body.workspacePath.trim()) {
        updates.push("workspace_path = ?");
        values.push(req.body.workspacePath.trim());
      }

      const touchesMetadata =
        typeof req.body?.name === "string" ||
        typeof req.body?.description === "string" ||
        typeof req.body?.gitRepo === "string" ||
        typeof req.body?.gitDefaultBranch === "string";
      if (touchesMetadata) {
        if (role !== "owner") {
          return sendApiError(res, 403, "FORBIDDEN", "Only project owner can rename project metadata.");
        }
        if (typeof req.body?.name === "string" && req.body.name.trim()) {
          updates.push("name = ?");
          values.push(req.body.name.trim());
        }
        if (typeof req.body?.description === "string") {
          updates.push("description = ?");
          values.push(req.body.description.trim());
        }
        if (typeof req.body?.gitRepo === "string") {
          const normalized = req.body.gitRepo.trim();
          if (normalized && !isValidGitHubRepo(normalized)) {
            return sendApiError(res, 400, "INVALID_INPUT", "gitRepo must use owner/repo format.");
          }
          updates.push("git_repo = ?");
          values.push(normalized || null);
        }
        if (typeof req.body?.gitDefaultBranch === "string" && req.body.gitDefaultBranch.trim()) {
          updates.push("git_default_branch = ?");
          values.push(req.body.gitDefaultBranch.trim());
        }
      }

      if (updates.length === 0) {
        return sendApiError(res, 400, "INVALID_INPUT", "No updatable fields provided.");
      }

      updates.push("updated_at = ?");
      values.push(now);
      values.push(projectId);
      openCollaborationDb()
        .prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`)
        .run(...(values as any[]));
      recordProjectActivity(projectId, authUser.id, "project.updated", { updates: Object.keys(req.body || {}) });
      const project = getProjectById(projectId);
      return res.json(project);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to update project.";
      return sendApiError(res, 500, "PROJECT_UPDATE_FAILED", message);
    }
  });

  app.delete("/api/projects/:projectId", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner"]);
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");
      if (project.is_personal === 1) {
        return sendApiError(res, 400, "INVALID_OPERATION", "Personal default project cannot be deleted.");
      }
      if (project.owner_user_id !== authUser.id && !isSuperAdminUser(authUser.id)) {
        return sendApiError(res, 403, "FORBIDDEN", "Only project owner can delete this project.");
      }

      const fallbackProjectId = ensurePersonalProjectForUser(authUser);
      const jobs = getLocalJobs();
      let changed = false;
      const rewrittenJobs = jobs.map((job) => {
        if (job.projectId !== projectId) return job;
        changed = true;
        return {
          ...job,
          projectId: fallbackProjectId,
          pipelineId: undefined,
          updatedAt: nowIso(),
        };
      });
      if (changed) {
        saveLocalJobs(rewrittenJobs);
      }

      recordProjectActivity(projectId, authUser.id, "project.deleted", {
        deletedProjectId: projectId,
        reassignedJobsToProjectId: fallbackProjectId,
      });
      openCollaborationDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      return res.json({ success: true, deletedProjectId: projectId, fallbackProjectId });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to delete project.";
      return sendApiError(res, 500, "PROJECT_DELETE_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/repo", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");

      const payload: Record<string, unknown> = {
        projectId: project.id,
        gitRepo: project.git_repo || null,
        gitProvider: project.git_provider || "github",
        defaultBranch: project.git_default_branch || "main",
      };
      const includeStatus = String(req.query?.includeStatus || "").toLowerCase() === "true";
      if (!includeStatus) {
        return res.json(payload);
      }

      const workspacePath = resolveProjectWorkspacePath(projectId);
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        return res.json({ ...payload, workspacePath: workspacePath || null, gitStatus: null });
      }
      const { simpleGit } = await import("simple-git");
      const git = simpleGit({ baseDir: workspacePath });
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return res.json({ ...payload, workspacePath, gitStatus: null });
      }
      const status = await git.status();
      return res.json({
        ...payload,
        workspacePath,
        gitStatus: {
          current: status.current,
          tracking: status.tracking,
          ahead: status.ahead,
          behind: status.behind,
          detached: status.detached,
          clean: status.isClean(),
        },
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to fetch project repo metadata.";
      return sendApiError(res, 500, "PROJECT_REPO_FETCH_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/members", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const members = openCollaborationDb()
        .prepare(
          `SELECT
             pm.user_id,
             pm.role,
             pm.status,
             pm.created_at,
             up.email,
             up.display_name,
             up.provider,
             up.username
           FROM project_members pm
           LEFT JOIN user_profiles up ON up.id = pm.user_id
           WHERE pm.project_id = ?
           ORDER BY CASE pm.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, pm.created_at ASC`,
        )
        .all(projectId) as Array<{
        user_id: string;
        role: MemberRole;
        status: string;
        created_at: string;
        email: string | null;
        display_name: string | null;
        provider: string | null;
        username: string | null;
      }>;
      return res.json(
        members.map((member) => ({
          userId: member.user_id,
          role: member.role,
          status: member.status,
          email: member.email,
          displayName: member.display_name,
          provider: member.provider,
          username: member.username,
          createdAt: member.created_at,
        })),
      );
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list members.";
      return sendApiError(res, 500, "PROJECT_MEMBERS_FAILED", message);
    }
  });

  app.patch("/api/projects/:projectId/members/:memberUserId", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner"]);
      const memberUserId = req.params.memberUserId;
      const role = requireString(req.body?.role, "role").toLowerCase();
      if (!isValidMemberRole(role)) {
        return sendApiError(res, 400, "INVALID_INPUT", "role must be owner, editor, or viewer.");
      }

      const db = openCollaborationDb();
      const existing = db
        .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
        .get(projectId, memberUserId) as { role: MemberRole } | undefined;
      if (!existing) return sendApiError(res, 404, "NOT_FOUND", "Member not found.");

      if (existing.role === "owner" && role !== "owner") {
        const ownerCount = db
          .prepare("SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'owner'")
          .get(projectId) as { count: number };
        if (Number(ownerCount.count) <= 1) {
          return sendApiError(res, 400, "LAST_OWNER", "Project must have at least one owner.");
        }
      }

      db.prepare("UPDATE project_members SET role = ?, updated_at = ? WHERE project_id = ? AND user_id = ?").run(
        role,
        nowIso(),
        projectId,
        memberUserId,
      );
      recordProjectActivity(projectId, authUser.id, "member.role_updated", { memberUserId, role });
      return res.json({ success: true });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to update member.";
      return sendApiError(res, 500, "PROJECT_MEMBER_UPDATE_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/invites", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const invites = openCollaborationDb()
        .prepare(
          `SELECT id, email, role, status, token, invited_by_user_id, expires_at, accepted_by_user_id, accepted_at, created_at, updated_at
           FROM project_invites
           WHERE project_id = ?
           ORDER BY created_at DESC`,
        )
        .all(projectId) as ProjectInviteRow[];
      return res.json(invites);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list invites.";
      return sendApiError(res, 500, "PROJECT_INVITES_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/invites", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      enforceInviteRateLimit(authUser.id);

      const email = normalizeEmail(requireString(req.body?.email, "email"));
      const roleRaw = requireString(req.body?.role, "role").toLowerCase();
      if (!isValidMemberRole(roleRaw)) {
        return sendApiError(res, 400, "INVALID_INPUT", "role must be owner, editor, or viewer.");
      }

      const db = openCollaborationDb();
      const existingUser = db
        .prepare("SELECT id FROM user_profiles WHERE email = ? LIMIT 1")
        .get(email) as { id: string } | undefined;
      if (existingUser) {
        const existingMember = db
          .prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1")
          .get(projectId, existingUser.id) as { id: string } | undefined;
        if (existingMember) {
          return sendApiError(res, 409, "ALREADY_MEMBER", "User is already a project collaborator.");
        }
      }

      const now = nowIso();
      const token = randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
      const inviteId = createRecordId("inv");
      db.prepare(
        `INSERT INTO project_invites
         (id, project_id, email, invited_by_user_id, role, token, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(inviteId, projectId, email, authUser.id, roleRaw, token, expiresAt, now, now);
      recordProjectActivity(projectId, authUser.id, "invite.created", { inviteId, email, role: roleRaw });

      let inviteEmailDelivery = "stub";
      const smtpHost = process.env.SMTP_HOST;
      const smtpPort = Number(process.env.SMTP_PORT || 587);
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const fromAddress = process.env.SMTP_FROM || smtpUser;
      const acceptUrl = `${DEFAULT_APP_URL}/login?invite=${encodeURIComponent(token)}`;
      if (smtpHost && smtpUser && smtpPass && fromAddress) {
        inviteEmailDelivery = "smtp_queued";
        // Do not block the API response on SMTP handshakes.
        // Local/dev SMTP misconfiguration should not freeze the collaboration flow.
        void (async () => {
          try {
            const nodemailer = await import("nodemailer");
            const transporter = nodemailer.createTransport({
              host: smtpHost,
              port: smtpPort,
              secure: smtpPort === 465,
              auth: { user: smtpUser, pass: smtpPass },
              connectionTimeout: 5000,
              greetingTimeout: 5000,
              socketTimeout: 7000,
            });
            await transporter.sendMail({
              from: fromAddress,
              to: email,
              subject: "SUSE DocEngine project invite",
              text: `You have been invited to collaborate on a project.\n\nAccept invite: ${acceptUrl}\n\nToken: ${token}`,
            });
            logEvent("invite.smtp.sent", {
              requestId: (req as Request & { requestId?: string }).requestId,
              inviteId,
              projectId,
              email,
            });
          } catch (smtpError: unknown) {
            logEvent("invite.smtp.failed", {
              requestId: (req as Request & { requestId?: string }).requestId,
              inviteId,
              projectId,
              email,
              message: smtpError instanceof Error ? smtpError.message : "SMTP delivery failed",
            });
          }
        })();
      }

      return res.status(201).json({
        inviteId,
        projectId,
        email,
        role: roleRaw,
        token,
        status: "pending",
        expiresAt,
        delivery: inviteEmailDelivery,
        acceptUrl,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to create invite.";
      return sendApiError(res, 500, "PROJECT_INVITE_CREATE_FAILED", message);
    }
  });

  app.post("/api/invites/accept", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const token = requireString(req.body?.token, "token");
      const db = openCollaborationDb();
      const invite = db
        .prepare("SELECT * FROM project_invites WHERE token = ? LIMIT 1")
        .get(token) as ProjectInviteRow | undefined;
      if (!invite) return sendApiError(res, 404, "NOT_FOUND", "Invite not found.");
      if (invite.status === "accepted" && invite.accepted_by_user_id === authUser.id) {
        return res.json({ success: true, projectId: invite.project_id, idempotent: true });
      }
      if (invite.status !== "pending") return sendApiError(res, 400, "INVALID_STATE", "Invite is not pending.");
      if (normalizeEmail(invite.email) !== normalizeEmail(authUser.email)) {
        return sendApiError(res, 403, "FORBIDDEN", "Invite email does not match authenticated user.");
      }
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        db.prepare("UPDATE project_invites SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), invite.id);
        return sendApiError(res, 400, "INVITE_EXPIRED", "Invite has expired.");
      }

      withDbTransaction((tx) => {
        tx.prepare(
          `INSERT INTO project_members (id, project_id, user_id, role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(project_id, user_id) DO UPDATE SET
             role = excluded.role,
             status = 'active',
             updated_at = excluded.updated_at`,
        ).run(createRecordId("pm"), invite.project_id, authUser.id, invite.role, nowIso(), nowIso());
        tx.prepare(
          "UPDATE project_invites SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ? WHERE id = ?",
        ).run(authUser.id, nowIso(), nowIso(), invite.id);
      });
      recordProjectActivity(invite.project_id, authUser.id, "invite.accepted", { inviteId: invite.id });
      return res.json({ success: true, projectId: invite.project_id });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to accept invite.";
      return sendApiError(res, 500, "PROJECT_INVITE_ACCEPT_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/pipelines", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const pipelines = openCollaborationDb()
        .prepare(
          `SELECT
             pl.id,
             pl.project_id,
             pl.name,
             pl.slug,
             pl.created_by_user_id,
             pl.base_job_id,
             pl.default_branch,
             pl.latest_version_no,
             pl.head_version_id,
             pl.created_at,
             pl.updated_at,
             pv.status AS head_status,
             pv.change_summary AS head_change_summary,
             COALESCE((SELECT COUNT(*) FROM project_branches br WHERE br.pipeline_id = pl.id), 0) AS branch_count,
             COALESCE((SELECT COUNT(*) FROM merge_requests mr WHERE mr.pipeline_id = pl.id AND mr.status IN ('open','approved')), 0) AS open_merge_requests
           FROM project_pipelines pl
           LEFT JOIN pipeline_versions pv ON pv.id = pl.head_version_id
           WHERE pl.project_id = ?
           ORDER BY pl.updated_at DESC`,
        )
        .all(projectId);
      return res.json(pipelines);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list pipelines.";
      return sendApiError(res, 500, "PIPELINE_LIST_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/attachable-pipelines", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);

      const userJobs = getJobsForUser(authUser.id);
      const db = openCollaborationDb();
      const linkedRows = db
        .prepare("SELECT project_id, base_job_id FROM project_pipelines WHERE base_job_id IS NOT NULL")
        .all() as Array<{ project_id: string; base_job_id: string }>;
      const personalProjectRows = db
        .prepare("SELECT id FROM projects WHERE is_personal = 1")
        .all() as Array<{ id: string }>;
      const personalProjectIds = new Set(personalProjectRows.map((row) => row.id));

      const linkedByJob = new Map<string, string[]>();
      for (const row of linkedRows) {
        const current = linkedByJob.get(row.base_job_id) || [];
        current.push(row.project_id);
        linkedByJob.set(row.base_job_id, current);
      }

      const eligible = userJobs
        .map((job) => {
          const linkedProjects = linkedByJob.get(job.id) || [];
          const inCurrentProject = linkedProjects.includes(projectId);
          const linkedElsewhere = linkedProjects.some((id) => id !== projectId && !personalProjectIds.has(id));
          const canAttach = inCurrentProject || linkedProjects.length === 0 || !linkedElsewhere;
          return {
            id: job.id,
            title: job.googleDocTitle || job.source || `Pipeline ${job.id}`,
            status: job.status,
            projectId: job.projectId || null,
            linkedProjects,
            inCurrentProject,
            linkedElsewhere,
            canAttach,
          };
        })
        .filter((item) => item.canAttach);

      return res.json({
        items: eligible,
        totalUserPipelines: userJobs.length,
        eligibleCount: eligible.length,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list attachable pipelines.";
      return sendApiError(res, 500, "ATTACHABLE_PIPELINES_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/pipelines", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const pipelineName = requireString(req.body?.name, "name");
      const baseJobId = typeof req.body?.baseJobId === "string" ? req.body.baseJobId : null;
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");
      let baseJob: JobRecord | undefined;
      if (baseJobId) {
        baseJob = getLocalJobs().find((job) => job.id === baseJobId);
        if (!baseJob || baseJob.userId !== authUser.id) {
          return sendApiError(
            res,
            403,
            "FORBIDDEN",
            "You can attach only your own personal pipelines to this project.",
          );
        }
        const db = openCollaborationDb();
        const alreadyAttachedHere = db
          .prepare("SELECT id FROM project_pipelines WHERE project_id = ? AND base_job_id = ? LIMIT 1")
          .get(projectId, baseJobId) as { id: string } | undefined;
        if (alreadyAttachedHere) {
          return sendApiError(res, 409, "ALREADY_EXISTS", "Selected pipeline is already attached to this project.");
        }
        const linkedElsewhere = db
          .prepare(
            `SELECT pp.id
             FROM project_pipelines pp
             JOIN projects p ON p.id = pp.project_id
             WHERE pp.base_job_id = ? AND pp.project_id != ? AND p.is_personal = 0
             LIMIT 1`,
          )
          .get(baseJobId, projectId) as { id: string } | undefined;
        if (linkedElsewhere) {
          return sendApiError(
            res,
            409,
            "ALREADY_LINKED",
            "Selected pipeline is already linked to another collaboration project.",
          );
        }
      }
      const defaultBranch =
        typeof req.body?.defaultBranch === "string" && req.body.defaultBranch.trim()
          ? req.body.defaultBranch.trim()
          : project.git_default_branch || "main";
      const now = nowIso();
      const db = openCollaborationDb();
      const pipelineId = createRecordId("pl");
      const baseSlug = toProjectSlug(pipelineName, "pipeline");
      let slug = baseSlug;
      let idx = 2;
      while (
        db.prepare("SELECT 1 FROM project_pipelines WHERE project_id = ? AND slug = ? LIMIT 1").get(projectId, slug) as
          | { 1: number }
          | undefined
      ) {
        slug = `${baseSlug}-${idx}`;
        idx += 1;
      }
      db.prepare(
        `INSERT INTO project_pipelines
         (id, project_id, name, slug, created_by_user_id, base_job_id, default_branch, latest_version_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(pipelineId, projectId, pipelineName, slug, authUser.id, baseJobId, defaultBranch, now, now);
      const initialContent =
        req.body?.initialContent ??
        (baseJob ? baseJob.asciiDocContent || "" : "");
      const initialVersion = createPipelineVersion(pipelineId, authUser.id, {
        sourceJobId: baseJobId,
        parentVersionId: null,
        baseVersionId: null,
        changeSummary: "Initial version",
        content: initialContent,
        status: "published",
      });
      db.prepare(
        `INSERT INTO project_branches
         (id, project_id, pipeline_id, name, created_by_user_id, base_version_id, head_version_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        createRecordId("br"),
        projectId,
        pipelineId,
        defaultBranch,
        authUser.id,
        initialVersion.versionId,
        initialVersion.versionId,
        nowIso(),
        nowIso(),
      );
      recordProjectActivity(projectId, authUser.id, "pipeline.created", { pipelineId, versionId: initialVersion.versionId });
      return res.status(201).json({
        id: pipelineId,
        projectId,
        name: pipelineName,
        slug,
        defaultBranch,
        headVersionId: initialVersion.versionId,
        latestVersionNo: initialVersion.versionNo,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to create pipeline.";
      return sendApiError(res, 500, "PIPELINE_CREATE_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/pipelines/:pipelineId/working-copy", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const db = openCollaborationDb();
      const pipeline = db
        .prepare("SELECT head_version_id FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(pipelineId, projectId) as { head_version_id: string | null } | undefined;
      if (!pipeline) return sendApiError(res, 404, "NOT_FOUND", "Pipeline not found.");
      const parent = pipeline.head_version_id
        ? (db
            .prepare("SELECT id, content_json FROM pipeline_versions WHERE id = ?")
            .get(pipeline.head_version_id) as { id: string; content_json: string } | undefined)
        : undefined;
      const requestedContent = req.body?.content;
      const content = requestedContent !== undefined ? requestedContent : JSON.parse(parent?.content_json || "{}");
      const version = createPipelineVersion(pipelineId, authUser.id, {
        parentVersionId: parent?.id || null,
        baseVersionId: parent?.id || null,
        sourceJobId: null,
        changeSummary: "Working copy",
        content,
        status: "working",
      });
      recordProjectActivity(projectId, authUser.id, "pipeline.working_copy_created", {
        pipelineId,
        versionId: version.versionId,
      });
      return res.status(201).json(version);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to create working copy.";
      return sendApiError(res, 500, "PIPELINE_WORKING_COPY_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/pipelines/:pipelineId/publish", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const versionId = requireString(req.body?.versionId, "versionId");
      const changeSummary = typeof req.body?.changeSummary === "string" ? req.body.changeSummary.trim() : null;
      const db = openCollaborationDb();
      const version = db
        .prepare("SELECT status FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
        .get(versionId, pipelineId) as { status: string } | undefined;
      if (!version) return sendApiError(res, 404, "NOT_FOUND", "Version not found.");
      if (version.status !== "working") {
        return sendApiError(res, 400, "INVALID_STATE", "Only working versions can be published.");
      }
      db.prepare("UPDATE pipeline_versions SET status = 'published', change_summary = ?, updated_at = ? WHERE id = ?").run(
        changeSummary,
        nowIso(),
        versionId,
      );
      recordProjectActivity(projectId, authUser.id, "pipeline.version_published", { pipelineId, versionId });
      return res.json({ success: true, versionId });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to publish version.";
      return sendApiError(res, 500, "PIPELINE_PUBLISH_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/pipelines/:pipelineId/branches", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const db = openCollaborationDb();
      const rows = db
        .prepare(
          `SELECT
             br.id,
             br.project_id,
             br.pipeline_id,
             br.name,
             br.created_by_user_id,
             br.base_version_id,
             br.head_version_id,
             br.status,
             br.created_at,
             br.updated_at,
             COALESCE((SELECT COUNT(*) FROM pipeline_commits pc WHERE pc.branch_id = br.id), 0) AS commit_count
           FROM project_branches br
           WHERE br.project_id = ? AND br.pipeline_id = ?
           ORDER BY br.updated_at DESC`,
        )
        .all(projectId, pipelineId);
      return res.json(rows);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list branches.";
      return sendApiError(res, 500, "PIPELINE_BRANCH_LIST_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/pipelines/:pipelineId/branches", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const name = requireString(req.body?.name, "name");
      const db = openCollaborationDb();
      const pipeline = db
        .prepare("SELECT head_version_id FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(pipelineId, projectId) as { head_version_id: string | null } | undefined;
      if (!pipeline) return sendApiError(res, 404, "NOT_FOUND", "Pipeline not found.");
      const baseVersionId =
        typeof req.body?.baseVersionId === "string" && req.body.baseVersionId.trim()
          ? req.body.baseVersionId.trim()
          : pipeline.head_version_id;
      const existing = db
        .prepare("SELECT id FROM project_branches WHERE pipeline_id = ? AND name = ? LIMIT 1")
        .get(pipelineId, name) as { id: string } | undefined;
      if (existing) {
        return sendApiError(res, 409, "ALREADY_EXISTS", "Branch already exists.");
      }
      const branchId = createRecordId("br");
      db.prepare(
        `INSERT INTO project_branches
         (id, project_id, pipeline_id, name, created_by_user_id, base_version_id, head_version_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(branchId, projectId, pipelineId, name, authUser.id, baseVersionId || null, baseVersionId || null, nowIso(), nowIso());
      recordProjectActivity(projectId, authUser.id, "branch.created", { pipelineId, branchId, branchName: name });
      return res.status(201).json({ id: branchId, projectId, pipelineId, name, baseVersionId: baseVersionId || null });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to create branch.";
      return sendApiError(res, 500, "PIPELINE_BRANCH_CREATE_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/pipelines/:pipelineId/commits", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const branchId = typeof req.query?.branchId === "string" ? req.query.branchId.trim() : "";
      const db = openCollaborationDb();
      const sql = `
        SELECT
          pc.id,
          pc.project_id,
          pc.pipeline_id,
          pc.branch_id,
          br.name AS branch_name,
          pc.version_id,
          pc.message,
          pc.author_user_id,
          up.display_name AS author_name,
          pc.linked_work_item_id,
          pc.git_sha,
          pc.status,
          pc.created_at
        FROM pipeline_commits pc
        LEFT JOIN project_branches br ON br.id = pc.branch_id
        LEFT JOIN user_profiles up ON up.id = pc.author_user_id
        WHERE pc.project_id = ? AND pc.pipeline_id = ?
      `;
      const rows = branchId
        ? db.prepare(`${sql} AND pc.branch_id = ? ORDER BY pc.created_at DESC`).all(projectId, pipelineId, branchId)
        : db.prepare(`${sql} ORDER BY pc.created_at DESC`).all(projectId, pipelineId);
      return res.json(rows);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list commits.";
      return sendApiError(res, 500, "PIPELINE_COMMIT_LIST_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/pipelines/:pipelineId/commits", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const message = requireString(req.body?.message, "message");
      const versionId = requireString(req.body?.versionId, "versionId");
      const db = openCollaborationDb();
      const version = db
        .prepare("SELECT status FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
        .get(versionId, pipelineId) as { status: string } | undefined;
      if (!version) return sendApiError(res, 404, "NOT_FOUND", "Version not found.");
      if (version.status === "working") {
        db.prepare("UPDATE pipeline_versions SET status = 'published', updated_at = ? WHERE id = ?").run(nowIso(), versionId);
      }

      let branchId = typeof req.body?.branchId === "string" ? req.body.branchId.trim() : "";
      if (!branchId) {
        const branch = getDefaultBranchRecord(projectId, pipelineId);
        if (!branch) return sendApiError(res, 404, "NOT_FOUND", "Default branch not found.");
        branchId = branch.id;
      }

      const branch = db
        .prepare("SELECT id, name FROM project_branches WHERE id = ? AND project_id = ? AND pipeline_id = ?")
        .get(branchId, projectId, pipelineId) as { id: string; name: string } | undefined;
      if (!branch) return sendApiError(res, 404, "NOT_FOUND", "Branch not found.");

      const linkedWorkItemId =
        typeof req.body?.linkedWorkItemId === "string" && req.body.linkedWorkItemId.trim()
          ? req.body.linkedWorkItemId.trim()
          : null;
      if (linkedWorkItemId) {
        const workItem = db
          .prepare("SELECT id FROM project_work_items WHERE id = ? AND project_id = ?")
          .get(linkedWorkItemId, projectId) as { id: string } | undefined;
        if (!workItem) {
          return sendApiError(res, 404, "NOT_FOUND", "Linked work item not found.");
        }
      }

      const commitId = createRecordId("cmt");
      withDbTransaction((tx) => {
        tx.prepare(
          `INSERT INTO pipeline_commits
           (id, project_id, pipeline_id, branch_id, version_id, message, author_user_id, linked_work_item_id, git_sha, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
        ).run(
          commitId,
          projectId,
          pipelineId,
          branch.id,
          versionId,
          message,
          authUser.id,
          linkedWorkItemId,
          typeof req.body?.gitSha === "string" ? req.body.gitSha.trim() || null : null,
          nowIso(),
        );
        tx.prepare("UPDATE project_branches SET head_version_id = ?, updated_at = ? WHERE id = ?").run(
          versionId,
          nowIso(),
          branch.id,
        );
        if (linkedWorkItemId) {
          tx.prepare(
            "UPDATE project_work_items SET state = 'review', branch_id = ?, pipeline_id = ?, updated_at = ? WHERE id = ?",
          ).run(branch.id, pipelineId, nowIso(), linkedWorkItemId);
        }
      });
      recordProjectActivity(projectId, authUser.id, "commit.published", {
        pipelineId,
        branchId: branch.id,
        commitId,
        versionId,
        linkedWorkItemId,
      });
      return res.status(201).json({
        id: commitId,
        projectId,
        pipelineId,
        branchId: branch.id,
        branchName: branch.name,
        versionId,
        message,
        linkedWorkItemId,
        createdAt: nowIso(),
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to publish commit.";
      return sendApiError(res, 500, "PIPELINE_COMMIT_PUBLISH_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/pipelines/:pipelineId/push", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const commitId = requireString(req.body?.commitId, "commitId");
      const requestedBranchId =
        typeof req.body?.branchId === "string" && req.body.branchId.trim() ? req.body.branchId.trim() : "";
      const requestedBranchName =
        typeof req.body?.branchName === "string" && req.body.branchName.trim() ? req.body.branchName.trim() : "";
      const createIfMissing = req.body?.createIfMissing !== false;
      const db = openCollaborationDb();
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");
      if (!project.git_repo) {
        return sendApiError(res, 400, "PROJECT_REPO_NOT_CONFIGURED", "Project repository is not configured.");
      }
      const pipeline = db
        .prepare("SELECT id, name, slug, base_job_id FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(pipelineId, projectId) as { id: string; name: string; slug: string; base_job_id: string | null } | undefined;
      if (!pipeline) return sendApiError(res, 404, "NOT_FOUND", "Pipeline not found.");

      const commit = db
        .prepare(
          `SELECT id, branch_id, version_id, message
           FROM pipeline_commits
           WHERE id = ? AND project_id = ? AND pipeline_id = ?`,
        )
        .get(commitId, projectId, pipelineId) as
        | { id: string; branch_id: string; version_id: string; message: string }
        | undefined;
      if (!commit) return sendApiError(res, 404, "NOT_FOUND", "Commit not found for selected pipeline.");

      let targetBranch =
        requestedBranchId
          ? (db
              .prepare("SELECT id, name FROM project_branches WHERE id = ? AND project_id = ? AND pipeline_id = ?")
              .get(requestedBranchId, projectId, pipelineId) as { id: string; name: string } | undefined)
          : undefined;
      if (!targetBranch && requestedBranchName) {
        targetBranch = db
          .prepare("SELECT id, name FROM project_branches WHERE project_id = ? AND pipeline_id = ? AND name = ?")
          .get(projectId, pipelineId, requestedBranchName) as { id: string; name: string } | undefined;
      }
      if (!targetBranch && requestedBranchName && createIfMissing) {
        const now = nowIso();
        const branchId = createRecordId("br");
        db.prepare(
          `INSERT INTO project_branches
           (id, project_id, pipeline_id, name, created_by_user_id, base_version_id, head_version_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(
          branchId,
          projectId,
          pipelineId,
          requestedBranchName,
          authUser.id,
          commit.version_id,
          commit.version_id,
          now,
          now,
        );
        targetBranch = { id: branchId, name: requestedBranchName };
      }
      if (!targetBranch) {
        targetBranch = db
          .prepare("SELECT id, name FROM project_branches WHERE id = ? AND project_id = ? AND pipeline_id = ?")
          .get(commit.branch_id, projectId, pipelineId) as { id: string; name: string } | undefined;
      }
      if (!targetBranch) {
        return sendApiError(res, 404, "NOT_FOUND", "Target branch not found.");
      }

      const versionRow = db
        .prepare("SELECT content_json FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
        .get(commit.version_id, pipelineId) as { content_json: string } | undefined;
      if (!versionRow) return sendApiError(res, 404, "NOT_FOUND", "Version content not found.");
      const parsedVersionContent = (() => {
        try {
          return JSON.parse(versionRow.content_json || "null");
        } catch {
          return versionRow.content_json;
        }
      })();
      const versionFiles = normalizeVersionFiles(parsedVersionContent);

      const workspacePath = resolveProjectWorkspacePath(projectId);
      if (!workspacePath) {
        return sendApiError(res, 400, "INVALID_STATE", "Project workspace path is not configured.");
      }
      if (!fs.existsSync(workspacePath)) {
        return sendApiError(res, 404, "NOT_FOUND", "Project workspace path does not exist.");
      }

      const { simpleGit } = await import("simple-git");
      const git = simpleGit({ baseDir: workspacePath });
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return sendApiError(res, 400, "GIT_REPO_NOT_FOUND", "Workspace is not a git repository.");
      }

      if ((project.git_provider || "github") === "github") {
        const remotes = await git.getRemotes(true);
        const githubRemote = remotes.find((remote) => {
          const fetch = remote.refs.fetch || "";
          const push = remote.refs.push || "";
          return /github\.com[:/]/i.test(fetch) || /github\.com[:/]/i.test(push);
        });
        if (githubRemote) {
          const actorSettings = getUserSettings(authUser.id);
          const ownerSettings = getUserSettings(project.owner_user_id);
          if (!actorSettings.github_token && !ownerSettings.github_token) {
            return sendApiError(
              res,
              400,
              "GITHUB_AUTH_MISSING",
              "GitHub token is missing. Configure it in Settings before pushing this project.",
            );
          }
        }
      }

      const targetBranchName = targetBranch.name.trim();
      let remoteBranchExists = false;
      try {
        const remoteResult = await git.raw(["ls-remote", "--heads", "origin", targetBranchName]);
        remoteBranchExists = Boolean(remoteResult.trim());
      } catch {
        remoteBranchExists = false;
      }

      const localBranches = await git.branchLocal();
      if (localBranches.all.includes(targetBranchName)) {
        await git.checkout(targetBranchName);
      } else if (remoteBranchExists) {
        await git.checkout(["-b", targetBranchName, `origin/${targetBranchName}`]);
      } else if (createIfMissing) {
        await git.checkoutLocalBranch(targetBranchName);
      } else {
        return sendApiError(
          res,
          404,
          "BRANCH_NOT_FOUND",
          "Branch does not exist locally or remotely. Enable createIfMissing to create it.",
        );
      }

      const touchedFiles: string[] = [];
      const mainAdoc = versionFiles["adoc/main.adoc"] || Object.values(versionFiles)[0] || "";
      const targetAsciiPath = resolvePipelineAsciiTargetPath(pipeline, workspacePath);
      fs.mkdirSync(path.dirname(targetAsciiPath), { recursive: true });
      fs.writeFileSync(targetAsciiPath, mainAdoc, "utf-8");
      touchedFiles.push(path.relative(workspacePath, targetAsciiPath).replace(/\\/g, "/"));

      const snapshotRoot = path.join(workspacePath, ".suse-docengine", "pipelines", pipeline.slug || pipeline.id, "snapshot");
      for (const [filePath, fileContent] of Object.entries(versionFiles)) {
        const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
        if (!normalizedPath) continue;
        const targetPath = path.join(snapshotRoot, normalizedPath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, fileContent, "utf-8");
        touchedFiles.push(path.relative(workspacePath, targetPath).replace(/\\/g, "/"));
      }

      const pushLedgerPath = path.join(workspacePath, ".suse-docengine", "push-log.jsonl");
      fs.mkdirSync(path.dirname(pushLedgerPath), { recursive: true });
      fs.appendFileSync(
        pushLedgerPath,
        `${JSON.stringify({
          timestamp: nowIso(),
          projectId,
          pipelineId,
          commitId: commit.id,
          branch: targetBranchName,
          actorUserId: authUser.id,
        })}\n`,
        "utf-8",
      );
      touchedFiles.push(path.relative(workspacePath, pushLedgerPath).replace(/\\/g, "/"));

      await git.add(".");
      const commitMessage =
        typeof req.body?.message === "string" && req.body.message.trim()
          ? req.body.message.trim()
          : `[docengine] ${pipeline.name} :: ${commit.message}`;
      let localCommitSha = "";
      try {
        const commitResult = await git.commit(commitMessage);
        localCommitSha = commitResult.commit || "";
      } catch (commitError) {
        const commitText = commitError instanceof Error ? commitError.message : String(commitError || "");
        if (!/nothing to commit/i.test(commitText)) {
          throw commitError;
        }
      }

      let pushResult: unknown = null;
      try {
        pushResult = remoteBranchExists
          ? await git.push("origin", targetBranchName)
          : await git.push(["-u", "origin", targetBranchName]);
      } catch (pushError: unknown) {
        const message = pushError instanceof Error ? pushError.message : String(pushError || "Push failed.");
        if (isGitConflictMessage(message)) {
          return sendApiError(
            res,
            409,
            "PUSH_CONFLICT",
            "Push was rejected due to branch divergence. Pull/rebase manually, resolve conflicts, then retry push.",
            {
              branch: targetBranchName,
              repo: project.git_repo,
              hint: "Run pull on the target branch, resolve conflicts locally, publish a fresh commit, then push again.",
              raw: message,
            },
          );
        }
        return sendApiError(res, 500, "PUSH_FAILED", message);
      }

      const gitStatus = await git.status();
      withDbTransaction((tx) => {
        tx.prepare("UPDATE project_branches SET head_version_id = ?, updated_at = ? WHERE id = ?").run(
          commit.version_id,
          nowIso(),
          targetBranch.id,
        );
        tx.prepare("UPDATE pipeline_commits SET git_sha = ?, status = ? WHERE id = ?").run(
          localCommitSha || null,
          "pushed",
          commit.id,
        );
      });
      recordProjectActivity(projectId, authUser.id, "pipeline.pushed", {
        pipelineId,
        commitId: commit.id,
        branchId: targetBranch.id,
        branchName: targetBranchName,
        gitSha: localCommitSha || null,
        touchedFiles: touchedFiles.slice(0, 30),
        projectRepo: project.git_repo,
        result: pushResult,
      });

      return res.json({
        success: true,
        projectId,
        pipelineId,
        commitId: commit.id,
        branchId: targetBranch.id,
        branchName: targetBranchName,
        gitSha: localCommitSha || null,
        touchedFiles: touchedFiles.slice(0, 100),
        pushResult,
        syncStatus: {
          current: gitStatus.current,
          tracking: gitStatus.tracking,
          ahead: gitStatus.ahead,
          behind: gitStatus.behind,
          detached: gitStatus.detached,
          clean: gitStatus.isClean(),
          conflicted: gitStatus.files.some((file) => /U/.test(`${file.index || ""}${file.working_dir || ""}`)),
        },
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to push pipeline to repository.";
      return sendApiError(res, 500, "PIPELINE_PUSH_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/pipelines/:pipelineId/push-status", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, pipelineId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const db = openCollaborationDb();
      const pipeline = db
        .prepare("SELECT id, name FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(pipelineId, projectId) as { id: string; name: string } | undefined;
      if (!pipeline) return sendApiError(res, 404, "NOT_FOUND", "Pipeline not found.");

      const activityRows = db
        .prepare(
          `SELECT id, actor_user_id, payload_json, created_at
           FROM project_activity
           WHERE project_id = ? AND event_type = 'pipeline.pushed'
           ORDER BY created_at DESC
           LIMIT 200`,
        )
        .all(projectId) as Array<{ id: string; actor_user_id: string; payload_json: string; created_at: string }>;
      const lastPush = activityRows
        .map((row) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(row.payload_json || "{}") as Record<string, unknown>;
          } catch {
            payload = {};
          }
          return { row, payload };
        })
        .find((item) => String(item.payload.pipelineId || "") === pipelineId);

      let syncStatus: Record<string, unknown> | null = null;
      const workspacePath = resolveProjectWorkspacePath(projectId);
      if (workspacePath && fs.existsSync(workspacePath)) {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit({ baseDir: workspacePath });
        const isRepo = await git.checkIsRepo();
        if (isRepo) {
          const gitStatus = await git.status();
          syncStatus = {
            current: gitStatus.current,
            tracking: gitStatus.tracking,
            ahead: gitStatus.ahead,
            behind: gitStatus.behind,
            detached: gitStatus.detached,
            clean: gitStatus.isClean(),
            conflicted: gitStatus.files.some((file) => /U/.test(`${file.index || ""}${file.working_dir || ""}`)),
          };
        }
      }

      return res.json({
        projectId,
        pipelineId,
        pipelineName: pipeline.name,
        lastPush: lastPush
          ? {
              id: lastPush.row.id,
              actorUserId: lastPush.row.actor_user_id,
              createdAt: lastPush.row.created_at,
              payload: lastPush.payload,
            }
          : null,
        syncStatus,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to fetch push status.";
      return sendApiError(res, 500, "PIPELINE_PUSH_STATUS_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/pipeline-compare", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner"]);
      const leftPipelineId = requireString(req.query?.leftPipelineId, "leftPipelineId");
      const rightPipelineId = requireString(req.query?.rightPipelineId, "rightPipelineId");
      const leftCommitId = typeof req.query?.leftCommitId === "string" ? req.query.leftCommitId.trim() : "";
      const rightCommitId = typeof req.query?.rightCommitId === "string" ? req.query.rightCommitId.trim() : "";
      const leftVersionId = typeof req.query?.leftVersionId === "string" ? req.query.leftVersionId.trim() : "";
      const rightVersionId = typeof req.query?.rightVersionId === "string" ? req.query.rightVersionId.trim() : "";
      const db = openCollaborationDb();

      const leftPipeline = db
        .prepare("SELECT id, name, head_version_id FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(leftPipelineId, projectId) as { id: string; name: string; head_version_id: string | null } | undefined;
      const rightPipeline = db
        .prepare("SELECT id, name, head_version_id FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(rightPipelineId, projectId) as { id: string; name: string; head_version_id: string | null } | undefined;
      if (!leftPipeline || !rightPipeline) {
        return sendApiError(res, 404, "NOT_FOUND", "One or both selected pipelines were not found.");
      }

      const resolveVersion = (
        pipelineId: string,
        pipelineHeadVersionId: string | null,
        explicitCommitId: string,
        explicitVersionId: string,
      ) => {
        if (explicitCommitId) {
          const commit = db
            .prepare(
              `SELECT pc.id, pc.version_id, pc.author_user_id, pc.created_at, up.display_name AS author_name
               FROM pipeline_commits pc
               LEFT JOIN user_profiles up ON up.id = pc.author_user_id
               WHERE pc.id = ? AND pc.project_id = ? AND pc.pipeline_id = ?`,
            )
            .get(explicitCommitId, projectId, pipelineId) as
            | { id: string; version_id: string; author_user_id: string; created_at: string; author_name: string | null }
            | undefined;
          if (!commit) throw asApiError(404, "NOT_FOUND", `Commit ${explicitCommitId} not found.`);
          return {
            commitId: commit.id,
            versionId: commit.version_id,
            actorUserId: commit.author_user_id,
            actorName: commit.author_name,
            createdAt: commit.created_at,
          };
        }
        if (explicitVersionId) {
          const version = db
            .prepare(
              `SELECT pv.id, pv.created_by_user_id, pv.created_at, up.display_name AS author_name
               FROM pipeline_versions pv
               LEFT JOIN user_profiles up ON up.id = pv.created_by_user_id
               WHERE pv.id = ? AND pv.pipeline_id = ?`,
            )
            .get(explicitVersionId, pipelineId) as
            | { id: string; created_by_user_id: string; created_at: string; author_name: string | null }
            | undefined;
          if (!version) throw asApiError(404, "NOT_FOUND", `Version ${explicitVersionId} not found.`);
          return {
            commitId: null as string | null,
            versionId: version.id,
            actorUserId: version.created_by_user_id,
            actorName: version.author_name,
            createdAt: version.created_at,
          };
        }
        const latestCommit = db
          .prepare(
            `SELECT pc.id, pc.version_id, pc.author_user_id, pc.created_at, up.display_name AS author_name
             FROM pipeline_commits pc
             LEFT JOIN user_profiles up ON up.id = pc.author_user_id
             WHERE pc.project_id = ? AND pc.pipeline_id = ?
             ORDER BY pc.created_at DESC
             LIMIT 1`,
          )
          .get(projectId, pipelineId) as
          | { id: string; version_id: string; author_user_id: string; created_at: string; author_name: string | null }
          | undefined;
        if (latestCommit) {
          return {
            commitId: latestCommit.id,
            versionId: latestCommit.version_id,
            actorUserId: latestCommit.author_user_id,
            actorName: latestCommit.author_name,
            createdAt: latestCommit.created_at,
          };
        }
        if (!pipelineHeadVersionId) {
          throw asApiError(404, "NOT_FOUND", "Pipeline does not have any version to compare.");
        }
        const headVersion = db
          .prepare(
            `SELECT pv.id, pv.created_by_user_id, pv.created_at, up.display_name AS author_name
             FROM pipeline_versions pv
             LEFT JOIN user_profiles up ON up.id = pv.created_by_user_id
             WHERE pv.id = ? AND pv.pipeline_id = ?`,
          )
          .get(pipelineHeadVersionId, pipelineId) as
          | { id: string; created_by_user_id: string; created_at: string; author_name: string | null }
          | undefined;
        if (!headVersion) throw asApiError(404, "NOT_FOUND", "Pipeline head version not found.");
        return {
          commitId: null as string | null,
          versionId: headVersion.id,
          actorUserId: headVersion.created_by_user_id,
          actorName: headVersion.author_name,
          createdAt: headVersion.created_at,
        };
      };

      const leftSelection = resolveVersion(leftPipeline.id, leftPipeline.head_version_id, leftCommitId, leftVersionId);
      const rightSelection = resolveVersion(rightPipeline.id, rightPipeline.head_version_id, rightCommitId, rightVersionId);
      const leftVersionRow = db
        .prepare("SELECT content_json FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
        .get(leftSelection.versionId, leftPipeline.id) as { content_json: string } | undefined;
      const rightVersionRow = db
        .prepare("SELECT content_json FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
        .get(rightSelection.versionId, rightPipeline.id) as { content_json: string } | undefined;
      if (!leftVersionRow || !rightVersionRow) {
        return sendApiError(res, 404, "NOT_FOUND", "Unable to load compared version content.");
      }

      const parseVersionContent = (jsonText: string) => {
        try {
          return JSON.parse(jsonText || "null");
        } catch {
          return jsonText;
        }
      };
      const leftFiles = normalizeVersionFiles(parseVersionContent(leftVersionRow.content_json));
      const rightFiles = normalizeVersionFiles(parseVersionContent(rightVersionRow.content_json));
      const paths = Array.from(new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)])).sort((a, b) =>
        a.localeCompare(b),
      );

      const files = paths.map((filePath) => {
        const leftText = leftFiles[filePath];
        const rightText = rightFiles[filePath];
        const status =
          leftText === undefined
            ? "added"
            : rightText === undefined
              ? "removed"
              : leftText === rightText
                ? "unchanged"
                : "modified";
        const unifiedDiff =
          status === "unchanged" ? "" : buildUnifiedDiff(leftText || "", rightText || "", filePath);
        const maxPreviewLines = 60;
        const toPreview = (value: string | undefined) =>
          (value || "")
            .split(/\r?\n/)
            .slice(0, maxPreviewLines)
            .join("\n");
        return {
          path: filePath,
          status,
          leftLineCount: leftText ? leftText.split(/\r?\n/).length : 0,
          rightLineCount: rightText ? rightText.split(/\r?\n/).length : 0,
          changedLines: countChangedDiffLines(unifiedDiff),
          unifiedDiff,
          leftPreview: toPreview(leftText),
          rightPreview: toPreview(rightText),
        };
      });

      const summary = files.reduce(
        (acc, file) => {
          if (file.status === "added") acc.added += 1;
          if (file.status === "removed") acc.removed += 1;
          if (file.status === "modified") acc.modified += 1;
          if (file.status !== "unchanged") acc.changed += 1;
          return acc;
        },
        { total: files.length, changed: 0, added: 0, removed: 0, modified: 0 },
      );

      return res.json({
        left: {
          pipelineId: leftPipeline.id,
          pipelineName: leftPipeline.name,
          commitId: leftSelection.commitId,
          versionId: leftSelection.versionId,
          actorUserId: leftSelection.actorUserId,
          actorName: leftSelection.actorName,
          createdAt: leftSelection.createdAt,
        },
        right: {
          pipelineId: rightPipeline.id,
          pipelineName: rightPipeline.name,
          commitId: rightSelection.commitId,
          versionId: rightSelection.versionId,
          actorUserId: rightSelection.actorUserId,
          actorName: rightSelection.actorName,
          createdAt: rightSelection.createdAt,
        },
        summary,
        files,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to compare pipelines.";
      return sendApiError(res, 500, "PIPELINE_COMPARE_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/work-items", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const stateFilter = typeof req.query?.state === "string" ? req.query.state.trim() : "";
      const db = openCollaborationDb();
      const sql = `
        SELECT
          wi.id,
          wi.project_id,
          wi.title,
          wi.description,
          wi.type,
          wi.state,
          wi.created_by_user_id,
          wi.assignee_user_id,
          wi.pipeline_id,
          wi.branch_id,
          wi.merge_request_id,
          wi.created_at,
          wi.updated_at,
          creator.display_name AS creator_name,
          assignee.display_name AS assignee_name
        FROM project_work_items wi
        LEFT JOIN user_profiles creator ON creator.id = wi.created_by_user_id
        LEFT JOIN user_profiles assignee ON assignee.id = wi.assignee_user_id
        WHERE wi.project_id = ?
      `;
      const rows = stateFilter
        ? db.prepare(`${sql} AND wi.state = ? ORDER BY wi.updated_at DESC`).all(projectId, stateFilter)
        : db.prepare(`${sql} ORDER BY wi.updated_at DESC`).all(projectId);
      return res.json(rows);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list work items.";
      return sendApiError(res, 500, "WORK_ITEM_LIST_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/work-items", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const title = requireString(req.body?.title, "title");
      const typeRaw = typeof req.body?.type === "string" ? req.body.type.trim().toLowerCase() : "task";
      if (!isValidWorkItemType(typeRaw)) {
        return sendApiError(res, 400, "INVALID_INPUT", "type must be task, bug, or story.");
      }
      const stateRaw = typeof req.body?.state === "string" ? req.body.state.trim().toLowerCase() : "open";
      if (!isValidWorkItemState(stateRaw)) {
        return sendApiError(res, 400, "INVALID_INPUT", "state must be open, in_progress, review, or done.");
      }
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      const assigneeUserId =
        typeof req.body?.assigneeUserId === "string" && req.body.assigneeUserId.trim()
          ? req.body.assigneeUserId.trim()
          : null;
      const pipelineId =
        typeof req.body?.pipelineId === "string" && req.body.pipelineId.trim() ? req.body.pipelineId.trim() : null;
      const branchId =
        typeof req.body?.branchId === "string" && req.body.branchId.trim() ? req.body.branchId.trim() : null;
      const workItemId = createRecordId("wi");
      openCollaborationDb()
        .prepare(
          `INSERT INTO project_work_items
           (id, project_id, title, description, type, state, created_by_user_id, assignee_user_id, pipeline_id, branch_id, merge_request_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(workItemId, projectId, title, description, typeRaw, stateRaw, authUser.id, assigneeUserId, pipelineId, branchId, nowIso(), nowIso());
      recordProjectActivity(projectId, authUser.id, "work_item.created", { workItemId, title, type: typeRaw, state: stateRaw });
      return res.status(201).json({
        id: workItemId,
        projectId,
        title,
        description,
        type: typeRaw,
        state: stateRaw,
        createdByUserId: authUser.id,
        assigneeUserId,
        pipelineId,
        branchId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to create work item.";
      return sendApiError(res, 500, "WORK_ITEM_CREATE_FAILED", message);
    }
  });

  app.patch("/api/projects/:projectId/work-items/:workItemId", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, workItemId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const updates: string[] = [];
      const values: unknown[] = [];
      if (typeof req.body?.title === "string" && req.body.title.trim()) {
        updates.push("title = ?");
        values.push(req.body.title.trim());
      }
      if (typeof req.body?.description === "string") {
        updates.push("description = ?");
        values.push(req.body.description.trim());
      }
      if (typeof req.body?.state === "string") {
        const state = req.body.state.trim().toLowerCase();
        if (!isValidWorkItemState(state)) {
          return sendApiError(res, 400, "INVALID_INPUT", "state must be open, in_progress, review, or done.");
        }
        updates.push("state = ?");
        values.push(state);
      }
      if (typeof req.body?.assigneeUserId === "string") {
        updates.push("assignee_user_id = ?");
        values.push(req.body.assigneeUserId.trim() || null);
      }
      if (typeof req.body?.pipelineId === "string") {
        updates.push("pipeline_id = ?");
        values.push(req.body.pipelineId.trim() || null);
      }
      if (typeof req.body?.branchId === "string") {
        updates.push("branch_id = ?");
        values.push(req.body.branchId.trim() || null);
      }
      if (typeof req.body?.mergeRequestId === "string") {
        updates.push("merge_request_id = ?");
        values.push(req.body.mergeRequestId.trim() || null);
      }
      if (updates.length === 0) {
        return sendApiError(res, 400, "INVALID_INPUT", "No updatable fields provided.");
      }
      updates.push("updated_at = ?");
      values.push(nowIso());
      values.push(workItemId);
      values.push(projectId);
      const db = openCollaborationDb();
      const result = db
        .prepare(`UPDATE project_work_items SET ${updates.join(", ")} WHERE id = ? AND project_id = ?`)
        .run(...(values as any[]));
      if (Number(result.changes || 0) === 0) {
        return sendApiError(res, 404, "NOT_FOUND", "Work item not found.");
      }
      recordProjectActivity(projectId, authUser.id, "work_item.updated", { workItemId, fields: Object.keys(req.body || {}) });
      const item = db
        .prepare("SELECT * FROM project_work_items WHERE id = ? AND project_id = ?")
        .get(workItemId, projectId);
      return res.json(item);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to update work item.";
      return sendApiError(res, 500, "WORK_ITEM_UPDATE_FAILED", message);
    }
  });

  app.post(
    "/api/projects/:projectId/pipelines/:pipelineId/merge-requests",
    requireAuth,
    (req: AuthedRequest, res) => {
      try {
        const authUser = getAuthUser(req);
        const { projectId, pipelineId } = req.params;
        requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
        const db = openCollaborationDb();

        const sourceCommitId =
          typeof req.body?.sourceCommitId === "string" && req.body.sourceCommitId.trim()
            ? req.body.sourceCommitId.trim()
            : null;
        const sourceBranchId =
          typeof req.body?.sourceBranchId === "string" && req.body.sourceBranchId.trim()
            ? req.body.sourceBranchId.trim()
            : null;
        let sourceVersionId =
          typeof req.body?.sourceVersionId === "string" && req.body.sourceVersionId.trim()
            ? req.body.sourceVersionId.trim()
            : "";
        if (!sourceVersionId && sourceCommitId) {
          const commit = db
            .prepare("SELECT version_id, branch_id FROM pipeline_commits WHERE id = ? AND project_id = ? AND pipeline_id = ?")
            .get(sourceCommitId, projectId, pipelineId) as { version_id: string; branch_id: string } | undefined;
          if (!commit) return sendApiError(res, 404, "NOT_FOUND", "Source commit not found.");
          sourceVersionId = commit.version_id;
        }
        if (!sourceVersionId) {
          return sendApiError(res, 400, "INVALID_INPUT", "sourceVersionId or sourceCommitId is required.");
        }
        const title = (req.body?.title as string | undefined)?.trim() || `Merge ${sourceVersionId}`;
        const description = (req.body?.description as string | undefined)?.trim() || "";
        const sourceVersion = db
          .prepare("SELECT status FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
          .get(sourceVersionId, pipelineId) as { status: string } | undefined;
        if (!sourceVersion) return sendApiError(res, 404, "NOT_FOUND", "Source version not found.");
        if (sourceVersion.status !== "published") {
          return sendApiError(res, 400, "INVALID_STATE", "Only published versions can open merge requests.");
        }
        const pipeline = db
          .prepare("SELECT head_version_id FROM project_pipelines WHERE id = ? AND project_id = ?")
          .get(pipelineId, projectId) as { head_version_id: string | null } | undefined;
        if (!pipeline) return sendApiError(res, 404, "NOT_FOUND", "Pipeline not found.");
        const targetVersionId =
          typeof req.body?.targetVersionId === "string" && req.body.targetVersionId.trim()
            ? req.body.targetVersionId.trim()
            : pipeline.head_version_id;
        if (sourceBranchId) {
          const sourceBranch = db
            .prepare("SELECT id FROM project_branches WHERE id = ? AND project_id = ? AND pipeline_id = ?")
            .get(sourceBranchId, projectId, pipelineId) as { id: string } | undefined;
          if (!sourceBranch) return sendApiError(res, 404, "NOT_FOUND", "Source branch not found.");
        }
        const targetBranch = getDefaultBranchRecord(projectId, pipelineId);
        const targetBranchId =
          typeof req.body?.targetBranchId === "string" && req.body.targetBranchId.trim()
            ? req.body.targetBranchId.trim()
            : targetBranch?.id || null;
        if (targetBranchId) {
          const branch = db
            .prepare("SELECT id FROM project_branches WHERE id = ? AND project_id = ? AND pipeline_id = ?")
            .get(targetBranchId, projectId, pipelineId) as { id: string } | undefined;
          if (!branch) return sendApiError(res, 404, "NOT_FOUND", "Target branch not found.");
        }
        const linkedWorkItemId =
          typeof req.body?.linkedWorkItemId === "string" && req.body.linkedWorkItemId.trim()
            ? req.body.linkedWorkItemId.trim()
            : null;
        if (linkedWorkItemId) {
          const workItem = db
            .prepare("SELECT id FROM project_work_items WHERE id = ? AND project_id = ?")
            .get(linkedWorkItemId, projectId) as { id: string } | undefined;
          if (!workItem) return sendApiError(res, 404, "NOT_FOUND", "Linked work item not found.");
        }
        const mergeRequestId = createRecordId("mr");
        db.prepare(
          `INSERT INTO merge_requests
           (id, project_id, pipeline_id, source_version_id, target_version_id, source_branch_id, target_branch_id, source_commit_id, target_commit_id, linked_work_item_id, created_by_user_id, title, description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(
          mergeRequestId,
          projectId,
          pipelineId,
          sourceVersionId,
          targetVersionId,
          sourceBranchId,
          targetBranchId,
          sourceCommitId,
          null,
          linkedWorkItemId,
          authUser.id,
          title,
          description,
          nowIso(),
          nowIso(),
        );
        recordProjectActivity(projectId, authUser.id, "merge_request.created", {
          mergeRequestId,
          pipelineId,
          sourceVersionId,
          targetVersionId,
          sourceBranchId,
          targetBranchId,
          sourceCommitId,
          linkedWorkItemId,
        });
        if (linkedWorkItemId) {
          db.prepare(
            "UPDATE project_work_items SET merge_request_id = ?, state = 'review', updated_at = ? WHERE id = ?",
          ).run(mergeRequestId, nowIso(), linkedWorkItemId);
        }
        return res.status(201).json({
          id: mergeRequestId,
          projectId,
          pipelineId,
          sourceVersionId,
          targetVersionId,
          sourceBranchId,
          targetBranchId,
          sourceCommitId,
          linkedWorkItemId,
          title,
          description,
          status: "open",
        });
      } catch (error: unknown) {
        if (typeof error === "object" && error && "status" in error && "payload" in error) {
          const typed = error as { status: number; payload: ApiErrorPayload };
          return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
        }
        const message = error instanceof Error ? error.message : "Failed to create merge request.";
        return sendApiError(res, 500, "MERGE_REQUEST_CREATE_FAILED", message);
      }
    },
  );

  app.get("/api/projects/:projectId/merge-requests", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const statusFilter =
        typeof req.query?.status === "string" && req.query.status.trim() ? req.query.status.trim().toLowerCase() : null;
      const sql = `
        SELECT
          mr.id,
          mr.project_id,
          mr.pipeline_id,
          mr.source_version_id,
          mr.target_version_id,
          mr.source_branch_id,
          mr.target_branch_id,
          mr.source_commit_id,
          mr.target_commit_id,
          mr.linked_work_item_id,
          mr.created_by_user_id,
          mr.title,
          mr.description,
          mr.status,
          mr.approval_user_id,
          mr.approved_at,
          mr.merged_by_user_id,
          mr.merged_at,
          mr.created_at,
          mr.updated_at,
          creator.display_name AS creator_name,
          approver.display_name AS approver_name,
          merger.display_name AS merger_name,
          sb.name AS source_branch_name,
          tb.name AS target_branch_name,
          wi.title AS linked_work_item_title
        FROM merge_requests mr
        LEFT JOIN user_profiles creator ON creator.id = mr.created_by_user_id
        LEFT JOIN user_profiles approver ON approver.id = mr.approval_user_id
        LEFT JOIN user_profiles merger ON merger.id = mr.merged_by_user_id
        LEFT JOIN project_branches sb ON sb.id = mr.source_branch_id
        LEFT JOIN project_branches tb ON tb.id = mr.target_branch_id
        LEFT JOIN project_work_items wi ON wi.id = mr.linked_work_item_id
        WHERE mr.project_id = ?
      `;
      const rows = statusFilter
        ? openCollaborationDb().prepare(`${sql} AND mr.status = ? ORDER BY mr.updated_at DESC`).all(projectId, statusFilter)
        : openCollaborationDb().prepare(`${sql} ORDER BY mr.updated_at DESC`).all(projectId);
      return res.json(rows);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list merge requests.";
      return sendApiError(res, 500, "MERGE_REQUEST_LIST_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/merge-requests/:mergeRequestId/approve", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, mergeRequestId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const db = openCollaborationDb();
      const mr = db
        .prepare("SELECT status FROM merge_requests WHERE id = ? AND project_id = ?")
        .get(mergeRequestId, projectId) as { status: string } | undefined;
      if (!mr) return sendApiError(res, 404, "NOT_FOUND", "Merge request not found.");
      if (mr.status !== "open") {
        return sendApiError(res, 400, "INVALID_STATE", "Only open merge requests can be approved.");
      }
      db.prepare(
        "UPDATE merge_requests SET status = 'approved', approval_user_id = ?, approved_at = ?, updated_at = ? WHERE id = ?",
      ).run(authUser.id, nowIso(), nowIso(), mergeRequestId);
      recordProjectActivity(projectId, authUser.id, "merge_request.approved", { mergeRequestId });
      return res.json({ success: true });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to approve merge request.";
      return sendApiError(res, 500, "MERGE_REQUEST_APPROVE_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/merge-requests/:mergeRequestId/merge", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const { projectId, mergeRequestId } = req.params;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const db = openCollaborationDb();
      const mr = db
        .prepare(
          `SELECT id, pipeline_id, source_version_id, target_version_id, source_branch_id, target_branch_id, linked_work_item_id, status
           FROM merge_requests
           WHERE id = ? AND project_id = ?`,
        )
        .get(mergeRequestId, projectId) as
        | {
            id: string;
            pipeline_id: string;
            source_version_id: string;
            target_version_id: string | null;
            source_branch_id: string | null;
            target_branch_id: string | null;
            linked_work_item_id: string | null;
            status: string;
          }
        | undefined;
      if (!mr) return sendApiError(res, 404, "NOT_FOUND", "Merge request not found.");
      if (mr.status === "merged") {
        return res.json({ success: true, mergedVersionId: mr.source_version_id, idempotent: true });
      }
      if (mr.status !== "approved" && mr.status !== "open") {
        return sendApiError(res, 400, "INVALID_STATE", "Merge request cannot be merged in current state.");
      }
      const pipeline = db
        .prepare("SELECT head_version_id, latest_version_no FROM project_pipelines WHERE id = ? AND project_id = ?")
        .get(mr.pipeline_id, projectId) as { head_version_id: string | null; latest_version_no: number } | undefined;
      if (!pipeline) return sendApiError(res, 404, "NOT_FOUND", "Pipeline not found.");

      if (mr.target_version_id && pipeline.head_version_id && mr.target_version_id !== pipeline.head_version_id) {
        return sendApiError(res, 409, "MERGE_CONFLICT", "Pipeline head changed. Rebase working copy before merge.", {
          expectedTargetVersionId: mr.target_version_id,
          currentHeadVersionId: pipeline.head_version_id,
        });
      }

      const sourceVersion = db
        .prepare("SELECT version_no FROM pipeline_versions WHERE id = ? AND pipeline_id = ?")
        .get(mr.source_version_id, mr.pipeline_id) as { version_no: number } | undefined;
      if (!sourceVersion) return sendApiError(res, 404, "NOT_FOUND", "Source version not found.");

      withDbTransaction((tx) => {
        tx.prepare("UPDATE pipeline_versions SET status = 'merged', updated_at = ? WHERE id = ?").run(
          nowIso(),
          mr.source_version_id,
        );
        tx.prepare("UPDATE project_pipelines SET head_version_id = ?, latest_version_no = ?, updated_at = ? WHERE id = ?").run(
          mr.source_version_id,
          Math.max(Number(pipeline.latest_version_no || 0), Number(sourceVersion.version_no || 0)),
          nowIso(),
          mr.pipeline_id,
        );
        tx.prepare(
          "UPDATE merge_requests SET status = 'merged', merged_by_user_id = ?, merged_at = ?, updated_at = ? WHERE id = ?",
        ).run(authUser.id, nowIso(), nowIso(), mr.id);
        if (mr.target_branch_id) {
          tx.prepare("UPDATE project_branches SET head_version_id = ?, updated_at = ? WHERE id = ?").run(
            mr.source_version_id,
            nowIso(),
            mr.target_branch_id,
          );
        }
        if (mr.source_branch_id) {
          tx.prepare("UPDATE project_branches SET status = 'merged', updated_at = ? WHERE id = ?").run(
            nowIso(),
            mr.source_branch_id,
          );
        }
        if (mr.linked_work_item_id) {
          tx.prepare("UPDATE project_work_items SET state = 'done', merge_request_id = ?, updated_at = ? WHERE id = ?").run(
            mr.id,
            nowIso(),
            mr.linked_work_item_id,
          );
        }
      });
      recordProjectActivity(projectId, authUser.id, "merge_request.merged", {
        mergeRequestId,
        pipelineId: mr.pipeline_id,
        sourceBranchId: mr.source_branch_id,
        targetBranchId: mr.target_branch_id,
        linkedWorkItemId: mr.linked_work_item_id,
      });
      return res.json({ success: true, mergedVersionId: mr.source_version_id });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to merge merge request.";
      return sendApiError(res, 500, "MERGE_REQUEST_MERGE_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/activity", requireAuth, (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const activity = openCollaborationDb()
        .prepare(
          `SELECT
             pa.id,
             pa.project_id,
             pa.actor_user_id,
             pa.event_type,
             pa.payload_json,
             pa.created_at,
             up.display_name AS actor_name,
             up.email AS actor_email
           FROM project_activity pa
           LEFT JOIN user_profiles up ON up.id = pa.actor_user_id
           WHERE pa.project_id = ?
           ORDER BY pa.created_at DESC
           LIMIT 100`,
        )
        .all(projectId) as Array<{
        id: string;
        project_id: string;
        actor_user_id: string;
        event_type: string;
        payload_json: string;
        created_at: string;
        actor_name: string | null;
        actor_email: string | null;
      }>;
      return res.json(
        activity.map((entry) => ({
          id: entry.id,
          projectId: entry.project_id,
          actorUserId: entry.actor_user_id,
          actorName: entry.actor_name,
          actorEmail: entry.actor_email,
          eventType: entry.event_type,
          payload: JSON.parse(entry.payload_json || "{}"),
          createdAt: entry.created_at,
        })),
      );
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to fetch activity.";
      return sendApiError(res, 500, "PROJECT_ACTIVITY_FAILED", message);
    }
  });

  app.get("/api/projects/:projectId/git-status", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");
      if (!project.git_repo) {
        return sendApiError(res, 400, "PROJECT_REPO_NOT_CONFIGURED", "Project repository is not configured.");
      }
      const workspacePath = resolveProjectWorkspacePath(projectId);
      if (!workspacePath) {
        return sendApiError(res, 400, "INVALID_STATE", "Project workspace path is not configured.");
      }
      if (!fs.existsSync(workspacePath)) {
        return sendApiError(res, 404, "NOT_FOUND", "Project workspace path does not exist.");
      }
      const { simpleGit } = await import("simple-git");
      const git = simpleGit({ baseDir: workspacePath });
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return sendApiError(res, 400, "GIT_REPO_NOT_FOUND", "Workspace is not a git repository.");
      }
      const status = await git.status();
      return res.json({
        projectRepo: project.git_repo,
        gitProvider: project.git_provider || "github",
        workspacePath,
        current: status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
        detached: status.detached,
        files: status.files,
        clean: status.isClean(),
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to fetch git status.";
      return sendApiError(res, 500, "GIT_STATUS_FAILED", message);
    }
  });

  app.post("/api/projects/:projectId/git-sync", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = getAuthUser(req);
      const projectId = req.params.projectId;
      requireProjectRole(authUser.id, projectId, ["owner", "editor"]);
      const project = getProjectById(projectId);
      if (!project) return sendApiError(res, 404, "NOT_FOUND", "Project not found.");
      if (!project.git_repo) {
        return sendApiError(res, 400, "PROJECT_REPO_NOT_CONFIGURED", "Project repository is not configured.");
      }
      const action = requireString(req.body?.action, "action").toLowerCase();
      if (action !== "pull" && action !== "push") {
        return sendApiError(res, 400, "INVALID_INPUT", "action must be pull or push.");
      }
      const workspacePath = resolveProjectWorkspacePath(projectId);
      if (!workspacePath) {
        return sendApiError(res, 400, "INVALID_STATE", "Project workspace path is not configured.");
      }
      if (!fs.existsSync(workspacePath)) {
        return sendApiError(res, 404, "NOT_FOUND", "Project workspace path does not exist.");
      }
      const { simpleGit } = await import("simple-git");
      const git = simpleGit({ baseDir: workspacePath });
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return sendApiError(res, 400, "GIT_REPO_NOT_FOUND", "Workspace is not a git repository.");
      }
      if ((project.git_provider || "github") === "github") {
        const remotes = await git.getRemotes(true);
        const githubRemote = remotes.find((remote) => {
          const fetch = remote.refs.fetch || "";
          const push = remote.refs.push || "";
          return /github\.com[:/]/i.test(fetch) || /github\.com[:/]/i.test(push);
        });
        if (githubRemote) {
          const actorSettings = getUserSettings(authUser.id);
          const ownerSettings = getUserSettings(project.owner_user_id);
          if (!actorSettings.github_token && !ownerSettings.github_token) {
            return sendApiError(
              res,
              400,
              "GITHUB_AUTH_MISSING",
              "GitHub token is missing. Configure it in Settings before syncing this repository.",
            );
          }
        }
      }

      let result: unknown;
      if (action === "pull") {
        result = await git.pull();
      } else {
        result = await git.push();
      }
      const status = await git.status();
      recordProjectActivity(projectId, authUser.id, "git.sync", { action, result });
      return res.json({
        action,
        projectRepo: project.git_repo,
        gitProvider: project.git_provider || "github",
        result,
        status: {
          current: status.current,
          tracking: status.tracking,
          ahead: status.ahead,
          behind: status.behind,
          detached: status.detached,
          files: status.files,
          clean: status.isClean(),
        },
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to sync git workspace.";
      return sendApiError(res, 500, "GIT_SYNC_FAILED", message);
    }
  });

  app.get("/api/extractions", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const allowedFiles = new Set(
      getJobsForUser(authUser.id)
        .map((job) => (job.localExtractionPath as string | undefined)?.replace(/\\/g, "/"))
        .filter((value): value is string => Boolean(value)),
    );
    return res.json(Array.from(allowedFiles));
  });

  app.get("/api/extractions-content", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const relativePath = req.query.path as string;
    if (!relativePath) return sendApiError(res, 400, "INVALID_INPUT", "Missing path.");
    if (!isPathAllowedForUser(authUser.id, relativePath)) {
      return sendApiError(res, 403, "FORBIDDEN", "You do not have access to this extraction.");
    }

    // Security check: ensure path is within DATA_DIR
    const filePath = path.join(DATA_DIR, relativePath);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(DATA_DIR))) {
      return sendApiError(res, 403, "FORBIDDEN", "Access denied.");
    }

    if (!fs.existsSync(filePath)) {
      return sendApiError(res, 404, "NOT_FOUND", "File not found.");
    }
    
    const content = fs.readFileSync(filePath, "utf-8");
    res.json(JSON.parse(content));
  });

  app.get("/api/jobs", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const projectId = typeof req.query?.projectId === "string" ? req.query.projectId.trim() : "";
    if (projectId) {
      try {
        requireProjectRole(authUser.id, projectId, ["owner", "editor", "viewer"]);
      } catch {
        return sendApiError(res, 403, "FORBIDDEN", "You do not have access to this project.");
      }
      const projectJobs = getLocalJobs().filter((job) => job.projectId === projectId);
      return res.json(projectJobs);
    }
    return res.json(getJobsForUser(authUser.id));
  });

  app.get("/api/jobs/:id", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const jobs = getLocalJobs();
    const job = jobs.find((j) => j.id === req.params.id && j.userId === authUser.id);
    if (!job) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
    res.json(job);
  });

  app.get("/api/pipeline/:jobId/workspace-tree", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    try {
      const jobs = getLocalJobs();
      const job = jobs.find((record) => record.id === req.params.jobId && record.userId === authUser.id);
      if (!job) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      const workspaceRootAbs = resolveWorkspaceRootForJob(job);
      migrateWorkspaceForDapsSafety(job, workspaceRootAbs);
      if (!fs.existsSync(workspaceRootAbs)) {
        return sendApiError(res, 404, "NOT_FOUND", "Workspace directory does not exist.");
      }
      const items: Array<{ path: string; type: "file" | "dir"; size?: number }> = [];
      const walk = (currentDir: string, relativeDir: string) => {
        const entries = fs
          .readdirSync(currentDir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
        entries.forEach((entry) => {
          const nextRelative = path.join(relativeDir, entry.name).replace(/\\/g, "/");
          const nextAbs = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            items.push({ path: nextRelative, type: "dir" });
            walk(nextAbs, nextRelative);
            return;
          }
          if (!entry.isFile()) return;
          const ext = path.extname(entry.name).toLowerCase();
          const editable = PIPELINE_FILE_EDIT_ALLOWLIST.includes(ext as (typeof PIPELINE_FILE_EDIT_ALLOWLIST)[number]);
          if (!editable && !entry.name.startsWith("DC-")) return;
          items.push({ path: nextRelative, type: "file", size: fs.statSync(nextAbs).size });
        });
      };
      walk(workspaceRootAbs, "");
      const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
      return res.json({
        jobId: job.id,
        rootPath: workspaceRecord.rootPath || job.outputFolderPath || "",
        documentbase: workspaceRecord.documentbase || null,
        dcFileName: workspaceRecord.dcFileName || null,
        items,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to list workspace tree.";
      return sendApiError(res, 500, "PIPELINE_TREE_FAILED", message);
    }
  });

  app.get("/api/pipeline/:jobId/workspace-file", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    try {
      const relativePath = typeof req.query?.path === "string" ? req.query.path : "";
      const jobs = getLocalJobs();
      const job = jobs.find((record) => record.id === req.params.jobId && record.userId === authUser.id);
      if (!job) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      const workspaceRootAbs = resolveWorkspaceRootForJob(job);
      migrateWorkspaceForDapsSafety(job, workspaceRootAbs);
      const { normalized, targetAbs } = resolveWorkspaceFilePath(workspaceRootAbs, relativePath);
      if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
        return sendApiError(res, 404, "NOT_FOUND", "Workspace file not found.");
      }
      const content = fs.readFileSync(targetAbs, "utf8");
      return res.json({ jobId: job.id, path: normalized, content });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to read workspace file.";
      return sendApiError(res, 500, "PIPELINE_FILE_READ_FAILED", message);
    }
  });

  app.put("/api/pipeline/:jobId/workspace-file", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    try {
      const relativePath = typeof req.body?.path === "string" ? req.body.path : "";
      const content = typeof req.body?.content === "string" ? req.body.content : null;
      if (content === null) {
        return sendApiError(res, 400, "INVALID_INPUT", "content must be a string.");
      }
      const jobs = getLocalJobs();
      const idx = jobs.findIndex((record) => record.id === req.params.jobId && record.userId === authUser.id);
      if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      const job = jobs[idx];
      const workspaceRootAbs = resolveWorkspaceRootForJob(job);
      const migrationResult = migrateWorkspaceForDapsSafety(job, workspaceRootAbs);
      const { normalized, targetAbs } = resolveWorkspaceFilePath(workspaceRootAbs, relativePath);
      const beforeContent = fs.existsSync(targetAbs) && fs.statSync(targetAbs).isFile() ? fs.readFileSync(targetAbs, "utf8") : "";
      const savedContent = writeWorkspaceNormalizedFile(targetAbs, content);
      const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
      let varsRewrite: {
        rewritten: boolean;
        changedKeys: number;
        addedKeys: number;
        removedKeys: number;
        compatAliasesAdded?: number;
      } | null = null;
      if (normalized.toLowerCase().endsWith("-vars.adoc")) {
        const rewriteResult = maybeRewriteMainAdocUsingVars(job, workspaceRootAbs, beforeContent, savedContent);
        const compatAliases = ensureVarsCompatibilityAliases({
          varsAbsPath: targetAbs,
          mainAdocAbsPath: workspaceRecord.mainAdocPath
            ? path.join(process.cwd(), workspaceRecord.mainAdocPath)
            : undefined,
          docinfoAbsPath: workspaceRecord.docinfoPath
            ? path.join(process.cwd(), workspaceRecord.docinfoPath)
            : undefined,
          context: buildReferenceContext(job, typeof job.metadata === "object" ? job.metadata : {}, workspaceRecord.documentbase),
        });
        varsRewrite = {
          rewritten: rewriteResult.rewritten,
          changedKeys: rewriteResult.changedKeys,
          addedKeys: rewriteResult.addedKeys,
          removedKeys: rewriteResult.removedKeys,
          compatAliasesAdded: compatAliases.added,
        };
        if (rewriteResult.rewritten && typeof rewriteResult.content === "string") {
          jobs[idx] = {
            ...jobs[idx],
            asciiDocContent: rewriteResult.content,
          };
        }
      }
      if (workspaceRecord.mainAdocPath) {
        const expectedMainPath = path.resolve(path.join(process.cwd(), workspaceRecord.mainAdocPath));
        if (path.resolve(targetAbs) === expectedMainPath) {
          jobs[idx] = {
            ...jobs[idx],
            asciiDocContent: savedContent,
            updatedAt: nowIso(),
          };
          saveLocalJobs(jobs);
        }
      }
      if (!jobs[idx].updatedAt || jobs[idx].updatedAt === job.updatedAt) {
        jobs[idx] = { ...jobs[idx], updatedAt: nowIso() };
        saveLocalJobs(jobs);
      }
      return res.json({
        success: true,
        path: normalized,
        updatedAt: jobs[idx].updatedAt,
        varsRewrite,
        normalizationApplied: migrationResult.normalizedFiles,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to save workspace file.";
      return sendApiError(res, 500, "PIPELINE_FILE_WRITE_FAILED", message);
    }
  });

  app.post("/api/jobs", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    ensurePersonalProjectForUser(authUser);
    const jobs = getLocalJobs();
    const requestedStatus = typeof req.body?.status === "string" ? req.body.status : "pending";
    const requestedProjectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
    const effectiveProjectId = requestedProjectId || getPersonalProjectForUser(authUser.id)?.id;
    if (!effectiveProjectId) {
      return sendApiError(res, 500, "PROJECT_RESOLUTION_FAILED", "Failed to resolve default project.");
    }
    try {
      requireProjectRole(authUser.id, effectiveProjectId, ["owner", "editor", "viewer"]);
    } catch {
      return sendApiError(res, 403, "FORBIDDEN", "You do not have access to selected project.");
    }

    const newJob = {
      ...req.body,
      id: "job-" + Date.now().toString(),
      userId: authUser.id,
      projectId: effectiveProjectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: requestedStatus,
    };
    jobs.push(newJob as JobRecord);
    saveLocalJobs(jobs);
    const pipelineId = ensurePipelineForJob(newJob as JobRecord, authUser.id);
    if (pipelineId) {
      (newJob as JobRecord).pipelineId = pipelineId;
      const idx = jobs.findIndex((job) => job.id === newJob.id);
      if (idx >= 0) {
        jobs[idx] = { ...jobs[idx], pipelineId };
        saveLocalJobs(jobs);
      }
    }
    recordProjectActivity(effectiveProjectId, authUser.id, "job.created", { jobId: newJob.id, pipelineId: pipelineId || null });
    logEvent("jobs.create", {
      requestId: (req as Request & { requestId?: string }).requestId,
      userId: authUser.id,
      jobId: newJob.id,
    });
    res.json(newJob);
  });

  app.post("/api/reference-scaffold", requireAuth, (req, res) => {
    try {
      const { partnerName, suseProduct, partnerProduct, documentType, profileId } = req.body || {};
      const referenceScaffold = createReferenceScaffold(
        partnerName,
        suseProduct,
        partnerProduct,
        documentType,
        profileId,
      );
      res.json(referenceScaffold);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create reference scaffold";
      res.status(500).json({ error: { code: "REFERENCE_SCAFFOLD_FAILED", message } });
    }
  });

  app.post("/api/admin/pipeline-reset-full", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    if (!isSuperAdminUser(authUser.id)) {
      return sendApiError(res, 403, "FORBIDDEN", "Only super-admin can reset pipeline data.");
    }
    const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim() : "";
    if (confirmation !== PIPELINE_RESET_CONFIRMATION) {
      return sendApiError(
        res,
        400,
        "INVALID_INPUT",
        `confirmation must equal '${PIPELINE_RESET_CONFIRMATION}'.`,
      );
    }
    try {
      const removed = resetPipelineDataStore();
      clearSessionCookie(res);
      return res.json({ success: true, removed, message: "Pipeline data reset completed." });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to reset pipeline data.";
      return sendApiError(res, 500, "PIPELINE_RESET_FAILED", message);
    }
  });

  app.get("/api/pipeline/partner-presets", requireAuth, (_req: AuthedRequest, res) => {
    try {
      const partners = listPartnerPresetDefinitions().map((entry) => ({
        partnerKey: entry.partnerKey,
        label: entry.label,
        doctype: entry.doctype,
        comingSoon: entry.comingSoon,
        sourceUrl: entry.sourceUrl,
        sourceFileName: entry.sourceFileName,
      }));
      return res.json({ partners });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to load partner presets.";
      return sendApiError(res, 500, "PIPELINE_PARTNER_PRESETS_FAILED", message);
    }
  });

  app.post("/api/pipeline/structure/preview", requireAuth, (req: AuthedRequest, res) => {
    try {
      const input = parseRefsetupStructureInput(req.body);
      const preview = buildRefsetupStructurePreview(input);
      return res.json(preview);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to build structure preview.";
      return sendApiError(res, 500, "PIPELINE_PREVIEW_FAILED", message);
    }
  });

  app.post("/api/pipeline/structure/validate", requireAuth, (req: AuthedRequest, res) => {
    try {
      const input = parseRefsetupStructureInput(req.body);
      const validation = validateRefsetupStructure(input);
      return res.json(validation);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to validate structure.";
      return sendApiError(res, 500, "PIPELINE_VALIDATE_FAILED", message);
    }
  });

  app.post("/api/pipeline/structure/save", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    try {
      ensurePersonalProjectForUser(authUser);
      const input = parseRefsetupStructureInput(req.body);
      const requestedProjectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
      const effectiveProjectId = requestedProjectId || getPersonalProjectForUser(authUser.id)?.id;
      if (!effectiveProjectId) {
        return sendApiError(res, 500, "PROJECT_RESOLUTION_FAILED", "Failed to resolve project for pipeline workspace.");
      }
      requireProjectRole(authUser.id, effectiveProjectId, ["owner", "editor", "viewer"]);
      const workspace = createRefsetupWorkspace(input);
      const partnerPreset = getPartnerPresetDefinition(workspace.presetPartnerKey);
      const setupMetadata = {
        source_name: workspace.documentbase,
        partner_display: partnerPreset.label,
        partner_product_display: input.partnerProduct || partnerPreset.label,
        suse_product_display: input.suseProducts.join(", "),
        doc_type: input.doctype,
      };
      const context = buildReferenceContext(undefined, setupMetadata, workspace.documentbase);
      writeWorkspaceNormalizedFile(path.join(process.cwd(), workspace.docinfoPath), buildReferenceDocInfoContent(context));
      ensureVarsCompatibilityAliases({
        varsAbsPath: path.join(process.cwd(), workspace.varsPath),
        mainAdocAbsPath: path.join(process.cwd(), workspace.mainAdocPath),
        docinfoAbsPath: path.join(process.cwd(), workspace.docinfoPath),
        context,
      });

      const jobs = getLocalJobs();
      const now = nowIso();
      const workspaceRecord: PipelineWorkspaceRecord = {
        doctype: input.doctype,
        suseProducts: input.suseProducts,
        partnerName: workspace.partnerFolder,
        partnerProduct: input.partnerProduct || "",
        distinctiveText: input.distinctiveText || "",
        documentbase: workspace.documentbase,
        dcFileName: workspace.dcFileName,
        partnerFolder: workspace.partnerFolder,
        rootPath: workspace.rootPath,
        mainAdocPath: workspace.mainAdocPath,
        varsPath: workspace.varsPath,
        docinfoPath: workspace.docinfoPath,
        presetPartnerKey: partnerPreset.partnerKey,
        createdAt: now,
      };
      const newJob: JobRecord = {
        id: `job-${Date.now()}`,
        userId: authUser.id,
        projectId: effectiveProjectId,
        createdAt: now,
        updatedAt: now,
        status: "pending",
        googleDocTitle: workspace.documentbase,
        projectSetup: {
          documentType: input.doctype === "gs" ? "getting-started" : "reference",
          partnerName: workspace.partnerFolder,
          partnerProduct: input.partnerProduct || "",
          suseProduct: input.suseProducts.join(","),
          profileId: resolveReferenceProfile(workspace.partnerFolder, "").profile.id,
        },
        metadata: {
          ...setupMetadata,
          base_name: workspace.documentbase,
          preset_partner_key: partnerPreset.partnerKey,
        },
        outputFolderPath: workspace.rootPath,
        asciiDocPath: workspace.mainAdocPath,
        pipelineWorkspace: workspaceRecord,
        localExtractionPath: "",
      };
      jobs.push(newJob);
      saveLocalJobs(jobs);
      const pipelineId = ensurePipelineForJob(newJob, authUser.id);
      if (pipelineId) {
        const idx = jobs.findIndex((job) => job.id === newJob.id);
        if (idx >= 0) {
          jobs[idx] = { ...jobs[idx], pipelineId };
          saveLocalJobs(jobs);
        }
      }
      setProjectWorkspacePath(effectiveProjectId, workspace.rootPath);
      recordProjectActivity(effectiveProjectId, authUser.id, "pipeline.structure_saved", {
        jobId: newJob.id,
        workspaceRoot: workspace.rootPath,
      });
      return res.status(201).json({ job: newJob, workspace, pipelineId: pipelineId || null });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to save pipeline structure.";
      return sendApiError(res, 500, "PIPELINE_STRUCTURE_SAVE_FAILED", message);
    }
  });

  app.post("/api/save-extraction-file", requireAuth, (req, res) => {
    try {
      const { extractionData, sourceName, subfolder, customFilename } = req.body || {};
      if (!extractionData || !sourceName) {
        return sendApiError(res, 400, "INVALID_INPUT", "extractionData and sourceName are required");
      }
      const localPath = saveExtractedDataToFile(extractionData, sourceName, subfolder, customFilename);
      res.json({ localPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to save extraction file";
      res.status(500).json({ error: { code: "SAVE_EXTRACTION_FAILED", message } });
    }
  });

  app.post("/api/setup-project/:id", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const {
      suseProduct,
      partnerName,
      partnerProduct,
      customFilename,
      documentType, // e.g. 'reference-configuration', 'trd'
      subfolder,
      profileId,
    } = req.body;

    const jobs = getLocalJobs();
    const idx = findJobIndexForUser(jobs, authUser.id, req.params.id);
    if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found");

    try {
      // Always scaffold under references/<partner>/... using SUSE TRD naming conventions.
      const referenceScaffold = createReferenceScaffold(
        partnerName,
        suseProduct,
        partnerProduct,
        documentType,
        profileId,
      );
      const baseName = referenceScaffold.baseName;
      const projectDir = path.join(process.cwd(), referenceScaffold.rootPath);

      let localExtractionPath = (jobs[idx].localExtractionPath as string | undefined) || "";
      let appliedMetadata = jobs[idx].metadata;
      
      // Handle extraction file renaming if customFilename is provided
      if (localExtractionPath && (customFilename || suseProduct || partnerProduct)) {
        try {
          const jsonPath = path.join(DATA_DIR, localExtractionPath);
          if (fs.existsSync(jsonPath)) {
            const rawContent = fs.readFileSync(jsonPath, "utf8");
            appliedMetadata = JSON.parse(rawContent);
            
            // Rename the extraction file if needed
            const newPath = renameExtractionFile(
              localExtractionPath,
              customFilename,
              suseProduct,
              partnerProduct
            );
            
            if (newPath) {
              localExtractionPath = newPath;
            }
          }
        } catch {
          // Ignore extraction reload/rename failures and continue with existing metadata.
        }
      }

      // Update the job with project info and output path
      jobs[idx] = {
        ...jobs[idx],
        projectSetup: req.body,
        localExtractionPath: localExtractionPath, // Use updated path
        metadata: {
          ...(typeof appliedMetadata === "object" && appliedMetadata ? appliedMetadata : {}),
          base_name: baseName,
          profileId: referenceScaffold.profileId,
          reference_profile: {
            profileId: referenceScaffold.profileId,
            fallbackUsed: referenceScaffold.fallbackUsed,
            docTokenMode: referenceScaffold.docTokenMode,
            namingPattern: referenceScaffold.namingPattern,
            templateSource: referenceScaffold.templateSource,
            migrationApplied: referenceScaffold.migrationApplied,
          },
        },
        outputFolderPath: referenceScaffold.rootPath,
        asciiDocPath: path.join(referenceScaffold.rootPath, "adoc", `${baseName}.adoc`).replace(/\\/g, "/"),
        updatedAt: new Date().toISOString()
      };
      if (jobs[idx].projectId) {
        setProjectWorkspacePath(String(jobs[idx].projectId), referenceScaffold.rootPath);
      }

      copyExtractionAssetsToProject(appliedMetadata, projectDir);
      const imageRelabel = relabelProjectImages(appliedMetadata, projectDir);
      const manifestPath = path.join(projectDir, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          manifest.generated_from = {
            source_type: "google_doc_json",
            source_document_title:
              String(
                (appliedMetadata as any)?.source_name ||
                  (jobs[idx] as any).googleDocTitle ||
                  ((jobs[idx] as any).projectSetup?.customFilename ?? ""),
              ),
          };
          manifest.reference_profile = {
            profileId: referenceScaffold.profileId,
            fallbackUsed: referenceScaffold.fallbackUsed,
            docTokenMode: referenceScaffold.docTokenMode,
            namingPattern: referenceScaffold.namingPattern,
            templateSource: referenceScaffold.templateSource,
            migrationApplied: referenceScaffold.migrationApplied,
          };
          manifest.images = imageRelabel.mapping;
          manifest.warnings = imageRelabel.warnings;
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        } catch {
          // Keep setup resilient even if manifest patching fails.
        }
      }

      const varsPath = path.join(projectDir, "adoc", `${baseName}-vars.adoc`);
      const setupMetadata = {
        ...(typeof appliedMetadata === "object" && appliedMetadata ? appliedMetadata : {}),
        suse_product_display: suseProduct,
        partner_display: partnerName,
        partner_product_display: partnerProduct,
        doc_type: documentType,
        profileId: referenceScaffold.profileId,
        reference_profile: {
          profileId: referenceScaffold.profileId,
          fallbackUsed: referenceScaffold.fallbackUsed,
          docTokenMode: referenceScaffold.docTokenMode,
          namingPattern: referenceScaffold.namingPattern,
          templateSource: referenceScaffold.templateSource,
          migrationApplied: referenceScaffold.migrationApplied,
        },
        source_name:
          String(
            (appliedMetadata as any)?.source_name ||
              (jobs[idx] as any).googleDocTitle ||
              customFilename ||
              "",
          ),
      };
      const setupContext = buildReferenceContext(undefined, setupMetadata, baseName);
      syncReferenceVarsFile(varsPath, setupContext, setupMetadata.source_name);
      ensureVarsCompatibilityAliases({
        varsAbsPath: varsPath,
        mainAdocAbsPath: path.join(projectDir, "adoc", `${baseName}.adoc`),
        docinfoAbsPath: path.join(projectDir, "adoc", `${baseName}-docinfo.xml`),
        context: setupContext,
      });
      migrateWorkspaceForDapsSafety(jobs[idx], path.join(process.cwd(), referenceScaffold.rootPath));

      saveLocalJobs(jobs);
      if (jobs[idx].projectId) {
        recordProjectActivity(String(jobs[idx].projectId), authUser.id, "job.project_configured", {
          jobId: jobs[idx].id,
          outputFolderPath: jobs[idx].outputFolderPath || null,
        });
      }

      res.json(jobs[idx]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Project setup failed";
      res.status(500).json({ error: { code: "PROJECT_SETUP_FAILED", message } });
    }
  });

  app.patch("/api/jobs/:id", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const jobs = getLocalJobs();
    const idx = findJobIndexForUser(jobs, authUser.id, req.params.id);
    if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found");

    const allowedPatchFields = new Set([
      "status",
      "asciiDocContent",
      "googleDocTitle",
      "githubPrUrl",
      "error",
      "metadata",
      "projectSetup",
      "localExtractionPath",
      "outputFolderPath",
      "asciiDocPath",
      "manualContent",
      "renderArtifacts",
      "pipelineWorkspace",
    ]);
    const patchData = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => allowedPatchFields.has(key)),
    );
    if ("localExtractionPath" in patchData) {
      const targetPath = patchData.localExtractionPath;
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        return sendApiError(res, 400, "INVALID_INPUT", "localExtractionPath must be a non-empty string.");
      }
      const normalizedTarget = targetPath.replace(/\\/g, "/");
      const currentPath = String(jobs[idx].localExtractionPath || "").replace(/\\/g, "/");
      const canAccessTarget =
        normalizedTarget === currentPath || isPathAllowedForUser(authUser.id, normalizedTarget);
      if (!canAccessTarget) {
        return sendApiError(res, 403, "FORBIDDEN", "Cannot link extraction path outside your workspace.");
      }
      patchData.localExtractionPath = normalizedTarget;
    }

    const updatedJob: JobRecord = {
      ...jobs[idx],
      ...patchData,
      updatedAt: new Date().toISOString(),
    };
    
    // Auto-save asciidoc to local fs if path is configured
    if (updatedJob.asciiDocPath && typeof req.body.asciiDocContent === "string") {
      try {
        const fullPath = path.join(process.cwd(), String(updatedJob.asciiDocPath));
        writeWorkspaceNormalizedFile(fullPath, req.body.asciiDocContent);
      } catch {
        // Keep API response success even if mirroring to local file fails.
      }
    }

    jobs[idx] = updatedJob;
    saveLocalJobs(jobs);
    logEvent("jobs.update", {
      requestId: (req as Request & { requestId?: string }).requestId,
      userId: authUser.id,
      jobId: req.params.id,
    });
    res.json(jobs[idx]);
  });

  app.delete("/api/jobs/:id", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    let jobs = getLocalJobs();
    const exists = jobs.some((j) => j.id === req.params.id && j.userId === authUser.id);
    if (!exists) return sendApiError(res, 404, "NOT_FOUND", "Job not found");

    jobs = jobs.filter((j) => !(j.id === req.params.id && j.userId === authUser.id));
    saveLocalJobs(jobs);
    logEvent("jobs.delete", {
      requestId: (req as Request & { requestId?: string }).requestId,
      userId: authUser.id,
      jobId: req.params.id,
    });
    res.json({ success: true });
  });

  const upload = multer({ storage: multer.memoryStorage() });

  app.post(
    "/api/extract-structured",
    requireAuth,
    upload.single("file"),
    async (req, res) => {
      if (!req.file) return sendApiError(res, 400, "INVALID_INPUT", "Missing file");

      if (!req.file.originalname.toLowerCase().endsWith(".docx")) {
        return sendApiError(res, 400, "INVALID_INPUT", "Only .docx files are supported for structured extraction.");
      }

      let tempDir = "";

      try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "suse-docx-"));
        const tempDocPath = path.join(tempDir, req.file.originalname);
        fs.writeFileSync(tempDocPath, req.file.buffer);

        const assetsPrefix = path.join("media", "src").split(path.sep).join("/");
        const assetsDir = path.join(DATA_DIR, "media", "src");
        if (!fs.existsSync(assetsDir)) {
          fs.mkdirSync(assetsDir, { recursive: true });
        }

        const extractedData = runPythonExtraction(tempDocPath, assetsDir, assetsPrefix);
        
        const subfolder = req.body.subfolder || "extractions";
        const customFilename = req.body.customFilename;
        const suseProduct = req.body.suseProduct;
        const partnerProduct = req.body.partnerProduct;
        
        // Save with generic name initially (will be renamed in /api/setup-project if needed)
        const localPath = saveExtractedDataToFile(
          extractedData,
          req.file.originalname,
          subfolder,
          customFilename,
          suseProduct,
          partnerProduct
        );

        res.json({
            ...extractedData,
            localPath
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Extraction failed";
        res.status(500).json({ error: { code: "EXTRACTION_FAILED", message } });
      } finally {
        if (tempDir && fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    },
  );

  function simpleHtmlToAsciiDoc(html: string): string {
    if (!html) return "";

    let adoc = html;

    // Headings
    adoc = adoc.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n= $1\n");
    adoc = adoc.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n== $1\n");
    adoc = adoc.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n=== $1\n");
    adoc = adoc.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n==== $1\n");

    // Bold/Italic
    adoc = adoc.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
    adoc = adoc.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");

    // Lists
    adoc = adoc.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "* $1\n");
    adoc = adoc.replace(/<ul[^>]*>/gi, "\n");
    adoc = adoc.replace(/<\/ul>/gi, "\n");

    // Paragraphs
    adoc = adoc.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");

    // Links
    adoc = adoc.replace(
      /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      "link:$1[$2]",
    );

    // Br
    adoc = adoc.replace(/<br\s*\/?>/gi, " +\n");

    // Clean up entities
    adoc = adoc.replace(/&nbsp;/g, " ");
    adoc = adoc.replace(/&amp;/g, "&");
    adoc = adoc.replace(/&lt;/g, "<");
    adoc = adoc.replace(/&gt;/g, ">");

    // Remove remaining tags
    adoc = adoc.replace(/<[^>]*>/g, "");

    // Trim whitespace
    adoc = adoc.replace(/\n\s*\n\s*\n/g, "\n\n");

    return adoc.trim();
  }

  function sentencePerLine(text: string): string {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    return clean
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n");
  }

  function safeImageTarget(imagePath: string): string {
    const normalized = (imagePath || "").replace(/\\/g, "/");
    const filename = path.basename(normalized);
    return filename || normalized;
  }

  function normalizeInlineLinks(text: string): string {
    const source = text || "";
    return source.replace(/\b(https?:\/\/[^\s)]+)\b/g, (url) => `link:${url}[${url}]`);
  }

  function toSingleLine(text: string): string {
    return normalizeExtractedText(text || "").replace(/\s+/g, " ").trim();
  }

  function isBoilerplateSectionHeading(heading: string): boolean {
    const normalized = normalizeForCompare(heading);
    const ignoredHeadings = new Set([
      normalizeForCompare("SUSE Technical Reference Documentation"),
      normalizeForCompare("SUSE Technical Reference Documentation: Reference Configuration"),
      normalizeForCompare("Metadata"),
      normalizeForCompare("Authors"),
      normalizeForCompare("Table Data"),
    ]);
    if (ignoredHeadings.has(normalized)) return true;
    return normalized.includes(normalizeForCompare("Guide content begins on next page"));
  }

  function toAdocParagraph(
    text: string,
    context: ReferenceContext,
    candidates?: ReplacementCandidate[],
  ): string {
    const withVariables = applyCoreVariableReferences(text || "", context, candidates);
    return normalizeInlineLinks(sentencePerLine(withVariables));
  }

  function toAdocListText(
    text: string,
    context: ReferenceContext,
    candidates?: ReplacementCandidate[],
  ): string {
    const withVariables = applyCoreVariableReferences(text || "", context, candidates);
    return normalizeInlineLinks(toSingleLine(withVariables));
  }

  function normalizeTemplateHeading(text: string): string {
    return (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function renderStructuredSectionLines(
    section: any,
    context: ReferenceContext,
    candidates?: ReplacementCandidate[],
  ): string[] {
    const lines: string[] = [];
    const blocks = Array.isArray(section?.blocks) ? section.blocks : [];

    blocks.forEach((block: any) => {
      if (block.type === "paragraph") {
        const rawParagraph = normalizeExtractedText(String(block.text || ""));
        if (!rawParagraph) return;

        const admonitionMatch = rawParagraph.match(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\s*:\s*(.+)$/i);
        if (admonitionMatch) {
          const admonitionType = admonitionMatch[1].toUpperCase();
          const admonitionBody = toAdocParagraph(admonitionMatch[2], context, candidates);
          if (admonitionBody) {
            lines.push(`[${admonitionType}]`);
            lines.push("====");
            lines.push(admonitionBody);
            lines.push("====");
            lines.push("");
          }
          return;
        }

        const paragraph = toAdocParagraph(rawParagraph, context, candidates);
        if (paragraph) {
          lines.push(paragraph);
          lines.push("");
        }
      } else if (block.type === "list-item") {
        const depth = Math.max(1, Math.min(2, (block.list_level ?? 0) + 1));
        const item = toAdocListText(String(block.text || ""), context, candidates);
        if (item) {
          lines.push(`${"*".repeat(depth)} ${item}`);
          lines.push("");
        }
      } else if (block.type === "numbered-item") {
        const depth = Math.max(1, Math.min(2, (block.list_level ?? 0) + 1));
        const item = toAdocListText(String(block.text || ""), context, candidates);
        if (item) {
          lines.push(`${".".repeat(depth)} ${item}`);
          lines.push("");
        }
      } else if (block.type === "code") {
        const language = (block.language || block.lang || guessCodeLanguage(block.text || ""))
          .toString()
          .toLowerCase();
        if (language === "console" || language === "yaml" || language === "json") {
          lines.push(`[source, ${language}]`);
        } else if (language === "output") {
          lines.push("[listing]");
        } else {
          lines.push("[source, text]");
        }
        lines.push("----");
        lines.push((block.text || "").toString());
        lines.push("----");
        lines.push("");
      } else if (
        block.type === "note" ||
        block.type === "tip" ||
        block.type === "important" ||
        block.type === "warning" ||
        block.type === "caution"
      ) {
        lines.push(`[${String(block.type).toUpperCase()}]`);
        lines.push("====");
        lines.push(toAdocParagraph(String(block.text || ""), context, candidates));
        lines.push("====");
        lines.push("");
      } else if (block.type === "image") {
        const imageTargetRaw = block.media_target_path || block.asset_path || "";
        const imageTarget = safeImageTarget(imageTargetRaw);
        const imageCaption = applyCoreVariableReferences(
          normalizeExtractedText(String(block.caption || "")) || "Extracted image",
          context,
          candidates,
        );
        lines.push(`.${imageCaption}`);
        lines.push(
          `image::${imageTarget}[title="${imageCaption}", ${imageCaption}, scaledwidth="90%", align="center"]`,
        );
        lines.push("");
      } else if (block.type === "table") {
        const rowsRaw = Array.isArray(block.rows) ? block.rows : [];
        const rows = rowsRaw
          .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []))
          .filter((row) => row.some((cell) => normalizeExtractedText(cell).length > 0));
        const hasBodyRow = rows.slice(1).some((row) =>
          row.some((cell) => normalizeExtractedText(cell).length > 0),
        );
        if (rows.length < 2 || !hasBodyRow) {
          return;
        }
        if (block.caption) {
          const caption = applyCoreVariableReferences(
            normalizeExtractedText(String(block.caption || "")),
            context,
            candidates,
          );
          lines.push(`.${caption}`);
        }
        lines.push("[%unbreakable]");
        lines.push('[cols="1,3",options="header"]');
        lines.push("|===");
        rows.forEach((row: string[], rowIdx: number) => {
          row.forEach((cell: string) => {
            const cellText = toAdocParagraph(toAsciiCell(cell), context, candidates);
            lines.push(`| ${cellText}`);
          });
          if (rowIdx === 0 && row.length > 0) {
            lines.push("");
          }
        });
        lines.push("|===");
        lines.push("");
      }
    });

    return lines;
  }

  function buildTemplateWrappedAdoc(context: ReferenceContext, bodyContent: string): string {
    const profile = resolveProfileForContext(context);
    return buildReferenceMainAdoc({
      context,
      profile,
      bodyContent,
    });
  }

  app.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
    if (!req.file) return sendApiError(res, 400, "INVALID_INPUT", "Missing file");

    try {
      let content = "";
      const mimeType = req.file.mimetype;

      const mammoth = await import("mammoth");
      const mammothLib = mammoth.default || mammoth;

      if (
        mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        req.file.originalname.endsWith(".docx")
      ) {
        // Use HTML for better formatting preservation during conversion
        const result = await mammothLib.convertToHtml({
          buffer: req.file.buffer,
        });
        content = result.value; // This is HTML
      } else {
        // Fallback for text files
        content = req.file.buffer.toString("utf-8");
      }

      const docId = "local-" + Date.now();

      res.json({
        docId,
        title: req.file.originalname,
        content: content,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Internal Server Error during upload";
      res.status(500).json({ error: { code: "UPLOAD_FAILED", message } });
    }
  });

  // --- Pipeline Endpoints ---

  app.post("/api/transform", requireAuth, async (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const { jobId, docId, accessToken, manualContent, metadata } = req.body;

    if (typeof jobId !== "string" || !jobId.trim()) {
      return sendApiError(res, 400, "INVALID_INPUT", "jobId is required.");
    }
      const ownedJob = getLocalJobs().find((job) => job.id === jobId && job.userId === authUser.id);
      if (!ownedJob) {
        return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      }
      const workspaceRootForTransform =
        typeof ownedJob.outputFolderPath === "string" && ownedJob.outputFolderPath
          ? path.join(process.cwd(), ownedJob.outputFolderPath)
          : null;
      if (workspaceRootForTransform && fs.existsSync(workspaceRootForTransform)) {
        migrateWorkspaceForDapsSafety(ownedJob, workspaceRootForTransform);
      }

    try {
      let contentToTransform = manualContent;
      let title = "Document";

      // NON-AI LOGIC: Programmatic transformation
      let adocBody = "";
      let finalAdoc = "";
      const metadataBaseName =
        (typeof metadata?.base_name === "string" && metadata.base_name.trim()) ||
        (typeof metadata?.baseName === "string" && metadata.baseName.trim()) ||
        (typeof ownedJob?.asciiDocPath === "string"
          ? path.basename(String(ownedJob.asciiDocPath)).replace(/\.adoc$/i, "")
          : null);
      const referenceContext = buildReferenceContext(
        ownedJob,
        metadata,
        metadataBaseName || undefined,
      );
      const varsReplacementCandidates: ReplacementCandidate[] = (() => {
        if (typeof ownedJob?.asciiDocPath === "string" && metadataBaseName) {
          const varsPath = path.join(
            process.cwd(),
            path.dirname(ownedJob.asciiDocPath),
            `${metadataBaseName}-vars.adoc`,
          );
          if (fs.existsSync(varsPath)) {
            const attrs = parseAdocAttributes(fs.readFileSync(varsPath, "utf8"));
            const parsedCandidates = buildReplacementCandidatesFromAttributes(attrs);
            if (parsedCandidates.length > 0) {
              return parsedCandidates;
            }
          }
        }
        return getReplacementCandidatesForContext(referenceContext);
      })();

      let migrationAppliedDuringTransform = false;
      if (typeof ownedJob?.asciiDocPath === "string") {
        const canonicalCommonRoot = ensureCanonicalCommonSourceAssets();
        const adocDir = path.join(process.cwd(), path.dirname(ownedJob.asciiDocPath));
        const commonFileMap: Array<[string, string]> = [
          ["common_docinfo_vars.adoc", path.join(canonicalCommonRoot, "adoc", "common_docinfo_vars.adoc")],
          ["common_gfdl1.2_i.adoc", path.join(canonicalCommonRoot, "adoc", "common_gfdl1.2_i.adoc")],
          ["common_sbp_legal_notice.adoc", path.join(canonicalCommonRoot, "adoc", "common_sbp_legal_notice.adoc")],
          ["common_trd_legal_notice.adoc", path.join(canonicalCommonRoot, "adoc", "common_trd_legal_notice.adoc")],
        ];
        commonFileMap.forEach(([name, sourcePath]) => {
          const targetPath = path.join(adocDir, name);
          const before =
            fs.existsSync(targetPath) && isPlaceholderCommonFile(fs.readFileSync(targetPath, "utf8"));
          ensureCommonFileInProject(adocDir, sourcePath, name);
          if (before) migrationAppliedDuringTransform = true;
        });
      }

      const hasProfileMetadata =
        Boolean(metadata?.reference_profile?.profileId) ||
        Boolean(metadata?.profileId) ||
        Boolean((ownedJob as any)?.metadata?.reference_profile?.profileId) ||
        Boolean((ownedJob as any)?.metadata?.profileId);
      if (!hasProfileMetadata) {
        const jobs = getLocalJobs();
        const idx = jobs.findIndex((job) => job.id === ownedJob.id && job.userId === authUser.id);
        if (idx >= 0) {
          const existingMetadata =
            typeof jobs[idx].metadata === "object" && jobs[idx].metadata ? (jobs[idx].metadata as Record<string, unknown>) : {};
          jobs[idx] = {
            ...jobs[idx],
            metadata: {
              ...existingMetadata,
              profileId: referenceContext.profileId,
              reference_profile: {
                profileId: referenceContext.profileId,
                fallbackUsed: referenceContext.profileFallbackUsed,
                docTokenMode: referenceContext.docTokenMode,
                namingPattern: referenceContext.namingPattern,
                templateSource: CANONICAL_TEMPLATE_SOURCE,
                migrationApplied: false,
              },
            },
            updatedAt: new Date().toISOString(),
          };
          saveLocalJobs(jobs);
        }
      }

      // If we have strict structured metadata from the UI!
      if (metadata) {
        if (Array.isArray(metadata)) {
          const blocks = metadata.map((el: { type?: string; content?: string }) => {
            const content = applyCoreVariableReferences(
              el.content || "",
              referenceContext,
              varsReplacementCandidates,
            );
            if (el.type === "h1") return `= ${content}`;
            if (el.type === "h2") return `== ${content}`;
            if (el.type === "h3") return `=== ${content}`;
            if (el.type === "h4") return `==== ${content}`;
            if (el.type === "bullet") return `* ${content}`;
            return content;
          });
          adocBody = blocks.filter(Boolean).join("\n\n");
          // Extract title from the first h1 if it exists
          const firstH1 = metadata.find((m: { type?: string; content?: string }) => m.type === "h1");
          if (firstH1) {
            title = firstH1.content;
          }
          finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
        } else if (metadata.sections) {
          const renderedSections: Array<{ heading: string; normalizedHeading: string; lines: string[] }> = [];
          const sectionItems = Array.isArray(metadata.sections) ? metadata.sections : [];

          sectionItems.forEach((section: any, sectionIndex: number) => {
            const headingRaw = normalizeExtractedText(String(section.heading || ""));
            const headingText = applyCoreVariableReferences(
              titleCaseToSentenceCase(headingRaw),
              referenceContext,
              varsReplacementCandidates,
            );
            if (!headingText || isBoilerplateSectionHeading(headingText)) return;
            const sourceNameNorm = normalizeForCompare(String(metadata.source_name || ""));
            const headingNorm = normalizeForCompare(headingText);
            if (
              sourceNameNorm &&
              headingNorm === sourceNameNorm &&
              sectionIndex <= 1
            ) {
              return;
            }

            const sectionLines = renderStructuredSectionLines(
              section,
              referenceContext,
              varsReplacementCandidates,
            );
            renderedSections.push({
              heading: headingText,
              normalizedHeading: normalizeTemplateHeading(headingText),
              lines: sectionLines,
            });
          });
          const profile = resolveProfileForContext(referenceContext);
          adocBody = buildTemplateFirstBody(profile, renderedSections);
          finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
          title =
            String(
              metadata.source_name ||
                referenceContext.pipelineName ||
                metadata.app ||
                "Document",
            );
        }
      } else {
        if (!contentToTransform) {
          if (
            accessToken &&
            accessToken !== "undefined" &&
            accessToken !== "null" &&
            docId &&
            !docId.startsWith("local-")
          ) {
            // If we have a Google token, try authenticated fetch first.
            try {
              const exportUrl = `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/html`;
              const response = await axios.get(exportUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              contentToTransform = response.data;
            } catch {
              // Fallback to Docs API with the same token; if this also fails, continue to public-link fallback.
              try {
                const auth = new google.auth.OAuth2();
                auth.setCredentials({ access_token: accessToken });
                const docs = google.docs({ version: "v1", auth });
                const response = await docs.documents.get({ documentId: docId });
                contentToTransform =
                  `<h1>${response.data.title}</h1>\n` +
                  JSON.stringify(response.data.body);
                title = response.data.title || title;
              } catch {
                // Intentionally swallow auth errors and try public fetch next.
              }
            }
          }

          if (!contentToTransform && docId && !docId.startsWith("local-")) {
            // Attempt to fetch public exports/downloads for shared Google Docs or Drive files.
            const sourceUrl =
              typeof ownedJob?.googleDocUrl === "string" ? ownedJob.googleDocUrl.trim() : "";
            const publicCandidates = new Set<string>();
            publicCandidates.add(
              `https://docs.google.com/document/d/${docId}/export?format=html`,
            );
            publicCandidates.add(`https://drive.google.com/uc?export=download&id=${docId}`);
            publicCandidates.add(`https://docs.google.com/uc?export=download&id=${docId}`);

            if (sourceUrl) {
              try {
                const parsed = new URL(sourceUrl);
                const idFromQuery = parsed.searchParams.get("id");
                if (idFromQuery) {
                  publicCandidates.add(
                    `https://docs.google.com/document/d/${idFromQuery}/export?format=html`,
                  );
                  publicCandidates.add(
                    `https://drive.google.com/uc?export=download&id=${idFromQuery}`,
                  );
                }
              } catch {
                // Ignore URL parsing issues and continue with known candidates.
              }
            }

            let fetched = false;
            for (const candidateUrl of publicCandidates) {
              try {
                if (candidateUrl.includes("/uc?")) {
                  const response = await axios.get<ArrayBuffer>(candidateUrl, {
                    responseType: "arraybuffer",
                    maxRedirects: 5,
                  });
                  const buffer = Buffer.from(response.data);
                  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
                  const contentDisposition = String(
                    response.headers?.["content-disposition"] || "",
                  ).toLowerCase();

                  const looksDocx =
                    (buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b) ||
                    contentType.includes("wordprocessingml.document") ||
                    contentDisposition.includes(".docx");

                  if (looksDocx) {
                    const mammoth = await import("mammoth");
                    const mammothLib = mammoth.default || mammoth;
                    const converted = await mammothLib.convertToHtml({ buffer });
                    contentToTransform = converted.value || "";
                  } else {
                    contentToTransform = buffer.toString("utf-8");
                  }
                } else {
                  const response = await axios.get(candidateUrl);
                  contentToTransform = response.data;
                }

                if (contentToTransform) {
                  fetched = true;
                  break;
                }
              } catch {
                // Keep trying next public URL candidate.
              }
            }

            if (!fetched) {
              throw new Error(
                "Unable to fetch document from the public Google link. Set sharing to 'Anyone with the link' and ensure the link points to a Google Doc or downloadable DOCX file.",
              );
            }
          }
        }

        if (!contentToTransform) {
          throw new Error(
            "No content available to transform. Please provide a valid document.",
          );
        }

        if (
          contentToTransform.includes("<") &&
          contentToTransform.includes(">")
        ) {
          // It's likely HTML
          adocBody = simpleHtmlToAsciiDoc(contentToTransform);
        } else {
          // It's likely plain text
          adocBody = contentToTransform;
          // Basic wrapping
          if (!adocBody.startsWith("=")) {
            adocBody = `= ${title}\n\n${adocBody}`;
          }
        }
        adocBody = adocBody.replace(/^=\s+[^\r\n]+\r?\n+/, "").trim();
        const safelyReplacedBody = applyReplacementsInUnprotectedSegments(adocBody, varsReplacementCandidates);
        adocBody = validateSnippetRenderSafety(safelyReplacedBody) ? safelyReplacedBody : adocBody;
        finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
      }

      if (!finalAdoc.trim()) {
        finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
      }

      finalAdoc = normalizeWorkspaceFileContent("main.adoc", finalAdoc);
      const renderSafety = validateAdocRenderSafety(finalAdoc);
      if (!renderSafety.safe) {
        finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
      }

      if (typeof ownedJob?.asciiDocPath === "string" && metadataBaseName) {
        try {
          const varsPath = path.join(
            process.cwd(),
            path.dirname(ownedJob.asciiDocPath),
            `${metadataBaseName}-vars.adoc`,
          );
          syncReferenceVarsFile(varsPath, referenceContext, title);
          ensureVarsCompatibilityAliases({
            varsAbsPath: varsPath,
            mainAdocAbsPath: path.join(process.cwd(), ownedJob.asciiDocPath),
            docinfoAbsPath: path.join(
              process.cwd(),
              path.dirname(ownedJob.asciiDocPath),
              `${metadataBaseName}-docinfo.xml`,
            ),
            context: referenceContext,
          });
        } catch {
          // Keep transform resilient when vars synchronization fails.
        }
      }

      if (migrationAppliedDuringTransform) {
        const jobs = getLocalJobs();
        const idx = jobs.findIndex((job) => job.id === ownedJob.id && job.userId === authUser.id);
        if (idx >= 0) {
          const existingMetadata =
            typeof jobs[idx].metadata === "object" && jobs[idx].metadata ? (jobs[idx].metadata as Record<string, unknown>) : {};
          jobs[idx] = {
            ...jobs[idx],
            metadata: {
              ...existingMetadata,
              reference_profile: {
                ...(typeof existingMetadata.reference_profile === "object" && existingMetadata.reference_profile
                  ? (existingMetadata.reference_profile as Record<string, unknown>)
                  : {}),
                templateSource: CANONICAL_TEMPLATE_SOURCE,
                migrationApplied: true,
              },
            },
            updatedAt: new Date().toISOString(),
          };
          saveLocalJobs(jobs);
        }
      }
      res.json({ adoc: finalAdoc, title });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Transformation failed";
      res.status(500).json({ error: { code: "TRANSFORM_FAILED", message } });
    }
  });

  app.post(
    "/api/pipeline/:jobId/upload-for-review",
    requireAuth,
    upload.single("file"),
    async (req: AuthedRequest, res) => {
      const authUser = getAuthUser(req);
      if (!req.file) return sendApiError(res, 400, "INVALID_INPUT", "Missing file.");
      if (!req.file.originalname.toLowerCase().endsWith(".docx")) {
        return sendApiError(res, 400, "INVALID_INPUT", "Only .docx files are supported.");
      }

      const jobs = getLocalJobs();
      const idx = jobs.findIndex((job) => job.id === req.params.jobId && job.userId === authUser.id);
      if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      const job = jobs[idx];
      let tempDir = "";

      try {
        const workspaceRootAbs = resolveWorkspaceRootForJob(job);
        const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
        const baseName =
          workspaceRecord.documentbase ||
          (typeof job.asciiDocPath === "string"
            ? path.basename(String(job.asciiDocPath)).replace(/\.adoc$/i, "")
            : "");
        if (!baseName) {
          return sendApiError(res, 400, "INVALID_STATE", "Workspace base name is missing.");
        }

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "suse-pipeline-upload-"));
        const tempDocPath = path.join(tempDir, req.file.originalname);
        fs.writeFileSync(tempDocPath, req.file.buffer);
        const assetsDir = path.join(workspaceRootAbs, "media", "src");
        fs.mkdirSync(assetsDir, { recursive: true });

        const extractedData = runPythonExtraction(
          tempDocPath,
          assetsDir,
          path.join("media", "src").replace(/\\/g, "/"),
        );
        const sourceName =
          typeof (extractedData as any)?.source_name === "string" && (extractedData as any).source_name.trim()
            ? String((extractedData as any).source_name).trim()
            : path.basename(req.file.originalname, path.extname(req.file.originalname));
        const localExtractionPath = saveExtractedDataToFile(
          extractedData,
          req.file.originalname,
          "extractions",
          `${baseName}-source`,
        );

        const metadata = {
          ...(typeof job.metadata === "object" && job.metadata ? (job.metadata as Record<string, unknown>) : {}),
          ...extractedData,
          source_name: sourceName,
          base_name: baseName,
        };

        jobs[idx] = {
          ...jobs[idx],
          metadata,
          localExtractionPath,
          updatedAt: nowIso(),
        };
        saveLocalJobs(jobs);

        return res.json({
          success: true,
          jobId: job.id,
          localExtractionPath,
          extraction: metadata,
          message: "Upload complete. Review extracted content before applying to ADOC.",
        });
      } catch (error: unknown) {
        if (typeof error === "object" && error && "status" in error && "payload" in error) {
          const typed = error as { status: number; payload: ApiErrorPayload };
          return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
        }
        const message = error instanceof Error ? error.message : "Failed to upload source document for review.";
        return sendApiError(res, 500, "PIPELINE_UPLOAD_REVIEW_FAILED", message);
      } finally {
        if (tempDir && fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    },
  );

  app.post(
    "/api/pipeline/:jobId/apply-reviewed-extraction",
    requireAuth,
    async (req: AuthedRequest, res) => {
      const authUser = getAuthUser(req);
      const jobs = getLocalJobs();
      const idx = jobs.findIndex((job) => job.id === req.params.jobId && job.userId === authUser.id);
      if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");

      const extractionData =
        typeof req.body?.extractionData === "object" && req.body.extractionData
          ? req.body.extractionData
          : null;
      if (!extractionData) {
        return sendApiError(res, 400, "INVALID_INPUT", "extractionData is required.");
      }

      const job = jobs[idx];
      try {
        const workspaceRootAbs = resolveWorkspaceRootForJob(job);
        const migrationResult = migrateWorkspaceForDapsSafety(job, workspaceRootAbs);
        const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
        const baseName =
          workspaceRecord.documentbase ||
          (typeof job.asciiDocPath === "string"
            ? path.basename(String(job.asciiDocPath)).replace(/\.adoc$/i, "")
            : "");
        if (!baseName) {
          return sendApiError(res, 400, "INVALID_STATE", "Workspace base name is missing.");
        }

        const mainAdocPathAbs = path.join(workspaceRootAbs, "adoc", `${baseName}.adoc`);
        const varsPathAbs = path.join(workspaceRootAbs, "adoc", `${baseName}-vars.adoc`);
        const sourceName =
          typeof extractionData?.source_name === "string" && extractionData.source_name.trim()
            ? String(extractionData.source_name).trim()
            : path.basename(String(req.body?.sourceFileName || `${baseName}.docx`), path.extname(String(req.body?.sourceFileName || `${baseName}.docx`)));

        const metadata = {
          ...(typeof job.metadata === "object" && job.metadata ? (job.metadata as Record<string, unknown>) : {}),
          ...extractionData,
          source_name: sourceName,
          base_name: baseName,
        };

        const referenceContext = buildReferenceContext(job, metadata, baseName);
        const varsReplacementCandidates: ReplacementCandidate[] = (() => {
          if (fs.existsSync(varsPathAbs)) {
            const attrs = parseAdocAttributes(fs.readFileSync(varsPathAbs, "utf8"));
            const parsed = buildReplacementCandidatesFromAttributes(attrs);
            if (parsed.length > 0) return parsed;
          }
          return getReplacementCandidatesForContext(referenceContext);
        })();

        let adocBody = "";
        if (Array.isArray((extractionData as any)?.sections)) {
          const renderedSections: Array<{ heading: string; normalizedHeading: string; lines: string[] }> = [];
          const sourceSections = (extractionData as any).sections as any[];
          sourceSections.forEach((section: any, sectionIndex: number) => {
            const headingRaw = normalizeExtractedText(String(section.heading || ""));
            const headingText = applyCoreVariableReferences(
              titleCaseToSentenceCase(headingRaw),
              referenceContext,
              varsReplacementCandidates,
            );
            if (!headingText || isBoilerplateSectionHeading(headingText)) return;
            const sourceNameNorm = normalizeForCompare(String((metadata as any).source_name || ""));
            const headingNorm = normalizeForCompare(headingText);
            if (sourceNameNorm && headingNorm === sourceNameNorm && sectionIndex <= 1) return;
            const sectionLines = renderStructuredSectionLines(section, referenceContext, varsReplacementCandidates);
            renderedSections.push({
              heading: headingText,
              normalizedHeading: normalizeTemplateHeading(headingText),
              lines: sectionLines,
            });
          });
          const profile = resolveProfileForContext(referenceContext);
          adocBody = buildTemplateFirstBody(profile, renderedSections);
        } else {
          const raw = typeof (extractionData as any)?.content === "string" ? (extractionData as any).content : "";
          adocBody = raw || "== Additional extracted content\n\nNo structured sections were detected.";
        }

        const finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
        const renderSafety = validateAdocRenderSafety(finalAdoc);
        const safeAdoc = renderSafety.safe ? finalAdoc : buildTemplateWrappedAdoc(referenceContext, adocBody);
        writeWorkspaceNormalizedFile(mainAdocPathAbs, safeAdoc);

        const workspacePresetKey = String(workspaceRecord.presetPartnerKey || "")
          .trim()
          .toLowerCase();
        const hasPresetTemplate = readPartnerPresetRegistry().some((entry) => entry.partnerKey === workspacePresetKey);
        if (!hasPresetTemplate) {
          syncReferenceVarsFile(varsPathAbs, referenceContext, String((metadata as any).source_name || baseName));
        }
        const compatResult = ensureVarsCompatibilityAliases({
          varsAbsPath: varsPathAbs,
          mainAdocAbsPath: mainAdocPathAbs,
          docinfoAbsPath: path.join(workspaceRootAbs, "adoc", `${baseName}-docinfo.xml`),
          context: referenceContext,
        });

        const sourceFileName =
          typeof req.body?.sourceFileName === "string" && req.body.sourceFileName.trim()
            ? req.body.sourceFileName.trim()
            : `${baseName}.docx`;
        const localExtractionPath = saveExtractedDataToFile(
          extractionData,
          sourceFileName,
          "extractions",
          `${baseName}-source`,
        );

        const workspaceRootRel =
          (typeof workspaceRecord.rootPath === "string" && workspaceRecord.rootPath) ||
          (typeof job.outputFolderPath === "string" ? job.outputFolderPath : "") ||
          "";

        jobs[idx] = {
          ...jobs[idx],
          metadata,
          asciiDocContent: safeAdoc,
          asciiDocPath: path.join(workspaceRootRel, "adoc", `${baseName}.adoc`).replace(/\\/g, "/"),
          localExtractionPath,
          status: "completed",
          updatedAt: nowIso(),
        };
        saveLocalJobs(jobs);

        return res.json({
          success: true,
          jobId: job.id,
          localExtractionPath,
          asciiDocPath: jobs[idx].asciiDocPath,
          adoc: safeAdoc,
          normalizationApplied: migrationResult.normalizedFiles,
          compatAliasesAdded: migrationResult.compatAliasesAdded + compatResult.added,
        });
      } catch (error: unknown) {
        if (typeof error === "object" && error && "status" in error && "payload" in error) {
          const typed = error as { status: number; payload: ApiErrorPayload };
          return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
        }
        const message = error instanceof Error ? error.message : "Failed to apply reviewed extraction.";
        return sendApiError(res, 500, "PIPELINE_APPLY_REVIEW_FAILED", message);
      }
    },
  );

  app.post(
    "/api/pipeline/:jobId/upload-and-apply",
    requireAuth,
    upload.single("file"),
    async (req: AuthedRequest, res) => {
      const authUser = getAuthUser(req);
      if (!req.file) return sendApiError(res, 400, "INVALID_INPUT", "Missing file.");
      if (!req.file.originalname.toLowerCase().endsWith(".docx")) {
        return sendApiError(res, 400, "INVALID_INPUT", "Only .docx files are supported.");
      }

      const jobs = getLocalJobs();
      const idx = jobs.findIndex((job) => job.id === req.params.jobId && job.userId === authUser.id);
      if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      const job = jobs[idx];
      let tempDir = "";
      try {
        const workspaceRootAbs = resolveWorkspaceRootForJob(job);
        const migrationResult = migrateWorkspaceForDapsSafety(job, workspaceRootAbs);
        const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
        const baseName =
          workspaceRecord.documentbase ||
          (typeof job.asciiDocPath === "string"
            ? path.basename(String(job.asciiDocPath)).replace(/\.adoc$/i, "")
            : "");
        if (!baseName) {
          return sendApiError(res, 400, "INVALID_STATE", "Workspace base name is missing.");
        }
        const mainAdocPathAbs = path.join(workspaceRootAbs, "adoc", `${baseName}.adoc`);
        const varsPathAbs = path.join(workspaceRootAbs, "adoc", `${baseName}-vars.adoc`);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "suse-pipeline-upload-"));
        const tempDocPath = path.join(tempDir, req.file.originalname);
        fs.writeFileSync(tempDocPath, req.file.buffer);
        const assetsDir = path.join(workspaceRootAbs, "media", "src");
        fs.mkdirSync(assetsDir, { recursive: true });
        const extractedData = runPythonExtraction(tempDocPath, assetsDir, path.join("media", "src").replace(/\\/g, "/"));

        const metadata = {
          ...(typeof job.metadata === "object" && job.metadata ? (job.metadata as Record<string, unknown>) : {}),
          ...extractedData,
          source_name: path.basename(req.file.originalname, path.extname(req.file.originalname)),
          base_name: baseName,
        };
        const referenceContext = buildReferenceContext(job, metadata, baseName);
        const varsReplacementCandidates: ReplacementCandidate[] = (() => {
          if (fs.existsSync(varsPathAbs)) {
            const attrs = parseAdocAttributes(fs.readFileSync(varsPathAbs, "utf8"));
            const parsed = buildReplacementCandidatesFromAttributes(attrs);
            if (parsed.length > 0) return parsed;
          }
          return getReplacementCandidatesForContext(referenceContext);
        })();

        let adocBody = "";
        if (Array.isArray((extractedData as any)?.sections)) {
          const renderedSections: Array<{ heading: string; normalizedHeading: string; lines: string[] }> = [];
          const sourceSections = (extractedData as any).sections as any[];
          sourceSections.forEach((section: any, sectionIndex: number) => {
            const headingRaw = normalizeExtractedText(String(section.heading || ""));
            const headingText = applyCoreVariableReferences(
              titleCaseToSentenceCase(headingRaw),
              referenceContext,
              varsReplacementCandidates,
            );
            if (!headingText || isBoilerplateSectionHeading(headingText)) return;
            const sourceNameNorm = normalizeForCompare(String((metadata as any).source_name || ""));
            const headingNorm = normalizeForCompare(headingText);
            if (sourceNameNorm && headingNorm === sourceNameNorm && sectionIndex <= 1) return;
            const sectionLines = renderStructuredSectionLines(section, referenceContext, varsReplacementCandidates);
            renderedSections.push({
              heading: headingText,
              normalizedHeading: normalizeTemplateHeading(headingText),
              lines: sectionLines,
            });
          });
          const profile = resolveProfileForContext(referenceContext);
          adocBody = buildTemplateFirstBody(profile, renderedSections);
        } else {
          const raw = typeof (extractedData as any)?.content === "string" ? (extractedData as any).content : "";
          adocBody = raw || "== Additional extracted content\n\nNo structured sections were detected.";
        }

        const finalAdoc = buildTemplateWrappedAdoc(referenceContext, adocBody);
        const renderSafety = validateAdocRenderSafety(finalAdoc);
        const safeAdoc = renderSafety.safe ? finalAdoc : buildTemplateWrappedAdoc(referenceContext, adocBody);
        writeWorkspaceNormalizedFile(mainAdocPathAbs, safeAdoc);
        const workspacePresetKey = String(workspaceRecord.presetPartnerKey || "")
          .trim()
          .toLowerCase();
        const hasPresetTemplate = readPartnerPresetRegistry().some((entry) => entry.partnerKey === workspacePresetKey);
        if (!hasPresetTemplate) {
          syncReferenceVarsFile(varsPathAbs, referenceContext, String((metadata as any).source_name || baseName));
        }
        const compatResult = ensureVarsCompatibilityAliases({
          varsAbsPath: varsPathAbs,
          mainAdocAbsPath: mainAdocPathAbs,
          docinfoAbsPath: path.join(workspaceRootAbs, "adoc", `${baseName}-docinfo.xml`),
          context: referenceContext,
        });
        const localExtractionPath = saveExtractedDataToFile(extractedData, req.file.originalname, "extractions", `${baseName}-source`);

        const workspaceRootRel =
          (typeof workspaceRecord.rootPath === "string" && workspaceRecord.rootPath) ||
          (typeof job.outputFolderPath === "string" ? job.outputFolderPath : "") ||
          "";

        jobs[idx] = {
          ...jobs[idx],
          metadata,
          asciiDocContent: safeAdoc,
          asciiDocPath: path.join(workspaceRootRel, "adoc", `${baseName}.adoc`).replace(/\\/g, "/"),
          localExtractionPath,
          status: "completed",
          updatedAt: nowIso(),
        };
        saveLocalJobs(jobs);
        return res.json({
          success: true,
          jobId: job.id,
          localExtractionPath,
          asciiDocPath: jobs[idx].asciiDocPath,
          adoc: safeAdoc,
          normalizationApplied: migrationResult.normalizedFiles,
          compatAliasesAdded: migrationResult.compatAliasesAdded + compatResult.added,
        });
      } catch (error: unknown) {
        if (typeof error === "object" && error && "status" in error && "payload" in error) {
          const typed = error as { status: number; payload: ApiErrorPayload };
          return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
        }
        const message = error instanceof Error ? error.message : "Failed to upload and apply source document.";
        return sendApiError(res, 500, "PIPELINE_UPLOAD_APPLY_FAILED", message);
      } finally {
        if (tempDir && fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    },
  );

  app.post("/api/pipeline/:jobId/render-html", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    try {
      const jobs = getLocalJobs();
      const idx = jobs.findIndex((job) => job.id === req.params.jobId && job.userId === authUser.id);
      if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
      const job = jobs[idx];
      const workspaceRootAbs = resolveWorkspaceRootForJob(job);
      const migrationResult = migrateWorkspaceForDapsSafety(job, workspaceRootAbs);
      const workspaceRecord = (job.pipelineWorkspace || {}) as Partial<PipelineWorkspaceRecord>;
      const requestedDc = typeof req.body?.dcFileName === "string" ? req.body.dcFileName.trim() : "";
      const dcFiles = fs
        .readdirSync(workspaceRootAbs)
        .filter((name) => name.startsWith("DC-") && fs.statSync(path.join(workspaceRootAbs, name)).isFile())
        .sort((a, b) => a.localeCompare(b));
      if (dcFiles.length === 0) {
        return sendApiError(res, 400, "INVALID_STATE", "No DC file found in workspace.");
      }
      const preferred = requestedDc || workspaceRecord.dcFileName || "";
      const dcFileName = dcFiles.includes(preferred) ? preferred : dcFiles[0];
      const renderResult = runDapsRender(workspaceRootAbs, dcFileName, "html");
      if (!renderResult.ok) {
        const status = renderResult.code === "DAPS_NOT_FOUND" ? 400 : 500;
        return sendApiError(res, status, renderResult.code, renderResult.message, {
          details: renderResult.details,
          phase: (renderResult as any).phase || "render",
          hints: (renderResult as any).hints || [],
        });
      }
      const latestArtifact = findLatestRenderedArtifact(workspaceRootAbs, "html", renderResult.startedAt);
      if (!latestArtifact) {
        return sendApiError(res, 500, "RENDER_OUTPUT_NOT_FOUND", "Rendered HTML artifact not found.");
      }
      const htmlBuildDirAbs = path.dirname(latestArtifact);
      const htmlBuildDirRel = path.relative(process.cwd(), htmlBuildDirAbs).replace(/\\/g, "/");
      const htmlFileName = path.basename(latestArtifact);
      const renderArtifacts =
        typeof job.renderArtifacts === "object" && job.renderArtifacts
          ? { ...(job.renderArtifacts as Record<string, string>) }
          : {};
      renderArtifacts.htmlBuildDir = htmlBuildDirRel;
      renderArtifacts.htmlFile = htmlFileName;
      renderArtifacts.html = `${htmlBuildDirRel}/${htmlFileName}`; // legacy compat
      jobs[idx] = {
        ...job,
        renderArtifacts,
        updatedAt: nowIso(),
      };
      saveLocalJobs(jobs);
      return res.json({
        success: true,
        format: "html",
        path: `${htmlBuildDirRel}/${htmlFileName}`,
        requestPath: `/api/rendered-html/${encodeURIComponent(job.id)}/${htmlFileName}?t=${Date.now()}`,
        normalizationApplied: migrationResult.normalizedFiles,
        compatAliasesAdded: migrationResult.compatAliasesAdded,
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "status" in error && "payload" in error) {
        const typed = error as { status: number; payload: ApiErrorPayload };
        return sendApiError(res, typed.status, typed.payload.code, typed.payload.message, typed.payload.details);
      }
      const message = error instanceof Error ? error.message : "Failed to render pipeline workspace.";
      return sendApiError(res, 500, "PIPELINE_RENDER_FAILED", message);
    }
  });

  app.post("/api/render", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const jobId = typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
    const formatRaw = typeof req.body?.format === "string" ? req.body.format.trim().toLowerCase() : "";
    if (!jobId) return sendApiError(res, 400, "INVALID_INPUT", "jobId is required.");
    if (formatRaw !== "html" && formatRaw !== "pdf") {
      return sendApiError(res, 400, "INVALID_INPUT", "format must be html or pdf.");
    }
    const format = formatRaw as "html" | "pdf";

    const jobs = getLocalJobs();
    const idx = findJobIndexForUser(jobs, authUser.id, jobId);
    if (idx === -1) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");

    const job = jobs[idx];
    const outputFolderPath = typeof job.outputFolderPath === "string" ? job.outputFolderPath : "";
    const asciiDocPath = typeof job.asciiDocPath === "string" ? job.asciiDocPath : "";
    if (!outputFolderPath || !asciiDocPath) {
      return sendApiError(res, 400, "INVALID_STATE", "Project setup is required before rendering.");
    }

    const dcDir = path.join(process.cwd(), outputFolderPath);
    const migrationResult = migrateWorkspaceForDapsSafety(job, dcDir);
    if (!fs.existsSync(dcDir)) {
      return sendApiError(res, 400, "INVALID_STATE", "Render directory not found.");
    }

    const adocAbsPath = path.join(process.cwd(), asciiDocPath);
    if (typeof job.asciiDocContent === "string" && job.asciiDocContent.trim()) {
      try {
        writeWorkspaceNormalizedFile(adocAbsPath, job.asciiDocContent);
      } catch {
        return sendApiError(res, 500, "RENDER_PREP_FAILED", "Failed to write AsciiDoc before rendering.");
      }
    }

    const dcFiles = fs
      .readdirSync(dcDir)
      .filter((name) => name.startsWith("DC-") && fs.statSync(path.join(dcDir, name)).isFile());
    if (dcFiles.length === 0) {
      return sendApiError(res, 400, "INVALID_STATE", "DC file not found in project directory.");
    }

    const baseName = path.basename(asciiDocPath).replace(/\.adoc$/i, "");
    const expectedDc = `DC-${baseName}`;
    const dcFileName = dcFiles.includes(expectedDc) ? expectedDc : dcFiles[0];

    const rendered = runDapsRender(dcDir, dcFileName, format);
    if (!rendered.ok) {
      const status = rendered.code === "DAPS_NOT_FOUND" ? 400 : 500;
      return sendApiError(res, status, rendered.code, rendered.message, {
        details: rendered.details,
        phase: (rendered as any).phase || "render",
        hints: (rendered as any).hints || [],
      });
    }

    const latestArtifact = findLatestRenderedArtifact(dcDir, format, rendered.startedAt);
    if (!latestArtifact) {
      return sendApiError(res, 500, "RENDER_OUTPUT_NOT_FOUND", `Rendered ${format} artifact not found.`);
    }

    const targetFileName = `${baseName}.${format}`;
    const renderArtifacts =
      typeof job.renderArtifacts === "object" && job.renderArtifacts
        ? { ...(job.renderArtifacts as Record<string, string>) }
        : {};

    let requestPath: string;
    if (format === "html") {
      // Store the full build directory so CSS/JS/images are served alongside the HTML.
      const htmlBuildDirAbs = path.dirname(latestArtifact);
      const htmlBuildDirRel = path.relative(process.cwd(), htmlBuildDirAbs).replace(/\\/g, "/");
      const htmlFileName = path.basename(latestArtifact);
      renderArtifacts.htmlBuildDir = htmlBuildDirRel;
      renderArtifacts.htmlFile = htmlFileName;
      renderArtifacts.html = `${htmlBuildDirRel}/${htmlFileName}`; // legacy compat
      requestPath = `/api/rendered-html/${encodeURIComponent(jobId)}/${htmlFileName}?t=${Date.now()}`;
    } else {
      // PDF: copy single file and serve via the old endpoint.
      const targetFilePath = path.join(dcDir, targetFileName);
      if (path.resolve(latestArtifact) !== path.resolve(targetFilePath)) {
        fs.copyFileSync(latestArtifact, targetFilePath);
      }
      const renderedRelative = path.join(outputFolderPath, targetFileName).replace(/\\/g, "/");
      renderArtifacts[format] = renderedRelative;
      requestPath = `/api/rendered-file?jobId=${encodeURIComponent(jobId)}&format=${format}&t=${Date.now()}`;
    }

    jobs[idx] = {
      ...job,
      renderArtifacts,
      updatedAt: new Date().toISOString(),
    };
    saveLocalJobs(jobs);

    return res.json({
      format,
      path: renderArtifacts[format === "html" ? "html" : format] ?? "",
      requestPath,
      normalizationApplied: migrationResult.normalizedFiles,
      compatAliasesAdded: migrationResult.compatAliasesAdded,
    });
  });

  // Serves all files from the DAPS HTML build directory so CSS/JS/images load correctly.
  app.get("/api/rendered-html/:jobId/*", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const jobId = typeof req.params.jobId === "string" ? req.params.jobId.trim() : "";
    const filePath = ((req.params as Record<string, string>)[0] ?? "").replace(/^\/+/, "");

    if (!jobId) return sendApiError(res, 400, "INVALID_INPUT", "jobId is required.");

    const job = getLocalJobs().find((record) => record.id === jobId && record.userId === authUser.id);
    if (!job) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");

    const artifacts = typeof job.renderArtifacts === "object" && job.renderArtifacts
      ? (job.renderArtifacts as Record<string, string>)
      : {};
    const buildDirRel = artifacts.htmlBuildDir;
    if (!buildDirRel) {
      return sendApiError(res, 404, "RENDER_OUTPUT_NOT_FOUND", "No HTML build directory found. Re-run the DAPS HTML render.");
    }

    const buildDirAbs = path.resolve(process.cwd(), buildDirRel);
    const targetAbs = filePath ? path.resolve(buildDirAbs, filePath) : buildDirAbs;

    // Security: prevent path traversal
    if (!targetAbs.startsWith(buildDirAbs + path.sep) && targetAbs !== buildDirAbs) {
      return sendApiError(res, 403, "FORBIDDEN", "Invalid file path.");
    }
    if (!fs.existsSync(targetAbs)) {
      return sendApiError(res, 404, "NOT_FOUND", "File not found in HTML build directory.");
    }

    res.sendFile(targetAbs);
  });

  app.get("/api/rendered-file", requireAuth, (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const jobId = typeof req.query?.jobId === "string" ? req.query.jobId.trim() : "";
    const formatRaw = typeof req.query?.format === "string" ? req.query.format.trim().toLowerCase() : "";
    if (!jobId) return sendApiError(res, 400, "INVALID_INPUT", "jobId is required.");
    if (formatRaw !== "html" && formatRaw !== "pdf") {
      return sendApiError(res, 400, "INVALID_INPUT", "format must be html or pdf.");
    }
    const format = formatRaw as "html" | "pdf";

    const job = getLocalJobs().find((record) => record.id === jobId && record.userId === authUser.id);
    if (!job) return sendApiError(res, 404, "NOT_FOUND", "Job not found.");

    const renderArtifacts =
      typeof job.renderArtifacts === "object" && job.renderArtifacts
        ? (job.renderArtifacts as Record<string, string>)
        : {};
    const relativePath = renderArtifacts[format];
    if (!relativePath) {
      return sendApiError(res, 404, "RENDER_OUTPUT_NOT_FOUND", `No ${format.toUpperCase()} render found for this job.`);
    }

    const fullPath = path.join(process.cwd(), relativePath);
    if (!fs.existsSync(fullPath)) {
      return sendApiError(res, 404, "RENDER_OUTPUT_NOT_FOUND", `${format.toUpperCase()} file not found on disk.`);
    }
    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    } else {
      res.setHeader("Content-Type", "application/pdf");
    }
    res.sendFile(fullPath);
  });

  app.post("/api/sync", requireAuth, async (req: AuthedRequest, res) => {
    const authUser = getAuthUser(req);
    const {
      jobId,
      githubToken,
      repo,
      branch,
      path: filePath,
      content,
      message,
    } = req.body;

    if (typeof jobId !== "string" || !jobId.trim()) {
      return sendApiError(res, 400, "INVALID_INPUT", "jobId is required.");
    }
    const ownedJob = getLocalJobs().find((job) => job.id === jobId && job.userId === authUser.id);
    if (!ownedJob) {
      return sendApiError(res, 404, "NOT_FOUND", "Job not found.");
    }

    if (!githubToken || !repo || !filePath || !content) {
      return sendApiError(res, 400, "INVALID_INPUT", "githubToken, repo, path, and content are required.");
    }

    try {
      const octokit = new Octokit({ auth: githubToken });
      const [owner, repoName] = repo.split("/");

      // Get current file SHA if exists to update
      let sha: string | undefined;
      try {
        const { data } = await octokit.repos.getContent({
          owner,
          repo: repoName,
          path: filePath,
          ref: branch,
        });
        if (!Array.isArray(data)) sha = data.sha;
      } catch (e) {
        // File doesn't exist, that's fine
      }

      const syncResult = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo: repoName,
        path: filePath,
        message: message || "docs: update from SUSE DocEngine",
        content: Buffer.from(content).toString("base64"),
        branch,
        sha,
      });

      res.json({ success: true, url: syncResult.data.commit.html_url });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "GitHub sync failed";
      res.status(500).json({ error: { code: "SYNC_FAILED", message } });
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unexpected server error.";
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", message);
  });

  const serveDistBundle = () => {
    const distPath = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distPath)) {
      throw new Error("Dist bundle is missing. Run `npm run build` to create dist assets.");
    }
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  };

  // Vite middleware for development with fallback to prebuilt dist if Vite cannot spawn child processes.
  if (process.env.NODE_ENV !== "production") {
    try {
      const vite = await createViteServer({
        configLoader: "runner",
        server: {
          host: true,
          allowedHosts: true,
          middlewareMode: true,
          watch: {
            ignored: [
              "**/data/**",
              "**/references/**",
              "**/reference/**",
              "**/document/**",
              "**/final/**",
              "**/data-test-*/**",
            ],
          },
        },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/spawn\s+EPERM/i.test(message)) {
        console.warn(
          "[dev] Vite middleware failed with spawn EPERM; falling back to dist static bundle.",
        );
        serveDistBundle();
      } else {
        throw error;
      }
    }
  } else {
    // In production, serve static files from dist
    serveDistBundle();
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SUSE DocEngine Server running on ${DEFAULT_APP_URL}`);
  });
}

startServer();
