import { z } from 'zod';

export const SyncCollectionSchema = z.enum([
  'projects', 'shootDays', 'projectSchedules', 'projectCrewGroups', 'projectCrewMembers', 'projectCrewMemberships',
  'records', 'translations', 'locations', 'itineraryDays', 'itineraryStops', 'timelineEvents', 'transfers',
  'itineraryPublications', 'independentArtifacts',
]);
export type SyncCollection = z.infer<typeof SyncCollectionSchema>;

export const SyncRecordSchema = z.object({
  collection: SyncCollectionSchema,
  id: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive(),
});
export type SyncRecord = z.infer<typeof SyncRecordSchema>;

export const SyncChangeSchema = z.object({
  cursor: z.number().int().positive(),
  operation: z.enum(['upsert', 'delete']),
  record: SyncRecordSchema,
});
export type SyncChange = z.infer<typeof SyncChangeSchema>;

export const PullResponseSchema = z.object({
  cursor: z.number().int().nonnegative(),
  changes: z.array(SyncChangeSchema),
});
export type PullResponse = z.infer<typeof PullResponseSchema>;

function structuredData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => key.toLowerCase().includes('attachment') ? [] : [[key, structuredData(item)]]));
}

export function projectSyncRecord(collection: SyncCollection, data: { id: string } & Record<string, unknown>, revision: number): SyncRecord {
  return SyncRecordSchema.parse({ collection, id: data.id, data: structuredData(data), revision });
}
