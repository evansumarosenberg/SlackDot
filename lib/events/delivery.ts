import { Failure, type Env } from '../runtime/config';
import { decrypt } from '../runtime/crypto';
import {cleanup, type Subscription} from '../storage';
import { SlackService } from '../slack/service';
import type { MessageEvent } from '../slack/normalize';
import { CallbackClient } from './callback';
import { DELIVERY_MS, NOTICE_MS, MAX_ATTEMPTS, MIN_ATTEMPT_MS, retryDelay } from './budget';

interface Job {event_id:string;subscription_id:string;attempts:number;deadline:number;claim:string}
interface StoredEvent {id:string;payload:string;accepted_at:number}
export interface DeliveryDependencies {
  access?: (conversation:string, deadline:number)=>Promise<void>;
  callbacks?: CallbackClient;
  notice?: (event:MessageEvent,text:string,deadline:number)=>Promise<unknown>;
  clock?: ()=>number;
  sleep?: (ms:number)=>Promise<void>;
}
const revoked = ['installation_revoked','installation_mismatch','conversation_unavailable','missing_scope'];
const category = (e:unknown) => e instanceof Failure ? e.category : 'delivery_failed';

// An event owns one persisted deadline. A duplicate invocation cannot extend it.
export async function deliverEvent(env:Env,eventId:string,deps:DeliveryDependencies={}) {
  if(env.SITES_IDENTITY_VERIFIED!=='true' || !env.OWNER_USER_ID) throw new Failure('identity_boundary_unverified');
  const clock=deps.clock??Date.now, sleep=deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const access=deps.access??((id,deadline)=>new SlackService(env,deadline).access(id));
  const callbacks=deps.callbacks??new CallbackClient(env.CALLBACK_ALLOWED_ORIGINS);
  const stored=await env.DB.prepare('SELECT id,payload,accepted_at FROM events WHERE id=?').bind(eventId).first<StoredEvent>();
  if(!stored) return {processed:0};
  const payload=stored.payload;
  const deadline=stored.accepted_at+DELIVERY_MS, noticeDeadline=deadline+NOTICE_MS;
  // Clamp legacy long-lived jobs too, without reviving or deleting their evidence.
  await env.DB.prepare("UPDATE deliveries SET state='terminal',last_error='interrupted_expired',claim=NULL,lease_until=NULL WHERE event_id=? AND (state='pending' OR (state='claimed' AND lease_until<=?)) AND min(deadline,?)<=?")
    .bind(eventId,clock(),deadline,clock()).run();
  if(clock()>=deadline) return {processed:0};
  const event=JSON.parse(stored.payload) as MessageEvent;
  const rows=await env.DB.prepare("SELECT subscription_id FROM deliveries WHERE event_id=? AND (state='pending' OR (state='claimed' AND lease_until<=?)) ORDER BY subscription_id")
    .bind(eventId,clock()).all<{subscription_id:string}>();
  let index=0,processed=0;

  async function run(subscriptionId:string) {
    const claim=crypto.randomUUID(),now=clock();
    const job=await env.DB.prepare(`UPDATE deliveries SET state='claimed',claim=?,lease_until=?
      WHERE event_id=? AND subscription_id=? AND (state='pending' OR (state='claimed' AND lease_until<=?))
      RETURNING event_id,subscription_id,attempts,deadline,claim`)
      .bind(claim,noticeDeadline,eventId,subscriptionId,now).first<Job>();
    if(!job) return;
    processed++;
    const end=Math.min(deadline,job.deadline);
    const finish=async(state:string,reason:string|null)=>{
      const changed=await env.DB.prepare('UPDATE deliveries SET state=?,last_error=?,claim=NULL,lease_until=NULL WHERE event_id=? AND subscription_id=? AND claim=?')
        .bind(state,reason,eventId,subscriptionId,claim).run();
      if(changed.meta.changes) console.info(JSON.stringify({component:'delivery',event_id:eventId,state,reason,attempts:job.attempts}));
    };
    const current=()=>env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(subscriptionId).first<Subscription>();
    const active=(sub:Subscription|null)=>sub?.active && sub.owner===env.OWNER_USER_ID && sub.expires_at>clock() && sub.secret;
    while(true) {
      if(clock()+MIN_ATTEMPT_MS>=end) {await finish('terminal','delivery_budget_exhausted');return;}
      if(job.attempts>=MAX_ATTEMPTS) {await finish('terminal','retry_exhausted');return;}
      let sub=await current();
      if(!active(sub)) {await finish('cancelled','inactive_subscription');return;}
      const counted=await env.DB.prepare("UPDATE deliveries SET attempts=attempts+1 WHERE event_id=? AND subscription_id=? AND claim=? AND state='claimed'")
        .bind(eventId,subscriptionId,claim).run();
      if(!counted.meta.changes) return;
      job.attempts++;
      let reason='delivery_failed',requestedDelay=0;
      try {
        await access(sub!.conversation,end);
        sub=await current();
        const held=await env.DB.prepare("SELECT claim FROM deliveries WHERE event_id=? AND subscription_id=? AND state='claimed'").bind(eventId,subscriptionId).first<{claim:string}>();
        if(!active(sub)||held?.claim!==claim) {await finish('cancelled','inactive_subscription');return;}
        const secret=await decrypt(sub!.secret!,env.SUBSCRIPTION_ENCRYPTION_KEY,sub!.id);
        if(clock()>=end) throw new Failure('execution_deadline');
        const response=await callbacks.post(sub!.callback,secret,sub!.id,event.eventId,payload,clock(),end);
        requestedDelay=retryDelay(response.headers.get('retry-after'),clock());
        const status=response.status;
        await response.body?.cancel();
        if(response.ok) {await finish('delivered',null);return;}
        if(status===410||status===413||(status>=400&&status<500&&status!==429&&status!==408)) {
          await finish('terminal',`http_${status}`);return;
        }
        reason=`http_${status}`;
      } catch(e) {
        reason=category(e);
        if(revoked.includes(reason)) {
          await env.DB.prepare('UPDATE subscriptions SET active=0,secret=NULL WHERE id=?').bind(subscriptionId).run();
          await finish('cancelled',reason);return;
        }
        if(reason.startsWith('callback_destination')||['callback_policy_unconfigured','callback_redirect_blocked','payload_too_large'].includes(reason)) {
          await finish('terminal',reason);return;
        }
        if(e instanceof Failure) requestedDelay=(e.retryAfter??0)*1000;
      }
      if(job.attempts>=MAX_ATTEMPTS) {await finish('terminal','retry_exhausted');return;}
      const delay=Math.max(1000*2**(job.attempts-1),requestedDelay);
      if(clock()+delay+MIN_ATTEMPT_MS>=end) {
        await finish('terminal',requestedDelay?'retry_after_exceeds_budget':'delivery_budget_exhausted');return;
      }
      await env.DB.prepare('UPDATE deliveries SET next_at=?,last_error=? WHERE event_id=? AND subscription_id=? AND claim=?')
        .bind(clock()+delay,reason,eventId,subscriptionId,claim).run();
      if(clock()+delay+MIN_ATTEMPT_MS>=end) {await finish('terminal','delivery_budget_exhausted');return;}
      await sleep(delay);
    }
  }
  async function worker() {
    while(index<rows.results.length) await run(rows.results[index++].subscription_id);
  }
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,rows.results.length)},worker));
  if(outcomes.some(result=>result.status==='rejected')) throw new Failure('delivery_state_unavailable');
  if(clock()>=noticeDeadline) return {processed};
  // Atomic event-level notice claim. A success or an active claim elsewhere suppresses it.
  const noticeClaim=await env.DB.prepare(`INSERT OR IGNORE INTO delivery_notices(event_id,state,created_at)
    SELECT ?,'in_flight',? WHERE
    EXISTS (SELECT 1 FROM deliveries d JOIN subscriptions s ON s.id=d.subscription_id
      WHERE d.event_id=? AND d.state='terminal' AND d.last_error!='interrupted_expired' AND s.active=1 AND s.owner=? AND s.expires_at>?)
    AND NOT EXISTS (SELECT 1 FROM deliveries WHERE event_id=? AND state IN ('delivered','pending','claimed'))`)
    .bind(eventId,clock(),eventId,env.OWNER_USER_ID,clock(),eventId).run();
  if(!noticeClaim.meta.changes) return {processed};
  const attempts=await env.DB.prepare('SELECT max(attempts) n FROM deliveries WHERE event_id=?').bind(eventId).first<{n:number}>();
  const text=`SlackDot couldn't confirm delivery to ChatGPT${(attempts?.n??0)>1?' after several attempts':''}. No further automatic attempts will be made for this message.`;
  const send=deps.notice??((message,body,end)=>new SlackService(env,end).send({conversation_id:message.data.conversation_id,
    thread_ts:message.data.thread_ts,text:body,request_id:`delivery-notice-${message.eventId}`},env.OWNER_USER_ID));
  try {
    if(clock()>=noticeDeadline) throw new Failure('execution_deadline');
    const result=await send(event,text,Math.min(noticeDeadline,clock()+NOTICE_MS));
    await env.DB.prepare("UPDATE delivery_notices SET state='sent',result=? WHERE event_id=?")
      .bind(JSON.stringify(result??null),eventId).run();
    console.info(JSON.stringify({component:'delivery_notice',event_id:eventId,state:'sent'}));
  } catch(e) {
    const reason=category(e),state=reason==='ambiguous_write'?'ambiguous':'failed';
    await env.DB.prepare('UPDATE delivery_notices SET state=?,last_error=? WHERE event_id=?').bind(state,reason,eventId).run();
    console.info(JSON.stringify({component:'delivery_notice',event_id:eventId,state,reason}));
  }
  return {processed};
}

// Retained diagnostic: never resets deadlines or revives terminal jobs.
export async function drain(env:Env,access?:(id:string,deadline:number)=>Promise<void>,callbacks?:CallbackClient,clock=Date.now) {
  const events=await env.DB.prepare("SELECT DISTINCT event_id FROM deliveries WHERE state IN ('pending','claimed') LIMIT 10").all<{event_id:string}>();
  let processed=0;
  await Promise.all(events.results.map(async e=>{processed+=(await deliverEvent(env,e.event_id,{access,callbacks,clock})).processed;}));
  await cleanup(env,clock());
  return {processed};
}
