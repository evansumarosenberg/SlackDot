import type { Env } from '../runtime/config';
import { SLACK_CALL_MS } from '../events/budget';
import { createBolt } from './receiver';

// Call only after delivery access checks or a confirmed tool reply. Status is
// advisory: no retries, persistence, or propagation of failures to the caller.
export async function setSessionStatus(env:Env,conversation:string,thread:string,status:'processing'|'active',deadline=Date.now()+SLACK_CALL_MS):Promise<void> {
  const end=Math.min(deadline,Date.now()+SLACK_CALL_MS);
  if(Date.now()>=end) return;
  try {
    await createBolt(env,end).app.client.agents.sessions.setStatus({
      token:env.SLACK_BOT_TOKEN,channel_id:conversation,thread_ts:thread,status,
    });
  } catch { /* Feature unavailable, rate limit, timeout, or uncertain write: leave Slack's timeout to recover. */ }
}
