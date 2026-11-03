import {it,expect} from 'vitest';
import {database} from '../support/database';
import {env} from '../support/fixtures';
import {cleanup} from '../../lib/storage';
import {claimDelivery,finishDelivery,ownsClaim,deliveryKey,CLAIM_MS,DEDUP_MS} from '../../lib/events/dedup';

it('atomically admits one simultaneous claimant and separates event/subscription pairs',async()=>{
  const {db,sqlite}=database(),e=env(db);
  const claims=await Promise.all(Array.from({length:8},()=>claimDelivery(e,'event','subscription',1000)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await claimDelivery(e,'other-event','subscription',1000)).not.toBeNull();
  expect(await claimDelivery(e,'event','other-subscription',1000)).not.toBeNull();
  const rows=sqlite.prepare('SELECT * FROM event_dedup').all();expect(rows).toHaveLength(3);
  expect(Object.keys(rows[0])).toEqual(['key','state','claim_token','claim_expires_at','expires_at']);
  expect(rows.every(row=>/^[a-f0-9]{64}$/.test(row.key as string))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('subscription');expect(JSON.stringify(rows)).not.toContain('event');
  expect(deliveryKey(e,'ab','c')).not.toBe(deliveryKey(e,'a','bc'));
  expect(deliveryKey(e,'event','subscription')).toBe(deliveryKey(e,'event','subscription'));
  expect(deliveryKey({...e,SUBSCRIPTION_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},'event','subscription')).not.toBe(claims.find(Boolean)!.key);
});
it('suppresses delivered events until fixed expiry, including when cleanup has not run',async()=>{
  const {db,sqlite}=database(),e=env(db),start=1000;
  const claim=(await claimDelivery(e,'event','sub',start))!;
  await finishDelivery(e,claim,'delivered',start+1);
  expect(await claimDelivery(e,'event','sub',start+CLAIM_MS)).toBeNull();
  expect(await claimDelivery(e,'event','sub',start+DEDUP_MS-1)).toBeNull();
  expect(sqlite.prepare('SELECT expires_at FROM event_dedup').get()?.expires_at).toBe(start+DEDUP_MS);
  expect(await claimDelivery(e,'event','sub',start+DEDUP_MS)).not.toBeNull();
  expect(sqlite.prepare('SELECT expires_at FROM event_dedup').get()?.expires_at).toBe(start+2*DEDUP_MS);
});
it.each(['processing','failed'] as const)('reclaims %s at the lease boundary without extending retention or allowing stale completion',async(state)=>{
  const {db,sqlite}=database(),e=env(db);
  const original=(await claimDelivery(e,'event','sub',1000))!;
  if(state==='failed') await finishDelivery(e,original,'failed',1001);
  expect(await claimDelivery(e,'event','sub',1000+CLAIM_MS-1)).toBeNull();
  const next=(await claimDelivery(e,'event','sub',1000+CLAIM_MS))!;expect(next).not.toBeNull();
  expect(next.token).not.toBe(original.token);
  expect(await ownsClaim(e,original,1000+CLAIM_MS)).toBe(false);
  expect(await ownsClaim(e,next,1000+CLAIM_MS)).toBe(true);
  await finishDelivery(e,original,'delivered',1000+CLAIM_MS+1);
  expect(sqlite.prepare('SELECT state,expires_at FROM event_dedup').get()).toEqual({state:'processing',expires_at:1000+DEDUP_MS});
  await finishDelivery(e,next,'delivered',1000+CLAIM_MS+1);
  expect(await ownsClaim(e,next,1000+CLAIM_MS+1)).toBe(false);
});
it('does not complete expired claims, or let a stale token alter a new retention window',async()=>{
  const {db,sqlite}=database(),e=env(db);
  const old=(await claimDelivery(e,'event','sub',1000))!;
  await finishDelivery(e,old,'delivered',1000+CLAIM_MS);
  expect(sqlite.prepare('SELECT state FROM event_dedup').get()?.state).toBe('processing');
  const next=(await claimDelivery(e,'event','sub',1000+DEDUP_MS))!;
  await finishDelivery(e,old,'failed',1000+DEDUP_MS+1);
  expect(await ownsClaim(e,next,1000+DEDUP_MS+1)).toBe(true);
});
it('cleans expired records in bounded batches without deleting live records',async()=>{
  const {db,sqlite}=database(),e=env(db);
  for(let i=0;i<105;i++) await claimDelivery(e,`event-${i}`,'sub',1000);
  await claimDelivery(e,'live','sub',1001);
  await cleanup(e,1000+DEDUP_MS);
  expect(sqlite.prepare('SELECT count(*) n FROM event_dedup').get()?.n).toBe(6);
  await cleanup(e,1000+DEDUP_MS);
  expect(sqlite.prepare('SELECT key FROM event_dedup').all()).toEqual([{key:deliveryKey(e,'live','sub')}]);
});
it('does not start a reclaim that could overlap a fresh expiration window',async()=>{
  const {db}=database(),e=env(db);
  await claimDelivery(e,'event','sub',1000);
  expect(await claimDelivery(e,'event','sub',1000+DEDUP_MS-CLAIM_MS)).not.toBeNull();
  expect(await claimDelivery(e,'event','sub',1000+DEDUP_MS-1)).toBeNull();
  expect(await claimDelivery(e,'event','sub',1000+DEDUP_MS)).not.toBeNull();
  await claimDelivery(e,'other','sub',1000);
  expect(await claimDelivery(e,'other','sub',1000+DEDUP_MS-CLAIM_MS+1)).toBeNull();
});
