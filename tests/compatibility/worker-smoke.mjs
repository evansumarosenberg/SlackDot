// Run after npm run build. Exercises the deployed bundle in workerd, not Node.
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('dist/server');
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
const runtime=new Miniflare({modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
  d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),bindings:{}, assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
});
try {
  const health=await runtime.dispatchFetch('http://localhost/health');assert.equal(health.status,200);assert.equal((await health.json()).service,'SlackDot');
  const denied=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'forged'},body:'{}'});assert.equal(denied.status,503);
  const db=await runtime.getD1Database('DB');
  const sql=readFileSync('drizzle/0000_broken_white_queen.sql','utf8');
  for(const statement of sql.split('--> statement-breakpoint').map(v=>v.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare('INSERT INTO receipts(id,accepted_at) VALUES (?,?)').bind('synthetic-smoke',0).run();
  assert.equal((await db.prepare('SELECT count(*) n FROM receipts').first()).n,1);
  console.log('PASS: bundled Worker health, protected MCP, and D1 migration/readback');
} finally {await runtime.dispose();}
