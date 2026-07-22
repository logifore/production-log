import { projectSyncRecord, type SyncChange, type SyncRecord } from '@production-log/core/sync';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type ProjectRole = 'owner' | 'viewer';
export type StoredChange = { cursor: number; projectId: string; operation: 'upsert' | 'delete'; record: SyncRecord };

export interface ProjectStore {
  roleFor(projectId: string, userId: string): Promise<ProjectRole | null>;
  recordFor(projectId: string, collection: SyncRecord['collection'], id: string): Promise<SyncRecord | null>;
  saveRecord(projectId: string, operation: 'upsert' | 'delete', record: SyncRecord, expectedRevision: number): Promise<number | null>;
  changesAfter(projectId: string, cursor: number): Promise<StoredChange[]>;
}

export interface ProjectAccessStore extends ProjectStore {
  createInvitation(code: string, projectId: string, expiresAt: string): Promise<void>;
  acceptInvitation(code: string, userId: string, now: string): Promise<string | null>;
}

export class ProjectService {
  constructor(private readonly store: ProjectStore) {}

  async write(actorId: string, projectId: string, record: SyncRecord, expectedRevision: number): Promise<SyncRecord> {
    await this.assertOwner(actorId, projectId);
    const sanitized = projectSyncRecord(record.collection, record.data as { id: string } & Record<string, unknown>, record.revision);
    this.assertRecordProject(projectId, sanitized);

    const current = await this.store.recordFor(projectId, sanitized.collection, sanitized.id);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) throw new ApiError(409, 'Record has changed. Refresh before saving again.');

    const saved = { ...sanitized, revision: currentRevision + 1 };
    const cursor = await this.store.saveRecord(projectId, 'upsert', saved, expectedRevision);
    if (cursor === null) throw new ApiError(409, 'Record has changed. Refresh before saving again.');
    return saved;
  }

  async pull(actorId: string, projectId: string, afterCursor: number): Promise<{ cursor: number; changes: SyncChange[] }> {
    await this.assertMember(actorId, projectId);
    const changes = await this.store.changesAfter(projectId, afterCursor);
    return {
      cursor: changes.at(-1)?.cursor ?? afterCursor,
      changes: changes.map(({ cursor, operation, record }) => ({ cursor, operation, record })),
    };
  }

  async delete(actorId: string, projectId: string, collection: SyncRecord['collection'], recordId: string, expectedRevision: number): Promise<SyncRecord> {
    await this.assertOwner(actorId, projectId);
    const current = await this.store.recordFor(projectId, collection, recordId);
    if (!current || current.revision !== expectedRevision) throw new ApiError(409, 'Record has changed. Refresh before deleting.');
    const deleted = { ...current, revision: current.revision + 1 };
    const cursor = await this.store.saveRecord(projectId, 'delete', deleted, expectedRevision);
    if (cursor === null) throw new ApiError(409, 'Record has changed. Refresh before deleting.');
    return deleted;
  }

  private async assertOwner(actorId: string, projectId: string) {
    const role = await this.store.roleFor(projectId, actorId);
    if (role !== 'owner') throw new ApiError(role ? 403 : 404, role ? 'Project is read-only.' : 'Project was not found.');
  }

  private async assertMember(actorId: string, projectId: string) {
    if (!await this.store.roleFor(projectId, actorId)) throw new ApiError(404, 'Project was not found.');
  }

  private assertRecordProject(projectId: string, record: SyncRecord) {
    const dataProjectId = record.collection === 'projects'
      ? (record.data.id as string | undefined)
      : (record.data.projectId as string | undefined);
    if (record.id !== (record.data.id as string | undefined) || dataProjectId !== projectId) {
      throw new ApiError(400, 'Record does not belong to this project.');
    }
  }
}

export class ProjectAccessService {
  constructor(private readonly store: ProjectAccessStore) {}

  async createInvitation(actorId: string, projectId: string, code: string, expiresAt: Date) {
    const role = await this.store.roleFor(projectId, actorId);
    if (role !== 'owner') throw new ApiError(role ? 403 : 404, role ? 'Project is read-only.' : 'Project was not found.');
    await this.store.createInvitation(code, projectId, expiresAt.toISOString());
  }

  async acceptInvitation(userId: string, code: string, now = new Date()) {
    const projectId = await this.store.acceptInvitation(code, userId, now.toISOString());
    if (!projectId) throw new ApiError(400, 'Invitation is invalid or expired.');
    return projectId;
  }
}
