import { requireChatGPTUser } from '../chatgpt-auth';
import { env } from 'cloudflare:workers';
import { SlackService } from '../../lib/slack/service';
import { Failure, type Env } from '../../lib/runtime/config';
export const dynamic='force-dynamic';
export default async function Setup() {
  const user=await requireChatGPTUser('/setup');
  const runtime=env as Env;
  let connection: Record<string,unknown> | null=null;
  if (runtime.SITES_IDENTITY_VERIFIED==='true' && user.userId===runtime.OWNER_USER_ID) {
    try { connection=await new SlackService(runtime).identity(); }
    catch(e) { connection={error:e instanceof Failure ? e.category : 'connection_check_failed'}; }
  }
  return <main style={{maxWidth:680,margin:'15vh auto',padding:32,fontFamily:'system-ui'}}>
    <h1>SlackDot setup identity</h1>
    <p>Your signed-in Site identity:</p><code>{user.userId}</code>
    <p>The Site owner can use their own identity when configuring SlackDot. Signing in does not grant access to Slack.</p>
    {connection && <><h2>Slack connection</h2><pre>{JSON.stringify(connection,null,2)}</pre></>}
  </main>;
}
