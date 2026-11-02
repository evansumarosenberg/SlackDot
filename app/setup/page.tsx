import { requireChatGPTUser } from '../chatgpt-auth';
export const dynamic='force-dynamic';
export default async function Setup() {
  const user=await requireChatGPTUser('/setup');
  return <main style={{maxWidth:680,margin:'15vh auto',padding:32,fontFamily:'system-ui'}}>
    <h1>SlackDot setup identity</h1>
    <p>Your signed-in Site identity:</p><code>{user.userId}</code>
    <p>The Site owner can use their own identity when configuring SlackDot. Signing in does not grant access to Slack.</p>
  </main>;
}
