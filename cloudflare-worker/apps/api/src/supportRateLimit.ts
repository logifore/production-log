import type { D1DatabaseLike } from './d1';

export const SUPPORT_TICKET_LIMIT = 5;
const SUPPORT_TICKET_WINDOW_MS = 60 * 60 * 1000;

export type SupportTicketQuota = { allowed: boolean; retryAfterSeconds?: number };

export class SupportTicketRateLimiter {
  constructor(private readonly database: D1DatabaseLike) {}

  async consume(userId: string, now = Date.now()): Promise<SupportTicketQuota> {
    const windowStart = now - SUPPORT_TICKET_WINDOW_MS;
    await this.database.prepare(
      'INSERT INTO support_ticket_rate_limits (user_id, window_started_at, request_count) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET window_started_at = CASE WHEN support_ticket_rate_limits.window_started_at <= ? THEN ? ELSE support_ticket_rate_limits.window_started_at END, request_count = CASE WHEN support_ticket_rate_limits.window_started_at <= ? THEN 1 ELSE support_ticket_rate_limits.request_count + 1 END',
    ).bind(userId, now, windowStart, now, windowStart).run();
    const quota = await this.database.prepare('SELECT request_count, window_started_at FROM support_ticket_rate_limits WHERE user_id = ?').bind(userId).first<{ request_count: number; window_started_at: number }>();
    if (!quota) throw new Error('Support ticket quota could not be read.');
    if (quota.request_count <= SUPPORT_TICKET_LIMIT) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((quota.window_started_at + SUPPORT_TICKET_WINDOW_MS - now) / 1000)) };
  }
}
