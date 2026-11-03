import { handleMcp } from '../mcp/server';
import { receiveSlack } from '../slack/receiver';
import { deliverEvent } from '../events/delivery';
import type { Env } from './config';

export async function route(request: Request, env: Env, ctx?: Pick<ExecutionContext,'waitUntil'>): Promise<Response | null> {
  const path=new URL(request.url).pathname;
  if (path==='/health') return Response.json({service:'SlackDot',status:'ok',stage:'compatibility-prototype'});
  if (!['/mcp','/slack/events'].includes(path)) return null;
  if (request.method!=='POST') return new Response(null,{status:405,headers:{Allow:'POST'}});
  try {
    if (path==='/mcp') return await handleMcp(request,env);
    return await receiveSlack(request,env,Date.now(),ctx ? (event,acceptedAt)=>{
      ctx.waitUntil(deliverEvent(env,event,acceptedAt).catch(()=>{
        console.error('delivery_unavailable');
      }));
    } : undefined);
  } catch { return Response.json({error:'service_unavailable'},{status:503}); }
}
