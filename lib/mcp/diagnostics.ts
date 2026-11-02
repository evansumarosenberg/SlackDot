import { z } from 'zod';

const reasons=new Set(['configuration_missing','invalid_subscription_arguments','invalid_unsubscribe_arguments',
  'invalid_signing_secret','callback_policy_unconfigured','callback_destination_blocked','callback_redirect_blocked',
  'callback_transport_failed','challenge_failed','missing_scope','installation_revoked','installation_mismatch',
  'invalid_bot_identity','conversation_unavailable','slack_unavailable','rate_limited','subscription_failed']);
const fields=new Set(['name','arguments','conversation_id','thread_ts','delivery','mode','url','secret','cursor','ttlMs','id','_meta']);

// Never copy validation messages, rejected values, or unknown property names into logs.
export function schemaIssues(error:z.ZodError) {
  return error.issues.slice(0,12).map(issue=>({code:issue.code,
    path:issue.path.slice(0,6).map(key=>typeof key==='string' && fields.has(key)?key:'other').join('.') || 'root'}));
}
export function eventRequestSummary(params:unknown) {
  const p=params && typeof params==='object'?params as Record<string,unknown>:{};
  const delivery=p.delivery && typeof p.delivery==='object'?p.delivery as Record<string,unknown>:{};
  let origin:string|undefined;
  if(typeof delivery.url==='string' && delivery.url.length<=2048) try {
    const url=new URL(delivery.url);
    // Origin only, never credentials, paths, queries, or fragments. This is an untrusted
    // candidate for operator investigation, never input to the callback allowlist.
    if(url.protocol==='https:' && !url.username && !url.password && !url.port &&
      /^[a-z0-9.-]+$/.test(url.hostname) && url.hostname.includes('.') && url.hostname.length<=253) origin=url.origin;
  } catch { /* Do not log malformed URL text. */ }
  return {name_matches:p.name==='slack.message.created',arguments_present:!!p.arguments,
    delivery_present:!!p.delivery,signing_secret_present:typeof delivery.secret==='string',
    ttl_ms_state:p.ttlMs===undefined?'absent':p.ttlMs===null?'null':typeof p.ttlMs==='number'?'number':'other',
    callback_origin_candidate:origin};
}
export function eventResponseSummary(body:unknown) {
  const b=body && typeof body==='object'?body as Record<string,any>:{};
  const reason=b.error?.data?.reason;
  return {outcome:b.error?'rpc_error':b.result?'result':'invalid_envelope',
    error_code:typeof b.error?.code==='number'?b.error.code:undefined,
    reason:typeof reason==='string'?(reasons.has(reason)?reason:'other'):undefined};
}
