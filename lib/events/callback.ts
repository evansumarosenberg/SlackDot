import { Webhook } from 'standardwebhooks';
import { isIP } from 'node:net';
import { boundedText, Failure } from '../runtime/config';
import { equal } from '../runtime/crypto';
import { CALLBACK_MS } from './budget';

export function validateSecret(secret: string) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Failure('invalid_signing_secret');
  const key=Buffer.from(secret.slice(6),'base64');
  if (key.length<24 || key.length>64 || key.toString('base64').replace(/=+$/,'')!==secret.slice(6).replace(/=+$/,'')) throw new Failure('invalid_signing_secret');
}
export function callbackUrl(raw: string, allowedOrigins = '') {
  const url=new URL(raw);
  if (url.protocol!=='https:' || url.username || url.password || url.hash || url.port || isIP(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.') || /\.(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new Failure('callback_destination_blocked');
  const allowed=allowedOrigins.split(',').map(v=>v.trim()).filter(Boolean);
  if (!allowed.length) throw new Failure('callback_policy_unconfigured');
  // Only operator-verified OpenAI-owned origins; no arbitrary DNS or suffix allowlisting.
  if (!allowed.includes(url.origin)) throw new Failure('callback_destination_blocked');
  return url.href;
}
export type CallbackFetch = (url: string, init: RequestInit) => Promise<Response>;
export class CallbackClient {
  // Workers fetch requires its runtime receiver; do not invoke it as this.transport.
  constructor(private origins = '', private transport: CallbackFetch = (url,init)=>globalThis.fetch(url,init)) {}
  validate(url: string) { return callbackUrl(url,this.origins); }
  async post(url: string, secret: string, subscription: string, id: string, body: string, now=Date.now(), deadline=Infinity, previousSecret?:string) {
    validateSecret(secret);
    if(previousSecret) validateSecret(previousSecret);
    if (Buffer.byteLength(body)>262144) throw new Failure('payload_too_large');
    const destination=this.validate(url), signedAt=new Date(now);
    const remaining=deadline-now;
    if(remaining<=0) throw new Failure('execution_deadline');
    try {
      const signature=new Webhook(secret).sign(id,signedAt,body);
      const signatures=previousSecret && previousSecret!==secret ? `${signature} ${new Webhook(previousSecret).sign(id,signedAt,body)}` : signature;
      const response=await this.transport(destination,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.floor(Math.min(Number.isFinite(deadline)?CALLBACK_MS:10000,remaining)))),
        headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(now/1000)),
          'webhook-signature':signatures,'X-MCP-Subscription-Id':subscription},body});
      if (response.status>=300 && response.status<400) { await response.body?.cancel(); throw new Failure('callback_redirect_blocked'); }
      return response;
    } catch(e) { throw e instanceof Failure ? e : new Failure('callback_transport_failed'); }
  }
  async verify(url: string, secret: string, subscription: string) {
    const challenge=crypto.randomUUID();
    const response=await this.post(url,secret,subscription,`verification_${crypto.randomUUID()}`,JSON.stringify({type:'verification',challenge}));
    if (!response.ok) { await response.body?.cancel(); throw new Failure('challenge_failed'); }
    let returned: unknown;
    try { returned=JSON.parse(await boundedText(response,4096)).challenge; } catch { throw new Failure('challenge_failed'); }
    if (typeof returned!=='string' || !equal(challenge,returned)) throw new Failure('challenge_failed');
  }
}
