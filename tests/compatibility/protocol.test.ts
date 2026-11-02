import { describe,it,expect } from 'vitest';
import { handleMcp } from '../../lib/mcp/server';
import { route } from '../../lib/runtime/router';
import { database } from '../support/database';
import { env } from '../support/fixtures';
export function rpc(method:string,params:Record<string,unknown>={},principal='owner') {
  return new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json',Accept:'application/json','Mcp-Method':method,...(typeof params.name==='string'?{'Mcp-Name':params.name}:{}),'MCP-Protocol-Version':'2026-07-28','oai-authenticated-user-id':principal},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'compatibility-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
}
describe('SDK protocol contract',()=>{
  it('advertises tools and webhook events through SDK modern discovery',async()=>{
    const e=env(database().db);
    const response=await handleMcp(rpc('server/discover'),e);
    expect(response.status).toBe(200);
    const body=await response.json() as any;
    expect(body.error).toBeUndefined();expect(body.result.supportedVersions).toContain('2026-07-28');
    expect(body.result.resultType).toBe('complete');expect(body.result.capabilities).toEqual({tools:{listChanged:false},events:{}});
  });
  it('lists exactly three tools and one event with strict filters',async()=>{
    const e=env(database().db);
    const tools=await (await handleMcp(rpc('tools/list'),e)).json() as any;
    expect(tools.error).toBeUndefined();expect(tools.result.tools.map((t:any)=>t.name).sort()).toEqual(['slack_get_connection_info','slack_get_thread','slack_send_message']);
    const events=await (await handleMcp(rpc('events/list'),e)).json() as any;
    expect(events.error).toBeUndefined();expect(events.result.events).toHaveLength(1);
    expect(events.result.events[0].inputSchema.additionalProperties).toBe(false);
    expect(events.result.events[0].delivery).toEqual(['webhook']);
  });
  it('rejects anonymous and other users before reading DB or Slack',async()=>{
    const e=env({} as D1Database);
    for(const who of ['', 'stranger']) for(const method of ['tools/call','events/subscribe','events/unsubscribe','tools/list']) expect((await handleMcp(rpc(method,{},who),e)).status).toBe(403);
    expect((await handleMcp(rpc('tools/list'),{...e,SITES_IDENTITY_VERIFIED:''})).status).toBe(503);
  });
  it('keeps recovery service authentication separate from owner headers',async()=>{
    const e=env({} as D1Database);
    expect((await route(new Request('https://site.example/internal/deliver',{method:'POST',headers:{'oai-authenticated-user-id':'owner'}}),e))?.status).toBe(403);
  });
  it('returns sanitized configuration errors and SDK invalid-argument errors',async()=>{
    const e={...env(database().db),SLACK_BOT_TOKEN:''};
    const result=await (await handleMcp(rpc('tools/call',{name:'slack_get_connection_info',arguments:{}}),e)).json() as any;
    expect(result.result.isError).toBe(true);expect(JSON.stringify(result)).toContain('configuration_missing');
    const invalid=await (await handleMcp(rpc('tools/call',{name:'slack_send_message',arguments:{}}),e)).json() as any;
    expect(invalid.error || invalid.result?.isError).toBeTruthy();
  });
});
