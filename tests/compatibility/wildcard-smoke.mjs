// Built Worker integration with synthetic Slack and callback services only.
import {Miniflare} from 'miniflare';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {Webhook} from 'standardwebhooks';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/server/validators/cf-worker';

const root=resolve('dist/server'),fixture=JSON.parse(readFileSync('tests/fixtures/mcp-discover.json','utf8'));
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`,ts='1793640000.123456';
const observed=[],accessed=[],statuses=[];let identities=0,sequence=0;
const runtime=new Miniflare({modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),
  assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
  bindings:{SLACK_SESSION_STATUS_ENABLED:'1',OWNER_USER_ID:'owner',SITES_IDENTITY_VERIFIED:'true',SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_TEAM_ID:'TTEST',SLACK_BOT_ID:'BBOT',SLACK_BOT_USER_ID:'UBOT',SLACK_APP_ID:'ATEST',SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),CALLBACK_ALLOWED_ORIGINS:'https://receiver.example.com'},
  outboundService:async request=>{
    const url=new URL(request.url),raw=await request.text();
    if(url.origin==='https://receiver.example.com') {
      const data=new Webhook(secret).verify(raw,Object.fromEntries(request.headers));
      if(data.type==='verification')return Response.json({challenge:data.challenge});
      assert.equal(request.headers.get('webhook-id'),data.eventId);
      assert.notEqual(data.data.conversation_id,'*');
      observed.push({subscription:request.headers.get('x-mcp-subscription-id'),...data});
      return new Response(null,{status:204});
    }
    assert.equal(url.origin,'https://slack.com');
    const method=url.pathname.split('/').pop(),body=request.headers.get('content-type')?.includes('json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));
    if(method==='auth.test'){identities++;return Response.json({ok:true,team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});}
    if(method==='conversations.info') {
      assert.notEqual(body.channel,'*');accessed.push(body.channel);
      if(body.channel==='CLEFT')return Response.json({ok:false,error:'not_in_channel'});
      if(body.channel==='CSCOPE')return Response.json({ok:false,error:'missing_scope'});
      return Response.json({ok:true,channel:{id:body.channel,is_member:body.channel!=='CUNJOINED',is_private:body.channel==='GPRIVATE',is_im:body.channel==='DTEST',is_mpim:body.channel==='GMPIM',is_archived:body.channel==='CARCHIVED',context_team_id:body.channel==='CFOREIGN'?'TOTHER':'TTEST'}});
    }
    if(method==='agents.sessions.setStatus') {
      assert.notEqual(body.channel_id,'*');assert.equal(body.status,'processing');statuses.push(body);return Response.json({ok:true});
    }
    throw new Error(`Unexpected synthetic method: ${method}`);
  }});
const waitFor=async predicate=>{
  const end=Date.now()+5000;
  while(!await predicate()) {assert.ok(Date.now()<end,'Timed out waiting for Worker delivery');await new Promise(resolve=>setTimeout(resolve,20));}
};
try {
  const db=await runtime.getD1Database('DB');
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync(`drizzle/${file}`,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  async function rpc(method,params={}) {
    const response=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'Mcp-Method':method,'Mcp-Name':params.name??'','oai-authenticated-user-id':'owner'},body:JSON.stringify({...fixture.request,method,params:{...fixture.request.params,...params}})});
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.error,undefined,JSON.stringify(data));return data.result;
  }
  const subscribe=(name,conversation='*',filters={})=>rpc('events/subscribe',{name,arguments:{conversation_id:conversation,...filters},delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret}});
  async function ingress(name,channel,marker=++sequence,text='hello <@UBOT>') {
    const message={user:'UPERSON',ts:`1793640000.${String(marker).padStart(6,'0')}`,text};
    const event=name==='slack.message.created'?{type:'message',channel,...message}:
      name==='slack.message.updated'?{type:'message',channel,subtype:'message_changed',message,event_ts:ts}:
      name==='slack.message.deleted'?{type:'message',channel,subtype:'message_deleted',deleted_ts:message.ts,previous_message:message,event_ts:ts}:
      {type:name==='slack.reaction.added'?'reaction_added':'reaction_removed',user:'UPERSON',item_user:'UBOT',item:{type:'message',channel,ts:message.ts},reaction:'eyes',event_ts:ts};
    const raw=JSON.stringify({type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:`Ev${marker}`,event}),stamp=String(Math.floor(Date.now()/1000));
    const signature='v0='+createHmac('sha256','synthetic-signing-secret').update(`v0:${stamp}:${raw}`).digest('hex');
    const response=await runtime.dispatchFetch('http://localhost/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':stamp,'x-slack-signature':signature},body:raw});assert.equal(response.status,200);
    return marker;
  }
  const count=async(table,where='1=1')=>(await db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).first()).n;
  const catalog=await rpc('events/list');assert.equal(catalog.events.length,5);
  for(const definition of catalog.events) {
    const validate=new CfWorkerJsonSchemaValidator().getValidator(definition.inputSchema);
    assert.equal(validate({conversation_id:'*'}).valid,true);assert.equal(validate({conversation_id:'*',thread_ts:ts}).valid,false);
    const beforeAccess=accessed.length,beforeIdentity=identities;
    const sub=await subscribe(definition.name);
    assert.equal(accessed.length,beforeAccess);assert.equal(identities,beforeIdentity+1);
    for(const channel of ['CTEST','GPRIVATE']) {
      const before=observed.length,delivered=await count('event_dedup',"state='delivered'");
      await ingress(definition.name,channel);
      await waitFor(async()=>await count('event_dedup',"state='delivered'")===delivered+1);
      assert.equal(observed.length,before+1);assert.equal(observed.at(-1).data.conversation_id,channel);
      if(definition.name==='slack.message.created')await waitFor(()=>statuses.length===observed.filter(e=>e.name==='slack.message.created').length);
    }
    await rpc('events/unsubscribe',{id:sub.id});
  }
  const name='slack.message.created',wild=await subscribe(name,'*',{mentions_only:true}),exact=await subscribe(name,'CTEST',{mentions_only:true});
  let delivered=await count('event_dedup',"state='delivered'");const before=observed.length,beforeStatus=statuses.length;
  const marker=await ingress(name,'CTEST');await waitFor(async()=>await count('event_dedup',"state='delivered'")===delivered+2);
  await waitFor(()=>statuses.length===beforeStatus+1);
  assert.deepEqual(new Set(observed.slice(before).map(e=>e.subscription)),new Set([wild.id,exact.id]));
  await ingress(name,'CTEST',marker); // Same event must not reach either destination again.
  for(const channel of ['CLEFT','CUNJOINED','CARCHIVED','GMPIM','CFOREIGN']) {
    const failed=await count('event_dedup',"state='failed'");await ingress(name,channel);
    await waitFor(async()=>await count('event_dedup',"state='failed'")===failed+1);
    assert.equal(await count('subscriptions'),2);assert.equal(observed.length,before+2);assert.equal(statuses.length,beforeStatus+1);
  }
  await ingress(name,'DTEST',++sequence,'no mention');
  await ingress(name,'CNEW',++sequence,'no mention');
  // A later joined channel and explicit DM mention are covered without a refresh.
  for(const channel of ['CNEW','DTEST']) {
    delivered=await count('event_dedup',"state='delivered'");await ingress(name,channel);
    await waitFor(async()=>await count('event_dedup',"state='delivered'")===delivered+1);
  }
  await waitFor(()=>statuses.length===beforeStatus+3);
  assert.equal(observed.length,before+4);
  await ingress(name,'CSCOPE');await waitFor(async()=>await count('subscriptions')===1);
  assert.equal((await db.prepare('SELECT id FROM subscriptions').first()).id,exact.id);
  // Canonical wildcard removal still works after a permanent access failure.
  await rpc('events/unsubscribe',{name,arguments:{conversation_id:'*',mentions_only:true},delivery:{mode:'webhook',url:'https://receiver.example.com/callback'}});
  await rpc('events/unsubscribe',{id:exact.id});assert.equal(await count('subscriptions'),0);
  assert.equal(observed.length,before+4);assert.equal(statuses.length,beforeStatus+3);
  console.log(JSON.stringify({result:'PASS',events:catalog.events.length,callbacks:observed.length,wildcardAccessCalls:accessed.filter(id=>id==='*').length,checks:['discovery','identity','all-event-types','overlap','dedup','membership-loss','scope-loss','new-channel','dm-mentions','unsubscribe']}));
} finally {await runtime.dispose();}
