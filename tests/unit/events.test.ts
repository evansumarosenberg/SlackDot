import { describe,it,expect } from 'vitest';
import { database } from '../support/database';
import { env,event,subscription,access } from '../support/fixtures';
import { normalize,matchesEvent,eventNames,eventDefinitions,eventSchemas } from '../../lib/slack/normalize';
import { subscribe,unsubscribe,subscribeSchema } from '../../lib/events/subscriptions';
import { CallbackClient } from '../../lib/events/callback';
import { canonical,hash } from '../../lib/runtime/crypto';
const runtime=()=>env({} as D1Database);
const changed=(extra={})=>event({subtype:'message_changed',hidden:true,event_ts:'1793640100.123456',message:{user:'UPERSON',text:'Edited',ts:'1793640000.123456',edited:{user:'UPERSON',ts:'1793640100.123456'}},...extra});
const deleted=(extra={})=>event({subtype:'message_deleted',hidden:true,deleted_ts:'1793640000.123456',event_ts:'1793640100.123456',...extra});
const reacted=(extra={})=>({...event(),event:{type:'reaction_added',user:'UPERSON',item_user:'UAUTHOR',item:{type:'message',channel:'CTEST',ts:'1793640000.123456'},reaction:'thumbsup',event_ts:'1793640100.123456',...extra}});
const verify=()=>new CallbackClient('https://receiver.example.com',async(_url,init)=>Response.json({challenge:JSON.parse(init.body as string).challenge}));
describe('event schemas and normalization',()=>{
  it('exposes all five strict event contracts',()=>{
    expect(eventDefinitions().map(definition=>definition.name)).toEqual(eventNames);
    for(const definition of eventDefinitions()) expect(definition.inputSchema.additionalProperties).toBe(false);
    expect(subscribeSchema.safeParse({...subscription(),arguments:{conversation_id:'CTEST',actor_user_ids:['UPERSON']}}).success).toBe(false);
    expect(subscribeSchema.safeParse({...subscription(),name:'slack.message.deleted',arguments:{conversation_id:'CTEST',mentions_only:true}}).success).toBe(false);
    expect(subscribeSchema.safeParse({...subscription(),name:'slack.reaction.added',arguments:{conversation_id:'CTEST',sender_user_ids:['UPERSON']}}).success).toBe(false);
  });
  it('preserves canonical new-message IDs and null replay cursor',()=>{
    const normalized=normalize(event(),runtime())!;
    expect(normalized.eventId).toBe(`evt_${hash('TTEST:CTEST:1793640000.123456')}`);
    expect(normalize(event(),runtime())).toEqual(normalized);
    expect(normalized.cursor).toBeNull();
    expect(normalized.data.thread_ts).toBe(normalized.data.message_ts);
  });
  it('ignores redundant mentions and thread summaries',()=>{
    expect(normalize(event({type:'app_mention'}),runtime())).toBeNull();
    expect(normalize(event({subtype:'message_replied'}),runtime())).toBeNull();
  });
  it('supports explicit mentions beyond the truncated preview',()=>{
    const normalized=normalize(event({text:'x'.repeat(4000)+'<@UBOT>'}),runtime())!;
    expect(normalized.data).toMatchObject({truncated:true,mentions_bot:true,text:'x'.repeat(4000)});
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',mentions_only:true,sender_user_ids:['UPERSON']})).toBe(true);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',sender_user_ids:['UOTHER']})).toBe(false);
  });
  it('includes other bots only on opt-in, while self messages remain excluded',()=>{
    const other=normalize(event({user:'UOTHER',bot_id:'BOTHER',subtype:'bot_message'}),runtime())!;
    expect(matchesEvent(other,other.name,{conversation_id:'CTEST'})).toBe(false);
    expect(matchesEvent(other,other.name,{conversation_id:'CTEST',include_bot_messages:true})).toBe(true);
    for(const patch of [{user:'UBOT'},{bot_id:'BBOT'},{app_id:'ATEST'}]) expect(normalize(event(patch),runtime())).toBeNull();
  });
  it('normalizes hidden changed envelopes as updates with occurrence time and nullable metadata',()=>{
    const normalized=normalize(changed(),runtime())!;
    expect(normalized.name).toBe('slack.message.updated');
    expect(normalized.timestamp).toBe(new Date(1793640100123).toISOString());
    expect(normalized.data).toMatchObject({message_ts:'1793640000.123456',thread_ts:null,text:'Edited',author_id:'UPERSON',edited_at:'1793640100.123456',editor_id:'UPERSON'});
    const partial=normalize(changed({message:{ts:'1793640000.123456'}}),runtime())!;
    expect(partial.data).toMatchObject({text:null,thread_ts:null,author_id:null,is_bot:null,mentions_bot:null,edited_at:null,editor_id:null});
    expect(matchesEvent(partial,partial.name,{conversation_id:'CTEST',include_bot_messages:true})).toBe(false);
  });
  it('uses each Slack occurrence ID to distinguish repeated edits and reactions',()=>{
    for(const body of [changed(),reacted()]) {
      const one=normalize(body,runtime())!;
      expect(normalize(body,runtime())!.eventId).toBe(one.eventId);
      const two=normalize({...body,event_id:'EvSECOND'},runtime())!;
      expect(two.eventId).not.toBe(one.eventId);
    }
  });
  it('retains deletion unknowns without inventing a root thread or original text',()=>{
    const normalized=normalize(deleted(),runtime())!;
    expect(normalized.name).toBe('slack.message.deleted');
    expect(normalized.data).toEqual({workspace_id:'TTEST',conversation_id:'CTEST',message_ts:'1793640000.123456',thread_ts:null,author_id:null,is_bot:null});
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST'})).toBe(false);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',include_bot_messages:true})).toBe(false);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',include_bot_messages:true,sender_user_ids:['UPERSON']})).toBe(false);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',include_bot_messages:true,thread_ts:'1793640000.123456'})).toBe(false);
  });
  it('uses known previous metadata only for deletion filters and excludes self',()=>{
    const previous={user:'UPERSON',ts:'1793640001.123456',thread_ts:'1793640000.123456'};
    const normalized=normalize(deleted({deleted_ts:previous.ts,previous_message:previous}),runtime())!;
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',thread_ts:previous.thread_ts,sender_user_ids:['UPERSON']})).toBe(true);
    expect(normalize(deleted({previous_message:{...previous,user:'UBOT'}}),runtime())).toBeNull();
    expect(normalize(changed({message:{...previous,user:'UBOT'}}),runtime())).toBeNull();
  });
  it('distinguishes reacting actor from item author, allowing human reactions to the bot',()=>{
    const normalized=normalize(reacted({item_user:'UBOT'}),runtime())!;
    expect(normalized.name).toBe('slack.reaction.added');
    expect(normalized.data).toMatchObject({actor_user_id:'UPERSON',author_id:'UBOT',thread_ts:null,emoji_name:'thumbsup'});
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',actor_user_ids:['UPERSON'],emoji_name:'thumbsup'})).toBe(true);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',actor_user_ids:['UBOT']})).toBe(false);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',emoji_name:'heart'})).toBe(false);
    expect(normalize(reacted({user:'UBOT'}),runtime())).toBeNull();
    expect(normalize(reacted({item_user:undefined}),runtime())!.data).toMatchObject({author_id:null});
  });
  it('normalizes reaction removal separately and ignores non-message items',()=>{
    expect(normalize(reacted({type:'reaction_removed'}),runtime())!.name).toBe('slack.reaction.removed');
    expect(normalize(reacted({item:{type:'file',file:'FTEST'}}),runtime())).toBeNull();
    expect(normalize(reacted({item:{type:'file_comment',file_comment:'FTEST'}}),runtime())).toBeNull();
  });
  it('requires exact event, conversation, known thread, and valid filter arguments',()=>{
    const normalized=normalize(event({thread_ts:'1793640001.123456'}),runtime())!;
    expect(matchesEvent(normalized,'slack.message.updated',{conversation_id:'CTEST'})).toBe(false);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'COTHER'})).toBe(false);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',thread_ts:'1793640001.123456'})).toBe(true);
    expect(matchesEvent(normalized,normalized.name,{conversation_id:'CTEST',thread_ts:'1793640002.123456'})).toBe(false);
    for(const args of [null,{},[],{conversation_id:'CTEST',unknown:true},{conversation_id:'CTEST',sender_user_ids:[]}]) expect(matchesEvent(normalized,normalized.name,args)).toBe(false);
  });
  it('rejects malformed target identifiers and event payload fields without throwing',()=>{
    for(const body of [event({channel:'bad'}),event({ts:'bad'}),event({thread_ts:'bad'}),changed({message:{ts:'bad'}}),deleted({deleted_ts:'bad'}),reacted({reaction:'not an emoji'})]) {
      expect(normalize(body,runtime())).toBeNull();
    }
  });
});
describe('extended subscription identities',()=>{
  it('preserves exact legacy identity and encrypted association after introducing filters',async()=>{
    const {db,sqlite}=database(),e=env(db),input=subscription();
    const expected=`sub_${hash(canonical({principal:'owner',url:input.delivery.url,name:input.name,arguments:input.arguments}))}`;
    const first=await subscribe(e,'owner',input,access,verify(),1000);
    expect(first.id).toBe(expected);
    expect(sqlite.prepare('SELECT args FROM subscriptions').get()?.args).toBe('{"conversation_id":"CTEST"}');
    const refreshed=await subscribe(e,'owner',input,access,verify(),2000);
    expect(refreshed.id).toBe(expected);
    await unsubscribe(e,'owner',{name:input.name,arguments:input.arguments,delivery:{mode:'webhook',url:input.delivery.url}},3000);
    expect(sqlite.prepare('SELECT count(*) n FROM subscriptions').get()?.n).toBe(0);
  });
  it.each(eventNames)('creates and canonically removes %s without new storage',async(name)=>{
    const {db,sqlite}=database(),e=env(db),input={...subscription(),name};
    const created=await subscribe(e,'owner',input,access,verify(),1000);
    expect(sqlite.prepare('SELECT name FROM subscriptions WHERE id=?').get(created.id)?.name).toBe(name);
    await unsubscribe(e,'owner',{name,arguments:input.arguments,delivery:{mode:'webhook',url:input.delivery.url}},2000);
    expect(sqlite.prepare('SELECT count(*) n FROM subscriptions').get()?.n).toBe(0);
  });
  it('does not materialize implicit boolean defaults during schema parsing',()=>{
    for(const name of eventNames) expect(eventSchemas[name].filter.parse({conversation_id:'CTEST'})).toEqual({conversation_id:'CTEST'});
  });
});
