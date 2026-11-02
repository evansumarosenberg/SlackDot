// Temporary hosted verification fixture. Its Worker import MUST be removed after verification.
// No user-selected destination or content; no real OpenAI request is made by this fixture.
import {CallbackClient} from '../../lib/events/callback';
import {deliverEvent} from '../../lib/events/delivery';
import {Failure,type Env} from '../../lib/runtime/config';
import {equal,encrypt,hash} from '../../lib/runtime/crypto';
const conversation='C0CE0REVDU1',thread='1793662208.602689';
const eventId=`evt_${hash(`bounded-failure-fixture:${conversation}:${thread}`)}`;
const subscriptionId='sub_bounded_failure_fixture_20261102';
class SyntheticFailure extends CallbackClient {
  override async post(...args:Parameters<CallbackClient['post']>):Promise<Response> {
    if(args[2]!==subscriptionId||args[3]!==eventId) throw new Error('fixture_scope_mismatch');
    console.info(JSON.stringify({component:'synthetic_delivery_fixture',event_id:eventId,outcome:'injected_transport_failure',openai_request_sent:false}));
    throw new Failure('synthetic_transient');
  }
}
export async function hostedFailureFixture(request:Request,env:Env,ctx:Pick<ExecutionContext,'waitUntil'>) {
  if(new URL(request.url).pathname!=='/internal/deliver'||request.headers.get('x-slackdot-fixture')!=='bounded-failure-20261102') return null;
  if(request.method!=='POST') return new Response(null,{status:405});
  if(!env.DELIVERY_TRIGGER_SECRET||env.DELIVERY_TRIGGER_SECRET.length<32||!equal(request.headers.get('authorization')??'',`Bearer ${env.DELIVERY_TRIGGER_SECRET}`)) return new Response(null,{status:403});
  if(env.SITES_IDENTITY_VERIFIED!=='true'||!env.OWNER_USER_ID||Date.now()>Date.parse('2026-11-03T01:00:00Z')) return new Response(null,{status:410});
  const existing=await env.DB.prepare('SELECT id FROM events WHERE id=?').bind(eventId).first();
  if(existing) return Response.json({synthetic_fixture:true,event_id:eventId,already_created:true});
  const now=Date.now();
  const claimed=await env.DB.prepare('INSERT OR IGNORE INTO receipts(id,accepted_at) VALUES (?,?)').bind(`fixture:${eventId}`,now).run();
  if(!claimed.meta.changes) return Response.json({synthetic_fixture:true,event_id:eventId,already_created:true});
  const event={eventId,name:'slack.message.created',timestamp:new Date(now).toISOString(),cursor:null,
    data:{workspace_id:env.SLACK_TEAM_ID,conversation_id:conversation,message_ts:thread,thread_ts:thread,
      author_id:env.SLACK_BOT_USER_ID,text:'Synthetic bounded-delivery failure fixture',truncated:false,is_bot:true,mentions_bot:false}};
  const secret=await encrypt(`whsec_${Buffer.alloc(32,9).toString('base64')}`,env.SUBSCRIPTION_ENCRYPTION_KEY,subscriptionId);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO events(id,conversation,thread,payload,accepted_at) VALUES (?,?,?,?,?)').bind(eventId,conversation,thread,JSON.stringify(event),now),
    env.DB.prepare(`INSERT OR IGNORE INTO subscriptions(id,owner,name,args,conversation,thread,callback,secret,secret_hash,verified_at,created_at,expires_at,active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(subscriptionId,env.OWNER_USER_ID,event.name,JSON.stringify({conversation_id:conversation,thread_ts:thread}),conversation,thread,
      'https://synthetic.invalid/never-requested',secret,'synthetic',now,now,now+25000),
    env.DB.prepare("INSERT OR IGNORE INTO deliveries(event_id,subscription_id,state,attempts,next_at,deadline) SELECT ?,?,'pending',0,accepted_at,accepted_at+20000 FROM events WHERE id=?")
      .bind(eventId,subscriptionId,eventId),
  ]);
  ctx.waitUntil(deliverEvent(env,eventId,{callbacks:new SyntheticFailure()})
    .catch(()=>console.error(JSON.stringify({component:'synthetic_delivery_fixture',event_id:eventId,outcome:'failed'})))
    .finally(async()=>{await env.DB.prepare('UPDATE subscriptions SET active=0,secret=NULL WHERE id=?').bind(subscriptionId).run();}));
  return Response.json({synthetic_fixture:true,event_id:eventId,scheduled:true},{status:202});
}
