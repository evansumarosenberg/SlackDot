import {beforeEach,it,expect,vi} from 'vitest';
import {env} from '../support/fixtures';
const mocks=vi.hoisted(()=>({add:vi.fn(),remove:vi.fn(),replies:vi.fn(),status:vi.fn(),createBolt:vi.fn()}));
vi.mock('../../lib/slack/receiver',()=>({createBolt:mocks.createBolt}));
import {setSessionStatus} from '../../lib/slack/session-status';
import {SlackService} from '../../lib/slack/service';
import {handleMcp} from '../../lib/mcp/server';
const e=env(new Proxy({} as D1Database,{get(){throw new Error('No status storage');}}));
const target={conversation_id:'CTEST',thread_ts:'1793640000.123456'};
beforeEach(()=>{
  vi.restoreAllMocks();vi.resetAllMocks();
  mocks.createBolt.mockReturnValue({app:{client:{reactions:{add:mocks.add,remove:mocks.remove},conversations:{replies:mocks.replies},agents:{sessions:{setStatus:mocks.status}}}}});
  mocks.replies.mockResolvedValue({messages:[]});
  mocks.status.mockResolvedValue({ok:true,agent_status:'active'});
});
async function call(name:string,args:Record<string,unknown>,config=e) {
  const request=new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','Mcp-Method':'tools/call','Mcp-Name':name,'MCP-Protocol-Version':'2026-07-28','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
  return await (await handleMcp(request,config)).json() as any;
}
it.each(['false','','invalid'])('skips both status calls without creating a client when configured as %j',async(value)=>{
  const disabled={...e,SLACK_SESSION_STATUS_ENABLED:value};
  await setSessionStatus(disabled,'CTEST',target.thread_ts,'processing');
  await setSessionStatus(disabled,'CTEST',target.thread_ts,'active');
  expect(mocks.createBolt).not.toHaveBeenCalled();expect(mocks.status).not.toHaveBeenCalled();
});
it('preserves enabled behavior when the variable is absent on an existing installation',async()=>{
  const legacy={...e};delete legacy.SLACK_SESSION_STATUS_ENABLED;
  await setSessionStatus(legacy,'CTEST',target.thread_ts,'processing');
  await setSessionStatus(legacy,'CTEST',target.thread_ts,'active');
  expect(mocks.status.mock.calls.map(([args])=>args.status)).toEqual(['processing','active']);
});
it('still sends a threaded reply successfully when status calls are disabled',async()=>{
  const result={...target,message_ts:'1793640001.123456'};
  const send=vi.spyOn(SlackService.prototype,'send').mockResolvedValue(result);
  const response=await call('slack_send_message',{...target,text:'Reply'},{...e,SLACK_SESSION_STATUS_ENABLED:'0'});
  expect(response.result.structuredContent).toEqual(result);expect(send).toHaveBeenCalledTimes(1);
  expect(mocks.status).not.toHaveBeenCalled();
});
it('uses a single bounded SDK call with only the target and lifecycle status',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(10000);
  await setSessionStatus(e,target.conversation_id,target.thread_ts,'processing',15000);
  expect(mocks.createBolt).toHaveBeenCalledExactlyOnceWith(e,12000);
  expect(mocks.status).toHaveBeenCalledExactlyOnceWith({token:e.SLACK_BOT_TOKEN,channel_id:'CTEST',thread_ts:target.thread_ts,status:'processing'});
  await setSessionStatus(e,'CTEST',target.thread_ts,'active',10500);
  expect(mocks.createBolt).toHaveBeenLastCalledWith(e,10500);
});
it('does not start a call after its deadline',async()=>{
  await setSessionStatus(e,'CTEST',target.thread_ts,'processing',Date.now()-1);
  expect(mocks.createBolt).not.toHaveBeenCalled();
});
it.each(['feature_disabled','ratelimited','internal_error','request_timeout'])('ignores %s without retrying or exposing the failure',async(error)=>{
  mocks.status.mockRejectedValue({data:{error},message:'sensitive payload'});
  await expect(setSessionStatus(e,'CTEST',target.thread_ts,'active')).resolves.toBeUndefined();
  expect(mocks.status).toHaveBeenCalledTimes(1);
});
it('marks active after a confirmed threaded tool reply, preserving the send result',async()=>{
  const result={...target,message_ts:'1793640001.123456'};
  vi.spyOn(SlackService.prototype,'send').mockImplementation(async()=>{
    expect(mocks.status).not.toHaveBeenCalled();return result;
  });
  const response=await call('slack_send_message',{...target,text:'Reply'});
  expect(response.result.structuredContent).toEqual(result);
  expect(mocks.status).toHaveBeenCalledExactlyOnceWith({token:e.SLACK_BOT_TOKEN,channel_id:'CTEST',thread_ts:target.thread_ts,status:'active'});
});
it('keeps a successful reply successful when the status update fails',async()=>{
  vi.spyOn(SlackService.prototype,'send').mockResolvedValue({...target,message_ts:'1793640001.123456'});
  mocks.status.mockRejectedValue(new Error('network failure'));
  const response=await call('slack_send_message',{...target,text:'Reply'});
  expect(response.result.isError).not.toBe(true);expect(mocks.status).toHaveBeenCalledTimes(1);
});
it('does not mark active after a failed send, top-level post, or thread read',async()=>{
  const send=vi.spyOn(SlackService.prototype,'send').mockRejectedValue(new Error('uncertain send'));
  expect((await call('slack_send_message',{...target,text:'Reply'})).result.isError).toBe(true);
  send.mockResolvedValue({conversation_id:'CTEST',message_ts:'1793640001.123456',thread_ts:null});
  expect((await call('slack_send_message',{conversation_id:'CTEST',text:'Post'})).result.isError).not.toBe(true);
  vi.spyOn(SlackService.prototype,'thread').mockResolvedValue({source:'slack.conversations.replies',complete:true,next_cursor:null,messages:[]});
  expect((await call('slack_get_thread',target)).result.isError).not.toBe(true);
  expect(mocks.status).not.toHaveBeenCalled();
});

it('adds eyes to the actual follow-up message rather than the thread root',async()=>{
  const config={...e,SLACK_SESSION_STATUS_ENABLED:'0'};
  await setSessionStatus(config,'CTEST',target.thread_ts,'processing',Date.now()+2000,'1793640002.000001');
  expect(mocks.add).toHaveBeenCalledExactlyOnceWith({token:e.SLACK_BOT_TOKEN,channel:'CTEST',timestamp:'1793640002.000001',name:'eyes'});
  expect(mocks.status).not.toHaveBeenCalled();
});
it('clears only our eyes on human messages, across pages, after a confirmed reply',async()=>{
  const ours=[{name:'eyes',users:[e.SLACK_BOT_USER_ID]}];
  mocks.replies.mockResolvedValueOnce({messages:[{ts:target.thread_ts,user:'UHUMAN',reactions:ours},{ts:'2',user:'UHUMAN',reactions:[{name:'eyes',users:['UOTHER']}]},{ts:'3',user:e.SLACK_BOT_USER_ID,reactions:ours},{ts:'4',user:'UOTHERBOT',bot_id:'BOTHER',reactions:ours}],response_metadata:{next_cursor:'page2'}}).mockResolvedValueOnce({messages:[{ts:'5',user:'UHUMAN',reactions:ours}]});
  vi.spyOn(SlackService.prototype,'send').mockImplementation(async()=>{expect(mocks.remove).not.toHaveBeenCalled();return {...target,message_ts:'6'};});
  const result=await call('slack_send_message',{...target,text:'Reply'},{...e,SLACK_SESSION_STATUS_ENABLED:'0'});
  expect(result.result.isError).not.toBe(true);
  expect(mocks.remove.mock.calls.map(([args])=>args.timestamp)).toEqual([target.thread_ts,'5']);
  expect(mocks.replies.mock.calls[1][0].cursor).toBe('page2');
  expect(mocks.status).not.toHaveBeenCalled();
});
it('keeps replies successful when reaction cleanup fails',async()=>{
  mocks.replies.mockRejectedValue(new Error('timeout'));
  vi.spyOn(SlackService.prototype,'send').mockResolvedValue({...target,message_ts:'6'});
  expect((await call('slack_send_message',{...target,text:'Reply'},{...e,SLACK_SESSION_STATUS_ENABLED:'0'})).result.isError).not.toBe(true);
  expect(mocks.replies).toHaveBeenCalledTimes(1);
});
it('bounds reaction pagination and honors an expired deadline',async()=>{
  const config={...e,SLACK_SESSION_STATUS_ENABLED:'0'};
  let page=0;mocks.replies.mockImplementation(async()=>({messages:[],response_metadata:{next_cursor:String(++page)}}));
  await setSessionStatus(config,'CTEST',target.thread_ts,'active');
  expect(mocks.replies).toHaveBeenCalledTimes(10);
  mocks.createBolt.mockClear();
  await setSessionStatus(config,'CTEST',target.thread_ts,'processing',Date.now()-1);
  expect(mocks.createBolt).not.toHaveBeenCalled();
});
