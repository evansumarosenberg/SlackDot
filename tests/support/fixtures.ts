import type { Env } from '../../lib/runtime/config';
export const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
export const env=(DB:D1Database):Env=>({DB,SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',
  SLACK_TEAM_ID:'TTEST',SLACK_BOT_USER_ID:'UBOT',SLACK_BOT_ID:'BBOT',SLACK_APP_ID:'ATEST',OWNER_USER_ID:'owner',
  SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),CALLBACK_ALLOWED_ORIGINS:'https://receiver.example.com',
  DELIVERY_TRIGGER_SECRET:'synthetic-trigger-secret-at-least-32-characters',SITES_IDENTITY_VERIFIED:'true'});
export const event=(extra={})=>({type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:'EvTEST',event:{type:'message',user:'UPERSON',channel:'CTEST',ts:'1793640000.123456',text:'Synthetic compatibility message',...extra}});
export const subscription=(args:Record<string,string>={conversation_id:'CTEST'})=>({name:'slack.message.created',arguments:args,delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret},cursor:null});
export const access=async()=>{};
