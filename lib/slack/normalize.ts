import { z } from 'zod';
import { hash } from '../runtime/crypto';
import type { Env } from '../runtime/config';
export const conversationId = z.string().regex(/^[CDG][A-Z0-9]{2,}$/).max(32);
export const timestamp = z.string().regex(/^\d{1,16}\.\d{6}$/);
export const filterSchema = z.object({ conversation_id: conversationId, thread_ts: timestamp.optional() }).strict();
export const payloadSchema = z.object({
  workspace_id: z.string(), conversation_id: conversationId, message_ts: timestamp,
  thread_ts: timestamp, author_id: z.string().nullable(), text: z.string().max(4000),
  truncated: z.boolean(), is_bot: z.boolean(), mentions_bot: z.boolean(),
}).strict();
export type MessagePayload = z.infer<typeof payloadSchema>;
export interface MessageEvent { eventId: string; name: 'slack.message.created'; timestamp: string; data: MessagePayload; cursor: null }
export function normalize(body: Record<string, any>, env: Env): MessageEvent | null {
  const e = body.event;
  if (!e || e.type !== 'message') return null;
  if (e.subtype && !['bot_message', 'file_share', 'thread_broadcast'].includes(e.subtype)) return null;
  if (e.hidden || e.user === env.SLACK_BOT_USER_ID || e.bot_id === env.SLACK_BOT_ID || e.app_id === env.SLACK_APP_ID) return null;
  if (!conversationId.safeParse(e.channel).success || !timestamp.safeParse(e.ts).success) return null;
  const fullText = typeof e.text === 'string' ? e.text : '';
  const occurrence = Number(e.ts.split('.')[0]) * 1000;
  if (!Number.isFinite(occurrence) || Math.abs(occurrence) > 8.64e15) return null;
  const data = payloadSchema.parse({workspace_id:env.SLACK_TEAM_ID, conversation_id:e.channel,
    message_ts:e.ts, thread_ts:e.thread_ts ?? e.ts, author_id:e.user ?? null,
    text:fullText.slice(0,4000), truncated:fullText.length > 4000,
    is_bot:Boolean(e.bot_id), mentions_bot:fullText.includes(`<@${env.SLACK_BOT_USER_ID}>`)});
  return {eventId:`evt_${hash(`${env.SLACK_TEAM_ID}:${e.channel}:${e.ts}`)}`, name:'slack.message.created', timestamp:new Date(occurrence).toISOString(), data, cursor:null};
}
