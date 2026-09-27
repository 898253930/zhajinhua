import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('完整联机、权限、幂等、账本与崩溃恢复', {timeout:120000},async t=>{
  mkdirSync('test-results',{recursive:true});const dir=mkdtempSync(resolve('test-results','api-')),port=35000+Math.floor(Math.random()*10000),origin=`http://127.0.0.1:${port}`,dbPath=resolve(dir,'game.sqlite');
  let child,logs='',pgClient,pgUrl,schema;
  if(process.env.TEST_DATABASE_URL){
    const {default:pg}=await import('pg');pgClient=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await pgClient.connect();
    schema='test_api_'+randomUUID().replaceAll('-','');await pgClient.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);pgUrl=url.toString();
    await pgClient.query(`SET search_path TO "${schema}"`);
  }
  async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,LOAD_ENV:'0',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:pgUrl||'',DB_PATH:pgUrl?'':dbPath},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<200;i++){try{if((await fetch(origin+'/api/bootstrap')).ok)return;}catch{}await wait(50);}throw Error(logs);}
  async function stop(){if(!child||child.exitCode!==null)return;const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}
  t.after(async()=>{await stop();if(pgClient){await pgClient.query(`DROP SCHEMA "${schema}" CASCADE`);await pgClient.end();}});await start();
  function client(){let cookie='';return async(path,data,expected=200)=>{const response=await fetch(origin+'/api'+path,{method:data?'POST':'GET',headers:{Cookie:cookie,...(data?{'Content-Type':'application/json',Origin:origin}:{})},body:data?JSON.stringify({requestId:randomUUID(),...data}):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const b=await response.json();assert.equal(response.status,expected,JSON.stringify(b));return b;};}
  const admin=client(),alice=client(),bob=client(),anon=client();
  const root=await admin('/setup',{username:'admin',nickname:'馆主',password:'Test-password-123'});
  assert.equal(root.me.role,'admin');assert.equal(root.me.balance,10000);
  await anon('/setup',{username:'admin2',nickname:'第二管理员',password:'Test-password-123'},400);
  const a=await alice('/register',{username:'alice',nickname:'小鹿',password:'Test-password-123'}),b=await bob('/register',{username:'bob',nickname:'南风',password:'Test-password-123'});
  await alice('/admin',undefined,403);
  await alice('/admin/adjust',{userId:a.me.id,amount:999,reason:'越权测试'},403);
  await admin('/admin/adjust',{userId:root.me.id,amount:100,reason:'管理员自增测试'},400);
  const req={requestId:randomUUID(),userId:a.me.id,amount:500,reason:'测试发放'};
  await admin('/admin/adjust',req);await admin('/admin/adjust',req);assert.equal((await alice('/state')).me.balance,10500);
  await admin('/admin/adjust',{...req,amount:501},409);
  await admin('/admin/adjust',{userId:a.me.id,amount:-20000,reason:'超额扣减'},400);
  await alice('/rooms/create',{buyin:2000});const created=await alice('/state');assert.equal(created.me.balance,8500);
  await bob('/rooms/join',{code:created.room.code,buyin:2000});
  await alice('/rooms/ready',{});await bob('/rooms/ready',{});await wait(3700);
  let state=await alice('/state'),g=state.room.game;assert.equal(g.status,'playing');assert.equal(g.pot,20);assert.ok(g.players.every(p=>p.cards===null));
  const current=g.actor===a.me.id?alice:bob,other=g.actor===a.me.id?bob:alice;
  const command={handId:g.id,version:g.version,turnId:g.turnId,type:'look'};
  await other('/game/action',command,400);
  await current('/game/action',command);g=(await current('/state')).room.game;assert.ok(g.players.find(p=>p.id===g.actor).cards);assert.ok((await other('/state')).room.game.players.every(p=>p.cards===null));
  await current('/game/action',command,409);
  const fold={requestId:randomUUID(),handId:g.id,version:g.version,turnId:g.turnId,type:'fold'};await current('/game/action',fold);await current('/game/action',fold);
  state=await alice('/state');assert.equal(state.room.game.status,'settled');assert.equal(state.room.seats.reduce((n,p)=>n+p.chips,0),4000);
  await alice('/rooms/ready',{});await bob('/rooms/ready',{});await wait(3600);
  assert.equal((await alice('/state')).room.game.status,'playing');await stop();await start();
  const afterA=await alice('/state'),afterB=await bob('/state');assert.equal(afterA.room,null);assert.equal(afterA.me.balance+afterB.me.balance,20500);
  const history=await alice('/history');assert.ok(history.some(h=>h.status==='voided'));assert.ok(history.some(h=>h.status==='settled'));
  await admin('/admin/status',{userId:b.me.id,disabled:true});await bob('/state',undefined,401);await bob('/login',{username:'bob',password:'Test-password-123'},403);
  const raw=pgClient?null:new DatabaseSync(dbPath);
  const query=async sql=>pgClient?(await pgClient.query(sql)).rows[0]:raw.prepare(sql).get();
  assert.equal(Number((await query('SELECT SUM(balance) AS total FROM accounts')).total),0);
  assert.equal(Number((await query('SELECT COUNT(*) AS n FROM (SELECT tx_id FROM entries GROUP BY tx_id HAVING SUM(amount)<>0) AS bad')).n),0);
  assert.equal(Number((await query("SELECT COUNT(*) AS n FROM accounts WHERE kind<>'system' AND balance<0")).n),0);raw?.close();
  const staticResponse=await fetch(origin+'/');assert.equal(staticResponse.status,200);assert.match(await staticResponse.text(),/金花小馆/);
  const csrf=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body:'{}'});assert.equal(csrf.status,403);
});
