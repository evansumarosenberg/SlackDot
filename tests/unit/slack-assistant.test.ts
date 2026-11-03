import {beforeEach,it,expect,vi} from 'vitest';
import {env} from '../support/fixtures';
const mocks=vi.hoisted(()=>({auth:vi.fn(),info:vi.fn(),status:vi.fn(),title:vi.fn(),prompts:vi.fn()}));
vi.mock('../../lib/slack/receiver',()=>({createBolt:()=>({app:{client:{auth:{test:mocks.auth},conversations:{info:mocks.info},assistant:{threads:{setStatus:mocks.status,setTitle:mocks.title,setSuggestedPrompts:mocks.prompts}}}}})}));
import {SlackService,assistantStatusSchema,assistantTitleSchema,assistantPromptsSchema} from '../../lib/slack/service';
import {handleMcp} from '../../lib/mcp/server';
function rpc(method:string,params:Record<string,unknown>,principal='owner') {
  return new Request('https://site.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','Mcp-Method':method,'Mcp-Name':String(params.name),'MCP-Protocol-Version':'2026-07-28','oai-authenticated-user-id':principal},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
}
const noStorage=new Proxy({} as D1Database,{get(){throw new Error('Assistant tools must not access storage');}});
const e=env(noStorage),target={conversation_id:'DTEST',thread_ts:'1793640000.123456'};
const prompts=[{title:'Summarize',message:'Summarize this conversation.'}];
const operations=[
  {mock:'status',name:'slack_set_assistant_status',input:{...target,status:'is thinking...'},run:(s:SlackService)=>s.setAssistantStatus({...target,status:'is thinking...'})},
  {mock:'title',name:'slack_set_assistant_title',input:{...target,title:'Planning'},run:(s:SlackService)=>s.setAssistantTitle({...target,title:'Planning'})},
  {mock:'prompts',name:'slack_set_assistant_suggested_prompts',input:{...target,prompts},run:(s:SlackService)=>s.setAssistantSuggestedPrompts({...target,prompts})},
] as const;
beforeEach(()=>{
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
  mocks.info.mockResolvedValue({channel:{id:'DTEST',is_im:true,user:'UPERSON'}});
  for(const key of ['status','title','prompts'] as const)mocks[key].mockResolvedValue({ok:true});
});
it.each(operations)('executes $name through MCP validation without storage',async({name,input,mock})=>{
  const body=await (await handleMcp(rpc('tools/call',{name,arguments:input}),e)).json() as any;
  expect(body.error).toBeUndefined();expect(body.result.isError).not.toBe(true);
  expect(body.result.structuredContent).toEqual({...target,ok:true});
  const {conversation_id,...args}=input;
  expect(mocks[mock]).toHaveBeenCalledExactlyOnceWith({token:e.SLACK_BOT_TOKEN,channel_id:conversation_id,...args});
});
it('preserves empty status for clearing and forwards all optional display fields',async()=>{
  const input=assistantStatusSchema.parse({...target,status:'',loading_messages:['Reading','Thinking'],icon_emoji:':eyes:',icon_url:'https://example.com/icon.png',username:'SlackDot'});
  await new SlackService(e).setAssistantStatus(input);
  const {conversation_id,...args}=input;
  expect(mocks.status).toHaveBeenCalledExactlyOnceWith({channel_id:conversation_id,token:e.SLACK_BOT_TOKEN,...args});
});
it('omits optional thread_ts for agent-view prompts and forwards the list title',async()=>{
  const input=assistantPromptsSchema.parse({conversation_id:'DTEST',prompts,title:'Next steps'});
  const body=await (await handleMcp(rpc('tools/call',{name:'slack_set_assistant_suggested_prompts',arguments:input}),e)).json() as any;
  expect(body.result.structuredContent).toEqual({conversation_id:'DTEST',thread_ts:null,ok:true});
  expect(mocks.prompts).toHaveBeenCalledExactlyOnceWith({channel_id:'DTEST',token:e.SLACK_BOT_TOKEN,prompts,title:'Next steps'});
});
it('enforces bounded inputs, exact timestamps, and strict nested prompt objects',()=>{
  expect(assistantPromptsSchema.safeParse({...target,prompts:Array(4).fill(prompts[0])}).success).toBe(true);
  expect(assistantStatusSchema.safeParse({...target,status:'',loading_messages:Array(10).fill('Working')}).success).toBe(true);
  for(const input of [
    {...target,status:'x',loading_messages:[]}, {...target,status:'x',loading_messages:Array(11).fill('Working')},
    {...target,status:'x',icon_url:'file:///secret'}, {...target,status:'x'.repeat(4001)},
    {...target,status:'x',thread_ts:1793640000.123456}, {...target,status:'x',token:'override'},
  ])expect(assistantStatusSchema.safeParse(input).success).toBe(false);
  expect(assistantTitleSchema.safeParse({...target,title:''}).success).toBe(false);
  expect(assistantPromptsSchema.safeParse({...target,prompts:Array(5).fill(prompts[0])}).success).toBe(false);
  expect(assistantPromptsSchema.safeParse({...target,prompts:[{title:'Test'}]}).success).toBe(false);
  expect(assistantPromptsSchema.safeParse({...target,prompts:[{...prompts[0],extra:'no'}]}).success).toBe(false);
});
it.each(operations)('rejects invalid arguments and non-owner access before $name',async({name,input,mock})=>{
  for(const who of ['', 'stranger'])expect((await handleMcp(rpc('tools/call',{name,arguments:input},who),e)).status).toBe(403);
  const result=await (await handleMcp(rpc('tools/call',{name,arguments:{...input,thread_ts:'bad'}}),e)).json() as any;
  expect(result.error || result.result?.isError).toBeTruthy();
  expect(mocks.auth).not.toHaveBeenCalled();expect(mocks[mock]).not.toHaveBeenCalled();
});
it.each(operations)('checks installation and conversation access before $name',async({run,mock})=>{
  mocks.auth.mockResolvedValueOnce({team_id:'TOTHER',user_id:'UBOT',bot_id:'BBOT'});
  await expect(run(new SlackService(e))).rejects.toThrow('installation_mismatch');
  for(const channel of [{id:'DTEST',is_mpim:true,is_member:true},{id:'DTEST',is_archived:true,is_im:true},{id:'DTEST',is_member:false},{id:'DTEST',is_im:true,context_team_id:'TOTHER'}]) {
    mocks.info.mockResolvedValueOnce({channel});
    await expect(run(new SlackService(e))).rejects.toThrow('conversation_unavailable');
  }
  expect(mocks[mock]).not.toHaveBeenCalled();
});
it.each(operations)('sanitizes errors and never retries $name',async({name,input,mock,run})=>{
  for(const [error,category] of [['missing_scope','missing_scope'],['invalid_thread_ts','invalid_message'],['internal_error','ambiguous_write']] as const) {
    mocks[mock].mockRejectedValueOnce({data:{error},message:'sensitive upstream content'});
    const result=await (await handleMcp(rpc('tools/call',{name,arguments:input}),e)).json() as any;
    expect(result.result.isError).toBe(true);expect(JSON.parse(result.result.content[0].text)).toEqual({error:category});
    expect(JSON.stringify(result)).not.toContain('sensitive');
  }
  mocks[mock].mockRejectedValueOnce({code:'slack_webapi_rate_limited_error',retryAfter:17});
  await expect(run(new SlackService(e))).rejects.toMatchObject({category:'rate_limited',retryAfter:17});
  for(const result of [{},{ok:false},{ok:'true'}]) {
    mocks[mock].mockResolvedValueOnce(result);
    await expect(run(new SlackService(e))).rejects.toThrow('ambiguous_write');
  }
  expect(mocks[mock]).toHaveBeenCalledTimes(7);
});
