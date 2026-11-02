import { handleMcp } from '../mcp/server';
import { receiveSlack } from '../slack/receiver';
import { SlackService } from '../slack/service';
import { drain, deliverEvent } from '../events/delivery';
import { equal } from './crypto';
import type { Env } from './config';

export async function route(request: Request, env: Env, ctx?: Pick<ExecutionContext,'waitUntil'>): Promise<Response | null> {
  const path=new URL(request.url).pathname;
  if (path==='/health') return Response.json({service:'SlackDot',status:'ok',stage:'compatibility-prototype'});
  if (!['/mcp','/slack/events','/internal/deliver'].includes(path)) return null;
  if (request.method!=='POST') return new Response(null,{status:405,headers:{Allow:'POST'}});
  try {
    if (path==='/mcp') return await handleMcp(request,env);
    if (path==='/slack/events') return await receiveSlack(request,env,Date.now(),ctx ? eventId=>{
      ctx.waitUntil(deliverEvent(env,eventId).catch(()=>{
        console.error(JSON.stringify({component:'delivery',event_id:eventId,state:'interrupted',reason:'background_failed'}));
      }));
    } : undefined);
    if (!env.DELIVERY_TRIGGER_SECRET || env.DELIVERY_TRIGGER_SECRET.length<32 || !equal(request.headers.get('Authorization')??'',`Bearer ${env.DELIVERY_TRIGGER_SECRET}`)) return new Response(null,{status:403});
    if (env.SITES_IDENTITY_VERIFIED!=='true' || !env.DB || !env.OWNER_USER_ID) return new Response(null,{status:503});
    return Response.json(await drain(env,(id,deadline)=>new SlackService(env,deadline).access(id)));
  } catch { return Response.json({error:'service_unavailable'},{status:503}); }
}
