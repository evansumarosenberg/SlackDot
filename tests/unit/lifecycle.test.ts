import { describe,it,expect,vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { database } from '../support/database';
import { env,event,secret,subscription,access } from '../support/fixtures';
import { CallbackClient, callbackUrl, validateSecret } from '../../lib/events/callback';
import { subscribe,unsubscribe } from '../../lib/events/subscriptions';
import { acceptEvent } from '../../lib/storage';
import { drain } from '../../lib/events/delivery';
import { receiveSlack } from '../../lib/slack/receiver';
import { normalize } from '../../lib/slack/normalize';
import { encrypt,decrypt } from '../../lib/runtime/crypto';
import { Failure } from '../../lib/runtime/config';
const verified=()=>new CallbackClient('https://receiver.example.com',async(_url,init)=>Response.json({challenge:JSON.parse(init.body as string).challenge}));
const count=(sqlite:any,table:string)=>sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;

describe('durable event lifecycle',()=>{
  it.each([undefined,null,1000,172800000])('bounds requested lifetime %s by the server maximum',async(ttlMs)=>{
    const {db,sqlite}=database(), e=env(db);
    const result=await subscribe(e,'owner',{...subscription(),ttlMs},access,verified(),1000);
    const expires=1000+Math.min(ttlMs??86400000,86400000);
    expect(result.refreshBefore).toBe(new Date(expires).toISOString());
    expect(sqlite.prepare('SELECT expires_at FROM subscriptions').get()?.expires_at).toBe(expires);
  });
  it('unsubscribes by documented canonical identity without affecting another owner or filter',async()=>{
    const {db,sqlite}=database(),e=env(db),args={conversation_id:'CTEST',thread_ts:'1793640000.123456'};
    const first=await subscribe(e,'owner',subscription(args),access,verified(),1000);
    await subscribe(e,'owner',subscription(),access,verified(),1000);
    await acceptEvent(e,event(),2000);
    const stop={name:'slack.message.created',arguments:{thread_ts:args.thread_ts,conversation_id:args.conversation_id},
      delivery:{mode:'webhook',url:'https://receiver.example.com/callback'}};
    await unsubscribe(e,'stranger',stop);
    expect(sqlite.prepare('SELECT active FROM subscriptions WHERE id=?').get(first.id)?.active).toBe(1);
    await unsubscribe({...e,CALLBACK_ALLOWED_ORIGINS:''},'owner',stop);
    await unsubscribe(e,'owner',stop);
    expect(sqlite.prepare('SELECT active,secret FROM subscriptions WHERE id=?').get(first.id)).toEqual({active:0,secret:null});
    expect(sqlite.prepare('SELECT count(*) n FROM subscriptions WHERE active=1').get()?.n).toBe(1);
    expect(sqlite.prepare("SELECT count(*) n FROM deliveries WHERE state='cancelled'").get()?.n).toBe(1);
    expect(sqlite.prepare("SELECT count(*) n FROM deliveries WHERE state='pending'").get()?.n).toBe(1);
  });
  it('does not revive pending events when an expired subscription is recreated',async()=>{
    const {db,sqlite}=database(), e=env(db);
    await subscribe(e,'owner',subscription(),access,verified(),1000);await acceptEvent(e,event(),2000);
    await subscribe(e,'owner',subscription(),access,verified(),86402000);
    expect(sqlite.prepare('SELECT state FROM deliveries').get()?.state).toBe('cancelled');
  });
  it('canonical refresh rotates encrypted secrets and retains a stable identity',async()=>{
    const {db,sqlite}=database(), e=env(db), callback=verified();
    const spy=vi.spyOn(callback,'verify');
    const first=await subscribe(e,'owner',subscription({conversation_id:'CTEST',thread_ts:'1793640000.123456'}),access,callback,1000);
    const second=await subscribe(e,'owner',subscription({thread_ts:'1793640000.123456',conversation_id:'CTEST'}),access,callback,2000);
    expect(second.id).toBe(first.id);expect(spy).toHaveBeenCalledTimes(1);
    const changed=subscription({conversation_id:'CTEST',thread_ts:'1793640000.123456'});changed.delivery.secret=`whsec_${Buffer.alloc(32,8).toString('base64')}`;
    await subscribe(e,'owner',changed,access,callback,3000);expect(spy).toHaveBeenCalledTimes(2);
    const row=sqlite.prepare('SELECT * FROM subscriptions').get() as any;
    expect(row.secret).not.toContain('whsec_');expect(await decrypt(row.secret,e.SUBSCRIPTION_ENCRYPTION_KEY,row.id)).toBe(changed.delivery.secret);
    expect(row.created_at).toBe(1000);expect(count(sqlite,'subscriptions')).toBe(1);
  });
  it('deduplicates retries and message/mention overlap; does not replay to new subscriptions',async()=>{
    const {db,sqlite}=database(), e=env(db);
    await subscribe(e,'owner',subscription(),access,verified(),1000);
    await acceptEvent(e,event(),2000);await acceptEvent(e,event(),2001);
    await acceptEvent(e,{...event({type:'app_mention'}),event_id:'EvMENTION'},2002);
    expect(count(sqlite,'receipts')).toBe(2);expect(count(sqlite,'events')).toBe(1);expect(count(sqlite,'deliveries')).toBe(1);
    await subscribe(e,'owner',subscription({conversation_id:'CTEST',thread_ts:'1793640000.123456'}),access,verified(),3000);
    await acceptEvent(e,event(),4000);expect(count(sqlite,'deliveries')).toBe(1);
  });
  it('matches conversation and thread, excluding the bot and edits',async()=>{
    const {db,sqlite}=database(),e=env(db);
    await subscribe(e,'owner',subscription({conversation_id:'CTEST',thread_ts:'1793640000.123456'}),access,verified(),1000);
    for(const patch of [{user:'UBOT'},{bot_id:'BBOT'},{subtype:'message_changed'},{subtype:'message_deleted'},{subtype:'message_replied'},{channel:'COTHER'},{thread_ts:'1793640001.123456'}]) await acceptEvent(e,event(patch),2000);
    expect(count(sqlite,'deliveries')).toBe(0);
    expect(normalize(event(),e)?.data.message_ts).toBe('1793640000.123456');
  });
  it('fails callback challenge without storing an active subscription',async()=>{
    const {db,sqlite}=database();
    await expect(subscribe(env(db),'owner',subscription(),access,new CallbackClient('https://receiver.example.com',async()=>Response.json({challenge:'wrong'})),1000)).rejects.toThrow('challenge_failed');
    expect(count(sqlite,'subscriptions')).toBe(0);
  });
  it('recovers expired claims atomically and cancels unsubscribed pending work',async()=>{
    const {db,sqlite}=database(),e=env(db);let now=Date.now();
    const sub=await subscribe(e,'owner',subscription(),access,verified(),now);await acceptEvent(e,event(),now);
    sqlite.prepare("UPDATE deliveries SET state='claimed',claim='abandoned',lease_until=?").run(now-1);
    let sent=0;const callback=new CallbackClient(e.CALLBACK_ALLOWED_ORIGINS,async()=>{sent++;return new Response(null,{status:204});});
    await Promise.all([drain(e,access,callback,()=>now),drain(e,access,callback,()=>now)]);expect(sent).toBe(1);
    await acceptEvent(e,{...event({ts:'1793640001.123456'}),event_id:'EvNEXT'},now);
    await unsubscribe(e,'stranger',{id:sub.id});expect(sqlite.prepare('SELECT active FROM subscriptions').get()?.active).toBe(1);
    await unsubscribe(e,'owner',{id:sub.id});await unsubscribe(e,'owner',{id:sub.id});
    await drain(e,access,callback,()=>now);expect(sent).toBe(1);expect(sqlite.prepare('SELECT secret FROM subscriptions').get()?.secret).toBeNull();
  });
  it.each(['expired','revoked'])('stops delivery when %s',async(kind)=>{
    const {db,sqlite}=database(),e=env(db),now=Date.now();await subscribe(e,'owner',subscription(),access,verified(),now);await acceptEvent(e,event(),now);
    const post=vi.fn(async()=>new Response(null,{status:204}));
    await drain(e,kind==='revoked'?async()=>{throw new Failure('installation_revoked');}:access,new CallbackClient(e.CALLBACK_ALLOWED_ORIGINS,post),()=>now+(kind==='expired'?86400001:0));
    expect(post).not.toHaveBeenCalled();expect(sqlite.prepare('SELECT state FROM deliveries').get()?.state).toBe(kind==='expired'?'terminal':'cancelled');
  });
});
describe('security boundaries',()=>{
  it.each(['http://receiver.example.com/x','https://127.0.0.1/x','https://[::1]/x','https://localhost/x','https://receiver.example.com.evil.com/x','https://user:pass@receiver.example.com/x','https://receiver.example.com:444/x','https://receiver.example.com/x#fragment'])('blocks %s',url=>{
    expect(()=>callbackUrl(url,'https://receiver.example.com')).toThrow();
  });
  it('fails closed without verified callback origins and blocks redirects',async()=>{
    expect(()=>new CallbackClient().validate('https://receiver.example.com/x')).toThrow('callback_policy_unconfigured');
    expect(()=>callbackUrl('https://receiver.example.com/x','')).toThrow('callback_policy_unconfigured');
    const callback=new CallbackClient('https://receiver.example.com',async(_url,init)=>{expect(init.redirect).toBe('manual');return new Response(null,{status:302});});
    await expect(callback.verify('https://receiver.example.com/x',secret,'sub')).rejects.toThrow('callback_redirect_blocked');
    for(const key of ['bad','whsec_YQ==',`whsec_${Buffer.alloc(65).toString('base64')}`]) expect(()=>validateSecret(key)).toThrow();
  });
  it('authenticates ciphertext against its subscription ID',async()=>{
    const key=env({} as D1Database).SUBSCRIPTION_ENCRYPTION_KEY,encrypted=await encrypt(secret,key,'one');
    await expect(decrypt(encrypted,key,'two')).rejects.toThrow();
  });
  it('verifies raw Slack signatures, challenge, installation context and failed persistence',async()=>{
    const {db,sqlite}=database(),e=env(db),now=Date.now();
    function request(body:unknown,ts=Math.floor(now/1000),bad=false) {
      const raw=JSON.stringify(body),signature=createHmac('sha256',e.SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex');
      return new Request('https://site.example/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':String(ts),'x-slack-signature':`v0=${bad?'0'.repeat(64):signature}`},body:raw});
    }
    expect((await receiveSlack(request(event(),undefined,true),e,now)).status).toBe(401);
    expect((await receiveSlack(request(event(),Math.floor(now/1000)-301),e,now)).status).toBe(401);
    expect((await receiveSlack(request({...event(),team_id:'TOTHER'}),e,now)).status).toBe(403);
    expect(await (await receiveSlack(request({type:'url_verification',challenge:'challenge'}),e,now)).json()).toEqual({challenge:'challenge'});
    expect(count(sqlite,'receipts')).toBe(0);
    expect((await receiveSlack(request(event()),e,now)).status).toBe(200);expect(count(sqlite,'receipts')).toBe(1);
    const broken={...e,DB:{prepare:db.prepare.bind(db),batch:async()=>{throw new Error('synthetic failure');}} as unknown as D1Database};
    expect((await receiveSlack(request(event()),broken,now)).status).toBe(503);
  });
});
