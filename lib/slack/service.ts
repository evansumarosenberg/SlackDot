import { createBolt } from './receiver';
import { Failure, requireConfig, type Env } from '../runtime/config';
import { z } from 'zod';
import { conversationId, timestamp } from './normalize';

const userId=z.string().regex(/^[UW][A-Z0-9]{2,}$/).max(32);
const page={cursor:z.string().max(512).optional(),limit:z.number().int().min(1).max(100).default(50)};
const messageText=z.string().min(1).max(4000);
export const conversationSchema=z.object({conversation_id:conversationId}).strict();
export const listConversationsSchema=z.object({...page,types:z.array(z.enum(['public_channel','private_channel','im'])).min(1).max(3).default(['public_channel','private_channel','im'])}).strict();
export const listUsersSchema=z.object({...page,name_filter:z.string().trim().min(1).max(200).optional()}).strict();
export const userSchema=z.object({user_id:userId}).strict();
export const sendSchema=z.object({conversation_id:conversationId,text:messageText,request_id:z.string().min(8).max(128).optional(),thread_ts:timestamp.optional()}).strict();
export const threadSchema=z.object({conversation_id:conversationId,thread_ts:timestamp,...page}).strict();
export const historySchema=z.object({conversation_id:conversationId,...page,oldest:timestamp.optional(),latest:timestamp.optional(),inclusive:z.boolean().default(false)}).strict().refine(input=>!input.oldest || !input.latest || compareTimestamp(input.oldest,input.latest)<=0,{message:'oldest must not exceed latest',path:['oldest']});
export const messageTargetSchema=z.object({conversation_id:conversationId,message_ts:timestamp}).strict();
export const updateSchema=messageTargetSchema.extend({text:messageText}).strict();
export const reactionSchema=messageTargetSchema.extend({emoji_name:z.string().min(1).max(100).regex(/^[a-zA-Z0-9_+\-]+(?:::skin-tone-[2-6])?$/)}).strict();
const assistantThreadSchema=z.object({conversation_id:conversationId,thread_ts:timestamp}).strict();
export const assistantStatusSchema=assistantThreadSchema.extend({
  status:z.string().max(4000).describe('Status suffix after the app name; an empty string clears it.'),
  loading_messages:z.array(messageText).min(1).max(10).optional(),
  icon_emoji:z.string().min(1).max(100).optional(),
  icon_url:z.url({protocol:/^https?$/}).max(2048).optional(),
  username:z.string().min(1).max(256).optional(),
}).strict();
export const assistantTitleSchema=assistantThreadSchema.extend({title:messageText}).strict();
export const assistantPromptsSchema=z.object({
  conversation_id:conversationId,
  thread_ts:timestamp.optional().describe('For legacy assistant_view only. Omit for agent_view apps.'),
  title:z.string().max(4000).optional(),
  prompts:z.array(z.object({title:messageText,message:messageText}).strict()).max(4),
}).strict();
export const assistantResultSchema=z.object({conversation_id:conversationId,thread_ts:timestamp.nullable(),ok:z.literal(true)}).strict();
export const messageResultSchema=z.object({message_ts:timestamp,thread_ts:timestamp,author_id:z.string().nullable(),text:z.string().max(4000),truncated:z.boolean()}).strict();
export const messagePageSchema=z.object({source:z.string(),complete:z.boolean(),next_cursor:z.string().nullable(),messages:z.array(messageResultSchema).max(100)}).strict();
export const conversationResultSchema=z.object({conversation_id:conversationId,type:z.enum(['public_channel','private_channel','im']),name:z.string().max(256).nullable(),user_id:z.string().nullable(),topic:z.string().max(1000),purpose:z.string().max(1000),truncated:z.boolean()}).strict();
export const userResultSchema=z.object({user_id:userId,name:z.string().max(256),real_name:z.string().max(256),display_name:z.string().max(256),title:z.string().max(256),is_bot:z.boolean(),deleted:z.boolean(),truncated:z.boolean()}).strict();
export const targetResultSchema=messageTargetSchema;
export const reactionResultSchema=reactionSchema.extend({state:z.enum(['present','absent']),changed:z.boolean()}).strict();
export const reactionsResultSchema=messageTargetSchema.extend({reactions:z.array(z.object({emoji_name:z.string().max(100),count:z.number().int().nonnegative(),user_ids:z.array(z.string()).max(100),users_complete:z.boolean(),bot_reacted:z.boolean()}).strict()).max(100),complete:z.boolean()}).strict();
function compareTimestamp(a:string,b:string) {
  const [as,af]=a.split('.'),[bs,bf]=b.split('.');
  return BigInt(as)<BigInt(bs)?-1:BigInt(as)>BigInt(bs)?1:af.localeCompare(bf);
}
interface Channel {id?:string;is_im?:boolean;is_mpim?:boolean;is_archived?:boolean;is_member?:boolean;is_private?:boolean;is_group?:boolean;context_team_id?:string;name?:string;user?:string;topic?:{value?:string};purpose?:{value?:string}}
interface Profile {id?:string;name?:string;real_name?:string;is_bot?:boolean;deleted?:boolean;profile?:{real_name?:string;display_name?:string;title?:string}}
interface Message {ts?:string;thread_ts?:string;user?:string;text?:string;bot_id?:string;app_id?:string}
function errorInfo(error:unknown) {return error && typeof error==='object' ? error as {code?:string;data?:{error?:string};retryAfter?:number}:{};}
export function slackFailure(error:unknown):Failure {
  if(error instanceof Failure) return error;
  const e=errorInfo(error),code=e.data?.error;
  if(e.code==='slack_webapi_rate_limited_error' || code==='ratelimited') return new Failure('rate_limited',e.retryAfter??60);
  if(['invalid_auth','token_revoked','account_inactive','not_authed'].includes(code??'')) return new Failure('installation_revoked');
  if(code==='missing_scope') return new Failure('missing_scope');
  if(code==='not_in_channel') return new Failure('not_in_conversation');
  if(['channel_not_found','message_not_found','thread_not_found','user_not_found','item_not_found'].includes(code??'')) return new Failure('not_found');
  if(['is_archived','method_not_supported_for_channel_type','restricted_action','not_allowed_token_type','user_not_visible','user_disabled','cannot_dm_bot','access_denied','no_permission'].includes(code??'')) return new Failure('conversation_unavailable');
  if(['cant_update_message','cant_delete_message','edit_window_closed'].includes(code??'')) return new Failure('message_not_editable');
  if(code==='invalid_cursor') return new Failure('invalid_cursor');
  if(code==='invalid_name') return new Failure('invalid_emoji');
  if(['msg_too_long','no_text','invalid_blocks','invalid_arguments','invalid_arg_name','invalid_metadata','invalid_thread_ts','bad_timestamp'].includes(code??'')) return new Failure('invalid_message');
  return new Failure('slack_unavailable');
}
function writeFailure(error:unknown):Failure {
  const failure=slackFailure(error);
  return failure.category==='slack_unavailable' || failure.category==='invalid_slack_response' ? new Failure('ambiguous_write'):failure;
}
function messageResult(m:Message) {
  if(!timestamp.safeParse(m.ts).success || !timestamp.safeParse(m.thread_ts??m.ts).success) throw new Failure('invalid_slack_response');
  return {message_ts:m.ts!,thread_ts:m.thread_ts??m.ts!,author_id:m.user??null,text:(m.text??'').slice(0,4000),truncated:(m.text?.length??0)>4000};
}
function channelResult(c:Channel) {
  if(!conversationId.safeParse(c.id).success) throw new Failure('invalid_slack_response');
  return {conversation_id:c.id!,type:c.is_im?'im' as const:c.is_private||c.is_group?'private_channel' as const:'public_channel' as const,
    name:c.name?.slice(0,256)??null,user_id:c.user??null,topic:(c.topic?.value??'').slice(0,1000),purpose:(c.purpose?.value??'').slice(0,1000),
    truncated:(c.name?.length??0)>256 || (c.topic?.value?.length??0)>1000 || (c.purpose?.value?.length??0)>1000};
}
function profileResult(u:Profile) {
  if(!userId.safeParse(u.id).success) throw new Failure('invalid_slack_response');
  const fields=[u.name??'',u.profile?.real_name??u.real_name??'',u.profile?.display_name??'',u.profile?.title??''];
  return {user_id:u.id!,name:fields[0].slice(0,256),real_name:fields[1].slice(0,256),display_name:fields[2].slice(0,256),title:fields[3].slice(0,256),is_bot:Boolean(u.is_bot),deleted:Boolean(u.deleted),truncated:fields.some(value=>value.length>256)};
}
export class SlackService {
  private client;
  constructor(private env:Env,deadline=Infinity) {
    requireConfig(env,['SLACK_BOT_TOKEN']);this.client=createBolt(env,deadline).app.client;
  }
  async identity() {
    requireConfig(this.env,['SLACK_TEAM_ID','SLACK_BOT_USER_ID','SLACK_BOT_ID','SLACK_APP_ID']);
    try {
      const r=await this.client.auth.test({token:this.env.SLACK_BOT_TOKEN});
      if(!r.team_id || !r.user_id || !r.bot_id) throw new Failure('invalid_bot_identity');
      if(r.team_id!==this.env.SLACK_TEAM_ID || r.user_id!==this.env.SLACK_BOT_USER_ID || r.bot_id!==this.env.SLACK_BOT_ID) throw new Failure('installation_mismatch');
      return {workspace_id:r.team_id,bot_user_id:r.user_id,bot_id:r.bot_id};
    } catch(e) {throw slackFailure(e);}
  }
  private permitted(c:Channel) {
    return !c.is_mpim && !c.is_archived && (c.is_im || c.is_member) && (!c.context_team_id || c.context_team_id===this.env.SLACK_TEAM_ID);
  }
  private async accessible(conversation:string) {
    await this.identity();
    try {
      const r=await this.client.conversations.info({token:this.env.SLACK_BOT_TOKEN,channel:conversation});
      if(!r.channel || !this.permitted(r.channel)) throw new Failure('conversation_unavailable');
      if(r.channel.id!==conversation) throw new Failure('invalid_slack_response');
      return r.channel;
    } catch(e) {throw slackFailure(e);}
  }
  async access(conversation:string) {await this.accessible(conversation);}
  async conversation(input:z.infer<typeof conversationSchema>) {return channelResult(await this.accessible(input.conversation_id));}
  async conversations(input:z.infer<typeof listConversationsSchema>) {
    await this.identity();
    try {
      const r=await this.client.conversations.list({token:this.env.SLACK_BOT_TOKEN,types:input.types.join(','),exclude_archived:true,cursor:input.cursor,limit:input.limit});
      if(!Array.isArray(r.channels)) throw new Failure('invalid_slack_response');
      const next=r.response_metadata?.next_cursor||null;
      return {conversations:r.channels.filter(c=>this.permitted(c)).map(channelResult),next_cursor:next,complete:!next};
    } catch(e) {throw slackFailure(e);}
  }
  async users(input:z.infer<typeof listUsersSchema>) {
    await this.identity();
    try {
      const r=await this.client.users.list({token:this.env.SLACK_BOT_TOKEN,cursor:input.cursor,limit:input.limit});
      if(!Array.isArray(r.members)) throw new Failure('invalid_slack_response');
      const name=input.name_filter?.toLocaleLowerCase(),next=r.response_metadata?.next_cursor||null;
      const users=r.members.map(profileResult).filter(u=>!name || [u.name,u.real_name,u.display_name].some(value=>value.toLocaleLowerCase().includes(name)));
      return {users,next_cursor:next,complete:!next,filter_scope:'page' as const};
    } catch(e) {throw slackFailure(e);}
  }
  async user(input:z.infer<typeof userSchema>) {
    await this.identity();
    try {
      const r=await this.client.users.info({token:this.env.SLACK_BOT_TOKEN,user:input.user_id});
      if(!r.user || r.user.id!==input.user_id) throw new Failure('invalid_slack_response');
      return profileResult(r.user);
    } catch(e) {throw slackFailure(e);}
  }
  async openDm(input:z.infer<typeof userSchema>) {
    await this.identity();
    if(input.user_id===this.env.SLACK_BOT_USER_ID) throw new Failure('conversation_unavailable');
    try {
      const r=await this.client.conversations.open({token:this.env.SLACK_BOT_TOKEN,users:input.user_id,return_im:true});
      if(!r.channel || !conversationId.safeParse(r.channel.id).success || !r.channel.id!.startsWith('D') || r.channel.is_im!==true || r.channel.user!==input.user_id) throw new Failure('ambiguous_write');
      return {conversation_id:r.channel.id!,user_id:input.user_id};
    } catch(e) {throw writeFailure(e);}
  }
  async history(input:z.infer<typeof historySchema>) {
    await this.access(input.conversation_id);
    try {
      const r=await this.client.conversations.history({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,cursor:input.cursor,limit:input.limit,oldest:input.oldest,latest:input.latest,inclusive:input.inclusive});
      if(!Array.isArray(r.messages)) throw new Failure('invalid_slack_response');
      return {source:'slack.conversations.history',complete:!r.has_more && !r.response_metadata?.next_cursor,next_cursor:r.response_metadata?.next_cursor||null,messages:r.messages.map(messageResult)};
    } catch(e) {throw slackFailure(e);}
  }
  async thread(input:z.infer<typeof threadSchema>) {
    await this.access(input.conversation_id);
    try {
      const r=await this.client.conversations.replies({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,ts:input.thread_ts,cursor:input.cursor,limit:input.limit});
      if(!Array.isArray(r.messages)) throw new Failure('invalid_slack_response');
      return {source:'slack.conversations.replies',complete:!r.has_more && !r.response_metadata?.next_cursor,next_cursor:r.response_metadata?.next_cursor||null,messages:r.messages.map(messageResult)};
    } catch(e) {throw slackFailure(e);}
  }
  async send(input:z.infer<typeof sendSchema>,_principal?:string) {
    await this.access(input.conversation_id);
    try {
      const r=await this.client.chat.postMessage({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,text:input.text,thread_ts:input.thread_ts,reply_broadcast:false,unfurl_links:false,unfurl_media:false});
      if(r.channel!==input.conversation_id || !timestamp.safeParse(r.ts).success) throw new Failure('ambiguous_write');
      return {conversation_id:r.channel,message_ts:r.ts!,thread_ts:input.thread_ts??null};
    } catch(e) {throw writeFailure(e);}
  }
  private async message(input:z.infer<typeof messageTargetSchema>) {
    // reactions.get addresses an exact message, including a reply without its parent timestamp.
    try {
      const r=await this.client.reactions.get({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,timestamp:input.message_ts,full:true});
      if(r.type!=='message' || r.channel!==input.conversation_id || r.message?.ts!==input.message_ts) throw new Failure('invalid_slack_response');
      return r.message;
    } catch(e) {throw slackFailure(e);}
  }
  private async ownMessage(input:z.infer<typeof messageTargetSchema>) {
    await this.access(input.conversation_id);
    const message=await this.message(input);
    const known=message.user===this.env.SLACK_BOT_USER_ID || message.bot_id===this.env.SLACK_BOT_ID;
    if(!known || (message.user && message.user!==this.env.SLACK_BOT_USER_ID) || (message.bot_id && message.bot_id!==this.env.SLACK_BOT_ID) || (message.app_id && message.app_id!==this.env.SLACK_APP_ID)) throw new Failure('message_not_owned');
  }
  async eventThread(conversation:string,messageTs:string):Promise<string|null> {
    await this.access(conversation);
    const message=await this.message({conversation_id:conversation,message_ts:messageTs});
    // Unlike a partial reaction event, this is the exact retrieved Slack message.
    // A non-threaded message has no thread_ts, so its own timestamp is its root.
    const thread=(message as Message).thread_ts ?? message.ts;
    return timestamp.safeParse(thread).success ? thread! : null;
  }
  async update(input:z.infer<typeof updateSchema>) {
    await this.ownMessage(input);
    try {
      const r=await this.client.chat.update({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,ts:input.message_ts,text:input.text});
      if(r.channel!==input.conversation_id || r.ts!==input.message_ts) throw new Failure('ambiguous_write');
      return {conversation_id:r.channel,message_ts:r.ts};
    } catch(e) {throw writeFailure(e);}
  }
  async delete(input:z.infer<typeof messageTargetSchema>) {
    await this.ownMessage(input);
    try {
      const r=await this.client.chat.delete({token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,ts:input.message_ts});
      if(r.channel!==input.conversation_id || r.ts!==input.message_ts) throw new Failure('ambiguous_write');
      return {conversation_id:r.channel,message_ts:r.ts};
    } catch(e) {throw writeFailure(e);}
  }
  async reactions(input:z.infer<typeof messageTargetSchema>) {
    await this.access(input.conversation_id);
    const message=await this.message(input),all=message.reactions===undefined?[]:message.reactions;
    if(!Array.isArray(all)) throw new Failure('invalid_slack_response');
    return {...input,complete:all.length<=100,reactions:all.slice(0,100).map(r=>{
      if(!reactionSchema.shape.emoji_name.safeParse(r.name).success || !Number.isInteger(r.count) || r.count!<0 || !Array.isArray(r.users) || !r.users.every(id=>userId.safeParse(id).success)) throw new Failure('invalid_slack_response');
      const users=r.users,count=r.count!;
      return {emoji_name:r.name!,count,user_ids:users.slice(0,100),users_complete:users.length<=100 && users.length===count,bot_reacted:users.includes(this.env.SLACK_BOT_USER_ID)};
    })};
  }
  async addReaction(input:z.infer<typeof reactionSchema>) {return this.changeReaction(input,true);}
  async removeReaction(input:z.infer<typeof reactionSchema>) {return this.changeReaction(input,false);}
  async setAssistantStatus(input:z.infer<typeof assistantStatusSchema>) {
    await this.access(input.conversation_id);
    const {conversation_id,...args}=input;
    try {
      const r=await this.client.assistant.threads.setStatus({token:this.env.SLACK_BOT_TOKEN,channel_id:conversation_id,...args});
      if(r.ok!==true) throw new Failure('ambiguous_write');
      return {conversation_id,thread_ts:input.thread_ts,ok:true as const};
    } catch(e) {throw writeFailure(e);}
  }
  async setAssistantTitle(input:z.infer<typeof assistantTitleSchema>) {
    await this.access(input.conversation_id);
    const {conversation_id,...args}=input;
    try {
      const r=await this.client.assistant.threads.setTitle({token:this.env.SLACK_BOT_TOKEN,channel_id:conversation_id,...args});
      if(r.ok!==true) throw new Failure('ambiguous_write');
      return {conversation_id,thread_ts:input.thread_ts,ok:true as const};
    } catch(e) {throw writeFailure(e);}
  }
  async setAssistantSuggestedPrompts(input:z.infer<typeof assistantPromptsSchema>) {
    await this.access(input.conversation_id);
    const {conversation_id,...args}=input;
    try {
      const r=await this.client.assistant.threads.setSuggestedPrompts({token:this.env.SLACK_BOT_TOKEN,channel_id:conversation_id,...args});
      if(r.ok!==true) throw new Failure('ambiguous_write');
      return {conversation_id,thread_ts:input.thread_ts??null,ok:true as const};
    } catch(e) {throw writeFailure(e);}
  }
  private async changeReaction(input:z.infer<typeof reactionSchema>,add:boolean) {
    await this.access(input.conversation_id);
    const state=add?'present' as const:'absent' as const;
    try {
      const args={token:this.env.SLACK_BOT_TOKEN,channel:input.conversation_id,timestamp:input.message_ts,name:input.emoji_name};
      const r=add?await this.client.reactions.add(args):await this.client.reactions.remove(args);
      if(!r.ok) throw new Failure('ambiguous_write');
      return {...input,state,changed:true};
    } catch(e) {
      if(errorInfo(e).data?.error===(add?'already_reacted':'no_reaction')) return {...input,state,changed:false};
      throw writeFailure(e);
    }
  }
}
