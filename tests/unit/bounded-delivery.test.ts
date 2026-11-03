import {it,expect,vi} from 'vitest';
import {Webhook} from 'standardwebhooks';
import {database} from '../support/database';
import {env,event,subscription,secret,access} from '../support/fixtures';
import {subscribe,unsubscribe} from '../../lib/events/subscriptions';
import {normalize} from '../../lib/slack/normalize';
import {CallbackClient} from '../../lib/events/callback';
import {deliverEvent} from '../../lib/events/delivery';
import {retryDelay} from '../../lib/events/budget';
import {Failure} from '../../lib/runtime/config';

async function fixture() {
  const {db,sqlite}=database(),e=env(db);let now=Date.now();const start=now;
  const verified=new CallbackClient(e.CALLBACK_ALLOWED_ORIGINS,async(_url,init)=>Response.json({challenge:JSON.parse(init.body as string).challenge}));
  const sub=await subscribe(e,'owner',subscription(),access,verified,now);
  const message=normalize(event(),e)!;
  const calls:RequestInit[]=[],notice=vi.fn(async(_event:unknown,_text:string,_deadline:number)=>({message_ts:'1793640009.123456'}));
  const sleep=vi.fn(async(ms:number)=>{now+=ms;});
  const transport=vi.fn(async(_url:string,init:RequestInit)=>{calls.push(init);return new Response(null,{status:204});});
  const callbacks=new CallbackClient(e.CALLBACK_ALLOWED_ORIGINS,transport);
  const deps={access,callbacks,notice,clock:()=>now,sleep};
  return {e,sqlite,sub,message,calls,notice,transport,verified,deps,start,advance:(ms:number)=>{now+=ms;},
    run:(acceptedAt=start)=>deliverEvent(e,message,acceptedAt,deps)};
}
it('retries in one invocation with stable bytes/ID and fresh signatures, without a success notice',async()=>{
  const f=await fixture();f.transport.mockImplementationOnce(async(_u,init)=>{f.calls.push(init);return new Response(null,{status:503});});
  expect(await f.run()).toEqual({processed:1});expect(f.calls).toHaveLength(2);expect(f.deps.sleep).toHaveBeenCalledWith(1000);
  const [a,b]=f.calls;expect(a.body).toBe(b.body);
  const ah=a.headers as Record<string,string>,bh=b.headers as Record<string,string>;
  expect(ah['webhook-id']).toBe(bh['webhook-id']);expect(ah['webhook-signature']).not.toBe(bh['webhook-signature']);
  new Webhook(secret).verify(a.body as string,ah);new Webhook(secret).verify(b.body as string,bh);
  expect(f.notice).not.toHaveBeenCalled();
});
it('exhausts three attempts then sends one correct threaded notice in this invocation',async()=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:503}));
  await f.run();expect(f.transport).toHaveBeenCalledTimes(3);expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice.mock.calls[0]).toEqual([f.message,expect.stringContaining('after several attempts'),f.start+8000]);
  expect(f.notice.mock.calls[0][1]).toContain('by this delivery run');
});
it('allows a separate redelivery to repeat callbacks and notices with the same event ID',async()=>{
  const f=await fixture();f.transport.mockImplementation(async(_url,init)=>{f.calls.push(init);return new Response(null,{status:410});});
  await f.run();f.advance(60000);await f.run(f.start+60000);
  expect(f.transport).toHaveBeenCalledTimes(2);expect(f.notice).toHaveBeenCalledTimes(2);
  expect(f.calls[0].body).toBe(f.calls[1].body);
  expect((f.calls[0].headers as Record<string,string>)['webhook-id']).toBe((f.calls[1].headers as Record<string,string>)['webhook-id']);
});
it.each([410,413,400,302])('does not retry permanent response %s or claim several attempts',async(status)=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status}));await f.run();
  expect(f.transport).toHaveBeenCalledTimes(1);expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice.mock.calls[0][1]).not.toContain('several attempts');
});
it.each(['60',new Date(Date.now()+60000).toUTCString()])('honors long Retry-After %s without exceeding the budget',async(value)=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:429,headers:{'retry-after':value}}));await f.run();
  expect(f.transport).toHaveBeenCalledTimes(1);expect(f.deps.sleep).not.toHaveBeenCalled();expect(f.notice).toHaveBeenCalledTimes(1);
});
it('does not send a callback after access consumes the budget; reserves bounded notice time',async()=>{
  const f=await fixture();f.deps.access=async()=>{f.advance(20000);};await f.run();
  expect(f.transport).not.toHaveBeenCalled();expect(f.notice.mock.calls[0][2]).toBe(f.start+25000);
});
it('suppresses notice when any matching subscription accepted the event',async()=>{
  const f=await fixture();await subscribe(f.e,'owner',{...subscription(),delivery:{...subscription().delivery,url:'https://receiver.example.com/second'}},access,f.verified,f.start-1);
  f.transport.mockImplementation(async(url,init)=>{f.calls.push(init);return new Response(null,{status:url.endsWith('/second')?204:410});});
  await f.run();expect(f.transport).toHaveBeenCalledTimes(2);expect(f.notice).not.toHaveBeenCalled();
});
it('shares one deadline across fanout and sends one notice when every destination fails',async()=>{
  const f=await fixture();
  for(let i=0;i<5;i++) await subscribe(f.e,'owner',{...subscription(),delivery:{...subscription().delivery,url:`https://receiver.example.com/${i}`}},access,f.verified,f.start-1);
  const deadlines:number[]=[];
  f.deps.access=async(_id?:string,deadline?:number)=>{deadlines.push(deadline!);};
  f.transport.mockResolvedValue(new Response(null,{status:410}));await f.run();
  expect(new Set(deadlines)).toEqual(new Set([f.start+20000]));expect(f.transport).toHaveBeenCalledTimes(6);expect(f.notice).toHaveBeenCalledTimes(1);
});
it('limits callback fanout to four concurrent destinations',async()=>{
  const f=await fixture();
  for(let i=0;i<7;i++) await subscribe(f.e,'owner',{...subscription(),delivery:{...subscription().delivery,url:`https://receiver.example.com/${i}`}},access,f.verified,f.start-1);
  let running=0,maximum=0;const releases:(()=>void)[]=[];
  f.transport.mockImplementation(async()=>{running++;maximum=Math.max(maximum,running);await new Promise<void>(resolve=>releases.push(resolve));running--;return new Response(null,{status:204});});
  const done=f.run();
  await vi.waitFor(()=>expect(releases).toHaveLength(4));expect(maximum).toBe(4);
  releases.splice(0).forEach(release=>release());
  await vi.waitFor(()=>expect(releases).toHaveLength(4));releases.splice(0).forEach(release=>release());
  await done;expect(maximum).toBe(4);expect(f.notice).not.toHaveBeenCalled();
});
it('does not deliver to subscriptions created after this invocation started',async()=>{
  const f=await fixture();f.sqlite.prepare('UPDATE subscriptions SET created_at=?').run(f.start+1);
  expect(await f.run()).toEqual({processed:0});expect(f.transport).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
});
it('cancels when unsubscribe is observed after access',async()=>{
  const f=await fixture();f.deps.access=async()=>{await unsubscribe(f.e,'owner',{id:f.sub.id});};await f.run();
  expect(f.transport).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
});
it('does not send an old event to a subscription recreated during access',async()=>{
  const f=await fixture();
  f.deps.access=async()=>{
    await unsubscribe(f.e,'owner',{id:f.sub.id});f.advance(1);
    const recreated=await subscribe(f.e,'owner',subscription(),access,f.verified,f.start+1);
    expect(recreated.id).toBe(f.sub.id);
  };
  await f.run();expect(f.transport).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
  expect(f.sqlite.prepare('SELECT created_at FROM subscriptions WHERE id=?').get(f.sub.id)).toEqual({created_at:f.start+1});
});
it('does not retry an old event after its subscription is recreated during backoff',async()=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:503}));
  f.deps.sleep.mockImplementation(async(ms:number)=>{
    await unsubscribe(f.e,'owner',{id:f.sub.id});f.advance(ms);
    await subscribe(f.e,'owner',subscription(),access,f.verified,f.start+ms);
  });
  await f.run();expect(f.transport).toHaveBeenCalledTimes(1);expect(f.notice).not.toHaveBeenCalled();
});
it('deletes revoked access without callback or notice',async()=>{
  const f=await fixture();f.deps.access=async()=>{throw new Failure('installation_revoked');};await f.run();
  expect(f.notice).not.toHaveBeenCalled();expect(f.sqlite.prepare('SELECT id FROM subscriptions').all()).toEqual([]);
});
it.each(['ambiguous_write','rate_limited'])('does not retry a notice after %s or store its outcome',async(reason)=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:410}));f.notice.mockRejectedValue(new Failure(reason));
  await f.run();expect(f.notice).toHaveBeenCalledTimes(1);
});
it('drops an expired invocation without replay while retaining its active subscription',async()=>{
  const f=await fixture();f.advance(30000);expect(await f.run()).toEqual({processed:0});
  expect(f.notice).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
  expect(f.sqlite.prepare('SELECT id FROM subscriptions').all()).toHaveLength(1);
});
it('does not retain recovery state if the invocation is interrupted',async()=>{
  const f=await fixture();f.transport.mockResolvedValue(new Response(null,{status:503}));
  f.deps.sleep.mockRejectedValue(new Error('simulated worker termination'));
  await expect(f.run()).rejects.toThrow('simulated worker termination');
  expect(f.transport).toHaveBeenCalledTimes(1);expect(f.notice).not.toHaveBeenCalled();
  // There is no stored event/job to resume; a later invocation needs a new ingress payload.
  expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toEqual([{name:'subscriptions'}]);
});
it('ignores redundant app_mention notifications and derives mentions from canonical messages',async()=>{
  const f=await fixture();expect(normalize(event({type:'app_mention'}),f.e)).toBeNull();
  expect(normalize(event({text:'hello <@UBOT>'}),f.e)?.data.mentions_bot).toBe(true);
  expect(normalize(event({text:'hello UBOT'}),f.e)?.data.mentions_bot).toBe(false);
});
it('rejects malformed/negative Retry-After without inventing a future delay',()=>{
  expect(retryDelay('garbage',0)).toBe(0);expect(retryDelay('-1',0)).toBe(0);
});
