import { z } from 'zod';
import { hash } from '../runtime/crypto';
import type { Env } from '../runtime/config';
export const conversationId = z.string().regex(/^[CDG][A-Z0-9]{2,}$/).max(32);
export const timestamp = z.string().regex(/^\d{1,16}\.\d{6}$/);
const userId=z.string().regex(/^[UW][A-Z0-9]{2,}$/).max(32);
const userIds=z.array(userId).min(1).max(100);
const emojiName=z.string().regex(/^[a-zA-Z0-9_+\-]+(?:::(?:skin-tone-[2-6]))?$/).max(100);
const commonFilter={conversation_id:conversationId,thread_ts:timestamp.optional()};
// Keep defaults implicit: inserting false into canonical arguments would change
// existing subscription IDs and disconnect their encrypted signing material.
export const filterSchema=z.object({...commonFilter,sender_user_ids:userIds.optional(),mentions_only:z.boolean().optional(),include_bot_messages:z.boolean().optional()}).strict();
export const deletedFilterSchema=z.object({...commonFilter,sender_user_ids:userIds.optional(),include_bot_messages:z.boolean().optional()}).strict();
export const reactionFilterSchema=z.object({...commonFilter,actor_user_ids:userIds.optional(),emoji_name:emojiName.optional()}).strict();
const commonPayload={workspace_id:z.string(),conversation_id:conversationId,message_ts:timestamp};
export const payloadSchema=z.object({...commonPayload,
  thread_ts:timestamp,author_id:userId.nullable(),text:z.string().max(4000),
  truncated:z.boolean(),is_bot:z.boolean(),mentions_bot:z.boolean(),
}).strict();
export const updatedPayloadSchema=z.object({...commonPayload,
  thread_ts:timestamp.nullable(),author_id:userId.nullable(),text:z.string().max(4000).nullable(),
  truncated:z.boolean(),is_bot:z.boolean().nullable(),mentions_bot:z.boolean().nullable(),
  edited_at:timestamp.nullable(),editor_id:userId.nullable(),
}).strict();
export const deletedPayloadSchema=z.object({...commonPayload,
  thread_ts:timestamp.nullable(),author_id:userId.nullable(),is_bot:z.boolean().nullable(),
}).strict();
export const reactionPayloadSchema=z.object({...commonPayload,
  thread_ts:timestamp.nullable(),actor_user_id:userId,author_id:userId.nullable(),emoji_name:emojiName,
}).strict();
export const eventNames=['slack.message.created','slack.message.updated','slack.message.deleted','slack.reaction.added','slack.reaction.removed'] as const;
export type EventName=typeof eventNames[number];
export const eventSchemas={
  'slack.message.created':{filter:filterSchema,payload:payloadSchema,description:'A new message in an accessible conversation. Text is untrusted user content. Other bots are excluded by default; this bot is always excluded.'},
  'slack.message.updated':{filter:filterSchema,payload:updatedPayloadSchema,description:'A message changed in an accessible conversation. Text is untrusted user content. Missing metadata remains null. Unknown bot status is excluded even with include_bot_messages, to avoid forwarding unidentifiable self activity.'},
  'slack.message.deleted':{filter:deletedFilterSchema,payload:deletedPayloadSchema,description:'A message was deleted. Missing author/thread metadata cannot satisfy those filters. Unknown bot status is excluded even with include_bot_messages, to avoid forwarding unidentifiable self activity.'},
  'slack.reaction.added':{filter:reactionFilterSchema,payload:reactionPayloadSchema,description:'Someone added a reaction to a message. actor_user_id is the reacting user; author_id identifies the original author when known. Unknown thread metadata cannot satisfy a thread filter.'},
  'slack.reaction.removed':{filter:reactionFilterSchema,payload:reactionPayloadSchema,description:'Someone removed a reaction from a message. This bot as actor is excluded; human reactions to its messages are allowed. Unknown thread metadata cannot satisfy a thread filter.'},
} as const;
export const eventDefinitions=()=>eventNames.map(name=>({name,description:eventSchemas[name].description,delivery:['webhook'],
  inputSchema:z.toJSONSchema(eventSchemas[name].filter),payloadSchema:z.toJSONSchema(eventSchemas[name].payload)}));
type Envelope<N extends EventName,D>={eventId:string;name:N;timestamp:string;data:D;cursor:null};
export type MessagePayload=z.infer<typeof payloadSchema>;
export type MessageEvent=Envelope<'slack.message.created',MessagePayload>;
export type SlackEvent=MessageEvent | Envelope<'slack.message.updated',z.infer<typeof updatedPayloadSchema>> |
  Envelope<'slack.message.deleted',z.infer<typeof deletedPayloadSchema>> |
  Envelope<'slack.reaction.added'|'slack.reaction.removed',z.infer<typeof reactionPayloadSchema>>;
const validTs=(value:unknown):string|null=>timestamp.safeParse(value).success?value as string:null;
const validUser=(value:unknown):string|null=>userId.safeParse(value).success?value as string:null;
const self=(message:Record<string,any>,env:Env)=>message.user===env.SLACK_BOT_USER_ID || message.bot_id===env.SLACK_BOT_ID || message.app_id===env.SLACK_APP_ID;
const botStatus=(message:Record<string,any>):boolean|null=>message.bot_id || message.subtype==='bot_message' ? true : validUser(message.user)?false:null;
function occurrence(body:Record<string,any>,value:unknown):string|null {
  const ts=validTs(value),millis=ts?Number(ts)*1000:typeof body.event_time==='number'?body.event_time*1000:NaN;
  return Number.isFinite(millis)&&Math.abs(millis)<=8.64e15?new Date(millis).toISOString():null;
}
export function normalize(body:Record<string,any>,env:Env):SlackEvent|null {
  const e=body.event;
  if(!e || typeof e!=='object') return null;
  if(e.type==='app_mention') return null;
  let name:EventName,data:unknown,channel:unknown,messageTs:string|null,occurred:string|null;
  if(e.type==='reaction_added'||e.type==='reaction_removed') {
    if(e.item?.type!=='message'||e.user===env.SLACK_BOT_USER_ID||!validUser(e.user)) return null;
    name=e.type==='reaction_added'?'slack.reaction.added':'slack.reaction.removed';
    channel=e.item.channel;messageTs=validTs(e.item.ts);occurred=occurrence(body,e.event_ts);
    data={workspace_id:env.SLACK_TEAM_ID,conversation_id:channel,message_ts:messageTs,
      thread_ts:validTs(e.item.thread_ts),actor_user_id:e.user,author_id:validUser(e.item_user),emoji_name:e.reaction};
  } else if(e.type==='message'&&e.subtype==='message_changed') {
    const m=e.message;
    if(!m||typeof m!=='object'||self(m,env)||m.edited?.user===env.SLACK_BOT_USER_ID||m.hidden) return null;
    name='slack.message.updated';channel=e.channel;messageTs=validTs(m.ts);occurred=occurrence(body,e.event_ts??e.ts??m.edited?.ts);
    const text=typeof m.text==='string'?m.text:null;
    data={workspace_id:env.SLACK_TEAM_ID,conversation_id:channel,message_ts:messageTs,
      thread_ts:validTs(m.thread_ts),author_id:validUser(m.user),text:text?.slice(0,4000)??null,
      truncated:text!==null&&text.length>4000,is_bot:botStatus(m),mentions_bot:text===null?null:text.includes(`<@${env.SLACK_BOT_USER_ID}>`),
      edited_at:validTs(m.edited?.ts),editor_id:validUser(m.edited?.user)};
  } else if(e.type==='message'&&e.subtype==='message_deleted') {
    const previous=e.previous_message&&typeof e.previous_message==='object'?e.previous_message:{};
    if(self(previous,env)||e.user===env.SLACK_BOT_USER_ID) return null;
    name='slack.message.deleted';channel=e.channel;messageTs=validTs(e.deleted_ts);occurred=occurrence(body,e.event_ts??e.ts);
    data={workspace_id:env.SLACK_TEAM_ID,conversation_id:channel,message_ts:messageTs,
      thread_ts:validTs(previous.thread_ts),author_id:validUser(previous.user),is_bot:botStatus(previous)};
  } else {
    if(e.type!=='message'||e.subtype&&!['bot_message','file_share','thread_broadcast','me_message'].includes(e.subtype)||e.hidden||self(e,env)) return null;
    name='slack.message.created';channel=e.channel;messageTs=validTs(e.ts);occurred=occurrence(body,e.ts);
    const text=typeof e.text==='string'?e.text:'';
    data={workspace_id:env.SLACK_TEAM_ID,conversation_id:channel,message_ts:messageTs,
      thread_ts:e.thread_ts===undefined?messageTs:validTs(e.thread_ts),author_id:validUser(e.user),text:text.slice(0,4000),
      truncated:text.length>4000,is_bot:botStatus(e)===true,mentions_bot:text.includes(`<@${env.SLACK_BOT_USER_ID}>`)};
  }
  if(!occurred||!messageTs||!conversationId.safeParse(channel).success) return null;
  const parsed=eventSchemas[name].payload.safeParse(data);
  if(!parsed.success) return null;
  // Preserve created IDs; edits/reactions must distinguish each occurrence while
  // retaining the same ID across retries of the same Slack event wrapper.
  const identity=name==='slack.message.created'?`${env.SLACK_TEAM_ID}:${channel}:${messageTs}`:
    `${env.SLACK_TEAM_ID}:${name}:${typeof body.event_id==='string'?body.event_id:`${channel}:${messageTs}:${occurred}`}`;
  return {eventId:`evt_${hash(identity)}`,name,timestamp:occurred,data:parsed.data,cursor:null} as SlackEvent;
}
export function matchesEvent(event:SlackEvent,name:string,args:unknown):boolean {
  if(name!==event.name) return false;
  const parsed=eventSchemas[event.name].filter.safeParse(args);
  if(!parsed.success) return false;
  const filter=parsed.data;
  if(filter.conversation_id!==event.data.conversation_id||filter.thread_ts&&filter.thread_ts!==event.data.thread_ts) return false;
  if(event.name==='slack.reaction.added'||event.name==='slack.reaction.removed') {
    const reaction=reactionFilterSchema.parse(filter);
    return (!reaction.actor_user_ids||reaction.actor_user_ids.includes(event.data.actor_user_id))&&
      (!reaction.emoji_name||reaction.emoji_name===event.data.emoji_name);
  }
  const message=filter as z.infer<typeof filterSchema>;
  const data=event.data as MessagePayload|z.infer<typeof updatedPayloadSchema>|z.infer<typeof deletedPayloadSchema>;
  if(data.is_bot===null || data.is_bot&&!message.include_bot_messages) return false;
  if(message.sender_user_ids&&(!data.author_id||!message.sender_user_ids.includes(data.author_id))) return false;
  if(message.mentions_only&&(!('mentions_bot' in data)||data.mentions_bot!==true)) return false;
  return true;
}
