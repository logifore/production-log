import type { SyncRecord } from '@production-log/core/sync';
import type { ProjectAccessStore, ProjectRole, StoredChange } from './projects';
import type { BrowserPairingStore, WechatUserStore } from './auth';

type D1Meta = { changes?: number; changed_db?: boolean };
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: D1Meta }>;
};

export type D1DatabaseLike = { prepare(query: string): D1Statement; batch?(statements: D1Statement[]): Promise<unknown> };

type StoredRecord = { data_json: string; revision: number };
type StoredChangeRow = { cursor: number; project_id: string; operation: 'upsert' | 'delete'; collection: SyncRecord['collection']; record_id: string; data_json: string; revision: number };
type ProjectListRow = { project_id: string; role: ProjectRole; data_json: string; revision: number };

export class D1ProjectStore implements ProjectAccessStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async roleFor(projectId: string, userId: string): Promise<ProjectRole | null> {
    const row = await this.db.prepare('SELECT role FROM memberships WHERE project_id = ? AND user_id = ?').bind(projectId, userId).first<{ role: ProjectRole }>();
    return row?.role ?? null;
  }

  async recordFor(projectId: string, collection: SyncRecord['collection'], id: string): Promise<SyncRecord | null> {
    const row = await this.db.prepare('SELECT data_json, revision FROM project_records WHERE project_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL').bind(projectId, collection, id).first<StoredRecord>();
    return row ? { collection, id, data: JSON.parse(row.data_json), revision: row.revision } : null;
  }

  async saveRecord(projectId: string, operation: 'upsert' | 'delete', record: SyncRecord, expectedRevision: number): Promise<number | null> {
    const deletedAt = operation === 'delete' ? new Date().toISOString() : null;
    const result = await this.db.prepare(
      'INSERT INTO project_records (project_id, collection, id, data_json, revision, deleted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, collection, id) DO UPDATE SET data_json = excluded.data_json, revision = excluded.revision, deleted_at = excluded.deleted_at WHERE project_records.revision = ?',
    ).bind(projectId, record.collection, record.id, JSON.stringify(record.data), record.revision, deletedAt, expectedRevision).run();
    return result.meta.changes === 1 || result.meta.changed_db === true ? record.revision : null;
  }

  async changesAfter(projectId: string, cursor: number): Promise<StoredChange[]> {
    const rows = await this.db.prepare(
      'SELECT changes.cursor, changes.project_id, changes.operation, changes.collection, changes.record_id, records.data_json, changes.revision FROM project_changes AS changes JOIN project_records AS records ON records.project_id = changes.project_id AND records.collection = changes.collection AND records.id = changes.record_id WHERE changes.project_id = ? AND changes.cursor > ? ORDER BY changes.cursor ASC',
    ).bind(projectId, cursor).all<StoredChangeRow>();
    return rows.results.map((row) => ({
      cursor: row.cursor,
      projectId: row.project_id,
      operation: row.operation,
      record: { collection: row.collection, id: row.record_id, data: JSON.parse(row.data_json), revision: row.revision },
    }));
  }

  async createProject(ownerId: string, record: SyncRecord) {
    const now = new Date().toISOString();
    const saved = { ...record, revision: 1 };
    const project = this.db.prepare('INSERT INTO projects (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(record.id, ownerId, now, now);
    const membership = this.db.prepare("INSERT INTO memberships (project_id, user_id, role) VALUES (?, ?, 'owner')").bind(record.id, ownerId);
    const recordInsert = this.db.prepare('INSERT INTO project_records (project_id, collection, id, data_json, revision, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)').bind(record.id, saved.collection, saved.id, JSON.stringify(saved.data), saved.revision);
    if (this.db.batch) await this.db.batch([project, membership, recordInsert]);
    else {
      await project.run();
      await membership.run();
      await recordInsert.run();
    }
    return saved;
  }

  async createInvitation(code: string, projectId: string, expiresAt: string) {
    await this.db.prepare('INSERT INTO invitations (code, project_id, expires_at) VALUES (?, ?, ?)').bind(code, projectId, expiresAt).run();
  }

  async acceptInvitation(code: string, userId: string, now: string) {
    const invitation = await this.db.prepare('SELECT project_id FROM invitations WHERE code = ? AND accepted_at IS NULL AND expires_at > ?').bind(code, now).first<{ project_id: string }>();
    if (!invitation) return null;
    const accepted = await this.db.prepare('UPDATE invitations SET accepted_at = ? WHERE code = ? AND accepted_at IS NULL').bind(now, code).run();
    if (accepted.meta.changes !== 1) return null;
    await this.db.prepare("INSERT OR IGNORE INTO memberships (project_id, user_id, role) VALUES (?, ?, 'viewer')").bind(invitation.project_id, userId).run();
    return invitation.project_id;
  }

  async listProjects(userId: string) {
    const rows = await this.db.prepare("SELECT memberships.project_id, memberships.role, project_records.data_json, project_records.revision FROM memberships JOIN project_records ON project_records.project_id = memberships.project_id AND project_records.collection = 'projects' AND project_records.id = memberships.project_id AND project_records.deleted_at IS NULL WHERE memberships.user_id = ? ORDER BY project_records.revision DESC").bind(userId).all<ProjectListRow>();
    return rows.results.map((row) => ({ projectId: row.project_id, role: row.role, record: { collection: 'projects' as const, id: row.project_id, data: JSON.parse(row.data_json), revision: row.revision } }));
  }
}

export class D1WechatUserStore implements WechatUserStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async findOrCreate(openid: string): Promise<{ id: string }> {
    const existing = await this.db.prepare('SELECT id FROM users WHERE wechat_openid = ?').bind(openid).first<{ id: string }>();
    if (existing) return existing;
    const id = crypto.randomUUID();
    await this.db.prepare('INSERT OR IGNORE INTO users (id, wechat_openid, created_at) VALUES (?, ?, ?)').bind(id, openid, new Date().toISOString()).run();
    const user = await this.db.prepare('SELECT id FROM users WHERE wechat_openid = ?').bind(openid).first<{ id: string }>();
    if (!user) throw new Error('WeChat user could not be created.');
    return user;
  }
}

export class D1BrowserPairingStore implements BrowserPairingStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async createBrowserSession(id: string, expiresAt: string) { await this.db.prepare('INSERT INTO browser_sessions (id, expires_at) VALUES (?, ?)').bind(id, expiresAt).run(); }
  async createPairing(id: string, browserSessionId: string, expiresAt: string) { await this.db.prepare('INSERT INTO pairings (id, browser_session_id, expires_at) VALUES (?, ?, ?)').bind(id, browserSessionId, expiresAt).run(); }
  async confirmPairing(id: string, userId: string, now: string, expiresAt: string) {
    const pairing = await this.db.prepare('SELECT browser_session_id FROM pairings WHERE id = ? AND confirmed_at IS NULL AND expires_at > ?').bind(id, now).first<{ browser_session_id: string }>();
    if (!pairing) return false;
    const absoluteExpiresAt = new Date(new Date(now).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db.prepare("UPDATE browser_sessions SET user_id = ?, expires_at = ?, platform = 'web', created_at = ?, last_seen_at = ?, absolute_expires_at = ?, revoked_at = NULL WHERE id = ? AND expires_at > ?").bind(userId, expiresAt, now, now, absoluteExpiresAt, pairing.browser_session_id, now).run();
    if (result.meta.changes !== 1) return false;
    await this.db.prepare('UPDATE pairings SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL').bind(now, id).run();
    return true;
  }
  async userForSession(id: string, now: string) {
    return this.db.prepare("SELECT user_id FROM browser_sessions WHERE id = ? AND user_id IS NOT NULL AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?").bind(id, now, now).first<{ user_id: string | null }>();
  }
  async createOrReuseMiniProgramSession(requestedId: string | undefined, userId: string, now: string) {
    if (requestedId) {
      const active = await this.db.prepare("SELECT id FROM browser_sessions WHERE id = ? AND user_id = ? AND platform = 'mini-program' AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?").bind(requestedId, userId, now, now).first<{ id: string }>();
      if (active) {
        await this.touchSession(active.id, now);
        return active.id;
      }
    }
    const id = crypto.randomUUID();
    const absoluteExpiresAt = new Date(new Date(now).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(new Date(now).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await this.db.prepare("INSERT INTO browser_sessions (id, user_id, expires_at, platform, created_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, 'mini-program', ?, ?, ?)").bind(id, userId, expiresAt, now, now, absoluteExpiresAt).run();
    return id;
  }
  async touchSession(id: string, now: string) {
    const rollingExpiry = new Date(new Date(now).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await this.db.prepare("UPDATE browser_sessions SET last_seen_at = ?, expires_at = CASE WHEN absolute_expires_at < ? THEN absolute_expires_at ELSE ? END WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?").bind(now, rollingExpiry, rollingExpiry, id, now, now).run();
  }
  async revokeSession(id: string, now: string) { await this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, id).run(); }
  async revokeAllForUser(userId: string, now: string) { await this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, userId).run(); }
}
