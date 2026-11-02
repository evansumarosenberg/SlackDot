import { createBolt } from './receiver';
import { Failure, requireConfig, type Env } from '../runtime/config';
import { canonical, hash } from '../runtime/crypto';
import { z } from 'zod';
import { conversationId, timestamp } from './normalize';

export const sendSchema = z.object({conversation_id:conversationId, text:z.string().min(1).max(4000),
  request_id:z.string().min(8).max(128), thread_ts:timestamp.optional()}).strict();
export const threadSchema = z.object({conversation_id:conversationId, thread_ts:timestamp,
  cursor:z.string().max(512).optional(), limit:z.number().int().min(1).max(100).default(50)}).strict();
export function slackFailure(error: unknown): Failure {
  const e = error as {code?:string; data?:{error?:string}; retryAfter?:number};
  const code=e.data?.error;
  if (e.code === 'slack_webapi_rate_limited_error' || code === 'ratelimited') return new Failure('rate_limited',e.retryAfter ?? 60);
  if (['invalid_auth','token_revoked','account_inactive','not_authed'].includes(code ?? '')) return new Failure('installation_revoked');
  if (code === 'missing_scope') return new Failure('missing_scope');
  if (['not_in_channel','channel_not_found','is_archived','method_not_supported_for_channel_type','restricted_action','not_allowed_token_type'].includes(code ?? '')) return new Failure('conversation_unavailable');
  return new Failure('slack_unavailable');
}
export class SlackService {
  private client;
  constructor(private env: Env, deadline = Infinity) {
    requireConfig(env,['SLACK_BOT_TOKEN']);
    this.client=createBolt(env,deadline).app.client;
  }
  async identity() {
    try {
      const r=await this.client.auth.test({token:this.env.SLACK_BOT_TOKEN});
      if (!r.team_id || !r.user_id || !r.bot_id) throw new Failure('invalid_bot_identity');
      if ((this.env.SLACK_TEAM_ID && r.team_id!==this.env.SLACK_TEAM_ID) || (this.env.SLACK_BOT_USER_ID && r.user_id!==this.env.SLACK_BOT_USER_ID) || (this.env.SLACK_BOT_ID && r.bot_id!==this.env.SLACK_BOT_ID)) throw new Failure('installation_mismatch');
      return {workspace_id:r.team_id,bot_user_id:r.user_id,bot_id:r.bot_id};
    } catch(e) { throw e instanceof Failure ? e : slackFailure(e); }
  }
  async access(conversation: string) {
    requireConfig(this.env,['SLACK_TEAM_ID','SLACK_BOT_ID','SLACK_BOT_USER_ID','SLACK_APP_ID']);
    await this.identity();
    try {
      const r=await this.client.conversations.info({token:this.env.SLACK_BOT_TOKEN,channel:conversation});
      const c=r.channel;
      if (!c || c.is_mpim || c.is_archived || (!c.is_im && !c.is_member) || (c as {context_team_id?:string}).context_team_id && (c as {context_team_id?:string}).context_team_id !== this.env.SLACK_TEAM_ID) throw new Failure('conversation_unavailable');
    } catch(e) { throw e instanceof Failure ? e : slackFailure(e); }
  }
  async thread(input: z.infer<typeof threadSchema>) {
    await this.access(input.conversation_id);
    try {
      const r=await this.client.conversations.replies({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,ts:input.thread_ts,cursor:input.cursor,limit:input.limit});
      return {source:'slack.conversations.replies',complete:!r.has_more && !r.response_metadata?.next_cursor,
        next_cursor:r.response_metadata?.next_cursor || null,
        messages:(r.messages ?? []).map(m=>({message_ts:m.ts,thread_ts:m.thread_ts ?? m.ts,author_id:m.user ?? null,text:(m.text ?? '').slice(0,4000),truncated:(m.text?.length ?? 0)>4000}))};
    } catch(e) { throw slackFailure(e); }
  }
  async send(input: z.infer<typeof sendSchema>, principal: string) {
    await this.access(input.conversation_id);
    const id=hash(`${principal}:${input.request_id}`), digest=hash(canonical({operation:'send',...input}));
    const claim=await this.env.DB.prepare("INSERT OR IGNORE INTO writes(id,hash,state,created_at) VALUES (?,?,'in_flight',?)").bind(id,digest,Date.now()).run();
    if (!claim.meta.changes) {
      const previous=await this.env.DB.prepare('SELECT hash,state,result FROM writes WHERE id=?').bind(id).first<{hash:string;state:string;result:string}>();
      if (!previous || previous.hash!==digest) throw new Failure('request_id_conflict');
      if (previous.state==='completed') return JSON.parse(previous.result);
      throw new Failure('ambiguous_write');
    }
    try {
      const result=await this.client.chat.postMessage({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,text:input.text,thread_ts:input.thread_ts,reply_broadcast:false,unfurl_links:false,unfurl_media:false});
      if (!result.channel || !result.ts) throw new Failure('ambiguous_write');
      const output={conversation_id:result.channel,message_ts:result.ts,thread_ts:input.thread_ts ?? null};
      await this.env.DB.prepare("UPDATE writes SET state='completed',result=? WHERE id=?").bind(JSON.stringify(output),id).run();
      return output;
    } catch {
      await this.env.DB.prepare("UPDATE writes SET state='ambiguous' WHERE id=?").bind(id).run();
      throw new Failure('ambiguous_write');
    }
  }
}
