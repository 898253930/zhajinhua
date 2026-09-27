import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Run through docker exec: loopback-only bootstrap stays inaccessible externally.
const origin = `http://127.0.0.1:${process.env.PORT || 3000}`;
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: true });
try {
  const status = await fetch(origin + '/api/bootstrap').then(r => r.json());
  if (!status.setup) throw Error('管理员已初始化，请直接在网页登录。');
  const username = (await rl.question('Username (3-24 letters/digits/_): ')).trim();
  const nickname = (await rl.question('Nickname: ')).trim();
  process.stdout.write('Password (8-128 characters, hidden): ');
  muted = true;
  const password = await rl.question('');
  muted = false;
  process.stdout.write('\nConfirm password (hidden): ');
  muted = true;
  const confirm = await rl.question('');
  muted = false;
  process.stdout.write('\n');
  if (password !== confirm) throw Error('两次输入的密码不同。');
  const response = await fetch(origin + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username, nickname, password })
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  console.log('管理员创建成功，请在浏览器中登录。');
} catch (error) {
  muted = false;
  console.error('\n' + error.message);
  process.exitCode = 1;
} finally { rl.close(); }
