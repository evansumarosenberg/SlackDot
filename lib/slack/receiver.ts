import { App, LogLevel, type Receiver } from '@slack/bolt';
import { createHmac } from 'node:crypto';
import { boundedText, Failure, requireConfig, type Env } from '../runtime/config';
import { equal } from '../runtime/crypto';
import { acceptEvent } from '../storage';

export const quietLogger = {debug(){}, info(){}, warn(){}, error(){}, setLevel(){}, getLevel(){return LogLevel.ERROR;}, setName(){}};
export class FetchReceiver implements Receiver {
  app!: App;
  init(app: App) { this.app = app; }
  async start() {}
  async stop() {}
  async receive(body: Record<string, any>) {
    // Bolt can ack before listeners finish; only HTTP receiveSlack releases the response.
    await this.app.processEvent({body, ack: async () => {}});
  }
}
export function createBolt(env: Env) {
  const receiver = new FetchReceiver();
  const app = new App({receiver, logger:quietLogger,
    authorize:async () => ({botToken:env.SLACK_BOT_TOKEN, teamId:env.SLACK_TEAM_ID, botId:env.SLACK_BOT_ID, botUserId:env.SLACK_BOT_USER_ID}),
    clientOptions:{retryConfig:{retries:0}, rejectRateLimitedCalls:true, timeout:8000,
      // Workers rejects redirect:'error'. Manual mode plus rejection never forwards credentials.
      fetch:async(input,init)=>{
        const response=await globalThis.fetch(input,{...init,redirect:'manual'});
        if (response.status>=300 && response.status<400) { await response.body?.cancel(); throw new Failure('slack_redirect_blocked'); }
        return response;
      }},
  });
  app.error(async () => { throw new Failure('acceptance_failed'); });
  app.use(async ({body}) => { await acceptEvent(env, body); });
  return {app, receiver};
}
export async function receiveSlack(request: Request, env: Env, now = Date.now()) {
  const started=Date.now();
  try {
    requireConfig(env, ['DB','SLACK_SIGNING_SECRET','SLACK_BOT_TOKEN','SLACK_TEAM_ID','SLACK_BOT_USER_ID','SLACK_BOT_ID','SLACK_APP_ID','OWNER_USER_ID']);
    const raw = await boundedText(request, 256*1024);
    const ts = request.headers.get('x-slack-request-timestamp') ?? '';
    const signature = request.headers.get('x-slack-signature') ?? '';
    if (!/^\d{10}$/.test(ts) || Math.abs(now/1000-Number(ts)) > 300) return new Response(null,{status:401});
    const expected = `v0=${createHmac('sha256', env.SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex')}`;
    if (!equal(expected,signature)) return new Response(null,{status:401});
    const body = JSON.parse(raw);
    if (body.type === 'url_verification' && typeof body.challenge === 'string' && body.challenge.length <= 1024) return Response.json({challenge:body.challenge});
    if (body.type !== 'event_callback' || body.team_id !== env.SLACK_TEAM_ID || body.api_app_id !== env.SLACK_APP_ID || typeof body.event_id !== 'string' || body.event_id.length > 128 || !body.event) return new Response(null,{status:403});
    const {receiver} = createBolt(env);
    // Bound the acknowledgment path; a late commit is harmless because acceptance is idempotent.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([receiver.receive(body), new Promise((_,reject) => {timer=setTimeout(()=>reject(new Failure('acceptance_timeout')),2400);})]);
    } finally { clearTimeout(timer); }
    console.info(JSON.stringify({component:'slack_ingress',outcome:'accepted',ack_ms:Date.now()-started}));
    return new Response(null,{status:200});
  } catch (error) {
    return Response.json({error:error instanceof Failure ? error.category : 'acceptance_failed'},{status:503});
  }
}
