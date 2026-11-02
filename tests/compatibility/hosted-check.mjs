// Read-only public-boundary probe. Never enables identity trust or makes Slack calls.
import assert from 'node:assert/strict';
const base=process.env.SLACKDOT_SITE_URL;
if (!base || new URL(base).protocol!=='https:') throw new Error('Set SLACKDOT_SITE_URL to the deployed HTTPS Site origin');
for(const [label,headers] of [['anonymous',{}],['forged',{'oai-authenticated-user-id':'synthetic-forged-owner','oai-authenticated-user-email':'synthetic@example.com'}]]) {
  const r=await fetch(new URL('/mcp',base),{method:'POST',redirect:'manual',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'slack_get_connection_info',arguments:{}}})});
  assert.ok([401,403,503].includes(r.status));console.log(JSON.stringify({check:label,status:r.status}));
}
const health=await fetch(new URL('/health',base),{redirect:'manual'});assert.equal(health.status,200);assert.equal((await health.json()).service,'SlackDot');
const setup=await fetch(new URL('/setup',base),{redirect:'manual',headers:{'oai-authenticated-user-id':'synthetic-forged-owner','oai-authenticated-user-email':'synthetic@example.com'}});
const body=await setup.text();assert.ok(!body.includes('synthetic-forged-owner'));
console.log(JSON.stringify({check:'identity_headers_not_reflected',status:setup.status}));
console.log('These probes do not prove an owner call or native plugin compatibility.');
