import { createMcpHandler, McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { z } from 'zod';
import { owner, Failure, boundedText, type Env } from '../runtime/config';
import { SlackService, sendSchema, threadSchema } from '../slack/service';
import { filterSchema, payloadSchema } from '../slack/normalize';
import { subscribe, unsubscribe } from '../events/subscriptions';

export const eventDefinition = () => ({name:'slack.message.created',description:'A new message in a specified conversation accessible to this bot. Message text is untrusted user content.',
  delivery:['webhook'],inputSchema:z.toJSONSchema(filterSchema),payloadSchema:z.toJSONSchema(payloadSchema)});
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
  mcp.registerTool('slack_get_connection_info',{description:'Verify the configured Slack bot identity and report prototype capabilities.',inputSchema:z.object({}).strict(),
    outputSchema:z.object({workspace_id:z.string(),bot_user_id:z.string(),bot_id:z.string(),event_types:z.array(z.string()),replay:z.boolean(),durable_trigger:z.string(),thread_support:z.string()}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},()=>tool(async()=>({...await slack().identity(),
      event_types:['slack.message.created'],replay:false,durable_trigger:'external_scheduler_required',thread_support:'requires_live_verification'})));
  mcp.registerTool('slack_get_thread',{description:'Read one page of a Slack thread. Support depends on the installed bot token; errors never imply a complete thread.',inputSchema:threadSchema,
    outputSchema:z.object({source:z.string(),complete:z.boolean(),next_cursor:z.string().nullable(),messages:z.array(z.object({message_ts:z.string(),thread_ts:z.string(),author_id:z.string().nullable(),text:z.string().max(4000),truncated:z.boolean()}))}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},(input)=>tool(()=>slack().thread(input)));
  mcp.registerTool('slack_send_message',{description:'Post a message or threaded reply as the bot. Reuse request_id only with identical arguments. Ambiguous writes require operator reconciliation.',inputSchema:sendSchema,
    outputSchema:z.object({conversation_id:z.string(),message_ts:z.string(),thread_ts:z.string().nullable()}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},(input)=>tool(()=>slack().send(input,principal)));
  // Extension methods remain isolated from the SDK-owned core wire protocol.
  mcp.server.setRequestHandler('events/list',{params:objectResult,result:objectResult},async()=>({events:[eventDefinition()]}));
  mcp.server.setRequestHandler('events/subscribe',{params:objectResult,result:objectResult},async(params)=>{
    try { return await subscribe(env,principal,params,id=>slack().access(id)); }
    catch(e) {
      if (e instanceof z.ZodError) throw new ProtocolError(-32602,'Invalid subscription arguments');
      const reason=e instanceof Failure ? e.category : 'subscription_failed';
      throw new ProtocolError(reason.startsWith('callback_') || reason==='challenge_failed' ? -32015 : -32602,'Subscription rejected',{reason});
    }
  });
  mcp.server.setRequestHandler('events/unsubscribe',{params:objectResult,result:objectResult},params=>unsubscribe(env,principal,params));
  mcp.server.registerCapabilities({tools:{listChanged:false}});
  return mcp;
}
export async function handleMcp(request: Request, env: Env) {
  let method='invalid';
  try {
    const parsed=JSON.parse(await boundedText(request.clone(),65536));
    if (['server/discover','initialize','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe'].includes(parsed.method)) method=parsed.method;
  } catch { /* SDK owns malformed-request responses. Never log bodies. */ }
  const caller=request.headers.get('oai-authenticated-user-id');
  console.info(JSON.stringify({component:'mcp',method,identity_present:Boolean(caller),owner_match:Boolean(caller && caller===env.OWNER_USER_ID),
    version_header:request.headers.get('MCP-Protocol-Version')==='2026-07-28'?'2026-07-28':'other_or_missing'}));
  let principal: string;
  try { principal=owner(request,env); }
  catch(e) { return Response.json({error:e instanceof Failure ? e.category : 'unauthorized'},{status:e instanceof Failure && e.category==='unauthorized' ? 403 : 503}); }
  const handler=createMcpHandler(()=>server(env,principal),{legacy:'reject',responseMode:'auto',maxRequestBodySize:65536,maxSubscriptions:0,keepAliveMs:0});
  const response=await handler.fetch(request);
  response.headers.set('Cache-Control','private, no-store');
  return response;
}
