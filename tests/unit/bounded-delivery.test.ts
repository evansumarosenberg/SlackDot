import {it,expect,vi} from 'vitest';
import {Webhook} from 'standardwebhooks';
import {database} from '../support/database';
import {env,event,subscription,secret,access} from '../support/fixtures';
import {subscribe,unsubscribe} from '../../lib/events/subscriptions';
import {acceptEvent} from '../../lib/storage';
import {CallbackClient} from '../../lib/events/callback';
import {deliverEvent} from '../../lib/events/delivery';
import {retryDelay} from '../../lib/events/budget';
import {Failure} from '../../lib/runtime/config';

async function fixture() {
  const {db,sqlite}=database(),e=env(db);let now=Date.now();const start=now;
  const verified=new CallbackClient(e.CALLBACK_ALLOWED_ORIGINS,async(_url,init)=>Response.json({challenge:JSON.parse(init.body as string).challenge}));
  const sub=await subscribe(e,'owner',subscription(),access,verified,now);
  const id=(await acceptEvent(e,event(),now))!;
  const calls:RequestInit[]=[],notice=vi.fn(async(_event:unknown,_text:string,_deadline:number)=>({message_ts:'1793640009.123456'}));
  const sleep=vi.fn(async(ms:number)=>{now+=ms;});
  const transport=vi.fn(async(_url:string,init:RequestInit)=>{calls.push(init);return new Response(null,{status:204});});
  const callbacks=new CallbackClient(e.CALLBACK_ALLOWED_ORIGINS,transport);
  const deps={access,callbacks,notice,clock:()=>now,sleep};
  return {e,sqlite,sub,id,calls,notice,transport,verified,deps,start,advance:(ms:number)=>{now+=ms;},run:()=>deliverEvent(e,id,deps),
    row:()=>sqlite.prepare('SELECT * FROM deliveries WHERE event_id=?').get(id),
    noticeRow:()=>sqlite.prepare('SELECT * FROM delivery_notices').get()};
}
it('retries in the same invocation with stable bytes/ID, a fresh signature, and no notice after acceptance',async()=>{
  const f=await fixture();f.transport.mockImplementationOnce(async(_u,init)=>{f.calls.push(init);return new Response(null,{status:503});});
  await f.run();expect(f.calls).toHaveLength(2);expect(f.deps.sleep).toHaveBeenCalledWith(1000);
  const [a,b]=f.calls;expect(a.body).toBe(b.body);
  const ah=a.headers as Record<string,string>,bh=b.headers as Record<string,string>;
  expect(ah['webhook-id']).toBe(bh['webhook-id']);expect(ah['webhook-signature']).not.toBe(bh['webhook-signature']);
  new Webhook(secret).verify(a.body as string,ah);new Webhook(secret).verify(b.body as string,bh);
  expect(f.row()).toMatchObject({state:'delivered',attempts:2});expect(f.notice).not.toHaveBeenCalled();
});
it('exhausts exactly three attempts and sends one correct threaded notice across duplicate/concurrent invocations',async()=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:503}));
  await Promise.all([f.run(),f.run()]);await acceptEvent(f.e,event(),f.start+100);await f.run();
  expect(f.transport).toHaveBeenCalledTimes(3);expect(f.row()).toMatchObject({state:'terminal',attempts:3,last_error:'retry_exhausted',deadline:f.start+20000});
  expect(f.notice).toHaveBeenCalledTimes(1);expect(f.notice.mock.calls[0]).toEqual([expect.objectContaining({data:expect.objectContaining({conversation_id:'CTEST',thread_ts:'1793640000.123456'})}),expect.stringContaining('after several attempts'),f.start+8000]);
  expect(f.noticeRow()).toMatchObject({state:'sent'});
});
it.each([410,413,400,302])('does not retry permanent response %s and avoids claiming multiple attempts',async(status)=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status}));await f.run();
  expect(f.transport).toHaveBeenCalledTimes(1);expect(f.row()?.state).toBe('terminal');
  expect(f.notice).toHaveBeenCalledTimes(1);expect(f.notice.mock.calls[0][1]).not.toContain('several attempts');
});
it.each(['60',new Date(Date.now()+60000).toUTCString()])('honors long Retry-After %s without waiting beyond budget',async(value)=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:429,headers:{'retry-after':value}}));await f.run();
  expect(f.transport).toHaveBeenCalledTimes(1);expect(f.deps.sleep).not.toHaveBeenCalled();
  expect(f.row()).toMatchObject({state:'terminal',last_error:'retry_after_exceeds_budget'});expect(f.notice).toHaveBeenCalledTimes(1);
});
it('does not send a callback after slow access consumes the budget; reserves bounded notice time',async()=>{
  const f=await fixture();f.deps.access=async()=>{f.advance(20000);};await f.run();
  expect(f.transport).not.toHaveBeenCalled();expect(f.row()?.state).toBe('terminal');
  expect(f.notice.mock.calls[0][2]).toBe(f.start+25000);
});
it('suppresses notice when another matching subscription accepted the event',async()=>{
  const f=await fixture();await subscribe(f.e,'owner',{...subscription(),delivery:{...subscription().delivery,url:'https://receiver.example.com/second'}},access,f.verified,f.start-1);
  // Second fixture ingress atomically fans out only to subscriptions present at acceptance.
  await acceptEvent(f.e,event(),f.start);
  f.transport.mockImplementation(async(url,init)=>{f.calls.push(init);return new Response(null,{status:url.endsWith('/second')?204:410});});
  await f.run();expect(f.transport).toHaveBeenCalledTimes(2);expect(f.notice).not.toHaveBeenCalled();
});
it('shares the original deadline across fanout and creates one notice when all destinations fail',async()=>{
  const f=await fixture();
  for(let i=0;i<5;i++) await subscribe(f.e,'owner',{...subscription(),delivery:{...subscription().delivery,url:`https://receiver.example.com/${i}`}},access,f.verified,f.start-1);
  await acceptEvent(f.e,event(),f.start);
  const deadlines:number[]=[];
  f.deps.access=async(_id?:string,deadline?:number)=>{deadlines.push(deadline!);};
  f.transport.mockResolvedValue(new Response(null,{status:410}));await f.run();
  expect(new Set(deadlines)).toEqual(new Set([f.start+20000]));
  expect(f.transport).toHaveBeenCalledTimes(6);expect(f.notice).toHaveBeenCalledTimes(1);
});
it('cancels on unsubscribe observed after access without callback or notice',async()=>{
  const f=await fixture();f.deps.access=async()=>{await unsubscribe(f.e,'owner',{id:f.sub.id});};await f.run();
  expect(f.transport).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();expect(f.row()?.state).toBe('cancelled');
});
it('cancels revoked access without notice',async()=>{
  const f=await fixture();f.deps.access=async()=>{throw new Failure('installation_revoked');};await f.run();
  expect(f.notice).not.toHaveBeenCalled();expect(f.row()?.state).toBe('cancelled');
});
it.each(['ambiguous_write','rate_limited'])('retains notice %s without blindly resending',async(reason)=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:410}));f.notice.mockRejectedValue(new Failure(reason));
  await f.run();await f.run();expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.noticeRow()).toMatchObject({state:reason==='ambiguous_write'?'ambiguous':'failed',last_error:reason});
});
it('does not revive an interrupted job after its original deadline, even on duplicate ingress',async()=>{
  const f=await fixture();f.advance(30000);await acceptEvent(f.e,event(),f.start+30000);await f.run();
  expect(f.row()).toMatchObject({state:'terminal',attempts:0,deadline:f.start+20000,last_error:'interrupted_expired'});
  expect(f.notice).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
});
it('does not overwrite another invocation active claim at the deadline',async()=>{
  const f=await fixture();f.sqlite.prepare("UPDATE deliveries SET state='claimed',claim='other',lease_until=?").run(f.start+25000);
  f.advance(21000);await f.run();expect(f.row()).toMatchObject({state:'claimed',claim:'other'});
  f.advance(5000);await f.run();expect(f.row()?.last_error).toBe('interrupted_expired');
});
it('rejects malformed/negative Retry-After without inventing a future delay',()=>{
  expect(retryDelay('garbage',0)).toBe(0);expect(retryDelay('-1',0)).toBe(0);
});
