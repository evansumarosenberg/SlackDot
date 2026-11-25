import {beforeEach,it,expect,vi} from 'vitest';
import {env} from '../support/fixtures';
const mocks=vi.hoisted(()=>({auth:vi.fn(),info:vi.fn(),list:vi.fn(),users:vi.fn(),user:vi.fn(),open:vi.fn(),history:vi.fn(),replies:vi.fn(),post:vi.fn(),update:vi.fn(),delete:vi.fn(),reactions:vi.fn(),add:vi.fn(),remove:vi.fn()}));
vi.mock('../../lib/slack/receiver',()=>({createBolt:()=>({app:{client:{auth:{test:mocks.auth},conversations:{info:mocks.info,list:mocks.list,open:mocks.open,history:mocks.history,replies:mocks.replies},users:{list:mocks.users,info:mocks.user},chat:{postMessage:mocks.post,update:mocks.update,delete:mocks.delete},reactions:{get:mocks.reactions,add:mocks.add,remove:mocks.remove}}}})}));
import {SlackService,historySchema,listConversationsSchema,listUsersSchema,reactionSchema} from '../../lib/slack/service';
import {handleMcp} from '../../lib/mcp/server';
const noStorage=new Proxy({} as D1Database,{get(){throw new Error('Slack tools must not access storage');}});
const e=env(noStorage),target={conversation_id:'CTEST',message_ts:'1793640001.123456'};
const user={id:'UPERSON',name:'person',profile:{real_name:'Test Person',display_name:'Tester',title:'Engineer',email:'never-return@example.com',phone:'never-return-phone'}};
const message={ts:target.message_ts,thread_ts:'1793640000.123456',user:'UBOT',bot_id:'BBOT',app_id:'ATEST',text:'Synthetic message'};
const service=()=>new SlackService(e);
beforeEach(()=>{
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
  mocks.info.mockResolvedValue({channel:{id:'CTEST',is_member:true,name:'test'}});
  mocks.list.mockResolvedValue({channels:[{id:'CTEST',is_member:true,name:'test'}],response_metadata:{next_cursor:''}});
  mocks.users.mockResolvedValue({members:[user],response_metadata:{next_cursor:''}});mocks.user.mockResolvedValue({user});
  mocks.open.mockResolvedValue({channel:{id:'DTEST',is_im:true,user:'UPERSON'}});
  mocks.history.mockResolvedValue({messages:[message],has_more:false});mocks.replies.mockResolvedValue({messages:[message],has_more:false});
  mocks.post.mockResolvedValue({channel:'CTEST',ts:target.message_ts});mocks.update.mockResolvedValue({channel:'CTEST',ts:target.message_ts});mocks.delete.mockResolvedValue({channel:'CTEST',ts:target.message_ts});
  mocks.reactions.mockResolvedValue({type:'message',channel:'CTEST',message:{...message,reactions:[{name:'thumbsup',count:3,users:['UBOT','UPERSON']}]}});
  mocks.add.mockResolvedValue({ok:true});mocks.remove.mockResolvedValue({ok:true});
});
it('filters discovery to joined channels and bot IMs while preserving empty-page cursors',async()=>{
  mocks.list.mockResolvedValueOnce({channels:[{id:'CNO',is_member:false},{id:'GMPIM',is_member:true,is_mpim:true},{id:'CARCH',is_member:true,is_archived:true},{id:'COTHER',is_member:true,context_team_id:'TOTHER'}],response_metadata:{next_cursor:'next'}});
  expect(await service().conversations(listConversationsSchema.parse({}))).toEqual({conversations:[],next_cursor:'next',complete:false});
  mocks.list.mockResolvedValueOnce({channels:[{id:'CPUBLIC',is_member:true},{id:'GPRIVATE',is_member:true,is_private:true},{id:'DIM',is_im:true,user:'UPERSON'}]});
  expect((await service().conversations(listConversationsSchema.parse({cursor:'next',limit:3}))).conversations.map(c=>c.type)).toEqual(['public_channel','private_channel','im']);
  expect(mocks.list.mock.calls[1][0]).toMatchObject({cursor:'next',limit:3,exclude_archived:true});expect(mocks.list).toHaveBeenCalledTimes(2);
});
it('filters names only on the requested page and never returns email/extra profile fields',async()=>{
  mocks.users.mockResolvedValueOnce({members:[user],response_metadata:{next_cursor:'more'}});
  const empty=await service().users(listUsersSchema.parse({name_filter:'absent'}));
  expect(empty).toEqual({users:[],next_cursor:'more',complete:false,filter_scope:'page'});
  const result=await service().users(listUsersSchema.parse({name_filter:'TEST',cursor:'more'}));
  expect(result.users).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('never-return');
  expect(JSON.stringify(await service().user({user_id:'UPERSON'}))).not.toContain('never-return');
});
it('does not call downstream methods for a mismatched workspace or missing identity configuration',async()=>{
  mocks.auth.mockResolvedValueOnce({team_id:'TOTHER',user_id:'UBOT',bot_id:'BBOT'});
  await expect(service().users(listUsersSchema.parse({}))).rejects.toThrow('installation_mismatch');expect(mocks.users).not.toHaveBeenCalled();
  await expect(new SlackService({...e,SLACK_TEAM_ID:''}).openDm({user_id:'UPERSON'})).rejects.toThrow('configuration_missing');expect(mocks.open).not.toHaveBeenCalled();
});
it('opens exactly one one-to-one DM without a greeting',async()=>{
  expect(await service().openDm({user_id:'UPERSON'})).toEqual({conversation_id:'DTEST',user_id:'UPERSON'});
  expect(mocks.open).toHaveBeenCalledWith({token:e.SLACK_BOT_TOKEN,users:'UPERSON',return_im:true});expect(mocks.post).not.toHaveBeenCalled();
  await expect(service().openDm({user_id:'UBOT'})).rejects.toThrow('conversation_unavailable');expect(mocks.open).toHaveBeenCalledTimes(1);
});
it('keeps timestamps exact and returns partial history with a cursor',async()=>{
  const oldest='9007199254740992.000001',latest='9007199254740992.000002';
  const input=historySchema.parse({conversation_id:'CTEST',oldest,latest,inclusive:true,limit:1});
  mocks.history.mockResolvedValueOnce({messages:[{ts:oldest,text:'x'.repeat(4001)}],has_more:true,response_metadata:{next_cursor:'next'}});
  const result=await service().history(input);
  expect(result).toMatchObject({complete:false,next_cursor:'next',messages:[{message_ts:oldest,truncated:true}]});
  expect(result.messages[0].text).toHaveLength(4000);
  expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({oldest,latest,inclusive:true,limit:1}));
  expect(()=>historySchema.parse({...input,oldest:latest,latest:oldest})).toThrow();
});
it.each(['update','delete'] as const)('verifies exact reply authorship before %s without history scanning',async(operation)=>{
  const result=operation==='update'?await service().update({...target,text:'Updated'}):await service().delete(target);
  expect(result).toEqual(target);
  expect(mocks.reactions).toHaveBeenCalledWith({token:e.SLACK_BOT_TOKEN,channel:'CTEST',timestamp:target.message_ts,full:true});
  expect(mocks[operation]).toHaveBeenCalledTimes(1);expect(mocks.history).not.toHaveBeenCalled();expect(mocks.replies).not.toHaveBeenCalled();
});
it.each([
  {user:'UPERSON'}, {bot_id:'BOTHER'}, {app_id:'AOTHER'}, {user:undefined,bot_id:undefined},
])('rejects non-owned or unknown authorship',async(change)=>{
  mocks.reactions.mockResolvedValue({type:'message',channel:'CTEST',message:{...message,...change}});
  await expect(service().update({...target,text:'Updated'})).rejects.toThrow('message_not_owned');
  await expect(service().delete(target)).rejects.toThrow('message_not_owned');expect(mocks.update).not.toHaveBeenCalled();expect(mocks.delete).not.toHaveBeenCalled();
});
it('does not mutate a different message returned by a malformed lookup',async()=>{
  mocks.reactions.mockResolvedValueOnce({type:'message',channel:'CTEST',message:{...message,ts:'1793640999.123456'}});
  await expect(service().delete(target)).rejects.toThrow('invalid_slack_response');expect(mocks.delete).not.toHaveBeenCalled();
});
it('reports actual reaction counts, incomplete participants, and bot membership',async()=>{
  expect(await service().reactions(target)).toEqual({...target,complete:true,reactions:[{emoji_name:'thumbsup',count:3,user_ids:['UBOT','UPERSON'],users_complete:false,bot_reacted:true}]});
  mocks.reactions.mockResolvedValueOnce({type:'message',channel:'CTEST',message:{...message,reactions:[{name:'eyes',count:1,users:['UPERSON']}]}});
  expect((await service().reactions(target)).reactions[0]).toMatchObject({bot_reacted:false,users_complete:true});
});
it('bounds reaction output and identifies truncation',async()=>{
  mocks.reactions.mockResolvedValueOnce({type:'message',channel:'CTEST',message:{...message,reactions:Array.from({length:101},(_,i)=>({name:`emoji_${i}`,count:101,users:Array.from({length:101},(_,j)=>`USER${j}`)}))}});
  const result=await service().reactions(target);
  expect(result.complete).toBe(false);expect(result.reactions).toHaveLength(100);expect(result.reactions[0].user_ids).toHaveLength(100);expect(result.reactions[0].users_complete).toBe(false);
});
it('reports repeated reaction operations as unchanged and never modifies another actor',async()=>{
  const input={...target,emoji_name:'thumbsup'};
  expect(await service().addReaction(input)).toEqual({...input,state:'present',changed:true});
  mocks.add.mockRejectedValueOnce({data:{error:'already_reacted'}});
  expect(await service().addReaction(input)).toEqual({...input,state:'present',changed:false});
  mocks.remove.mockRejectedValueOnce({data:{error:'no_reaction'}});
  expect(await service().removeReaction(input)).toEqual({...input,state:'absent',changed:false});
  expect(mocks.remove.mock.calls[0][0]).not.toHaveProperty('user');
});
it.each(['update','delete','open','add','remove'] as const)('does not retry an ambiguous %s mutation',async(operation)=>{
  mocks[operation].mockRejectedValueOnce({data:{error:'internal_error'},message:'sensitive server body'});
  const s=service(),call=operation==='update'?s.update({...target,text:'New'}):operation==='delete'?s.delete(target):operation==='open'?s.openDm({user_id:'UPERSON'}):operation==='add'?s.addReaction({...target,emoji_name:'eyes'}):s.removeReaction({...target,emoji_name:'eyes'});
  await expect(call).rejects.toThrow('ambiguous_write');expect(mocks[operation]).toHaveBeenCalledTimes(1);
});
it.each([
  ['not_in_channel','not_in_conversation'],['channel_not_found','not_found'],['missing_scope','missing_scope'],['invalid_cursor','invalid_cursor'],
])('returns the precise safe error for %s',async(code,category)=>{
  mocks.history.mockRejectedValueOnce({data:{error:code}});
  await expect(service().history(historySchema.parse({conversation_id:'CTEST'}))).rejects.toThrow(category);expect(mocks.history).toHaveBeenCalledTimes(1);
});
it('preserves Retry-After without sleeping or retrying',async()=>{
  mocks.users.mockRejectedValueOnce({code:'slack_webapi_rate_limited_error',retryAfter:17});
  await expect(service().users(listUsersSchema.parse({}))).rejects.toMatchObject({category:'rate_limited',retryAfter:17});expect(mocks.users).toHaveBeenCalledTimes(1);
});
it.each(['list','users','history','replies'] as const)('rejects missing/non-array %s data but accepts a confirmed empty page',async(operation)=>{
  const field=operation==='list'?'channels':operation==='users'?'members':'messages';
  const call=()=>operation==='list'?service().conversations(listConversationsSchema.parse({})):operation==='users'?service().users(listUsersSchema.parse({})):operation==='history'?service().history(historySchema.parse({conversation_id:'CTEST'})):service().thread({conversation_id:'CTEST',thread_ts:message.thread_ts,limit:50});
  for(const value of [undefined,null,'bad',{}]) {
    mocks[operation].mockResolvedValueOnce({ok:true,[field]:value});
    await expect(call()).rejects.toThrow('invalid_slack_response');
  }
  mocks[operation].mockResolvedValueOnce({ok:true,[field]:[]});
  await expect(call()).resolves.toMatchObject({complete:true,next_cursor:null});
});
it.each([
  {id:'D',is_im:true,user:'UPERSON'},
  {id:'CTEST',is_im:true,user:'UPERSON'},
  {id:'DTEST',is_im:false,user:'UPERSON'},
  {id:'DTEST',is_im:true,user:'UOTHER'},
  {id:'DTEST'},
])('rejects malformed or mismatched DM results without retry',async(channel)=>{
  mocks.open.mockResolvedValueOnce({ok:true,channel});
  await expect(service().openDm({user_id:'UPERSON'})).rejects.toThrow('ambiguous_write');
  expect(mocks.open).toHaveBeenCalledTimes(1);
});
it.each([
  {name:'eyes',users:['UPERSON']},
  {name:'eyes',count:-1,users:[]},
  {name:'eyes',count:1.5,users:['UPERSON']},
  {name:'eyes',count:'1',users:['UPERSON']},
  {name:':eyes:',count:1,users:['UPERSON']},
  {name:'eyes',count:1,users:'UPERSON'},
  {name:'eyes',count:1,users:['invalid-id']},
])('rejects malformed reaction data without inventing counts or membership',async(reaction)=>{
  mocks.reactions.mockResolvedValueOnce({type:'message',channel:'CTEST',message:{...message,reactions:[reaction]}});
  await expect(service().reactions(target)).rejects.toThrow('invalid_slack_response');
});
it('resolves validated roots and replies from an exact Slack message',async()=>{
  expect(await service().eventThread('CTEST',target.message_ts)).toBe(message.thread_ts);
  mocks.reactions.mockResolvedValueOnce({type:'message',channel:'CTEST',message:{...message,thread_ts:undefined}});
  expect(await service().eventThread('CTEST',target.message_ts)).toBe(target.message_ts);
  mocks.reactions.mockResolvedValueOnce({type:'message',channel:'CTEST',message:{...message,thread_ts:'invalid'}});
  expect(await service().eventThread('CTEST',target.message_ts)).toBeNull();
});
it('accepts bare emoji names and skin tones, but not surrounding colons or arbitrary text',()=>{
  for(const name of ['thumbsup','+1','wave::skin-tone-3']) expect(reactionSchema.parse({...target,emoji_name:name}).emoji_name).toBe(name);
  for(const name of [':eyes:','not an emoji']) expect(()=>reactionSchema.parse({...target,emoji_name:name})).toThrow();
});
it.each([
  ['slack_get_connection_info',{}],['slack_list_conversations',{}],['slack_get_conversation',{conversation_id:'CTEST'}],['slack_list_users',{}],['slack_get_user',{user_id:'UPERSON'}],['slack_open_dm',{user_id:'UPERSON'}],['slack_get_messages',{conversation_id:'CTEST'}],['slack_get_thread',{conversation_id:'CTEST',thread_ts:message.thread_ts}],['slack_send_message',{conversation_id:'CTEST',text:'Synthetic'}],['slack_update_message',{...target,text:'Updated'}],['slack_delete_message',target],['slack_get_reactions',target],['slack_add_reaction',{...target,emoji_name:'eyes'}],['slack_remove_reaction',{...target,emoji_name:'eyes'}],
])('executes %s through SDK input/output validation without database access',async(name,args)=>{
  const request=new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','Mcp-Method':'tools/call','Mcp-Name':name,'MCP-Protocol-Version':'2026-07-28','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
  const result=await (await handleMcp(request,e)).json() as any;
  expect(result.error).toBeUndefined();expect(result.result.isError).not.toBe(true);expect(result.result.structuredContent).toBeDefined();
  expect(JSON.stringify(result)).not.toContain('never-return');
});
