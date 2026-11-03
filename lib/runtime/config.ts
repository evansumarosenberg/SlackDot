export interface Env {
  DB: D1Database;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_TEAM_ID: string;
  SLACK_BOT_USER_ID: string;
  SLACK_BOT_ID: string;
  SLACK_APP_ID: string;
  SLACK_SESSION_STATUS_ENABLED?: string;
  OWNER_USER_ID: string;
  SUBSCRIPTION_ENCRYPTION_KEY: string;
  CALLBACK_ALLOWED_ORIGINS: string;
  SITES_IDENTITY_VERIFIED: string;
}
export class Failure extends Error {
  constructor(public category: string, public retryAfter?: number) { super(category); }
}
export function requireConfig(env: Env, keys: (keyof Env)[]) {
  if (keys.some(key => !env[key])) throw new Failure('configuration_missing');
}
export function owner(request: Request, env: Env) {
  requireConfig(env, ['OWNER_USER_ID']);
  if (env.SITES_IDENTITY_VERIFIED !== 'true') throw new Failure('identity_boundary_unverified');
  const principal = request.headers.get('oai-authenticated-user-id');
  if (!principal || principal !== env.OWNER_USER_ID) throw new Failure('unauthorized');
  return principal;
}
export async function boundedText(request: {body:ReadableStream<Uint8Array>|null}, max: number) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new Failure('body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
