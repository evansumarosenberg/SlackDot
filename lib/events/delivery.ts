import { Failure, type Env } from '../runtime/config';
import { decrypt } from '../runtime/crypto';
import { cleanup, type Subscription } from '../storage';
import { SlackService } from '../slack/service';
import { setSessionStatus } from '../slack/session-status';
import { matchesEvent, timestamp, type SlackEvent } from '../slack/normalize';
import { CallbackClient } from './callback';
import { claimDelivery, finishDelivery, ownsClaim, type Claim } from './dedup';
import { DELIVERY_MS, NOTICE_MS, MAX_ATTEMPTS, MIN_ATTEMPT_MS, SLACK_CALL_MS, retryDelay } from './budget';

export interface DeliveryDependencies {
  access?: (conversation:string, deadline:number)=>Promise<void>;
  callbacks?: CallbackClient;
  notice?: (event:SlackEvent,text:string,deadline:number)=>Promise<unknown>;
  eventThread?: (conversation:string,messageTs:string,deadline:number)=>Promise<string|null>;
  processing?: (conversation:string,thread:string,deadline:number)=>Promise<void>;
  clock?: ()=>number;
  sleep?: (ms:number)=>Promise<void>;
}
interface Outcome { id:string; state:'delivered'|'failed'|'cancelled'|'suppressed'; attempts:number }
const revoked = ['installation_revoked','installation_mismatch','conversation_unavailable','not_found','not_in_conversation','missing_scope'];
const category = (e:unknown) => e instanceof Failure ? e.category : 'delivery_failed';

// Payloads and attempts remain invocation-local. Only opaque deduplication keys,
// delivery state and bounded claims survive a request; there is no replay queue.
export async function deliverEvent(env:Env,event:SlackEvent,acceptedAt:number,deps:DeliveryDependencies={}) {
  if(env.SITES_IDENTITY_VERIFIED!=='true' || !env.OWNER_USER_ID) throw new Failure('identity_boundary_unverified');
  const clock=deps.clock??Date.now, sleep=deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const access=deps.access??((id,deadline)=>new SlackService(env,deadline).access(id));
  const callbacks=deps.callbacks??new CallbackClient(env.CALLBACK_ALLOWED_ORIGINS);
  const deadline=acceptedAt+DELIVERY_MS, noticeDeadline=deadline+NOTICE_MS;
  await cleanup(env,clock());
  if(clock()>=deadline) return {processed:0};
  const rows=await env.DB.prepare(`SELECT id,thread FROM subscriptions WHERE owner=? AND active=1 AND expires_at>?
    AND created_at<=? AND name=? AND conversation=? ORDER BY id`)
    .bind(env.OWNER_USER_ID,clock(),acceptedAt,event.name,event.data.conversation_id).all<{id:string;thread:string|null}>();
  if((event.name==='slack.reaction.added'||event.name==='slack.reaction.removed'||event.name==='slack.message.updated') && event.data.thread_ts===null &&
    rows.results.some(sub=>sub.thread!==null) && clock()+MIN_ATTEMPT_MS<deadline) {
    const lookup=deps.eventThread??((conversation,messageTs,end)=>new SlackService(env,end).eventThread(conversation,messageTs));
    try {
      const thread=await lookup(event.data.conversation_id,event.data.message_ts,deadline);
      // All candidates have the same nullable thread field; preserve the rest
      // of each discriminated payload unchanged when adding verified metadata.
      if(thread && timestamp.safeParse(thread).success) event={...event,data:{...event.data,thread_ts:thread}} as SlackEvent;
    } catch { /* A failed live lookup leaves metadata unknown; unfiltered delivery can continue. */ }
  }
  const payload=JSON.stringify(event);
  const current=(id:string)=>env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(id).first<Subscription>();
  const active=(sub:Subscription|null)=>{
    if(!sub?.active || sub.owner!==env.OWNER_USER_ID || sub.created_at>acceptedAt || sub.expires_at<=clock() || !sub.secret) return false;
    try { return matchesEvent(event,sub.name,JSON.parse(sub.args)); }
    catch { return false; }
  };
  let index=0;
  const outcomes:Outcome[]=[];
  let processing:Promise<void>|undefined;

  async function run(id:string,claim:Claim):Promise<Outcome> {
    let attempts=0;
    const result=(state:Outcome['state']):Outcome=>({id,state,attempts});
    while(true) {
      let sub=await current(id);
      if(!active(sub)) return result('cancelled');
      if(clock()+MIN_ATTEMPT_MS>=deadline || attempts>=MAX_ATTEMPTS) return result('failed');
      if(!await ownsClaim(env,claim,clock())) return result('suppressed');
      attempts++;
      let requestedDelay=0;
      try {
        await access(sub!.conversation,deadline);
        sub=await current(id);
        if(!active(sub)) return result('cancelled');
        const secret=await decrypt(sub!.secret!,env.SUBSCRIPTION_ENCRYPTION_KEY,sub!.id);
        const previousSecret=sub!.previous_secret && (sub!.previous_secret_expires_at??0)>clock()
          ? await decrypt(sub!.previous_secret,env.SUBSCRIPTION_ENCRYPTION_KEY,sub!.id) : undefined;
        if(clock()>=deadline) throw new Failure('execution_deadline');
        if(!await ownsClaim(env,claim,clock())) return result('suppressed');
        const response=await callbacks.post(sub!.callback,secret,sub!.id,event.eventId,payload,clock(),deadline,
          (sub!.previous_secret_expires_at??0)>clock()?previousSecret:undefined);
        requestedDelay=retryDelay(response.headers.get('retry-after'),clock());
        const status=response.status;
        // A body cleanup failure must not turn confirmed acceptance into a retry.
        try { await response.body?.cancel(); } catch { /* Status is already known. */ }
        if(response.ok) {
          if(!processing && event.name==='slack.message.created' && timestamp.safeParse(event.data.thread_ts).success && clock()<noticeDeadline) {
            const update=deps.processing??((conversation,thread,end)=>setSessionStatus(env,conversation,thread,'processing',end));
            // Start on the first confirmed delivery, not after slower fanout
            // destinations finish. One attempt per invocation, within 25 seconds.
            processing=(async()=>{
              try {await update(event.data.conversation_id,event.data.thread_ts!,Math.min(noticeDeadline,clock()+SLACK_CALL_MS));}
              catch { /* Status failure must never cause callback redelivery. */ }
            })();
          }
          return result('delivered');
        }
        if(status>=400&&status<500&&status!==429&&status!==408) return result('failed');
      } catch(e) {
        const reason=category(e);
        if(revoked.includes(reason)) {
          await env.DB.prepare('DELETE FROM subscriptions WHERE id=? AND owner=?').bind(id,env.OWNER_USER_ID).run();
          return result('cancelled');
        }
        if(reason.startsWith('callback_destination')||['callback_policy_unconfigured','callback_redirect_blocked','payload_too_large'].includes(reason)) return result('failed');
        if(e instanceof Failure) requestedDelay=(e.retryAfter??0)*1000;
      }
      if(attempts>=MAX_ATTEMPTS) return result('failed');
      const delay=Math.max(1000*2**(attempts-1),requestedDelay);
      if(clock()+delay+MIN_ATTEMPT_MS>=deadline) return result('failed');
      await sleep(delay);
    }
  }
  async function worker() {
    while(index<rows.results.length) {
      const id=rows.results[index++].id;
      if(!active(await current(id))) {outcomes.push({id,state:'cancelled',attempts:0});continue;}
      if(clock()+MIN_ATTEMPT_MS>=deadline) {outcomes.push({id,state:'failed',attempts:0});continue;}
      // Fail closed on claim/storage errors: do not send an uncoordinated callback.
      const claim=await claimDelivery(env,event.eventId,id,clock());
      if(!claim) {outcomes.push({id,state:'suppressed',attempts:0});continue;}
      const outcome=await run(id,claim);
      outcomes.push(outcome);
      // Keep this outside the callback retry loop. A failed success-record write
      // leaves an expiring claim, never an immediate duplicate callback.
      try {await finishDelivery(env,claim,outcome.state==='delivered'?'delivered':'failed',clock());}
      catch { /* A later ingress may reclaim; callback acceptance remains true. */ }
    }
  }
  // All callbacks share one deadline and at most four run concurrently. A storage
  // failure loses this invocation; there is deliberately no later recovery job.
  await Promise.all(Array.from({length:Math.min(4,rows.results.length)},worker));
  await processing;
  const processed=outcomes.length;
  if(clock()>=noticeDeadline || outcomes.some(result=>result.state==='delivered'||result.state==='suppressed')) return {processed};
  const thread=event.data.thread_ts;
  // A deleted target or unknown thread is not a safe place for feedback. Never
  // infer a root from a reaction's message timestamp or retain lookup history.
  if(event.name==='slack.message.deleted' || typeof thread!=='string' || !timestamp.safeParse(thread).success) return {processed};
  const failed=outcomes.filter(result=>result.state==='failed');
  if(!failed.length) return {processed};
  // An unsubscribe/expiry observed after fanout is an intentional cancellation.
  let eligible=false;
  for(const result of failed) if(active(await current(result.id))) {eligible=true;break;}
  if(!eligible || clock()>=noticeDeadline) return {processed};
  const attempts=Math.max(...failed.map(result=>result.attempts));
  const text=`SlackDot couldn't confirm delivery to ChatGPT${attempts>1?' after several attempts':''}. No further automatic attempts will be made by this delivery run.`;
  const send=deps.notice??((message,body,end)=>new SlackService(env,end).send({conversation_id:message.data.conversation_id,
    thread_ts:thread,text:body},env.OWNER_USER_ID));
  try {
    await send(event,text,Math.min(noticeDeadline,clock()+NOTICE_MS));
  } catch { /* One best-effort notice; never retry an uncertain Slack write. */ }
  return {processed};
}
