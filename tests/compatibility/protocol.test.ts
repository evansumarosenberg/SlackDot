import { describe,it,expect,vi } from 'vitest';
import { handleMcp } from '../../lib/mcp/server';
import { route } from '../../lib/runtime/router';
import { database } from '../support/database';
import { env,subscription,secret } from '../support/fixtures';
import { SlackService } from '../../lib/slack/service';
export function rpc(method:string,params:Record<string,unknown>={},principal='owner') {
  return new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json',Accept:'application/json','Mcp-Method':method,...(typeof params.name==='string'?{'Mcp-Name':params.name}:{}),'MCP-Protocol-Version':'2026-07-28','oai-authenticated-user-id':principal},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'compatibility-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
}
describe('SDK protocol contract',()=>{
  it('accepts native lifetime requests and reports callback policy failures without leaking secrets',async()=>{
    const e=env(database().db);
    // An unset Sites variable is absent, not necessarily an empty string.
    delete (e as Partial<typeof e>).CALLBACK_ALLOWED_ORIGINS;
    const access=vi.spyOn(SlackService.prototype,'access').mockResolvedValue(undefined);
    const logs=vi.spyOn(console,'info').mockImplementation(()=>{});
    try {
      const input={...subscription(),ttlMs:null};input.delivery.url='https://receiver.example.com/private-callback?token=synthetic-sensitive';
      const body=await (await handleMcp(rpc('events/subscribe',input),e)).json() as any;
      expect(body.error.code).toBe(-32015);expect(body.error.data.reason).toBe('callback_policy_unconfigured');
      expect(logs).not.toHaveBeenCalled();
      const logged=JSON.stringify(logs.mock.calls);
      for(const sensitive of [secret,'private-callback','synthetic-sensitive','synthetic-token']) expect(logged).not.toContain(sensitive);
      const stopped=await (await handleMcp(rpc('events/unsubscribe',{name:input.name,arguments:input.arguments,
        delivery:{mode:'webhook',url:input.delivery.url}}),e)).json() as any;
      expect(stopped.error).toBeUndefined();expect(stopped.result).toMatchObject({});
    } finally {access.mockRestore();logs.mockRestore();}
  });
  it('rejects invalid arguments without logging request content',async()=>{
    const logs=vi.spyOn(console,'info').mockImplementation(()=>{});
    try {
      const input={...subscription(),ttlMs:-1,'sensitive-extra-key':'sensitive-extra-value'};
      const body=await (await handleMcp(rpc('events/subscribe',input),env(database().db))).json() as any;
      expect(body.error.data.reason).toBe('invalid_subscription_arguments');
      const logged=JSON.stringify(logs.mock.calls);
      for(const sensitive of ['sensitive-extra-key','sensitive-extra-value',secret]) expect(logged).not.toContain(sensitive);
      expect(logs).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain('sensitive-extra');
    } finally {logs.mockRestore();}
  });
  it('advertises tools and webhook events through SDK modern discovery',async()=>{
    const e=env(database().db);
    const response=await handleMcp(rpc('server/discover'),e);
    expect(response.status).toBe(200);
    const body=await response.json() as any;
    expect(body.error).toBeUndefined();expect(body.result.supportedVersions).toContain('2026-07-28');
    expect(body.result.resultType).toBe('complete');expect(body.result.capabilities).toEqual({tools:{listChanged:false},events:{}});
  });
  it('lists all seventeen tools and five events with strict filters',async()=>{
    const e=env(database().db);
    const tools=await (await handleMcp(rpc('tools/list'),e)).json() as any;
    expect(tools.error).toBeUndefined();expect(tools.result.tools.map((t:any)=>t.name).sort()).toEqual(['slack_get_connection_info','slack_list_conversations','slack_get_conversation','slack_list_users','slack_get_user','slack_open_dm','slack_get_messages','slack_get_thread','slack_send_message','slack_update_message','slack_delete_message','slack_get_reactions','slack_add_reaction','slack_remove_reaction','slack_set_assistant_status','slack_set_assistant_title','slack_set_assistant_suggested_prompts'].sort());
    const send=tools.result.tools.find((t:any)=>t.name==='slack_send_message');
    expect(send.annotations.idempotentHint).toBe(false);
    expect(send.inputSchema.required).not.toContain('request_id');
    const events=await (await handleMcp(rpc('events/list'),e)).json() as any;
    expect(events.error).toBeUndefined();expect(events.result.events.map((e:any)=>e.name).sort()).toEqual(['slack.message.created','slack.message.updated','slack.message.deleted','slack.reaction.added','slack.reaction.removed'].sort());
    expect(events.result.events[0].inputSchema.additionalProperties).toBe(false);
    expect(events.result.events[0].delivery).toEqual(['webhook']);
  });
  it('rejects anonymous and other users before reading DB or Slack',async()=>{
    const e=env({} as D1Database);
    for(const who of ['', 'stranger']) for(const method of ['tools/call','events/subscribe','events/unsubscribe','tools/list']) expect((await handleMcp(rpc(method,{},who),e)).status).toBe(403);
    expect((await handleMcp(rpc('tools/list'),{...e,SITES_IDENTITY_VERIFIED:''})).status).toBe(503);
  });
  it('has no delivery recovery endpoint',async()=>{
    const e=env({} as D1Database);
    expect((await route(new Request('https://site.example/internal/deliver',{method:'POST',headers:{'oai-authenticated-user-id':'owner'}}),e))).toBeNull();
  });
  it('returns sanitized configuration errors and SDK invalid-argument errors',async()=>{
    const e={...env(database().db),SLACK_BOT_TOKEN:''};
    const result=await (await handleMcp(rpc('tools/call',{name:'slack_get_connection_info',arguments:{}}),e)).json() as any;
    expect(result.result.isError).toBe(true);expect(JSON.stringify(result)).toContain('configuration_missing');
    const invalid=await (await handleMcp(rpc('tools/call',{name:'slack_send_message',arguments:{}}),e)).json() as any;
    expect(invalid.error || invalid.result?.isError).toBeTruthy();
  });
});
