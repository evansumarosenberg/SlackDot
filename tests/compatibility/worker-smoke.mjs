// Run after the Sites build. Every outbound request is an isolated synthetic fixture.
import {Miniflare} from 'miniflare';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
const scenario=process.argv.find(v=>v.startsWith('--scenario='))?.split('=')[1]??'success';
assert.ok(['success','retry','exhaustion','permanent','rate-limit','notice-failure','timeout','interrupt','hosted-fixture'].includes(scenario));
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const root=resolve('dist/server'),fixture=JSON.parse(readFileSync('tests/fixtures/mcp-discover.json','utf8'));
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
let verifyCalls=0,callbackCalls=0,noticeCalls=0,ack=false;
const attempts=[];let release;
const gate=new Promise(resolve=>{release=resolve;});
const options={modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),
  assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
  bindings:{OWNER_USER_ID:'owner',SITES_IDENTITY_VERIFIED:'true',SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_TEAM_ID:'TTEST',SLACK_BOT_ID:'BBOT',SLACK_BOT_USER_ID:'UBOT',SLACK_APP_ID:'ATEST',
    SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),CALLBACK_ALLOWED_ORIGINS:'https://receiver.example.com',DELIVERY_TRIGGER_SECRET:'synthetic-trigger-secret-at-least-32-characters'},
  outboundService:async request=>{
    const url=new URL(request.url);
    if(url.origin==='https://receiver.example.com') {
      const raw=await request.text(),headers=Object.fromEntries(request.headers);
      const payload=new Webhook(secret).verify(raw,headers);
      assert.ok(headers['x-mcp-subscription-id'].startsWith('sub_'));
      if(payload.type==='verification') {verifyCalls++;return Response.json({challenge:payload.challenge});}
      callbackCalls++;attempts.push({raw,headers,at:Date.now()});
      assert.equal(payload.name,'slack.message.created');assert.equal(payload.eventId,headers['webhook-id']);
      assert.equal(payload.data.text,'Synthetic bounded delivery smoke');
      // Hold callback completion until the test has received Slack's HTTP acknowledgment.
      await gate;assert.equal(ack,true);
      if(scenario==='timeout'||scenario==='interrupt') {
        await new Promise(resolve=>setTimeout(resolve,8000));
        return new Response(null,{status:503});
      }
      const status=scenario==='permanent'?410:scenario==='rate-limit'?429:
        ['exhaustion','notice-failure'].includes(scenario)?503:scenario==='retry'&&callbackCalls===1?503:204;
      return new Response(null,{status,headers:scenario==='rate-limit'?{'retry-after':'60'}:{}});
    }
    assert.equal(url.origin,'https://slack.com');
    if(url.pathname==='/api/auth.test') return Response.json({ok:true,team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
    if(url.pathname==='/api/conversations.info') return Response.json({ok:true,channel:{id:'CTEST',is_member:true}});
    assert.equal(url.pathname,'/api/chat.postMessage');noticeCalls++;
    const raw=await request.text();
    const body=request.headers.get('content-type')?.includes('json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));
    assert.equal(body.channel,scenario==='hosted-fixture'?'C0CE0REVDU1':'CTEST');
    assert.equal(body.thread_ts,scenario==='hosted-fixture'?'1793662208.602689':'1793640001.123456');
    assert.ok(body.text.includes("couldn't confirm delivery"));
    if(scenario==='notice-failure') return Response.json({ok:false,error:'ratelimited'},{status:429,headers:{'retry-after':'60'}});
    return Response.json({ok:true,channel:'CTEST',ts:'1793640009.123456'});
  }};
let runtime=new Miniflare(options);
try {
  assert.equal((await runtime.dispatchFetch('http://localhost/health')).status,200);
  let db=await runtime.getD1Database('DB');
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())
    for(const sql of readFileSync(`drizzle/${file}`,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  async function rpc(method,params) {
    const response=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'Mcp-Method':method,'Mcp-Name':params.name??'','oai-authenticated-user-id':'owner'},
      body:JSON.stringify({...fixture.request,method,params:{...fixture.request.params,...params}})});
    assert.equal(response.status,200);const json=await response.json();assert.equal(json.error,undefined,JSON.stringify(json));return json.result;
  }
  const discovery=await rpc('server/discover',{});assert.deepEqual(discovery.capabilities,fixture.expectedResult.capabilities);
  const info=await rpc('tools/call',{name:'slack_get_connection_info',arguments:{}});assert.equal(info.structuredContent.durable_trigger,'request_wait_until_bounded');
  const params={name:'slack.message.created',arguments:{conversation_id:'CTEST'},ttlMs:null,delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret}};
  const sub=await rpc('events/subscribe',params);assert.ok(sub.id.startsWith('sub_'));assert.equal(verifyCalls,1);
  async function ingress(bot=false) {
    const raw=JSON.stringify({type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:bot?'EvBOT':'EvDELIVERY',
      event:{type:'message',user:bot?'UBOT':'UPERSON',channel:'CTEST',ts:bot?'1793640009.123456':'1793640001.123456',text:'Synthetic bounded delivery smoke'}});
    const ts=String(Math.floor(Date.now()/1000)),sig='v0='+createHmac('sha256','synthetic-signing-secret').update(`v0:${ts}:${raw}`).digest('hex');
    return runtime.dispatchFetch('http://localhost/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':ts,'x-slack-signature':sig},body:raw});
  }
  async function fixtureRequest(authorized=true) {
    return runtime.dispatchFetch('http://localhost/internal/deliver',{method:'POST',headers:{'x-slackdot-fixture':'bounded-failure-20261102',
      ...(authorized?{authorization:'Bearer synthetic-trigger-secret-at-least-32-characters'}:{})}});
  }
  if(scenario==='hosted-fixture') assert.equal((await fixtureRequest(false)).status,403);
  const started=Date.now(),response=await (scenario==='hosted-fixture'?fixtureRequest():ingress());
  assert.equal(response.status,scenario==='hosted-fixture'?202:200);const ackMs=Date.now()-started;ack=true;
  assert.ok(ackMs<3000);assert.equal(noticeCalls,0);release();
  if(scenario==='interrupt') {
    while(!callbackCalls) await new Promise(resolve=>setTimeout(resolve,20));
    await runtime.dispose();runtime=new Miniflare(options);db=await runtime.getD1Database('DB');
    // Persisted wall deadlines are aged only in this isolated fixture, not production.
    await db.prepare('UPDATE events SET accepted_at=accepted_at-30000').run();
    await db.prepare('UPDATE deliveries SET deadline=deadline-30000,lease_until=0').run();
    const count=callbackCalls;await ingress();await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(callbackCalls,count);assert.equal(noticeCalls,0);
    assert.equal((await db.prepare('SELECT last_error FROM deliveries').first()).last_error,'interrupted_expired');
  } else {
    const success=['success','retry'].includes(scenario);
    let row,notice;
    do {
      row=await db.prepare('SELECT * FROM deliveries').first();notice=await db.prepare('SELECT * FROM delivery_notices').first();
      if(success?row?.state==='delivered':row?.state==='terminal'&&notice&&notice.state!=='in_flight') break;
      await new Promise(resolve=>setTimeout(resolve,50));
    } while(Date.now()-started<27000);
    assert.equal(row.state,success?'delivered':'terminal');
    const expected=scenario==='success'||scenario==='permanent'||scenario==='rate-limit'?1:scenario==='retry'?2:3;
    assert.equal(callbackCalls,scenario==='hosted-fixture'?0:expected);assert.equal(row.attempts,expected);
    assert.equal(noticeCalls,success?0:1);
    if(!success) assert.equal(notice.state,scenario==='notice-failure'?'ambiguous':'sent');
    for(const attempt of attempts) {assert.equal(attempt.raw,attempts[0].raw);assert.equal(attempt.headers['webhook-id'],attempts[0].headers['webhook-id']);}
    if(attempts.length>1) assert.notEqual(attempts[0].headers['webhook-signature'],attempts[1].headers['webhook-signature']);
    const before=callbackCalls;
    if(scenario==='hosted-fixture') assert.equal((await fixtureRequest()).status,200);else await ingress();
    await ingress(true);await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(callbackCalls,before);assert.equal(noticeCalls,success?0:1);
    assert.equal((await db.prepare('SELECT count(*) n FROM deliveries').first()).n,1);
    assert.ok(Date.now()-started<26000);
  }
  await rpc('events/unsubscribe',{name:params.name,arguments:params.arguments,delivery:{mode:'webhook',url:params.delivery.url}});
  assert.equal((await db.prepare('SELECT count(*) n FROM subscriptions WHERE active=1').first()).n,0);
  console.log(JSON.stringify({result:'PASS',scenario,ack_ms:ackMs,elapsed_ms:Date.now()-started,callback_attempts:callbackCalls,notice_attempts:noticeCalls,manual_trigger_used:scenario==='hosted-fixture'}));
} finally {release();await runtime.dispose();}
