import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
// Real SQLite transactions exercise the production D1 SQL without an HTTP service.
export function database() {
  const sqlite=new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const queries:string[]=[];
  function prepare(sql:string,values:unknown[]=[]): any {
    // Runtime tests must fail if application code resumes operational persistence.
    // Record SQL shape only; never keep event, secret or request argument values.
    if(!/\bsubscriptions\b/i.test(sql) || /\b(receipts|events|deliveries|delivery_notices|writes)\b/i.test(sql)) {
      throw new Error('Application database access must use subscriptions only');
    }
    queries.push(sql);
    return {bind:(...args:unknown[])=>prepare(sql,args),
      first:async()=>sqlite.prepare(sql).get(...values as any[]) ?? null,
      all:async()=>({results:sqlite.prepare(sql).all(...values as any[])}),
      run:async()=>{const r=sqlite.prepare(sql).run(...values as any[]); return {success:true,meta:{changes:Number(r.changes)}};}};
  }
  return {sqlite, queries, db:{prepare,batch:async(statements:any[])=>{
    sqlite.exec('BEGIN');try {const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}
    catch(e){sqlite.exec('ROLLBACK');throw e;}
  }} as unknown as D1Database};
}
