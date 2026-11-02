import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
// Real SQLite transactions exercise the production D1 SQL without an HTTP service.
export function database() {
  const sqlite=new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql'))) sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  function prepare(sql:string,values:unknown[]=[]): any {
    return {bind:(...args:unknown[])=>prepare(sql,args),
      first:async()=>sqlite.prepare(sql).get(...values as any[]) ?? null,
      all:async()=>({results:sqlite.prepare(sql).all(...values as any[])}),
      run:async()=>{const r=sqlite.prepare(sql).run(...values as any[]); return {success:true,meta:{changes:Number(r.changes)}};}};
  }
  return {sqlite, db:{prepare,batch:async(statements:any[])=>{
    sqlite.exec('BEGIN');try {const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}
    catch(e){sqlite.exec('ROLLBACK');throw e;}
  }} as unknown as D1Database};
}
