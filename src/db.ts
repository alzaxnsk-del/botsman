import Database from 'better-sqlite3';
import fs from 'node:fs';
import { paths } from './paths.js';
import type { ProjectMeta, ProjectStatus, TaskKind, TaskRecord, TaskStatus } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  domain TEXT NOT NULL,
  internal_port INTEGER NOT NULL,
  current_commit TEXT,
  current_image TEXT,
  prev_commit TEXT,
  prev_image TEXT,
  db_name TEXT NOT NULL,
  db_user TEXT NOT NULL,
  db_password TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface ProjectRow {
  slug: string; name: string; description: string; status: string; domain: string;
  internal_port: number; current_commit: string | null; current_image: string | null;
  prev_commit: string | null; prev_image: string | null;
  db_name: string; db_user: string; db_password: string;
  created_at: string; updated_at: string;
}

interface TaskRow {
  id: number; project_slug: string; kind: string; instruction: string; status: string;
  summary: string | null; error: string | null; created_at: string; finished_at: string | null;
}

function rowToProject(r: ProjectRow): ProjectMeta {
  return {
    slug: r.slug, name: r.name, description: r.description,
    status: r.status as ProjectStatus, domain: r.domain, internalPort: r.internal_port,
    currentCommit: r.current_commit, currentImage: r.current_image,
    prevCommit: r.prev_commit, prevImage: r.prev_image,
    dbName: r.db_name, dbUser: r.db_user, dbPassword: r.db_password,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToTask(r: TaskRow): TaskRecord {
  return {
    id: r.id, projectSlug: r.project_slug, kind: r.kind as TaskKind,
    instruction: r.instruction, status: r.status as TaskStatus,
    summary: r.summary, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

export class Store {
  private db: Database.Database;

  constructor(file?: string) {
    const dbFile = file ?? paths.dbFile();
    if (dbFile !== ':memory:') {
      fs.mkdirSync(paths.home(), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- projects ---

  createProject(p: Omit<ProjectMeta, 'createdAt' | 'updatedAt'>): ProjectMeta {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (slug, name, description, status, domain, internal_port,
        current_commit, current_image, prev_commit, prev_image,
        db_name, db_user, db_password, created_at, updated_at)
      VALUES (@slug, @name, @description, @status, @domain, @internalPort,
        @currentCommit, @currentImage, @prevCommit, @prevImage,
        @dbName, @dbUser, @dbPassword, @createdAt, @updatedAt)
    `).run({ ...p, createdAt: now, updatedAt: now });
    return { ...p, createdAt: now, updatedAt: now };
  }

  getProject(slug: string): ProjectMeta | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
    return r ? rowToProject(r) : null;
  }

  listProjects(): ProjectMeta[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  projectExists(slug: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug);
  }

  updateProject(slug: string, patch: Partial<ProjectMeta>): void {
    const current = this.getProject(slug);
    if (!current) throw new Error(`Project ${slug} not found`);
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      UPDATE projects SET name=@name, description=@description, status=@status,
        domain=@domain, internal_port=@internalPort,
        current_commit=@currentCommit, current_image=@currentImage,
        prev_commit=@prevCommit, prev_image=@prevImage,
        db_name=@dbName, db_user=@dbUser, db_password=@dbPassword,
        updated_at=@updatedAt
      WHERE slug=@slug
    `).run(merged);
  }

  setStatus(slug: string, status: ProjectStatus): void {
    this.updateProject(slug, { status });
  }

  deleteProject(slug: string): void {
    this.db.prepare('DELETE FROM projects WHERE slug = ?').run(slug);
    this.db.prepare('DELETE FROM tasks WHERE project_slug = ?').run(slug);
  }

  // --- tasks ---

  createTask(projectSlug: string, kind: TaskKind, instruction: string): TaskRecord {
    const now = new Date().toISOString();
    const info = this.db.prepare(`
      INSERT INTO tasks (project_slug, kind, instruction, status, created_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(projectSlug, kind, instruction, now);
    return {
      id: Number(info.lastInsertRowid), projectSlug, kind, instruction,
      status: 'queued', summary: null, error: null, createdAt: now, finishedAt: null,
    };
  }

  finishTask(id: number, status: 'done' | 'failed', summary?: string, error?: string): void {
    this.db.prepare(`
      UPDATE tasks SET status=?, summary=?, error=?, finished_at=? WHERE id=?
    `).run(status, summary ?? null, error ?? null, new Date().toISOString(), id);
  }

  setTaskStatus(id: number, status: TaskStatus): void {
    this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id);
  }

  /** Startup reconciliation: tasks interrupted by a daemon restart must not look in-flight forever. */
  failInterruptedTasks(): number {
    const info = this.db.prepare(`
      UPDATE tasks SET status='failed', error='Interrupted by a daemon restart', finished_at=?
      WHERE status IN ('queued', 'running')
    `).run(new Date().toISOString());
    return info.changes;
  }

  tasksForProject(slug: string, limit = 20): TaskRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE project_slug=? ORDER BY id DESC LIMIT ?',
    ).all(slug, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  // --- kv (install id, telemetry markers, last active project per chat) ---

  kvGet(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value);
  }
}
