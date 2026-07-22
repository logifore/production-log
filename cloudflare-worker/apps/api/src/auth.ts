const ACCESS_TOKEN_DURATION_MS = 60 * 60 * 1000;
const PAIRING_DURATION_MS = 5 * 60 * 1000;
const WEB_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

type SessionPayload = { sub: string; sid: string; exp: number };

export type WechatUserStore = { findOrCreate(openid: string): Promise<{ id: string }> };
export type MiniProgramSessionStore = { createOrReuseMiniProgramSession(requestedId: string | undefined, userId: string, now: string): Promise<string> };
export type BrowserPairingStore = {
  createBrowserSession(id: string, expiresAt: string): Promise<void>;
  createPairing(id: string, browserSessionId: string, expiresAt: string): Promise<void>;
  confirmPairing(id: string, userId: string, now: string, expiresAt: string): Promise<boolean>;
};
export type WechatAuthOptions = {
  appId: string;
  appSecret: string;
  signingKey: string;
  fetcher: (input: string) => Promise<Response>;
  users: WechatUserStore;
  sessions: MiniProgramSessionStore;
};

function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decode(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function signingKey(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(payload: string, secret: string) {
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(payload));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function createSessionToken(userId: string, sessionId: string, secret: string, now = new Date()) {
  const payload = encode(JSON.stringify({ sub: userId, sid: sessionId, exp: Math.floor((now.getTime() + ACCESS_TOKEN_DURATION_MS) / 1000) } satisfies SessionPayload));
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(token: string, secret: string, now = new Date()): Promise<{ userId: string; sessionId: string }> {
  try {
    const [encodedPayload, encodedSignature, extra] = token.split('.');
    if (!encodedPayload || !encodedSignature || extra) throw new Error('Malformed token');
    const signatureBinary = atob(encodedSignature.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encodedSignature.length % 4) % 4));
    const signature = Uint8Array.from(signatureBinary, (character) => character.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), signature, new TextEncoder().encode(encodedPayload));
    const payload = JSON.parse(decode(encodedPayload)) as SessionPayload;
    if (!valid || !payload.sub || !payload.sid || !Number.isInteger(payload.exp) || payload.exp * 1000 <= now.getTime()) throw new Error('Invalid token');
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    throw new Error('Session is invalid or expired.');
  }
}

export async function authenticateWechatCode(code: string, requestedSessionId: string | undefined, options: WechatAuthOptions, now = new Date()) {
  if (!code.trim()) throw new Error('WeChat login code is required.');
  const query = new URLSearchParams({ appid: options.appId, secret: options.appSecret, js_code: code, grant_type: 'authorization_code' });
  const response = await options.fetcher(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
  const body = await response.json() as { openid?: string; errcode?: number };
  if (!response.ok || !body.openid || body.errcode) throw new Error('WeChat login could not be verified.');
  const user = await options.users.findOrCreate(body.openid);
  const sessionId = await options.sessions.createOrReuseMiniProgramSession(requestedSessionId, user.id, now.toISOString());
  return { user, token: await createSessionToken(user.id, sessionId, options.signingKey, now), expiresAt: new Date(now.getTime() + ACCESS_TOKEN_DURATION_MS).toISOString(), deviceSessionId: sessionId };
}

export async function createBrowserPairing(store: BrowserPairingStore, pairingId: string, browserSessionId: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + PAIRING_DURATION_MS).toISOString();
  await store.createBrowserSession(browserSessionId, expiresAt);
  await store.createPairing(pairingId, browserSessionId, expiresAt);
  return { id: pairingId, expiresAt };
}

export async function confirmBrowserPairing(store: BrowserPairingStore, pairingId: string, userId: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + WEB_SESSION_DURATION_MS).toISOString();
  if (!await store.confirmPairing(pairingId, userId, now.toISOString(), expiresAt)) throw new Error('Pairing is invalid or expired.');
}
