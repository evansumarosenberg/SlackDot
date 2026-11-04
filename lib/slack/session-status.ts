import type { Env } from '../runtime/config';
import { SLACK_CALL_MS } from '../events/budget';
import { createBolt } from './receiver';

// Call only after delivery access checks or a confirmed tool reply. Status is
// advisory: no retries, persistence, or propagation of failures to the caller.
export async function setSessionStatus(env:Env,conversation:string,thread:string,status:'processing'|'active',deadline=Date.now()+SLACK_CALL_MS,messageTs=thread):Promise<void> {
  // Preserve existing installations when unset; explicitly configured values
  // Use reactions only for an explicit "0"; invalid values remain disabled.
  const mode=env.SLACK_SESSION_STATUS_ENABLED??'1';
  if(mode!=='1' && mode!=='0') return;
  const end=Math.min(deadline,Date.now()+SLACK_CALL_MS);
  if(Date.now()>=end) return;
  try {
    const client=createBolt(env,end).app.client;
    if(mode==='0') {
      if(status==='processing') {
        await client.reactions.add({token:env.SLACK_BOT_TOKEN,channel:conversation,timestamp:messageTs,name:'eyes'});
      } else {
        // No retained message IDs: find our reactions in the source thread.
        // Bound pagination and all removals by the same two-second deadline.
        let cursor:string|undefined;
        for(let page=0;page<10 && Date.now()<end;page++) {
          const result=await client.conversations.replies({token:env.SLACK_BOT_TOKEN,channel:conversation,ts:thread,limit:100,cursor});
          for(const message of result.messages??[]) {
            if(Date.now()>=end) return;
            if(!message.ts || !message.user || message.bot_id || message.user===env.SLACK_BOT_USER_ID ||
              !message.reactions?.some(reaction=>reaction.name==='eyes' && reaction.users?.includes(env.SLACK_BOT_USER_ID))) continue;
            try { await client.reactions.remove({token:env.SLACK_BOT_TOKEN,channel:conversation,timestamp:message.ts,name:'eyes'}); }
            catch { /* Continue cleanup within the shared budget; never retry. */ }
          }
          const next=result.response_metadata?.next_cursor;
          if(!next || next===cursor) break;
          cursor=next;
        }
      }
      return;
    }
    await client.agents.sessions.setStatus({
      token:env.SLACK_BOT_TOKEN,channel_id:conversation,thread_ts:thread,status,
    });
  } catch { /* Best effort: indicator failures never change delivery or send results. */ }
}
