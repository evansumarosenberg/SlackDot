import type { Env } from './runtime/config';
import { normalize } from './slack/normalize';
import { DELIVERY_MS } from './events/budget';
export interface Subscription {
  id:string; owner:string; name:string; args:string; conversation:string; thread:string|null;
  callback:string; secret:string|null; secret_hash:string; verified_at:number; created_at:number; expires_at:number; active:number;
}
export async function acceptEvent(env: Env, body: Record<string, any>, now = Date.now()) {
  const event = normalize(body, env);
  const statements = [env.DB.prepare('INSERT OR IGNORE INTO receipts(id,accepted_at) VALUES (?,?)').bind(`${env.SLACK_TEAM_ID}:${body.event_id}`, now)];
  if (event) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO events(id,conversation,thread,payload,accepted_at) VALUES (?,?,?,?,?)')
      .bind(event.eventId,event.data.conversation_id,event.data.thread_ts,JSON.stringify(event),now));
    // Acceptance and fanout commit together. Do not replay to later subscriptions.
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO deliveries(event_id,subscription_id,state,attempts,next_at,deadline)
      SELECT e.id,s.id,'pending',0,?,? FROM events e JOIN subscriptions s ON s.conversation=e.conversation
      WHERE e.id=? AND s.owner=? AND s.active=1 AND s.expires_at>? AND s.created_at<=e.accepted_at
      AND (s.thread IS NULL OR s.thread=e.thread)`).bind(now,now+DELIVERY_MS,event.eventId,env.OWNER_USER_ID,now));
  }
  await env.DB.batch(statements);
  return event?.eventId ?? null;
}
export async function cleanup(env: Env, now: number) {
  await env.DB.batch([
    env.DB.prepare('UPDATE subscriptions SET active=0,secret=NULL WHERE expires_at<=?').bind(now),
    env.DB.prepare("DELETE FROM deliveries WHERE state IN ('delivered','terminal','cancelled') AND deadline<?").bind(now-7*86400000),
    env.DB.prepare('DELETE FROM receipts WHERE accepted_at<?').bind(now-7*86400000),
    env.DB.prepare('DELETE FROM events WHERE accepted_at<? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id=events.id)').bind(now-7*86400000),
    env.DB.prepare("DELETE FROM writes WHERE state='completed' AND created_at<?").bind(now-7*86400000),
    env.DB.prepare("DELETE FROM delivery_notices WHERE state NOT IN ('in_flight','ambiguous') AND created_at<?").bind(now-7*86400000),
  ]);
}
