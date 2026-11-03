import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Exercise the real CLI with isolated synthetic HTTP responses; never contact a Site.
function probe(args:string[],statuses=[401,403],health=200,reflectIdentity=false) {
  const fixture={statuses,health,reflectIdentity};
  const source=`
    const fixture=${JSON.stringify(fixture)};
    let mcpCalls=0;
    globalThis.fetch=async (url)=>{
      if(url.pathname==='/mcp') return new Response('MCP fixture',{status:fixture.statuses[mcpCalls++]});
      if(url.pathname==='/health') return new Response(JSON.stringify({service:'SlackDot'}),{status:fixture.health});
      if(url.pathname==='/setup') return new Response(fixture.reflectIdentity?'synthetic-forged-owner':'Sign in',{status:307});
      throw new Error('Unexpected request');
    };
    process.argv=['node','hosted-check.mjs',...${JSON.stringify(args)}];
    await import('./tests/compatibility/hosted-check.mjs');
  `;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{
    encoding:'utf8',env:{...process.env,SLACKDOT_SITE_URL:'https://site.example'},timeout:10000,
  });
  if(result.error) throw result.error;
  return result;
}

describe('hosted boundary check CLI',()=>{
  it('accepts unpublished 404 only in explicit pre-publication mode',()=>{
    const result=probe(['--pre-publication'],[404,404]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"check":"forged","status":404,"phase":"pre-publication"');
    expect(result.stdout).toContain('do not establish MCP readiness');
  });
  it('allows unconfigured 503 before publication without claiming readiness',()=>{
    const result=probe(['--pre-publication'],[503,503]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Rerun with --post-publication');
  });
  for(const args of [[],['--post-publication']]) {
    it(`accepts 401/403 with ${args[0]??'the strict default'}`,()=>{
      expect(probe(args).status).toBe(0);
    });
    for(const status of [404,503]) {
      it(`rejects ${status} with ${args[0]??'the strict default'}`,()=>{
        const result=probe(args,[401,status]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(`"check":"forged","status":${status},"phase":"post-publication"`);
        expect(result.stderr).toContain(`forged: expected 401/403 during post-publication, received ${status}`);
      });
    }
  }
  for(const args of [['--pre-publication'],['--post-publication']]) {
    for(const status of [200,302]) {
      it(`rejects unexpected MCP ${status} with ${args[0]}`,()=>{
        const result=probe(args,[status,status]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(`"check":"anonymous","status":${status}`);
      });
    }
  }
  it('logs health status before a failed health assertion',()=>{
    const result=probe([],undefined,500);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('"check":"health","status":500');
  });
  it('still rejects reflected forged identity and logs the setup status',()=>{
    const result=probe([],undefined,200,true);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('"check":"identity_headers_not_reflected","status":307');
  });
  it('rejects unknown or conflicting phase arguments',()=>{
    for(const args of [['--pre-publish'],['--pre-publication','--post-publication']]) {
      const result=probe(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Usage:');
      expect(result.stdout).toBe('');
    }
  });
});
