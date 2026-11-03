import { createMcpHandler, McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { z } from 'zod';
import { owner, Failure, type Env } from '../runtime/config';
import { SlackService, sendSchema, threadSchema, conversationSchema, listConversationsSchema, listUsersSchema, userSchema,
  historySchema, messageTargetSchema, updateSchema, reactionSchema, messagePageSchema, conversationResultSchema,
  userResultSchema, targetResultSchema, reactionResultSchema, reactionsResultSchema } from '../slack/service';
import { eventDefinitions, eventNames } from '../slack/normalize';
import { subscribe, unsubscribe } from '../events/subscriptions';
import { setSessionStatus } from '../slack/session-status';

const objectResult=z.record(z.string(),z.unknown());
async function tool(operation:()=>Promise<Record<string,unknown>>) {
  try { const output=await operation(); return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output}; }
  catch(e) { const error=e instanceof Failure ? e.category : 'operation_failed';
    return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error,retry_after:e instanceof Failure ? e.retryAfter : undefined})}]}; }
}
export function server(env: Env, principal: string) {
  const capabilities={tools:{},events:{}};
  const mcp=new McpServer({name:'SlackDot',version:'0.1.0'}, {
    capabilities,jsonSchemaValidator:new CfWorkerJsonSchemaValidator(),
  });
  const slack=()=>new SlackService(env);
  mcp.registerTool('slack_get_connection_info',{description:'Verify the configured Slack bot identity and report enabled capabilities.',inputSchema:z.object({}).strict(),
    outputSchema:z.object({workspace_id:z.string(),bot_user_id:z.string(),bot_id:z.string(),event_types:z.array(z.string()),replay:z.boolean(),durable_trigger:z.string(),thread_support:z.string()}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},()=>tool(async()=>({...await slack().identity(),
      event_types:[...eventNames],replay:false,durable_trigger:'request_wait_until_bounded',thread_support:'verified_public_private_dm'})));
  mcp.registerTool('slack_get_thread',{description:'Read one page of a Slack thread. Support depends on the installed bot token; errors never imply a complete thread.',inputSchema:threadSchema,
    outputSchema:messagePageSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},(input)=>tool(()=>slack().thread(input)));
  mcp.registerTool('slack_send_message',{description:'Post once as the bot. A confirmed threaded reply also attempts to mark that Slack agent session active; status failure does not fail the send. Repeated calls can create duplicates; request_id is accepted for compatibility only and is not stored. On ambiguous_write, inspect Slack before deciding whether to resend.',inputSchema:sendSchema,
    outputSchema:z.object({conversation_id:z.string(),message_ts:z.string(),thread_ts:z.string().nullable()}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},(input)=>tool(async()=>{
      const result=await slack().send(input,principal);
      if(input.thread_ts) await setSessionStatus(env,input.conversation_id,input.thread_ts,'active');
      return result;
    }));
  mcp.registerTool('slack_list_conversations',{description:'Read one page of joined public/private channels and bot one-to-one DMs. Filtering can leave an empty page with a continuation cursor; follow that cursor to continue.',inputSchema:listConversationsSchema,
    outputSchema:z.object({conversations:z.array(conversationResultSchema).max(100),next_cursor:z.string().nullable(),complete:z.boolean()}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},input=>tool(()=>slack().conversations(input)));
  mcp.registerTool('slack_get_conversation',{description:'Read metadata for one joined channel or bot one-to-one DM; group DMs and unavailable conversations are rejected.',inputSchema:conversationSchema,outputSchema:conversationResultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},input=>tool(()=>slack().conversation(input)));
  mcp.registerTool('slack_list_users',{description:'Read one page of available user profiles without email addresses. Optional name_filter matches names within this page only; continue using next_cursor even when no users match.',inputSchema:listUsersSchema,
    outputSchema:z.object({users:z.array(userResultSchema).max(100),next_cursor:z.string().nullable(),complete:z.boolean(),filter_scope:z.literal('page')}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},input=>tool(()=>slack().users(input)));
  mcp.registerTool('slack_get_user',{description:'Read available profile names and title for one Slack user ID. Does not expose email or cache profiles.',inputSchema:userSchema,outputSchema:userResultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},input=>tool(()=>slack().user(input)));
  mcp.registerTool('slack_open_dm',{description:'Open or retrieve a one-to-one DM with the specified user as the bot. Sends no greeting. An ambiguous response does not establish failure.',inputSchema:userSchema,
    outputSchema:z.object({conversation_id:conversationSchema.shape.conversation_id,user_id:userSchema.shape.user_id}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},input=>tool(()=>slack().openDm(input)));
  mcp.registerTool('slack_get_messages',{description:'Read one page of conversation history. Timestamps remain strings; bounds are exclusive unless inclusive is true. Follow next_cursor or timestamp bounds when complete is false. Use slack_get_thread for replies.',inputSchema:historySchema,outputSchema:messagePageSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},input=>tool(()=>slack().history(input)));
  mcp.registerTool('slack_update_message',{description:'Replace the text of an exact bot-authored message, including a thread reply. Checks authorship from Slack before one update call. On ambiguous_write, inspect Slack before deciding whether to resend.',inputSchema:updateSchema,outputSchema:targetResultSchema,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},input=>tool(()=>slack().update(input)));
  mcp.registerTool('slack_delete_message',{description:'Delete an exact bot-authored message, including a thread reply. Checks authorship from Slack before one delete call. Cannot delete a message authored by another user. On ambiguous_write, inspect Slack before deciding whether to repeat.',inputSchema:messageTargetSchema,outputSchema:targetResultSchema,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},input=>tool(()=>slack().delete(input)));
  mcp.registerTool('slack_get_reactions',{description:'Read reactions on an exact message. Counts can exceed returned user lists; users_complete and complete report bounded/partial results. bot_reacted refers to this bot, not the message author.',inputSchema:messageTargetSchema,outputSchema:reactionsResultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},input=>tool(()=>slack().reactions(input)));
  mcp.registerTool('slack_add_reaction',{description:'Add the reaction of this bot once. Use emoji_name without surrounding colons. Already-present returns changed:false. Uncertain writes are not retried.',inputSchema:reactionSchema,outputSchema:reactionResultSchema,
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},input=>tool(()=>slack().addReaction(input)));
  mcp.registerTool('slack_remove_reaction',{description:'Remove only the reaction of this bot once. Already-absent returns changed:false; reactions from other users remain. Uncertain writes are not retried.',inputSchema:reactionSchema,outputSchema:reactionResultSchema,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},input=>tool(()=>slack().removeReaction(input)));
  // Extension methods remain isolated from the SDK-owned core wire protocol.
  mcp.server.setRequestHandler('events/list',{params:objectResult,result:objectResult},async()=>({events:eventDefinitions()}));
  mcp.server.setRequestHandler('events/subscribe',{params:objectResult,result:objectResult},async(params)=>{
    try { return await subscribe(env,principal,params,id=>slack().access(id)); }
    catch(e) {
      if (e instanceof z.ZodError) {
        throw new ProtocolError(-32602,'Invalid subscription arguments',{reason:'invalid_subscription_arguments'});
      }
      const reason=e instanceof Failure ? e.category : 'subscription_failed';
      throw new ProtocolError(reason.startsWith('callback_') || reason==='challenge_failed' ? -32015 : -32602,'Subscription rejected',{reason});
    }
  });
  mcp.server.setRequestHandler('events/unsubscribe',{params:objectResult,result:objectResult},async(params)=>{
    try { return await unsubscribe(env,principal,params); }
    catch(e) {
      if(e instanceof z.ZodError) {
        throw new ProtocolError(-32602,'Invalid unsubscribe arguments',{reason:'invalid_unsubscribe_arguments'});
      }
      throw new ProtocolError(-32603,'Unsubscribe failed');
    }
  });
  mcp.server.registerCapabilities({tools:{listChanged:false}});
  return mcp;
}
export async function handleMcp(request: Request, env: Env) {
  let principal: string;
  try { principal=owner(request,env); }
  catch(e) { return Response.json({error:e instanceof Failure ? e.category : 'unauthorized'},{status:e instanceof Failure && e.category==='unauthorized' ? 403 : 503}); }
  const handler=createMcpHandler(()=>server(env,principal),{legacy:'reject',responseMode:'auto',maxRequestBodySize:65536,maxSubscriptions:0,keepAliveMs:0});
  const response=await handler.fetch(request);
  response.headers.set('Cache-Control','private, no-store');
  return response;
}
