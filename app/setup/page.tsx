import { requireChatGPTUser } from '../chatgpt-auth';
import { env } from 'cloudflare:workers';
import { SlackService } from '../../lib/slack/service';
import { Failure, owner, type Env } from '../../lib/runtime/config';
export const dynamic='force-dynamic';
export default async function Setup() {
  const user=await requireChatGPTUser('/setup');
  const runtime=env as Env;
  let connection: Record<string,unknown> | null=null;
  let authorized=false;
  try { owner(new Request('https://slackdot.invalid/setup',{headers:{'oai-authenticated-user-id':user.userId}}),runtime); authorized=true; }
  catch { /* Bootstrap identity is visible only to that signed-in user; no configuration is exposed. */ }
  if (authorized) {
    try { connection=await new SlackService(runtime).identity(); }
    catch(e) { connection={error:e instanceof Failure ? e.category : 'connection_check_failed'}; }
  }
  return <main style={{maxWidth:680,margin:'15vh auto',padding:32,fontFamily:'system-ui'}}>
    <h1>SlackDot setup</h1>
    <p>Your signed-in Site identity:</p><code>{user.userId}</code>
    <p>The Site owner can use their own identity when configuring SlackDot. Signing in does not grant access to Slack.</p>
    {authorized && <><h2>Configuration</h2><ul>
      {(['SLACK_BOT_TOKEN','SLACK_SIGNING_SECRET','SLACK_TEAM_ID','SLACK_BOT_USER_ID','SLACK_BOT_ID','SLACK_APP_ID','SUBSCRIPTION_ENCRYPTION_KEY','CALLBACK_ALLOWED_ORIGINS','DB'] as const)
        .map(key=><li key={key}>{key}: {runtime[key]?'configured':'missing'}</li>)}
    </ul><p>Change configuration and secrets in the Site environment settings. SlackDot stores only subscriptions; message content and delivery results are not saved.</p></>}
    {connection && <><h2>Slack connection</h2><pre>{JSON.stringify(connection,null,2)}</pre></>}
  </main>;
}
