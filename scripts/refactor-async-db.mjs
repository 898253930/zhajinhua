// One-time migration tool. Retained to make the async conversion reviewable.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
const traverse=traverseModule.default||traverseModule,generate=generateModule.default||generateModule;
let source=readFileSync('server.mjs','utf8');
if(source.includes("'./lib/database.mjs'"))throw Error('Server has already been migrated');
source=source.replace("import { DatabaseSync } from 'node:sqlite';", "import { openDatabase } from './lib/database.mjs';");
const start=source.indexOf('const ROOT='),end=source.indexOf('const now=');
source=source.slice(0,start)+`const ROOT=dirname(fileURLToPath(import.meta.url));
if(process.env.LOAD_ENV!=='0'&&existsSync(resolve(ROOT,'.env')))process.loadEnvFile(resolve(ROOT,'.env'));
const PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'127.0.0.1';
const db=await openDatabase();
const {get,all,run,tx}=db;
`+source.slice(end);
source=source.replace(/function tx\(fn\)\{.*?\}\}\r?\n/,'');
source=source.replace("INSERT OR IGNORE INTO accounts VALUES(?,?,?,0)","INSERT INTO accounts VALUES(?,?,?,0) ON CONFLICT DO NOTHING");
source=source.replace("INSERT OR REPLACE INTO history VALUES(?,?,?)","INSERT INTO history VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,created=excluded.created");
source=source.replace("all('SELECT * FROM users ORDER BY created DESC').map(safeUser)","await Promise.all(all('SELECT * FROM users ORDER BY created DESC').map(safeUser))");
source=source.replace('数据库：${dbPath}','数据库：${db.kind}');
const names=new Set('get all run tx audit account balance ledger makeUser rooms save mine requireRoom changeHand release leaveRoom voidHand checkBooks invalidateSessions login auth safeUser state historyFor getLedger mutation join'.split(' '));
const ast=parse(source,{sourceType:'module'});
traverse(ast,{
  FunctionDeclaration(path){if(names.has(path.node.id?.name))path.node.async=true;},
  CallExpression:{exit(path){
    const n=path.node;
    if((n.callee.type==='Identifier'&&names.has(n.callee.name))||(n.callee.type==='MemberExpression'&&n.callee.object.name==='db'&&n.callee.property.name==='close')){
      if(path.parentPath.isAwaitExpression())return;
      path.replaceWith({type:'AwaitExpression',argument:n});
      const fn=path.getFunctionParent();if(fn)fn.node.async=true;
      path.skip();
    }
  }}
});
writeFileSync('server.mjs',generate(ast,{comments:true}).code+'\n');
console.log('Migrated server database calls to async/await.');
