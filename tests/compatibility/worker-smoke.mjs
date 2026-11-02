// Run after npm run build. Exercises the deployed bundle in workerd, not Node.
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const root=resolve('dist/server');
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
const runtime=new Miniflare({modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
  d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),
  bindings:{OWNER_USER_ID:'owner',SITES_IDENTITY_VERIFIED:'true',SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_TEAM_ID:'TTEST',SLACK_BOT_ID:'BBOT',SLACK_BOT_USER_ID:'UBOT',SLACK_APP_ID:'ATEST'},
  assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
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
  console.log(JSON.stringify({result:'PASS',checks:['bundled Worker health','owner authorization','D1 migration/readback','Bolt signed ingress','MCP SDK discovery'],ingress_ms:Math.round(performance.now()-start)}));
} finally {await runtime.dispose();}
