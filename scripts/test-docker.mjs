import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
process.loadEnvFile('.env');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
mkdirSync('test-results', { recursive: true });
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw Error((result.stderr || result.error?.message || 'Docker command failed').trim());
  return result.stdout.trim();
}
try {
  for (const [arch, port] of [['amd64',3311],['arm64',3312]]) {
    const id = randomUUID().replaceAll('-',''),schema = 'test_docker_' + id,name = 'jinhua-test-' + id;
    const envPath = resolve('test-results',name+'.env');
    await client.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
    writeFileSync(envPath,`DATABASE_URL=${url}\nHOST=0.0.0.0\nPORT=3000\n`,{mode:0o600});
    let created = false;
    try {
      docker('run','-d','--init','--name',name,'--platform','linux/'+arch,'--env-file',envPath,'-p',`127.0.0.1:${port}:3000`,'zhajinhua:latest-'+arch);created = true;
      const ready = async () => {for(let n=0;n<60;n++){try{const r=await fetch(`http://127.0.0.1:${port}/api/bootstrap`,{signal:AbortSignal.timeout(1000)});if(r.ok)return await r.json();}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Container did not start: '+docker('logs',name));};
      assert.equal((await ready()).setup,true);
      assert.equal(docker('exec',name,'node','-p','process.arch'),arch==='amd64'?'x64':'arm64');
      assert.equal(docker('exec',name,'node','-p',"require('node:fs').existsSync('/app/.env')"),'false');
      const create = `const origin='http://127.0.0.1:3000';const r=await fetch(origin+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'test_admin',nickname:'Docker test',password:'Container-test-123'})});if(!r.ok)throw Error(await r.text());console.log('created');`;
      assert.equal(docker('exec',name,'node','--input-type=module','-e',create),'created');
      docker('restart',name);assert.equal((await ready()).setup,false);
      const count=await client.query(`SELECT COUNT(*) AS count FROM "${schema}".users`);assert.equal(Number(count.rows[0].count),1);
      console.log(`${arch}: container startup, PG connection, initialization, persistence/restart and secret exclusion passed`);
    } finally {
      if(created)docker('rm','-f','-v',name);
      unlinkSync(envPath);
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }
} finally { await client.end(); }
