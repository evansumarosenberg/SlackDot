// Built SDK/Worker integration: synthetic services only; no real messages or payload files.
import {Miniflare} from 'miniflare';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
const root=resolve('dist/server'),fixture=JSON.parse(readFileSync('tests/fixtures/mcp-discover.json','utf8'));
const modules=readdirSync(root,{recursive:true}).filter(f=>String(f).endsWith('.js')).map(String).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`,parent='1793640000.123456',reply='1793640001.123456';
const own={ts:reply,thread_ts:parent,user:'UBOT',bot_id:'BBOT',app_id:'ATEST',text:'synthetic bot reply'};
const human={ts:parent,user:'UPERSON',text:'synthetic parent'};
const observed=[],methods=[],statuses=[];let ack=false,reaction=false,deleted=false;
const statusEnabled=process.argv.includes('--status-disabled')?'0':'1';
const runtime=new Miniflare({modules:modules.map(file=>({type:'ESModule',path:resolve(root,file)})),modulesRoot:root,
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist:resolve('.wrangler/smoke',crypto.randomUUID()),
  assets:{directory:resolve('dist/client'),routerConfig:{has_user_worker:true}},
  bindings:{SLACK_SESSION_STATUS_ENABLED:statusEnabled,OWNER_USER_ID:'owner',SITES_IDENTITY_VERIFIED:'true',SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_TEAM_ID:'TTEST',SLACK_BOT_ID:'BBOT',SLACK_BOT_USER_ID:'UBOT',SLACK_APP_ID:'ATEST',SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),CALLBACK_ALLOWED_ORIGINS:'https://receiver.example.com'},
  outboundService:async request=>{
    const url=new URL(request.url),raw=await request.text();
    if(url.origin==='https://receiver.example.com') {
      const data=new Webhook(secret).verify(raw,Object.fromEntries(request.headers));
      if(data.type==='verification') return Response.json({challenge:data.challenge});
      // Yield until ingress has returned; callback acceptance happens after acknowledgment.
      for(let i=0;!ack&&i<100;i++) await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(ack,true);assert.equal(request.headers.get('webhook-id'),data.eventId);observed.push(data);return new Response(null,{status:204});
    }
    assert.equal(url.origin,'https://slack.com');const method=url.pathname.split('/').pop();methods.push(method);
    const body=request.headers.get('content-type')?.includes('json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));
    switch(method) {
      case 'auth.test': return Response.json({ok:true,team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
      case 'conversations.info': return Response.json({ok:true,channel:{id:body.channel,is_member:true,is_im:body.channel==='DTEST',user:body.channel==='DTEST'?'UPERSON':undefined,name:'synthetic'}});
      case 'conversations.list': return Response.json({ok:true,channels:[{id:'CTEST',is_member:true,name:'synthetic'},{id:'CHIDDEN',is_member:false,name:'hidden'}],response_metadata:{next_cursor:'next-page'}});
      case 'users.list': return Response.json({ok:true,members:[{id:'UPERSON',name:'person',profile:{display_name:'Synthetic Person',email:'must-not-escape@example.com'}}],response_metadata:{next_cursor:'next-users'}});
      case 'users.info': return Response.json({ok:true,user:{id:body.user,name:'person',profile:{display_name:'Synthetic Person',email:'must-not-escape@example.com'}}});
      case 'conversations.open': assert.equal(body.users,'UPERSON');return Response.json({ok:true,channel:{id:'DTEST',user:'UPERSON',is_im:true}});
      case 'conversations.history': return Response.json({ok:true,messages:[human],has_more:false});
      case 'conversations.replies': return Response.json({ok:true,messages:deleted?[human]:[human,own],has_more:false});
      case 'chat.postMessage': assert.equal(body.thread_ts,parent);return Response.json({ok:true,channel:'CTEST',ts:reply});
      case 'chat.update': assert.equal(body.ts,reply);own.text=body.text;return Response.json({ok:true,channel:'CTEST',ts:reply});
      case 'chat.delete': assert.equal(body.ts,reply);deleted=true;return Response.json({ok:true,channel:'CTEST',ts:reply});
      case 'agents.sessions.setStatus':
        assert.equal(body.channel_id,'CTEST');assert.equal(body.thread_ts,parent);
        if(body.status==='processing')assert.ok(observed.some(event=>event.name==='slack.message.created'));
        else {assert.equal(body.status,'active');assert.ok(methods.includes('chat.postMessage'));}
        statuses.push(body.status);return Response.json({ok:true,agent_status:body.status,status:body.status});
      case 'reactions.get': return Response.json({ok:true,type:'message',channel:'CTEST',message:{...(body.timestamp===reply?own:human),reactions:reaction?[{name:'eyes',count:1,users:['UBOT']}]:[]}});
      case 'reactions.add': if(reaction)return Response.json({ok:false,error:'already_reacted'});reaction=true;return Response.json({ok:true});
      case 'reactions.remove': if(!reaction)return Response.json({ok:false,error:'no_reaction'});reaction=false;return Response.json({ok:true});
      default: throw new Error(`Unexpected synthetic method: ${method}`);
    }
  }});
try {
  const db=await runtime.getD1Database('DB');
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) for(const sql of readFileSync(`drizzle/${file}`,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  async function rpc(method,params={}) {
    const response=await runtime.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{...fixture.headers,'Mcp-Method':method,'Mcp-Name':params.name??'','oai-authenticated-user-id':'owner'},body:JSON.stringify({...fixture.request,method,params:{...fixture.request.params,...params}})});
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.error,undefined,JSON.stringify(data));return data.result;
  }
  const called=new Set();
  async function call(name,args={}) {called.add(name);const result=await rpc('tools/call',{name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));assert.ok(!JSON.stringify(result).includes('must-not-escape'));return result.structuredContent;}
  const catalog=await rpc('tools/list');assert.equal(catalog.tools.length,14);
  const events=await rpc('events/list');assert.equal(events.events.length,5);
  assert.equal((await call('slack_get_connection_info')).event_types.length,5);
  const channels=await call('slack_list_conversations');assert.deepEqual(channels.conversations.map(c=>c.conversation_id),['CTEST']);assert.equal(channels.next_cursor,'next-page');
  await call('slack_get_conversation',{conversation_id:'CTEST'});
  const users=await call('slack_list_users',{name_filter:'absent'});assert.deepEqual(users.users,[]);assert.equal(users.next_cursor,'next-users');
  await call('slack_get_user',{user_id:'UPERSON'});assert.equal((await call('slack_open_dm',{user_id:'UPERSON'})).conversation_id,'DTEST');
  await call('slack_get_messages',{conversation_id:'CTEST',oldest:parent,inclusive:true});
  await call('slack_get_thread',{conversation_id:'CTEST',thread_ts:parent});
  const sent=await call('slack_send_message',{conversation_id:'CTEST',text:'synthetic bot reply',thread_ts:parent});assert.equal(sent.message_ts,reply);
  const target={conversation_id:'CTEST',message_ts:reply},reactionTarget={...target,emoji_name:'eyes'};
  await call('slack_update_message',{...target,text:'updated synthetic reply'});
  assert.equal((await call('slack_get_thread',{conversation_id:'CTEST',thread_ts:parent})).messages[1].text,'updated synthetic reply');
  assert.equal((await call('slack_add_reaction',reactionTarget)).changed,true);assert.equal((await call('slack_add_reaction',reactionTarget)).changed,false);
  assert.equal((await call('slack_get_reactions',target)).reactions[0].bot_reacted,true);
  assert.equal((await call('slack_remove_reaction',reactionTarget)).changed,true);assert.equal((await call('slack_remove_reaction',reactionTarget)).changed,false);
  const inputs=[
    ['slack.message.created',{conversation_id:'CTEST',sender_user_ids:['UPERSON'],mentions_only:true},{type:'message',channel:'CTEST',user:'UPERSON',ts:parent,text:'<@UBOT> synthetic'}],
    ['slack.message.updated',{conversation_id:'CTEST',thread_ts:parent},{type:'message',subtype:'message_changed',hidden:true,channel:'CTEST',event_ts:'1793640002.000001',message:{...human,thread_ts:parent,text:'edited',edited:{user:'UPERSON',ts:'1793640002.000001'}}}],
    ['slack.message.deleted',{conversation_id:'CTEST',sender_user_ids:['UPERSON']},{type:'message',subtype:'message_deleted',hidden:true,channel:'CTEST',deleted_ts:parent,event_ts:'1793640003.000001',previous_message:human}],
    ['slack.reaction.added',{conversation_id:'CTEST',thread_ts:parent,actor_user_ids:['UPERSON'],emoji_name:'eyes'},{type:'reaction_added',user:'UPERSON',item_user:'UBOT',reaction:'eyes',item:{type:'message',channel:'CTEST',ts:reply},event_ts:'1793640004.000001'}],
    ['slack.reaction.removed',{conversation_id:'CTEST',thread_ts:parent,actor_user_ids:['UPERSON'],emoji_name:'eyes'},{type:'reaction_removed',user:'UPERSON',item_user:'UBOT',reaction:'eyes',item:{type:'message',channel:'CTEST',ts:reply},event_ts:'1793640005.000001'}],
  ];
  for(const [name,args,event] of inputs) {
    const subscription={name,arguments:args,delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret}};
    const sub=await rpc('events/subscribe',subscription);assert.ok(sub.id);
    const raw=JSON.stringify({type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:`Ev${observed.length}`,event}),ts=String(Math.floor(Date.now()/1000));
    const signature='v0='+createHmac('sha256','synthetic-signing-secret').update(`v0:${ts}:${raw}`).digest('hex');
    ack=false;const started=Date.now(),response=await runtime.dispatchFetch('http://localhost/slack/events',{method:'POST',headers:{'x-slack-request-timestamp':ts,'x-slack-signature':signature},body:raw});ack=true;
    assert.equal(response.status,200);assert.ok(Date.now()-started<3000);
    while(observed.at(-1)?.name!==name && Date.now()-started<3000)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(observed.at(-1)?.name,name);
    if(name==='slack.message.created') {
      while(statusEnabled==='1' && !statuses.includes('processing') && Date.now()-started<3000)await new Promise(resolve=>setTimeout(resolve,20));
      assert.deepEqual(statuses,statusEnabled==='1'?['active','processing']:[]);
      await call('slack_send_message',{conversation_id:'CTEST',thread_ts:parent,text:'synthetic completed reply'});
      assert.deepEqual(statuses,statusEnabled==='1'?['active','processing','active']:[]);
    }
    if(name.startsWith('slack.reaction'))assert.equal(observed.at(-1).data.thread_ts,parent);
    await rpc('events/unsubscribe',{id:sub.id});
  }
  await call('slack_delete_message',target);assert.equal(called.size,14);
  assert.deepEqual(statuses,statusEnabled==='1'?['active','processing','active']:[]);
  assert.equal(observed.length,5);assert.equal((await db.prepare('SELECT count(*) n FROM subscriptions').first()).n,0);
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map(r=>r.name);
  assert.deepEqual(tables,['subscriptions','event_dedup']);
  console.log(JSON.stringify({result:'PASS',tool_count:called.size,event_types:observed.map(e=>e.name),application_tables:tables,slack_methods:[...new Set(methods)]}));
} finally {await runtime.dispose();}
