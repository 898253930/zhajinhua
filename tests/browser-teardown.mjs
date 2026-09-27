import { readFileSync } from 'node:fs';
export default async function(){
  // Windows Playwright process-tree cleanup can stall; stop this test's exact server PID.
  try { const owner=JSON.parse(readFileSync(process.env.ZJH_TEST_DB+'.lock','utf8'));const pid=typeof owner==='number'?owner:owner.pid;if(Number.isInteger(pid)&&pid>0)process.kill(pid); } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code))throw e; }
}
