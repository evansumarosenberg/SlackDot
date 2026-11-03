// Run after the Sites build. All outbound services and message contents are synthetic.
import {Miniflare} from 'miniflare';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
const scenario=process.argv.find(v=>v.startsWith('--scenario='))?.split('=')[1]??'success';
assert.ok(['success','retry','exhaustion','permanent','rate-limit','notice-failure','timeout','interrupt','fanout','duplicate'].includes(scenario));
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const root=resolve('dist/server'),fixture=JSON.parse(readFileSync('tests/fixtures/mcp-discover.json','utf8'));
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
let verifyCalls=0,callbackCalls=0,noticeCalls=0,ack=false,inflight=0,maxInflight=0;
const attempts=[];let release;
const gate=new Promise(resolve=>{release=resolve;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const options={modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),
  assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
  bindings:{OWNER_USER_ID:'owner',SITES_IDENTITY_VERIFIED:'true',SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_TEAM_ID:'TTEST',SLACK_BOT_ID:'BBOT',SLACK_BOT_USER_ID:'UBOT',SLACK_APP_ID:'ATEST',
    SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),CALLBACK_ALLOWED_ORIGINS:'https://receiver.example.com'},
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
      await gate;assert.equal(ack,true);
      if(scenario==='timeout'||scenario==='interrupt') {await pause(8000);return new Response(null,{status:503});}
      if(scenario==='fanout') {inflight++;maxInflight=Math.max(maxInflight,inflight);await pause(100);inflight--;}
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
    assert.equal(body.channel,'CTEST');assert.equal(body.thread_ts,'1793640001.123456');
    assert.ok(body.text.includes("couldn't confirm delivery"));
    assert.ok(body.text.includes('this delivery run'));
    if(scenario==='notice-failure') return Response.json({ok:false,error:'ratelimited'},{status:429,headers:{'retry-after':'60'}});
    return Response.json({ok:true,channel:'CTEST',ts:'1793640009.123456'});
  }};
let runtime=new Miniflare(options);
try {
  assert.equal((await runtime.dispatchFetch('http://localhost/health')).status,200);
  let db=await runtime.getD1Database('DB');
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())
    for(const sql of readFileSync(`drizzle/${file}`,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  // Assert the final migration's result; no payload/result tables are available to this Worker.
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map(r=>r.name);
  assert.deepEqual(tables,['subscriptions']);
  const setupHeaders={'oai-authenticated-user-email':'synthetic@example.com'};
  const outsider=await runtime.dispatchFetch('http://localhost/setup',{headers:{...setupHeaders,'oai-authenticated-user-id':'other'}});
  const outsiderHtml=await outsider.text();
  assert.ok(!outsiderHtml.includes('SLACK_BOT_TOKEN') && !outsiderHtml.includes('TTEST'));
  const ownerSetup=await runtime.dispatchFetch('http://localhost/setup',{headers:{...setupHeaders,'oai-authenticated-user-id':'owner'}});
  const ownerHtml=await ownerSetup.text();
  assert.ok(ownerHtml.includes('SLACK_BOT_TOKEN') && ownerHtml.includes('TTEST'));
  assert.ok(!ownerHtml.includes('synthetic-token') && !ownerHtml.includes('synthetic-signing-secret'));
  async function rpc(method,params) {
    const response=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'Mcp-Method':method,'Mcp-Name':params.name??'','oai-authenticated-user-id':'owner'},
      body:JSON.stringify({...fixture.request,method,params:{...fixture.request.params,...params}})});
    assert.equal(response.status,200);const json=await response.json();assert.equal(json.error,undefined,JSON.stringify(json));return json.result;
  }
  const discovery=await rpc('server/discover',{});assert.deepEqual(discovery.capabilities,fixture.expectedResult.capabilities);
  const info=await rpc('tools/call',{name:'slack_get_connection_info',arguments:{}});assert.equal(info.structuredContent.durable_trigger,'request_wait_until_bounded');
  const params={name:'slack.message.created',arguments:{conversation_id:'CTEST'},ttlMs:null,delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret}};
  const sub=await rpc('events/subscribe',params);assert.ok(sub.id.startsWith('sub_'));assert.equal(verifyCalls,1);
  if(scenario==='fanout') for(let i=1;i<6;i++) await rpc('events/subscribe',{...params,delivery:{...params.delivery,url:`https://receiver.example.com/callback/${i}`}});
  async function ingress(bot=false,badSignature=false) {
    const raw=JSON.stringify({type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:bot?'EvBOT':'EvDELIVERY',
      event:{type:'message',user:bot?'UBOT':'UPERSON',channel:'CTEST',ts:bot?'1793640009.123456':'1793640001.123456',text:'Synthetic bounded delivery smoke'}});
    const ts=String(Math.floor(Date.now()/1000)),sig='v0='+createHmac('sha256','synthetic-signing-secret').update(`v0:${ts}:${raw}`).digest('hex');
    return runtime.dispatchFetch('http://localhost/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':ts,'x-slack-signature':badSignature?'v0=invalid':sig},body:raw});
  }
  assert.equal((await ingress(false,true)).status,401);assert.equal(callbackCalls,0);
  const started=Date.now(),response=await ingress();
  assert.equal(response.status,200);const ackMs=Date.now()-started;ack=true;
  assert.ok(ackMs<3000);assert.equal(noticeCalls,0);release();
  if(scenario==='interrupt') {
    while(!callbackCalls) await pause(20);
    await runtime.dispose();runtime=new Miniflare(options);db=await runtime.getD1Database('DB');
    const count=callbackCalls,notices=noticeCalls;await runtime.dispatchFetch('http://localhost/health');await pause(250);
    assert.equal(callbackCalls,count);assert.equal(noticeCalls,notices);
    assert.equal((await db.prepare('SELECT count(*) n FROM subscriptions').first()).n,1);
    // No saved event resumes after restart. A separate Slack retry is a new invocation.
  } else {
    const success=['success','retry','fanout','duplicate'].includes(scenario);
    const expected=scenario==='fanout'?6:['success','duplicate','permanent','rate-limit'].includes(scenario)?1:scenario==='retry'?2:3;
    while(Date.now()-started<26000 && (success?callbackCalls<expected || inflight>0:noticeCalls<1)) await pause(50);
    await pause(200);
    assert.equal(callbackCalls,expected);assert.equal(noticeCalls,success?0:1);
    if(scenario==='fanout') assert.ok(maxInflight<=4 && maxInflight>1);
    for(const attempt of attempts) {assert.equal(attempt.raw,attempts[0].raw);assert.equal(attempt.headers['webhook-id'],attempts[0].headers['webhook-id']);}
    if(scenario==='retry') assert.notEqual(attempts[0].headers['webhook-signature'],attempts[1].headers['webhook-signature']);
    if(scenario==='duplicate') {
      await ingress();await pause(300);assert.equal(callbackCalls,2);
      assert.equal(attempts[0].headers['webhook-id'],attempts[1].headers['webhook-id']);
    }
    const before=callbackCalls;await ingress(true);await pause(100);assert.equal(callbackCalls,before);
    assert.ok(Date.now()-started<26000);
  }
  await rpc('events/unsubscribe',{name:params.name,arguments:params.arguments,delivery:{mode:'webhook',url:params.delivery.url}});
  assert.equal((await db.prepare('SELECT count(*) n FROM subscriptions WHERE id=?').bind(sub.id).first()).n,0);
  console.log(JSON.stringify({result:'PASS',scenario,ack_ms:ackMs,elapsed_ms:Date.now()-started,callback_attempts:callbackCalls,notice_attempts:noticeCalls,application_tables:tables}));
} finally {release();await runtime.dispose();}
