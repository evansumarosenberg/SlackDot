import {afterEach,describe,it,expect,vi} from 'vitest';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/server/validators/cf-worker';
import {database} from '../support/database';
import {env,event,subscription,secret} from '../support/fixtures';
import {eventNames,eventSchemas,normalize,matchesEvent,type EventName} from '../../lib/slack/normalize';
import {subscribe,unsubscribe,subscribeSchema} from '../../lib/events/subscriptions';
import {CallbackClient} from '../../lib/events/callback';
import {deliverEvent} from '../../lib/events/delivery';
import {CLAIM_MS} from '../../lib/events/dedup';
import {SlackService,conversationSchema,sendSchema} from '../../lib/slack/service';
import {Failure} from '../../lib/runtime/config';
import {decrypt} from '../../lib/runtime/crypto';
import {handleMcp} from '../../lib/mcp/server';

const ts='1793640000.123456';
const verify=()=>new CallbackClient('https://receiver.example.com',async(_url,init)=>Response.json({challenge:JSON.parse(init.body as string).challenge}));
function body(name:EventName,channel='CTEST',text='hello <@UBOT>') {
  const message={user:'UPERSON',ts,text};
  const wrap=(extra:Record<string,unknown>)=>({...event(extra),event_id:`Ev${name}:${channel}`});
  if(name==='slack.message.created') return wrap({...message,channel});
  if(name==='slack.message.updated') return wrap({channel,subtype:'message_changed',message,event_ts:ts});
  if(name==='slack.message.deleted') return wrap({channel,subtype:'message_deleted',previous_message:message,deleted_ts:ts,event_ts:ts});
  return wrap({type:name==='slack.reaction.added'?'reaction_added':'reaction_removed',user:'UPERSON',item_user:'UBOT',item:{type:'message',channel,ts},reaction:'eyes',event_ts:ts});
}
function request(method:string,params:Record<string,unknown>={},principal='owner') {
  return new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json',Accept:'application/json','Mcp-Method':method,'Mcp-Name':String(params.name??''),'MCP-Protocol-Version':'2026-07-28','oai-authenticated-user-id':principal},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'wildcard-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
}
afterEach(()=>vi.restoreAllMocks());

describe('wildcard contract',()=>{
  it.each(eventNames)('advertises and enforces the same %s selector contract',async(name)=>{
    const e=env(database().db);
    const result=await (await handleMcp(request('events/list'),e)).json() as any;
    const definition=result.result.events.find((item:any)=>item.name===name);
    const validate=new CfWorkerJsonSchemaValidator().getValidator(definition.inputSchema);
    for(const args of [{conversation_id:'*'},{conversation_id:'CTEST'},{conversation_id:'CTEST',thread_ts:ts}]) {
      expect(validate(args).valid).toBe(true);
      expect(subscribeSchema.safeParse({...subscription(),name,arguments:args}).success).toBe(true);
    }
    const invalid=[{}, {conversation_id:'*',thread_ts:ts},{conversation_id:'*',unknown:true},
      ...[null,'','C*','**',' *','* ',['CTEST']].map(conversation_id=>({conversation_id}))];
    for(const args of invalid) {
      expect(validate(args).valid,JSON.stringify(args)).toBe(false);
      expect(subscribeSchema.safeParse({...subscription(),name,arguments:args}).success).toBe(false);
    }
    const payload=normalize(body(name),e)!.data;
    expect(new CfWorkerJsonSchemaValidator().getValidator(definition.payloadSchema)({...payload,conversation_id:'*'}).valid).toBe(false);
    expect(eventSchemas[name].payload.safeParse({...payload,conversation_id:'*'}).success).toBe(false);
    expect(conversationSchema.safeParse({conversation_id:'*'}).success).toBe(false);
    expect(sendSchema.safeParse({conversation_id:'*',text:'hello'}).success).toBe(false);
  });
  it.each(eventNames)('matches %s in multiple channels without weakening other filters',name=>{
    const e=env(database().db),reaction=name.startsWith('slack.reaction');
    for(const channel of ['CTEST','GPRIVATE','DTEST']) {
      const normalized=normalize(body(name,channel),e)!;
      const filters=reaction?{actor_user_ids:['UPERSON'],emoji_name:'eyes'}:{sender_user_ids:['UPERSON'],...(name==='slack.message.deleted'?{}:{mentions_only:true})};
      expect(matchesEvent(normalized,name,{conversation_id:'*',...filters})).toBe(true);
      expect(matchesEvent(normalized,name,{conversation_id:'COTHER',...filters})).toBe(false);
      expect(matchesEvent(normalized,name,{conversation_id:'*',thread_ts:ts})).toBe(false);
      expect(matchesEvent(normalized,name,{conversation_id:'*',...(reaction?{actor_user_ids:['UOTHER']}:{sender_user_ids:['UOTHER']})})).toBe(false);
      if(reaction) expect(matchesEvent(normalized,name,{conversation_id:'*',emoji_name:'heart'})).toBe(false);
      else if(name!=='slack.message.deleted') expect(matchesEvent(normalize(body(name,channel,'no mention'),e)!,name,{conversation_id:'*',mentions_only:true})).toBe(false);
    }
  });
  it('preserves bot suppression, unknown metadata and mentions beyond preview truncation',()=>{
    const e=env(database().db),name='slack.message.created';
    const other=normalize(event({user:'UOTHER',bot_id:'BOTHER',text:'<@UBOT>'}),e)!;
    expect(matchesEvent(other,name,{conversation_id:'*',mentions_only:true})).toBe(false);
    expect(matchesEvent(other,name,{conversation_id:'*',mentions_only:true,include_bot_messages:true})).toBe(true);
    expect(normalize(event({user:'UBOT'}),e)).toBeNull();
    expect(matchesEvent(normalize(event({text:'x'.repeat(4000)+'<@UBOT>'}),e)!,name,{conversation_id:'*',mentions_only:true})).toBe(true);
    for(const subtype of ['message_changed','message_deleted']) {
      const partial=normalize(event({subtype,message:{ts},deleted_ts:ts,event_ts:ts}),e)!;
      expect(matchesEvent(partial,partial.name,{conversation_id:'*',include_bot_messages:true})).toBe(false);
    }
  });
});

describe('wildcard subscription lifecycle',()=>{
  it.each(eventNames)('verifies identity on %s creation/refresh and unsubscribes without Slack',async name=>{
    const {db,sqlite}=database(),e=env(db),access=vi.fn(async()=>{}),identity=vi.spyOn(SlackService.prototype,'identity').mockResolvedValue({workspace_id:'TTEST',bot_user_id:'UBOT',bot_id:'BBOT'});
    const input={...subscription({conversation_id:'*'}),name};
    const first=await subscribe(e,'owner',input,access,verify(),1000);
    const refreshed=await subscribe(e,'owner',input,access,verify(),2000);
    expect(refreshed.id).toBe(first.id);expect(identity).toHaveBeenCalledTimes(2);expect(access).not.toHaveBeenCalled();
    const stored=sqlite.prepare('SELECT * FROM subscriptions WHERE id=?').get(first.id)!;
    expect(stored).toMatchObject({conversation:'*',args:'{"conversation_id":"*"}',thread:null,expires_at:259202000});
    expect(await decrypt(stored.secret as string,e.SUBSCRIPTION_ENCRYPTION_KEY,first.id)).toBe(secret);
    identity.mockRejectedValue(new Failure('installation_revoked'));
    const stop={name,arguments:input.arguments,delivery:{mode:'webhook',url:input.delivery.url}};
    await unsubscribe(e,'stranger',stop,2100);expect(sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(1);
    await unsubscribe({...e,SLACK_BOT_TOKEN:'',CALLBACK_ALLOWED_ORIGINS:''},'owner',stop,2200);
    expect(sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(0);expect(identity).toHaveBeenCalledTimes(2);
  });
  it('checks owner and actual configured identity through the MCP handler',async()=>{
    const {db,sqlite}=database(),e=env(db),input=subscription({conversation_id:'*'});
    const identity=vi.spyOn(SlackService.prototype,'identity').mockRejectedValue(new Failure('installation_mismatch'));
    expect((await handleMcp(request('events/subscribe',input,'stranger'),e)).status).toBe(403);expect(identity).not.toHaveBeenCalled();
    const failed=await (await handleMcp(request('events/subscribe',input),e)).json() as any;
    expect(failed.error.data.reason).toBe('installation_mismatch');expect(identity).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(0);
  });
  it('rejects invalid thread combinations before Slack or storage and during canonical unsubscribe',async()=>{
    const e=env(database().db),access=vi.fn(async()=>{}),identity=vi.spyOn(SlackService.prototype,'identity');
    for(const name of eventNames) {
      const input={...subscription({conversation_id:'*',thread_ts:ts}),name};
      await expect(subscribe(e,'owner',input,access,verify(),1000)).rejects.toThrow();
      await expect(unsubscribe(e,'owner',{name,arguments:input.arguments,delivery:{mode:'webhook',url:input.delivery.url}},1000)).rejects.toThrow();
    }
    expect(access).not.toHaveBeenCalled();expect(identity).not.toHaveBeenCalled();
  });
});

async function deliveryFixture(name:EventName='slack.message.created') {
  const {db,sqlite}=database(),e=env(db);let now=Date.now();
  const access=vi.fn(async(_id:string,_deadline?:number)=>{}),identity=async()=>{};
  const input={...subscription({conversation_id:'*'}),name};
  const sub=await subscribe(e,'owner',input,access,verify(),now,identity);access.mockClear();
  const post=vi.fn(async()=>new Response(null,{status:204})),callbacks=verify();vi.spyOn(callbacks,'post').mockImplementation(post);
  const notice=vi.fn(async()=>{}),processing=vi.fn(async()=>{}),eventThread=vi.fn(async()=>null);
  const deps={access,callbacks,notice,processing,eventThread,clock:()=>now,sleep:async(ms:number)=>{now+=ms;}};
  return {e,sqlite,sub,input,access,post,notice,processing,eventThread,deps,identity,now:()=>now,advance:(ms:number)=>{now+=ms;},
    run:(channel='CTEST')=>deliverEvent(e,normalize(body(name,channel),e)!,now,deps)};
}
describe('wildcard delivery',()=>{
  it.each(eventNames)('delivers %s from new conversations without refresh or wildcard access calls',async name=>{
    const f=await deliveryFixture(name);
    await f.run('CTEST');await f.run('GPRIVATE');
    expect(f.access.mock.calls.map(([id])=>id)).toEqual(['CTEST','GPRIVATE']);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.eventThread).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
  });
  it.each(['conversation_unavailable','not_found','not_in_conversation'])('retains wildcard after %s and delivers in another channel',async reason=>{
    const f=await deliveryFixture();f.access.mockRejectedValueOnce(new Failure(reason));
    await f.run();expect(f.post).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();expect(f.processing).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT state FROM event_dedup').get()).toEqual({state:'failed'});
    expect(f.sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(1);
    await f.run('COTHER');expect(f.post).toHaveBeenCalledTimes(1);
    f.advance(CLAIM_MS);await f.run();expect(f.post).toHaveBeenCalledTimes(2);
  });
  it.each(['installation_revoked','installation_mismatch','missing_scope'])('deletes wildcard on access %s',async reason=>{
    const f=await deliveryFixture();f.access.mockRejectedValue(new Failure(reason));await f.run();
    expect(f.sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(0);
    expect(f.post).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();expect(f.processing).not.toHaveBeenCalled();
  });
  it('retains wildcard on a temporary access failure',async()=>{
    const f=await deliveryFixture();f.access.mockRejectedValueOnce(new Failure('rate_limited',60));await f.run();
    expect(f.sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(1);expect(f.post).not.toHaveBeenCalled();
    await f.run('COTHER');expect(f.post).toHaveBeenCalledTimes(1);
  });
  it('delivers exact and wildcard subscriptions independently, deduplicates retries and sets status once',async()=>{
    const f=await deliveryFixture();await subscribe(f.e,'owner',subscription(),f.access,verify(),f.now());f.access.mockClear();
    await f.run();await f.run();expect(f.post).toHaveBeenCalledTimes(2);expect(f.processing).toHaveBeenCalledTimes(1);
    expect(f.access.mock.calls.map(([id])=>id)).toEqual(['CTEST','CTEST']);
    expect(f.sqlite.prepare('SELECT state FROM event_dedup').all()).toEqual([{state:'delivered'},{state:'delivered'}]);
  });
  it('does not treat callback errors as revoked Slack access',async()=>{
    const f=await deliveryFixture();f.post.mockRejectedValue(new Failure('not_in_conversation'));await f.run();
    expect(f.sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(1);expect(f.notice).toHaveBeenCalledTimes(1);
  });
  it.each(['unsubscribe','expire','recreate','invalid_filter'] as const)('rechecks %s after access',async change=>{
    const f=await deliveryFixture();
    f.access.mockImplementationOnce(async()=>{
      if(change==='expire') f.sqlite.prepare('UPDATE subscriptions SET expires_at=?').run(f.now());
      else if(change==='invalid_filter') f.sqlite.prepare('UPDATE subscriptions SET args=?').run(JSON.stringify({conversation_id:'*',thread_ts:ts}));
      else {
        await unsubscribe(f.e,'owner',{id:f.sub.id},f.now());
        if(change==='recreate') {f.advance(1);await subscribe(f.e,'owner',f.input,async()=>{},verify(),f.now(),f.identity);}
      }
    });
    await f.run();expect(f.post).not.toHaveBeenCalled();expect(f.processing).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
  });
});
