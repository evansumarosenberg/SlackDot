// Run after npm run build. Exercises the deployed bundle in workerd, not Node.
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
const callbackSecret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const triggerSecret='synthetic-trigger-secret-at-least-32-characters';
let verificationCalls=0,deliveryCalls=0;
const root=resolve('dist/server');
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
const runtime=new Miniflare({modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
  d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),
  bindings:{OWNER_USER_ID:'owner',SITES_IDENTITY_VERIFIED:'true',SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_TEAM_ID:'TTEST',SLACK_BOT_ID:'BBOT',SLACK_BOT_USER_ID:'UBOT',SLACK_APP_ID:'ATEST',
    SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),CALLBACK_ALLOWED_ORIGINS:'https://receiver.example.com',DELIVERY_TRIGGER_SECRET:triggerSecret},
  assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
  outboundService:async request=>{
    if(new URL(request.url).origin==='https://receiver.example.com') {
      assert.equal(request.method,'POST');
      assert.ok(request.headers.get('x-mcp-subscription-id')?.startsWith('sub_'));
      const payload=new Webhook(callbackSecret).verify(await request.text(),Object.fromEntries(request.headers));
      if(payload.type==='verification') {
        verificationCalls++;assert.equal(typeof payload.challenge,'string');
        return Response.json({challenge:payload.challenge});
      }
      deliveryCalls++;assert.equal(payload.name,'slack.message.created');
      assert.equal(payload.eventId,request.headers.get('webhook-id'));
      assert.equal(payload.data.text,'Synthetic delivery smoke');
      return new Response(null,{status:204});
    }
    assert.equal(new URL(request.url).origin,'https://slack.com');
    if(new URL(request.url).pathname==='/api/conversations.info') return Response.json({ok:true,channel:{id:'CTEST',is_member:true}});
    assert.equal(new URL(request.url).pathname,'/api/auth.test');
    return Response.json({ok:true,team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
  },
});
try {
  const health=await runtime.dispatchFetch('http://localhost/health');assert.equal(health.status,200);assert.equal((await health.json()).service,'SlackDot');
  const denied=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'forged'},body:'{}'});assert.equal(denied.status,403);
  const db=await runtime.getD1Database('DB');
  const sql=readFileSync('drizzle/0000_broken_white_queen.sql','utf8');
  for(const statement of sql.split('--> statement-breakpoint').map(v=>v.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare('INSERT INTO receipts(id,accepted_at) VALUES (?,?)').bind('synthetic-smoke',0).run();
  assert.equal((await db.prepare('SELECT count(*) n FROM receipts').first()).n,1);
  const body=JSON.stringify({type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:'EvSYNTHETIC',event:{type:'message',user:'UPERSON',channel:'CTEST',ts:'1793640000.123456',text:'Synthetic workerd smoke'}});
  const ts=String(Math.floor(Date.now()/1000)),signature='v0='+createHmac('sha256','synthetic-signing-secret').update(`v0:${ts}:${body}`).digest('hex');
  const start=performance.now();
  const received=await runtime.dispatchFetch('http://localhost/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':ts,'x-slack-signature':signature},body});
  assert.equal(received.status,200);assert.equal((await db.prepare('SELECT count(*) n FROM receipts').first()).n,2);
  const fixture=JSON.parse(readFileSync('tests/fixtures/mcp-discover.json','utf8'));
  const discovery=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'oai-authenticated-user-id':'owner'},body:JSON.stringify(fixture.request)});
  assert.equal(discovery.status,200);assert.deepEqual((await discovery.json()).result.capabilities,fixture.expectedResult.capabilities);
  const infoBody={...fixture.request,method:'tools/call',params:{...fixture.request.params,name:'slack_get_connection_info',arguments:{}}};
  const info=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'Mcp-Method':'tools/call','Mcp-Name':'slack_get_connection_info','oai-authenticated-user-id':'owner'},body:JSON.stringify(infoBody)});
  const infoResult=await info.json();assert.equal(infoResult.result.isError,undefined,JSON.stringify(infoResult));
  const eventParams={...fixture.request.params,name:'slack.message.created',arguments:{conversation_id:'CTEST'},ttlMs:null,
    delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret:callbackSecret}};
  async function eventCall(method,params) {
    const response=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'Mcp-Method':method,'Mcp-Name':'slack.message.created','oai-authenticated-user-id':'owner'},
      body:JSON.stringify({...fixture.request,method,params})});
    assert.equal(response.status,200);return response.json();
  }
  const subscription=await eventCall('events/subscribe',eventParams);
  assert.equal(subscription.error,undefined,JSON.stringify(subscription));
  assert.equal(verificationCalls,1);assert.ok(subscription.result.id.startsWith('sub_'));
  assert.equal((await db.prepare('SELECT count(*) n FROM subscriptions WHERE active=1').first()).n,1);
  const incoming=JSON.parse(body);incoming.event_id='EvDELIVERY';incoming.event.ts='1793640001.123456';incoming.event.text='Synthetic delivery smoke';
  const incomingBody=JSON.stringify(incoming),incomingSignature='v0='+createHmac('sha256','synthetic-signing-secret').update(`v0:${ts}:${incomingBody}`).digest('hex');
  assert.equal((await runtime.dispatchFetch('http://localhost/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':ts,'x-slack-signature':incomingSignature},body:incomingBody})).status,200);
  const delivered=await runtime.dispatchFetch('http://localhost/internal/deliver',{method:'POST',headers:{Authorization:`Bearer ${triggerSecret}`}});
  assert.equal(delivered.status,200);assert.equal((await delivered.json()).processed,1);assert.equal(deliveryCalls,1);
  assert.equal((await db.prepare("SELECT count(*) n FROM deliveries WHERE state='delivered'").first()).n,1);
  const {ttlMs,...stopParams}=eventParams;
  const stopped=await eventCall('events/unsubscribe',{...stopParams,delivery:{mode:'webhook',url:eventParams.delivery.url}});
  assert.equal(stopped.error,undefined);assert.ok(stopped.result);
  assert.equal((await db.prepare('SELECT count(*) n FROM subscriptions WHERE active=1').first()).n,0);
  console.log(JSON.stringify({result:'PASS',checks:['bundled Worker health','owner authorization','D1 migration/readback','Bolt signed ingress','MCP SDK discovery','signed callback verification using default transport','signed outbox delivery using authenticated trigger','canonical unsubscribe'],ingress_ms:Math.round(performance.now()-start)}));
} finally {await runtime.dispose();}
