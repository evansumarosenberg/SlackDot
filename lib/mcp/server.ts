import { createMcpHandler, McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { z } from 'zod';
import { owner, Failure, boundedText, type Env } from '../runtime/config';
import { SlackService, sendSchema, threadSchema } from '../slack/service';
import { filterSchema, payloadSchema } from '../slack/normalize';
import { subscribe, unsubscribe } from '../events/subscriptions';
import { eventRequestSummary, eventResponseSummary, schemaIssues } from './diagnostics';

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
      if (e instanceof z.ZodError) {
        console.info(JSON.stringify({component:'mcp_event_validation',method:'events/subscribe',issues:schemaIssues(e)}));
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
        console.info(JSON.stringify({component:'mcp_event_validation',method:'events/unsubscribe',issues:schemaIssues(e)}));
        throw new ProtocolError(-32602,'Invalid unsubscribe arguments',{reason:'invalid_unsubscribe_arguments'});
      }
      throw new ProtocolError(-32603,'Unsubscribe failed');
    }
  });
  mcp.server.registerCapabilities({tools:{listChanged:false}});
  return mcp;
}
export async function handleMcp(request: Request, env: Env) {
  let method='invalid';
  let eventRequest:ReturnType<typeof eventRequestSummary>|undefined;
  let requestMeta={version_match:false,client_info_present:false,client_capabilities_present:false};
  try {
    const parsed=JSON.parse(await boundedText(request.clone(),65536));
    if (['server/discover','initialize','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe'].includes(parsed.method)) method=parsed.method;
    if(['events/subscribe','events/unsubscribe'].includes(method)) eventRequest=eventRequestSummary(parsed.params);
    const meta=parsed.params?._meta;
    requestMeta={version_match:meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28',
      client_info_present:Boolean(meta?.['io.modelcontextprotocol/clientInfo']),
      client_capabilities_present:Boolean(meta?.['io.modelcontextprotocol/clientCapabilities'])};
  } catch { /* SDK owns malformed-request responses. Never log bodies. */ }
  const caller=request.headers.get('oai-authenticated-user-id');
  console.info(JSON.stringify({component:'mcp',method,identity_present:Boolean(caller),owner_match:Boolean(caller && caller===env.OWNER_USER_ID),
    version_header:request.headers.get('MCP-Protocol-Version')==='2026-07-28'?'2026-07-28':'other_or_missing'}));
  let principal: string;
  try { principal=owner(request,env); }
  catch(e) { return Response.json({error:e instanceof Failure ? e.category : 'unauthorized'},{status:e instanceof Failure && e.category==='unauthorized' ? 403 : 503}); }
  if(eventRequest) console.info(JSON.stringify({component:'mcp_event_request',method,...eventRequest}));
  const handler=createMcpHandler(()=>server(env,principal),{legacy:'reject',responseMode:'auto',maxRequestBodySize:65536,maxSubscriptions:0,keepAliveMs:0});
  const response=await handler.fetch(request);
  // Catalog-only summaries distinguish HTTP success from JSON-RPC failure. Never log response bodies,
  // arbitrary keys/messages, call results, request arguments, identities, or callback credentials.
  if (['server/discover','tools/list','events/list'].includes(method)) {
    const json=response.headers.get('content-type')?.includes('application/json');
    let summary:Record<string,unknown>={outcome:'non_json'};
    if(json) try {
      const body=JSON.parse(await boundedText(response.clone(),65536));
      summary={outcome:body.error?'rpc_error':body.result?'result':'invalid_envelope',
        error_code:typeof body.error?.code==='number'?body.error.code:undefined,
        complete:body.result?.resultType==='complete',
        tool_count:Array.isArray(body.result?.tools)?body.result.tools.length:undefined,
        event_count:Array.isArray(body.result?.events)?body.result.events.length:undefined};
    } catch { summary={outcome:'unreadable_json'}; }
    console.info(JSON.stringify({component:'mcp_catalog',method,status:response.status,...requestMeta,...summary}));
  }
  response.headers.set('Cache-Control','private, no-store');
  if(['events/subscribe','events/unsubscribe'].includes(method)) {
    let summary:Record<string,unknown>={outcome:'non_json'};
    if(response.headers.get('content-type')?.includes('application/json')) try {
      summary=eventResponseSummary(JSON.parse(await boundedText(response.clone(),65536)));
    } catch { summary={outcome:'unreadable_json'}; }
    console.info(JSON.stringify({component:'mcp_event_response',method,status:response.status,...summary}));
  }
  return response;
}
