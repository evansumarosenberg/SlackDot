import { beforeEach,it,expect,vi } from 'vitest';
import { database } from '../support/database';
import { env } from '../support/fixtures';
const mocks=vi.hoisted(()=>({auth:vi.fn(),info:vi.fn(),post:vi.fn(),replies:vi.fn()}));
vi.mock('../../lib/slack/receiver',()=>({createBolt:()=>({app:{client:{auth:{test:mocks.auth},conversations:{info:mocks.info,replies:mocks.replies},chat:{postMessage:mocks.post}}}})}));
import { SlackService } from '../../lib/slack/service';
beforeEach(()=>{
  vi.resetAllMocks();mocks.auth.mockResolvedValue({team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'});
  mocks.info.mockResolvedValue({channel:{id:'CTEST',is_member:true}});
  mocks.post.mockResolvedValue({channel:'CTEST',ts:'1793640001.123456'});
});
const input={conversation_id:'CTEST',text:'Synthetic reply',request_id:'request-123',thread_ts:'1793640000.123456'};
it('persists successful write results and rejects request ID conflicts',async()=>{
  const {db}=database(),service=new SlackService(env(db));
  const first=await service.send(input,'owner');const second=await new SlackService(env(db)).send(input,'owner');
  expect(second).toEqual(first);expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0][0].thread_ts).toBe(input.thread_ts);expect(mocks.post.mock.calls[0][0].reply_broadcast).toBe(false);
  await expect(service.send({...input,text:'different'},'owner')).rejects.toThrow('request_id_conflict');
});
it('never automatically repeats an ambiguous Slack write',async()=>{
  const {db,sqlite}=database(),service=new SlackService(env(db));mocks.post.mockRejectedValue(new Error('lost response with secret payload'));
  await expect(service.send(input,'owner')).rejects.toThrow('ambiguous_write');
  await expect(service.send(input,'owner')).rejects.toThrow('ambiguous_write');
  expect(mocks.post).toHaveBeenCalledTimes(1);expect(sqlite.prepare('SELECT state FROM writes').get()?.state).toBe('ambiguous');
});
it('guards concurrent writes and a crash after claim',async()=>{
  const {db}=database(),service=new SlackService(env(db));
  const outcomes=await Promise.allSettled([service.send(input,'owner'),service.send(input,'owner')]);
  expect(outcomes.some(o=>o.status==='fulfilled')).toBe(true);expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('checks workspace identity and conversation membership before posting',async()=>{
  const service=new SlackService(env(database().db));
  mocks.auth.mockResolvedValueOnce({team_id:'TOTHER',user_id:'UBOT',bot_id:'BBOT'});
  await expect(service.send(input,'owner')).rejects.toThrow('installation_mismatch');
  mocks.info.mockResolvedValueOnce({channel:{is_member:false}});
  await expect(service.send(input,'owner')).rejects.toThrow('conversation_unavailable');
  mocks.info.mockResolvedValueOnce({channel:{is_member:true,is_mpim:true}});
  await expect(service.send(input,'owner')).rejects.toThrow('conversation_unavailable');expect(mocks.post).not.toHaveBeenCalled();
});
it('reports thread pagination and unsupported bot-token behavior without fabricated context',async()=>{
  const service=new SlackService(env(database().db));
  mocks.replies.mockResolvedValueOnce({has_more:true,response_metadata:{next_cursor:'next'},messages:[{ts:input.thread_ts,text:'Synthetic context',user:'UPERSON'}]});
  expect(await service.thread({conversation_id:'CTEST',thread_ts:input.thread_ts,limit:20})).toMatchObject({source:'slack.conversations.replies',complete:false,next_cursor:'next'});
  mocks.replies.mockRejectedValueOnce({data:{error:'not_allowed_token_type'}});
  await expect(service.thread({conversation_id:'CTEST',thread_ts:input.thread_ts,limit:20})).rejects.toThrow('conversation_unavailable');
});
