// Read-only public-boundary probe. Never enables identity trust or makes Slack calls.
import assert from 'node:assert/strict';
const args=process.argv.slice(2);
if (args.length>1 || (args.length===1 && !['--pre-publication','--post-publication'].includes(args[0]))) {
  throw new Error('Usage: node tests/compatibility/hosted-check.mjs [--pre-publication|--post-publication] (default: --post-publication)');
}
const phase=args[0]==='--pre-publication' ? 'pre-publication' : 'post-publication';
const rejectionStatuses=phase==='pre-publication' ? [401,403,404,503] : [401,403];
const report=(check,status)=>console.log(JSON.stringify({check,status,phase}));
const base=process.env.SLACKDOT_SITE_URL;
if (!base || new URL(base).protocol!=='https:') throw new Error('Set SLACKDOT_SITE_URL to the deployed HTTPS Site origin');
for(const [label,headers] of [['anonymous',{}],['forged',{'oai-authenticated-user-id':'synthetic-forged-owner','oai-authenticated-user-email':'synthetic@example.com'}]]) {
  const r=await fetch(new URL('/mcp',base),{method:'POST',redirect:'manual',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'slack_get_connection_info',arguments:{}}})});
  report(label,r.status);
  assert.ok(rejectionStatuses.includes(r.status),`${label}: expected ${rejectionStatuses.join('/')} during ${phase}, received ${r.status}`);
}
const health=await fetch(new URL('/health',base),{redirect:'manual'});
report('health',health.status);
assert.equal(health.status,200,'health: expected HTTP 200');assert.equal((await health.json()).service,'SlackDot');
const setup=await fetch(new URL('/setup',base),{redirect:'manual',headers:{'oai-authenticated-user-id':'synthetic-forged-owner','oai-authenticated-user-email':'synthetic@example.com'}});
report('identity_headers_not_reflected',setup.status);
const body=await setup.text();assert.ok(!body.includes('synthetic-forged-owner'));
if (phase==='pre-publication') console.log('Pre-publication checks allow an unpublished or unconfigured MCP endpoint; they do not establish MCP readiness. Rerun with --post-publication after publishing.');
console.log('These probes do not prove an owner call or native plugin compatibility.');
