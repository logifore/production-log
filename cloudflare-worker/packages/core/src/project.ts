import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  status: z.enum(['active', 'archived']),
  sortOrder: z.number().int().nonnegative().optional(),
  archivedAt: z.string().datetime().optional(),
  shootStartDate: z.string().date().optional(),
  shootEndDate: z.string().date().optional(),
  setupStatus: z.enum(['draft', 'complete']).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const ProjectScheduleTypeSchema = z.enum(['planning', 'scouting', 'shooting', 'post-production', 'custom']);
export type ProjectScheduleType = z.infer<typeof ProjectScheduleTypeSchema>;

export const ProjectScheduleSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  date: z.string().date(),
  title: z.string().trim().min(1),
  type: ProjectScheduleTypeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProjectSchedule = z.infer<typeof ProjectScheduleSchema>;
