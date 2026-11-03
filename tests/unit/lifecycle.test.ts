import { describe,it,expect,vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { database } from '../support/database';
import { env,event,secret,subscription,access } from '../support/fixtures';
import { CallbackClient, callbackUrl, validateSecret } from '../../lib/events/callback';
import { subscribe,unsubscribe } from '../../lib/events/subscriptions';
import { cleanup } from '../../lib/storage';
import { receiveSlack } from '../../lib/slack/receiver';
import { normalize } from '../../lib/slack/normalize';
import { encrypt,decrypt } from '../../lib/runtime/crypto';
const verified=()=>new CallbackClient('https://receiver.example.com',async(_url,init)=>Response.json({challenge:JSON.parse(init.body as string).challenge}));
const count=(sqlite:DatabaseSync)=>sqlite.prepare('SELECT count(*) n FROM subscriptions').get()!.n;

describe('subscription lifecycle',()=>{
  it.each([
    [undefined,259200000],[null,259200000],[1000,1000],
    [172800000,172800000],[259200000,259200000],[345600000,259200000],
  ])('grants requested lifetime %s as %s milliseconds',async(ttlMs,granted)=>{
    const {db,sqlite,queries}=database(), e=env(db);
    const result=await subscribe(e,'owner',{...subscription(),ttlMs},access,verified(),1000);
    const expires=1000+granted!;
    expect(result.refreshBefore).toBe(new Date(expires).toISOString());
    expect(sqlite.prepare('SELECT expires_at FROM subscriptions').get()?.expires_at).toBe(expires);
    expect(queries.every(query=>query.includes('subscriptions')||query.includes('event_dedup'))).toBe(true);
  });
  it('deletes canonical subscription identity without affecting another owner or filter',async()=>{
    const {db,sqlite}=database(),e=env(db),args={conversation_id:'CTEST',thread_ts:'1793640000.123456'};
    const first=await subscribe(e,'owner',subscription(args),access,verified(),1000);
    const second=await subscribe(e,'owner',subscription(),access,verified(),1000);
    const stop={name:'slack.message.created',arguments:{thread_ts:args.thread_ts,conversation_id:args.conversation_id},
      delivery:{mode:'webhook',url:'https://receiver.example.com/callback'}};
    await unsubscribe(e,'stranger',stop,2000);
    expect(sqlite.prepare('SELECT active FROM subscriptions WHERE id=?').get(first.id)?.active).toBe(1);
    await unsubscribe({...e,CALLBACK_ALLOWED_ORIGINS:''},'owner',stop,2000);
    expect(await unsubscribe(e,'owner',stop,2000)).toEqual({});
    expect(sqlite.prepare('SELECT * FROM subscriptions WHERE id=?').get(first.id)).toBeUndefined();
    expect(sqlite.prepare('SELECT id FROM subscriptions').all()).toEqual([{id:second.id}]);
  });
  it('keeps the legacy ID unsubscribe owner-scoped and idempotent',async()=>{
    const {db,sqlite}=database(),e=env(db);
    const sub=await subscribe(e,'owner',subscription(),access,verified(),1000);
    await unsubscribe(e,'stranger',{id:sub.id},2000);
    expect(count(sqlite)).toBe(1);
    await unsubscribe(e,'owner',{id:sub.id},2000);
    expect(await unsubscribe(e,'owner',{id:sub.id},2000)).toEqual({});
    expect(count(sqlite)).toBe(0);
  });
  it('reverifies an expired subscription with its stable identity and new creation time',async()=>{
    const {db,sqlite}=database(),e=env(db),callback=verified(),verify=vi.spyOn(callback,'verify');
    const first=await subscribe(e,'owner',subscription(),access,callback,1000);
    const second=await subscribe(e,'owner',subscription(),access,callback,259201000);
    expect(first.id).toBe(second.id);expect(verify).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT created_at FROM subscriptions').get()?.created_at).toBe(259201000);
    expect(count(sqlite)).toBe(1);
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
    expect(await decrypt(row.previous_secret,e.SUBSCRIPTION_ENCRYPTION_KEY,row.id)).toBe(secret);
    expect(row.previous_secret_expires_at).toBe(63000);
    expect(row.created_at).toBe(1000);expect(count(sqlite)).toBe(1);
  });
  it('preserves a rotation overlap without extending it on same-key refresh, then removes the old key',async()=>{
    const {db,sqlite}=database(),e=env(db),input=subscription();
    await subscribe(e,'owner',input,access,verified(),1000);
    const rotated={...input,delivery:{...input.delivery,secret:`whsec_${Buffer.alloc(32,8).toString('base64')}`}};
    await subscribe(e,'owner',rotated,access,verified(),2000);
    await subscribe(e,'owner',rotated,access,verified(),3000);
    expect(sqlite.prepare('SELECT previous_secret_expires_at FROM subscriptions').get()?.previous_secret_expires_at).toBe(62000);
    await cleanup(e,61999);
    expect(sqlite.prepare('SELECT previous_secret FROM subscriptions').get()?.previous_secret).toBeTypeOf('string');
    await cleanup(e,62000);
    expect(sqlite.prepare('SELECT previous_secret,previous_secret_expires_at FROM subscriptions').get()).toEqual({previous_secret:null,previous_secret_expires_at:null});
    expect(count(sqlite)).toBe(1);
  });
  it('retains only the immediately previous active key and caps overlap to subscription expiry',async()=>{
    const {db,sqlite}=database(),e=env(db),input=subscription();
    await subscribe(e,'owner',input,access,verified(),1000);
    const second={...input,delivery:{...input.delivery,secret:`whsec_${Buffer.alloc(32,8).toString('base64')}`}};
    await subscribe(e,'owner',second,access,verified(),2000);
    const third={...input,ttlMs:5000,delivery:{...input.delivery,secret:`whsec_${Buffer.alloc(32,9).toString('base64')}`}};
    await subscribe(e,'owner',third,access,verified(),3000);
    const row=sqlite.prepare('SELECT * FROM subscriptions').get() as any;
    expect(await decrypt(row.previous_secret,e.SUBSCRIPTION_ENCRYPTION_KEY,row.id)).toBe(second.delivery.secret);
    expect(row.previous_secret_expires_at).toBe(8000);
    await subscribe(e,'owner',input,access,verified(),8000);
    expect(sqlite.prepare('SELECT previous_secret,previous_secret_expires_at FROM subscriptions').get()).toEqual({previous_secret:null,previous_secret_expires_at:null});
  });
  it('does not replace current or previous signing keys when a rotation challenge fails',async()=>{
    const {db,sqlite}=database(),e=env(db),input=subscription();
    await subscribe(e,'owner',input,access,verified(),1000);
    const before=sqlite.prepare('SELECT secret,secret_hash,previous_secret,previous_secret_expires_at FROM subscriptions').get();
    const changed={...input,delivery:{...input.delivery,secret:`whsec_${Buffer.alloc(32,8).toString('base64')}`}};
    const rejected=new CallbackClient('https://receiver.example.com',async()=>Response.json({challenge:'incorrect'}));
    await expect(subscribe(e,'owner',changed,access,rejected,2000)).rejects.toThrow('challenge_failed');
    expect(sqlite.prepare('SELECT secret,secret_hash,previous_secret,previous_secret_expires_at FROM subscriptions').get()).toEqual(before);
  });
  it('removes expired and legacy inactive rows in bounded batches, preserving current subscriptions',async()=>{
    const {db,sqlite}=database(),e=env(db);
    const sub=await subscribe(e,'owner',subscription(),access,verified(),1000);
    for(let index=0;index<105;index++) sqlite.prepare(`INSERT INTO subscriptions(id,owner,name,args,conversation,thread,callback,secret,secret_hash,verified_at,created_at,expires_at,active) SELECT ?,owner,name,args,conversation,thread,callback,secret,secret_hash,verified_at,created_at,?,? FROM subscriptions WHERE id=?`)
      .run(`stale-${index}`,index%2?1000:999999, index%2?1:0,sub.id);
    await cleanup(e,2000);expect(count(sqlite)).toBe(6);
    await cleanup(e,2000);expect(count(sqlite)).toBe(1);
    expect(sqlite.prepare('SELECT id FROM subscriptions').get()?.id).toBe(sub.id);
  });
  it('fails callback challenge without storing an active subscription',async()=>{
    const {db,sqlite}=database();
    await expect(subscribe(env(db),'owner',subscription(),access,new CallbackClient('https://receiver.example.com',async()=>Response.json({challenge:'wrong'})),1000)).rejects.toThrow('challenge_failed');
    expect(count(sqlite)).toBe(0);
  });
  it('removes all historical operational tables and rows without changing subscription fields',()=>{
    const sqlite=new DatabaseSync(':memory:');
    try {
      sqlite.exec(readFileSync('drizzle/0000_broken_white_queen.sql','utf8'));
      sqlite.exec(readFileSync('drizzle/0001_sweet_jack_flag.sql','utf8'));
      sqlite.exec(`INSERT INTO subscriptions VALUES ('sub','owner','slack.message.created','{}','CTEST',NULL,'https://receiver.example.com','encrypted','hash',1,1,999999,1);
        INSERT INTO receipts VALUES ('receipt',1);
        INSERT INTO events VALUES ('event','CTEST','1.000001','synthetic payload',1);
        INSERT INTO deliveries(event_id,subscription_id,state,next_at,deadline) VALUES ('event','sub','pending',1,2);
        INSERT INTO writes VALUES ('write','hash','completed','synthetic result',1);
        INSERT INTO delivery_notices VALUES ('event','sent',NULL,'synthetic result',1);`);
      const before=sqlite.prepare('SELECT * FROM subscriptions').all();
      sqlite.exec(readFileSync('drizzle/0002_black_cammi.sql','utf8'));
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'subscriptions'}]);
      expect(sqlite.prepare('SELECT * FROM subscriptions').all()).toEqual(before);
      sqlite.exec(readFileSync('drizzle/0003_majestic_captain_flint.sql','utf8'));
      expect(sqlite.prepare('SELECT * FROM subscriptions').all()).toEqual(before.map(row=>({...row,previous_secret:null,previous_secret_expires_at:null})));
    } finally { sqlite.close(); }
  });
  it('guards the application DB interface against operational queries',()=>{
    const {db}=database();
    expect(()=>db.prepare('SELECT * FROM events')).toThrow('subscriptions or opaque dedup state only');
    expect(()=>db.prepare('SELECT * FROM subscriptions JOIN writes')).toThrow('subscriptions or opaque dedup state only');
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
  it('verifies raw Slack signatures and installation context before in-memory acceptance',async()=>{
    const {db,queries}=database(),e=env(db),now=Date.now();
    function request(body:unknown,ts=Math.floor(now/1000),bad=false) {
      const raw=JSON.stringify(body),signature=createHmac('sha256',e.SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex');
      return new Request('https://site.example/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':String(ts),'x-slack-signature':`v0=${bad?'0'.repeat(64):signature}`},body:raw});
    }
    const accepted=vi.fn();
    expect((await receiveSlack(request(event(),undefined,true),e,now,accepted)).status).toBe(401);
    expect((await receiveSlack(request(event(),Math.floor(now/1000)-301),e,now,accepted)).status).toBe(401);
    expect((await receiveSlack(request({...event(),team_id:'TOTHER'}),e,now,accepted)).status).toBe(403);
    expect(await (await receiveSlack(request({type:'url_verification',challenge:'challenge'}),e,now,accepted)).json()).toEqual({challenge:'challenge'});
    expect(accepted).not.toHaveBeenCalled();
    expect((await receiveSlack(request(event()),e,now,accepted)).status).toBe(200);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted.mock.calls[0][0]).toEqual(normalize(event(),e));
    expect(queries).toEqual([]);
  });
});
