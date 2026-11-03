import { beforeEach,it,expect,vi } from 'vitest';
import { env } from '../support/fixtures';
const mocks=vi.hoisted(()=>({auth:vi.fn(),info:vi.fn(),post:vi.fn(),replies:vi.fn()}));
vi.mock('../../lib/slack/receiver',()=>({createBolt:()=>({app:{client:{auth:{test:mocks.auth},conversations:{info:mocks.info,replies:mocks.replies},chat:{postMessage:mocks.post}}}})}));
import { SlackService, sendSchema } from '../../lib/slack/service';
beforeEach(()=>{
  vi.resetAllMocks();mocks.auth.mockResolvedValue({team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
  mocks.info.mockResolvedValue({channel:{id:'CTEST',is_member:true}});
  mocks.post.mockResolvedValue({channel:'CTEST',ts:'1793640001.123456'});
});
const input={conversation_id:'CTEST',text:'Synthetic reply',request_id:'request-123',thread_ts:'1793640000.123456'};
const noStorage=new Proxy({} as D1Database,{get(){throw new Error('Slack tools must not access storage');}});
it('posts once per invocation without retaining or replaying legacy request IDs',async()=>{
  const service=new SlackService(env(noStorage));
  const first=await service.send(input,'owner');
  expect(first).toEqual({conversation_id:'CTEST',message_ts:'1793640001.123456',thread_ts:input.thread_ts});
  await new SlackService(env(noStorage)).send(input,'owner');
  await service.send({...input,text:'different'},'owner');
  expect(mocks.post).toHaveBeenCalledTimes(3);
  expect(mocks.post.mock.calls[0][0]).toMatchObject({thread_ts:input.thread_ts,reply_broadcast:false,unfurl_links:false,unfurl_media:false});
  expect(mocks.post.mock.calls[0][0]).not.toHaveProperty('request_id');
});
it('accepts new calls without a legacy request ID',async()=>{
  const parsed=sendSchema.parse({conversation_id:'CTEST',text:'Synthetic reply'});
  expect(parsed.request_id).toBeUndefined();
  expect(await new SlackService(env(noStorage)).send(parsed,'owner')).toMatchObject({thread_ts:null});
});
it('never automatically repeats an ambiguous Slack write or retains the failure',async()=>{
  const service=new SlackService(env(noStorage));
  mocks.post.mockRejectedValueOnce(new Error('lost response with secret payload'));
  await expect(service.send(input,'owner')).rejects.toThrow('ambiguous_write');
  expect(mocks.post).toHaveBeenCalledTimes(1);
  await expect(service.send(input,'owner')).resolves.toMatchObject({conversation_id:'CTEST'});
  expect(mocks.post).toHaveBeenCalledTimes(2);
});
it('allows independent concurrent invocations with no cross-request suppression',async()=>{
  const service=new SlackService(env(noStorage));
  const outcomes=await Promise.allSettled([service.send(input,'owner'),service.send(input,'owner')]);
  expect(outcomes.every(o=>o.status==='fulfilled')).toBe(true);
  expect(mocks.post).toHaveBeenCalledTimes(2);
});
it.each([
  [{code:'slack_webapi_rate_limited_error',retryAfter:12},'rate_limited'],
  [{data:{error:'missing_scope'}},'missing_scope'],
  [{data:{error:'token_revoked'}},'installation_revoked'],
  [{data:{error:'not_in_channel'}},'conversation_unavailable'],
  [{data:{error:'msg_too_long'}},'invalid_message'],
  [{data:{error:'internal_error'}},'ambiguous_write'],
])('reports bounded Slack rejections and uncertainty without retries',async(error,category)=>{
  mocks.post.mockRejectedValueOnce(error);
  await expect(new SlackService(env(noStorage)).send(input,'owner')).rejects.toMatchObject({category});
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('treats incomplete success responses as uncertain',async()=>{
  mocks.post.mockResolvedValueOnce({ok:true});
  await expect(new SlackService(env(noStorage)).send(input,'owner')).rejects.toThrow('ambiguous_write');
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('checks workspace identity and conversation membership before posting',async()=>{
  const service=new SlackService(env(noStorage));
  mocks.auth.mockResolvedValueOnce({team_id:'TOTHER',user_id:'UBOT',bot_id:'BBOT'});
  await expect(service.send(input,'owner')).rejects.toThrow('installation_mismatch');
  mocks.info.mockResolvedValueOnce({channel:{is_member:false}});
  await expect(service.send(input,'owner')).rejects.toThrow('conversation_unavailable');
  mocks.info.mockResolvedValueOnce({channel:{is_member:true,is_mpim:true}});
  await expect(service.send(input,'owner')).rejects.toThrow('conversation_unavailable');expect(mocks.post).not.toHaveBeenCalled();
});
it('reports thread pagination and unsupported bot-token behavior without fabricated context',async()=>{
  const service=new SlackService(env(noStorage));
  mocks.replies.mockResolvedValueOnce({has_more:true,response_metadata:{next_cursor:'next'},messages:[{ts:input.thread_ts,text:'Synthetic context',user:'UPERSON'}]});
  expect(await service.thread({conversation_id:'CTEST',thread_ts:input.thread_ts,limit:20})).toMatchObject({source:'slack.conversations.replies',complete:false,next_cursor:'next'});
  mocks.replies.mockRejectedValueOnce({data:{error:'not_allowed_token_type'}});
  await expect(service.thread({conversation_id:'CTEST',thread_ts:input.thread_ts,limit:20})).rejects.toThrow('conversation_unavailable');
});
