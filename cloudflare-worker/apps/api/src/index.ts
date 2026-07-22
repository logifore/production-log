import { authenticateWechatCode, confirmBrowserPairing, createBrowserPairing, verifySessionToken } from './auth';
import { D1BrowserPairingStore, D1ProjectStore, D1WechatUserStore, type D1DatabaseLike } from './d1';
import { ApiError, ProjectAccessService, ProjectService } from './projects';
import { SupportTicketRateLimiter } from './supportRateLimit';
import { ProjectSchema } from '@production-log/core/project';
import { SyncCollectionSchema, SyncRecordSchema } from '@production-log/core/sync';

export type WorkerEnv = {
  WEB_ORIGIN: string;
  DB?: D1DatabaseLike;
  WECHAT_APP_ID?: string;
  WECHAT_APP_SECRET?: string;
  SESSION_SIGNING_KEY?: string;
  SUPPORT_EMAIL?: string;
  SUPPORT_FROM_EMAIL?: string;
  RESEND_API_KEY?: string;
};

const MAX_SUPPORT_TICKET_LENGTH = 5_000;

function supportTicketContent(value: unknown) {
  if (typeof value !== 'string') return null;
  const content = value.trim();
  return content.length > 0 && content.length <= MAX_SUPPORT_TICKET_LENGTH ? content : null;
}

async function sendSupportTicket(content: string, env: WorkerEnv) {
  if (!env.SUPPORT_EMAIL || !env.SUPPORT_FROM_EMAIL || !env.RESEND_API_KEY) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.SUPPORT_FROM_EMAIL,
      to: [env.SUPPORT_EMAIL],
      subject: '[Production Log] New support ticket',
      text: content,
    }),
  });
  return response.ok;
}

function corsHeaders(origin: string | null, env: WorkerEnv) {
  if (origin !== env.WEB_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': env.WEB_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

function hasBrowserSessionCookie(request: Request) {
  return /(?:^|;\s*)production_log_browser=/.test(request.headers.get('Cookie') ?? '');
}

function isUnsafeMethod(method: string) {
  return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
}

export function errorResponse(error: unknown, fallbackStatus: number, fallbackMessage: string, headers?: HeadersInit) {
  const status = error instanceof ApiError ? error.status : fallbackStatus;
  const message = error instanceof ApiError ? error.message : fallbackMessage;
  return new Response(message, { status, headers });
}

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const headers = corsHeaders(request.headers.get('Origin'), env);
  if (request.method === 'OPTIONS') return headers ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
  if (isUnsafeMethod(request.method) && hasBrowserSessionCookie(request) && request.headers.get('Origin') !== env.WEB_ORIGIN) return new Response('Forbidden.', { status: 403 });
  if (new URL(request.url).pathname === '/health') return Response.json({ ok: true }, { headers: headers ?? undefined });
  if (request.method === 'POST' && new URL(request.url).pathname === '/v1/support/tickets') {
    if (!headers) return new Response('Forbidden.', { status: 403 });
    if (!env.SUPPORT_EMAIL || !env.SUPPORT_FROM_EMAIL || !env.RESEND_API_KEY) return new Response('Support email is not configured.', { status: 503, headers });
    const actor = await authenticatedUser(request, env);
    if (!actor) return new Response('Unauthenticated.', { status: 401, headers });
    let body: { content?: unknown };
    try {
      body = await request.json() as { content?: unknown };
    } catch {
      return new Response('Support ticket content must be valid JSON.', { status: 400, headers });
    }
    const content = supportTicketContent(body.content);
    if (!content) return new Response('Support ticket content must be between 1 and 5000 characters.', { status: 400, headers });
    try {
      const quota = await new SupportTicketRateLimiter(env.DB!).consume(actor);
      if (!quota.allowed) return new Response('Support ticket limit reached. Please try again later.', { status: 429, headers: { ...headers, 'Retry-After': String(quota.retryAfterSeconds) } });
    } catch {
      return new Response('Support ticket service is temporarily unavailable.', { status: 503, headers });
    }
    try {
      if (!await sendSupportTicket(content, env)) return new Response('Support ticket could not be sent.', { status: 502, headers });
      return Response.json({ sent: true }, { status: 202, headers });
    } catch {
      return new Response('Support ticket could not be sent.', { status: 502, headers });
    }
  }
  if (request.method === 'POST' && new URL(request.url).pathname === '/v1/auth/wechat') {
    if (!env.DB || !env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET || !env.SESSION_SIGNING_KEY) return new Response('Authentication is not configured.', { status: 503, headers: headers ?? undefined });
    try {
      const body = await request.json() as { code?: unknown; deviceSessionId?: unknown };
      if (typeof body.code !== 'string') return new Response('WeChat login code is required.', { status: 400, headers: headers ?? undefined });
      const sessions = new D1BrowserPairingStore(env.DB);
      const result = await authenticateWechatCode(body.code, typeof body.deviceSessionId === 'string' ? body.deviceSessionId : undefined, { appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET, signingKey: env.SESSION_SIGNING_KEY, fetcher: (url) => fetch(url), users: new D1WechatUserStore(env.DB), sessions });
      return Response.json(result, { headers: headers ?? undefined });
    } catch {
      return new Response('WeChat login could not be verified.', { status: 401, headers: headers ?? undefined });
    }
  }
  if (request.method === 'DELETE' && new URL(request.url).pathname === '/v1/auth/session') {
    const actor = await authenticatedUser(request, env);
    const sessionId = await currentSessionId(request, env);
    if (!actor || !sessionId || !env.DB) return new Response('Unauthenticated.', { status: 401, headers: headers ?? undefined });
    await new D1BrowserPairingStore(env.DB).revokeSession(sessionId, new Date().toISOString());
    return new Response(null, { status: 204, headers: { ...(headers ?? {}), 'Set-Cookie': 'production_log_browser=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
  }
  if (request.method === 'POST' && new URL(request.url).pathname === '/v1/auth/sessions/revoke-all') {
    const actor = await authenticatedUser(request, env);
    if (!actor || !env.DB) return new Response('Unauthenticated.', { status: 401, headers: headers ?? undefined });
    await new D1BrowserPairingStore(env.DB).revokeAllForUser(actor, new Date().toISOString());
    return new Response(null, { status: 204, headers: { ...(headers ?? {}), 'Set-Cookie': 'production_log_browser=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
  }
  if (request.method === 'GET' && new URL(request.url).pathname === '/v1/auth/session') {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/, '');
    if (token && env.SESSION_SIGNING_KEY) {
      try { return Response.json(await verifySessionToken(token, env.SESSION_SIGNING_KEY), { headers: headers ?? undefined }); }
      catch { return new Response('Unauthenticated.', { status: 401, headers: headers ?? undefined }); }
    }
    const sessionId = request.headers.get('Cookie')?.match(/(?:^|;\s*)production_log_browser=([^;]+)/)?.[1];
    const session = sessionId && env.DB ? await new D1BrowserPairingStore(env.DB).userForSession(sessionId, new Date().toISOString()) : null;
    if (!session?.user_id) return new Response('Unauthenticated.', { status: 401, headers: headers ?? undefined });
    await new D1BrowserPairingStore(env.DB!).touchSession(sessionId!, new Date().toISOString());
    return Response.json({ userId: session.user_id }, { headers: { ...(headers ?? {}), 'Set-Cookie': `production_log_browser=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } });
  }
  if (request.method === 'POST' && new URL(request.url).pathname === '/v1/auth/pairings' && env.DB) {
    const pairingId = crypto.randomUUID(); const browserSessionId = crypto.randomUUID();
    const pairing = await createBrowserPairing(new D1BrowserPairingStore(env.DB), pairingId, browserSessionId);
    return Response.json(pairing, { headers: { ...(headers ?? {}), 'Set-Cookie': `production_log_browser=${browserSessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300` } });
  }
  const confirm = new URL(request.url).pathname.match(/^\/v1\/auth\/pairings\/([^/]+)\/confirm$/);
  const pairingActor = await authenticatedUser(request, env);
  if (request.method === 'POST' && confirm && pairingActor && env.DB) {
    try { await confirmBrowserPairing(new D1BrowserPairingStore(env.DB), confirm[1], pairingActor); return new Response(null, { status: 204, headers: headers ?? undefined }); }
    catch { return new Response('Pairing is invalid or expired.', { status: 400, headers: headers ?? undefined }); }
  }
  if (request.method === 'GET' && new URL(request.url).pathname === '/v1/auth/browser-session' && env.DB) {
    const sessionId = request.headers.get('Cookie')?.match(/(?:^|;\s*)production_log_browser=([^;]+)/)?.[1];
    const now = new Date().toISOString();
    const sessions = new D1BrowserPairingStore(env.DB);
    const session = sessionId ? await sessions.userForSession(sessionId, now) : null;
    if (!session?.user_id) return new Response('Unauthenticated.', { status: 401, headers: headers ?? undefined });
    await sessions.touchSession(sessionId!, now);
    return Response.json({ userId: session.user_id }, { headers: { ...(headers ?? {}), 'Set-Cookie': `production_log_browser=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } });
  }
  const actor = await authenticatedUser(request, env);
  const authenticatedHeaders = await responseHeadersForAuthenticatedWebSession(request, env, actor, headers);
  const url = new URL(request.url);
  if (actor && env.DB && request.method === 'POST' && url.pathname === '/v1/projects') {
    try {
      const project = ProjectSchema.parse(await request.json());
      const record = await new D1ProjectStore(env.DB).createProject(actor, { collection: 'projects', id: project.id, data: project, revision: 1 });
      return Response.json(record, { status: 201, headers: authenticatedHeaders });
    } catch (error) {
      return errorResponse(error, 400, 'Project could not be created.', authenticatedHeaders);
    }
  }
  if (actor && env.DB && request.method === 'GET' && url.pathname === '/v1/projects') {
    return Response.json(await new D1ProjectStore(env.DB).listProjects(actor), { headers: authenticatedHeaders });
  }
  const invitation = url.pathname.match(/^\/v1\/projects\/([^/]+)\/invitations$/);
  if (actor && env.DB && request.method === 'POST' && invitation) {
    try {
      const code = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await new ProjectAccessService(new D1ProjectStore(env.DB)).createInvitation(actor, invitation[1], code, expiresAt);
      return Response.json({ code, expiresAt: expiresAt.toISOString() }, { status: 201, headers: authenticatedHeaders });
    } catch (error) {
      return errorResponse(error, 400, 'Invitation could not be created.', authenticatedHeaders);
    }
  }
  const acceptInvitation = url.pathname.match(/^\/v1\/invitations\/([^/]+)\/accept$/);
  if (actor && env.DB && request.method === 'POST' && acceptInvitation) {
    try {
      const projectId = await new ProjectAccessService(new D1ProjectStore(env.DB)).acceptInvitation(actor, acceptInvitation[1]);
      return Response.json({ projectId }, { headers: authenticatedHeaders });
    } catch (error) {
      return errorResponse(error, 400, 'Invitation is invalid or expired.', authenticatedHeaders);
    }
  }
  const changes = url.pathname.match(/^\/v1\/projects\/([^/]+)\/changes$/);
  if (actor && env.DB && request.method === 'GET' && changes) {
    try {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isInteger(after) || after < 0) throw new Error('Invalid cursor');
      return Response.json(await new ProjectService(new D1ProjectStore(env.DB)).pull(actor, changes[1], after), { headers: authenticatedHeaders });
    } catch (error) {
      return errorResponse(error, 400, 'Project changes could not be loaded.', authenticatedHeaders);
    }
  }
  const write = url.pathname.match(/^\/v1\/projects\/([^/]+)\/records\/([^/]+)\/([^/]+)$/);
  if (actor && env.DB && request.method === 'PUT' && write) {
    try {
      const body = await request.json() as { record?: unknown; expectedRevision?: unknown };
      if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new Error('Invalid revision');
      const record = SyncRecordSchema.parse(body.record);
      if (record.collection !== write[2] || record.id !== write[3]) throw new Error('Invalid record');
      return Response.json(await new ProjectService(new D1ProjectStore(env.DB)).write(actor, write[1], record, body.expectedRevision as number), { headers: authenticatedHeaders });
    } catch (error) {
      return errorResponse(error, 400, 'Project record could not be saved.', authenticatedHeaders);
    }
  }
  const deletion = url.pathname.match(/^\/v1\/projects\/([^/]+)\/records\/([^/]+)\/([^/]+)$/);
  if (actor && env.DB && request.method === 'DELETE' && deletion) {
    try {
      const body = await request.json() as { expectedRevision?: unknown };
      if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw new Error('Invalid revision');
      const collection = SyncCollectionSchema.parse(deletion[2]);
      return Response.json(await new ProjectService(new D1ProjectStore(env.DB)).delete(actor, deletion[1], collection, deletion[3], body.expectedRevision as number), { headers: authenticatedHeaders });
    } catch (error) {
      return errorResponse(error, 400, 'Project record could not be deleted.', authenticatedHeaders);
    }
  }
  return new Response('Not found.', { status: 404, headers: authenticatedHeaders });
}

async function authenticatedUser(request: Request, env: WorkerEnv) {
  if (!env.DB) return null;
  const now = new Date().toISOString();
  const sessions = new D1BrowserPairingStore(env.DB);
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/, '');
  if (token && env.SESSION_SIGNING_KEY) {
    try {
      const payload = await verifySessionToken(token, env.SESSION_SIGNING_KEY);
      const session = await sessions.userForSession(payload.sessionId, now);
      if (session?.user_id === payload.userId) {
        await sessions.touchSession(payload.sessionId, now);
        return payload.userId;
      }
    } catch { /* Try a Web cookie before returning unauthenticated. */ }
  }
  const sessionId = request.headers.get('Cookie')?.match(/(?:^|;\s*)production_log_browser=([^;]+)/)?.[1];
  if (!sessionId) return null;
  const session = await sessions.userForSession(sessionId, now);
  if (!session?.user_id) return null;
  await sessions.touchSession(sessionId, now);
  return session.user_id;
}

async function currentSessionId(request: Request, env: WorkerEnv) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/, '');
  if (token && env.SESSION_SIGNING_KEY) {
    try { return (await verifySessionToken(token, env.SESSION_SIGNING_KEY)).sessionId; } catch { return null; }
  }
  return request.headers.get('Cookie')?.match(/(?:^|;\s*)production_log_browser=([^;]+)/)?.[1] ?? null;
}

async function responseHeadersForAuthenticatedWebSession(request: Request, env: WorkerEnv, userId: string | null, headers: HeadersInit | null) {
  if (!userId || !env.DB) return headers ?? undefined;
  const sessionId = request.headers.get('Cookie')?.match(/(?:^|;\s*)production_log_browser=([^;]+)/)?.[1];
  if (!sessionId) return headers ?? undefined;
  const now = new Date().toISOString();
  const sessions = new D1BrowserPairingStore(env.DB);
  const session = await sessions.userForSession(sessionId, now);
  if (session?.user_id !== userId) return headers ?? undefined;
  await sessions.touchSession(sessionId, now);
  return { ...(headers ?? {}), 'Set-Cookie': `production_log_browser=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` };
}

export default {
  fetch(request: Request, env: WorkerEnv) {
    return handleRequest(request, env);
  },
};
