export const RULE = Object.freeze({ ante: 10, levels: [10, 20, 50, 100], maxRounds: 20, turnMs: 20000 });
export const SUITS = ['♠', '♥', '♣', '♦'];
export const NAMES = ['单张', '对子', '顺子', '金花', '顺金', '豹子'];
export function uid() { return globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join(''); }
export function card(c) { const n = c % 13 + 2; return { rank: n, label: ({11:'J',12:'Q',13:'K',14:'A'})[n] || String(n), suit: SUITS[Math.floor(c / 13)], red: Math.floor(c / 13) % 2 === 1 }; }
export function rank(cards) {
  const r = cards.map(c => card(c).rank).sort((a,b) => b-a);
  const flush = cards.every(c => Math.floor(c/13) === Math.floor(cards[0]/13));
  const straight = r.join() === '14,3,2' ? 3 : r[0]-r[1] === 1 && r[1]-r[2] === 1 ? r[0] : 0;
  if (r[0] === r[2]) return [5,r[0]];
  if (flush && straight) return [4,straight];
  if (flush) return [3,...r];
  if (straight) return [2,straight];
  if (r[0] === r[1]) return [1,r[0],r[2]];
  if (r[1] === r[2]) return [1,r[1],r[0]];
  return [0,...r];
}
export function compare(a,b) { const x=rank(a),y=rank(b); for(let i=0;i<x.length;i++) if(x[i]!==y[i]) return Math.sign(x[i]-y[i]); return 0; }
export function secureInt(n) { const lim = Math.floor(4294967296/n)*n; const a=new Uint32Array(1); do { crypto.getRandomValues(a); } while(a[0]>=lim); return a[0]%n; }
export function shuffle(random=secureInt) { const deck=Array.from({length:52},(_,i)=>i); for(let i=51;i>0;i--) { const j=random(i+1); [deck[i],deck[j]]=[deck[j],deck[i]]; } return deck; }
const alive = s => s.players.filter(p=>p.status==='active');
const order = s => Array.from({length:s.players.length},(_,i)=>s.players[(s.dealer+1+i)%s.players.length].id);
function log(s,text) { s.logs.push(text); s.logs=s.logs.slice(-40); }
export function start(players, { dealer=0, now=Date.now(), id=uid(), deck=shuffle() }={}) {
  if(players.length<2 || players.length>6) throw Error('需要 2～6 位玩家');
  if(players.some(p=>p.chips<200)) throw Error('开局至少需要 200 桌上金币');
  if(deck.length!==52 || new Set(deck).size!==52 || deck.some(c=>!Number.isInteger(c)||c<0||c>51)) throw Error('无效牌组');
  const s={id,status:'playing',version:1,dealer,round:1,q:10,pot:players.length*10,players:players.map((p,i)=>({...p,cards:deck.slice(i*3,i*3+3),chips:p.chips-10,initial:p.chips,contribution:10,status:'active',seen:false})),queue:[],actor:null,turnId:0,deadline:0,logs:[],winners:[]};
  s.queue=order(s); s.actor=s.queue[0]; s.turnId=1; s.deadline=now+RULE.turnMs; log(s,'新一局开始 · 每人底注 10'); return s;
}
function finish(s) {
  const candidates=alive(s); let winners=[candidates[0]];
  for(const p of candidates.slice(1)) { const n=compare(p.cards,winners[0].cards); if(n>0) winners=[p]; else if(n===0) winners.push(p); }
  const ordered=order(s).filter(id=>winners.some(p=>p.id===id));
  const share=Math.floor(s.pot/winners.length),rest=s.pot%winners.length;
  winners.forEach(p=>{p.chips+=share+(ordered.indexOf(p.id)<rest?1:0);});
  s.winners=winners.map(p=>p.id); s.award=s.pot; s.pot=0; s.status='settled'; s.actor=null; s.deadline=0;
  log(s,`${winners.map(p=>p.name).join('、')} 获胜 · 分配 ${s.award} 金币`);
}
function advance(s,now) {
  s.queue=s.queue.filter(id=>s.players.find(p=>p.id===id)?.status==='active');
  if(alive(s).length===1) return finish(s);
  if(!s.queue.length) { if(s.round>=RULE.maxRounds) return finish(s); s.round++; s.queue=order(s).filter(id=>s.players.find(p=>p.id===id).status==='active'); }
  s.actor=s.queue[0]; s.turnId++; s.deadline=now+RULE.turnMs;
}
export function legal(s,id) {
  if(!s || s.status!=='playing' || s.actor!==id) return null;
  const p=s.players.find(p=>p.id===id), factor=p.seen?2:1;
  return {look:!p.seen,call:s.q*factor,canCall:p.chips>=s.q*factor,raises:RULE.levels.filter(q=>q>s.q&&p.chips>=q*factor).map(q=>({q,cost:q*factor})),compareCost:s.q*factor*2,targets:s.round>=2&&p.chips>=s.q*factor*2?alive(s).filter(p=>p.id!==id).map(p=>({id:p.id,name:p.name})):[]};
}
export function act(original,id,type,payload={},now=Date.now()) {
  const s=structuredClone(original), options=legal(s,id); if(!options) throw Error('尚未轮到你操作');
  const p=s.players.find(p=>p.id===id);
  if(type==='look') { if(!options.look) throw Error('你已经看过牌'); p.seen=true; s.version++; log(s,`${p.name} 看牌`); return s; }
  let cost=0;
  if(type==='fold') { p.status='folded'; log(s,`${p.name} 弃牌`); }
  else if(type==='call') { if(!options.canCall) throw Error('桌上余额不足'); cost=options.call; log(s,`${p.name} 跟注 ${cost}`); }
  else if(type==='raise') { const r=options.raises.find(r=>r.q===payload.q); if(!r) throw Error('无效加注档位'); s.q=r.q; cost=r.cost; log(s,`${p.name} 加注 ${cost}`); }
  else if(type==='compare') {
    if(!options.targets.some(t=>t.id===payload.target)) throw Error('当前无法与该玩家比牌');
    cost=options.compareCost; const target=s.players.find(p=>p.id===payload.target);
    const loser=compare(p.cards,target.cards)>0?target:p; loser.status='eliminated'; log(s,`${p.name} 与 ${target.name} 比牌 · ${loser.name} 出局`);
  } else throw Error('未知操作');
  p.chips-=cost; p.contribution+=cost; s.pot+=cost; s.queue.shift(); s.version++; advance(s,now); return s;
}
export function leave(original,id,now=Date.now()) {
  const s=structuredClone(original),p=s.players.find(p=>p.id===id);
  if(s.status!=='playing'||!p||p.status!=='active') return s;
  p.status='folded'; s.version++; log(s,`${p.name} 离桌弃牌`);
  if(alive(s).length===1) finish(s); else if(s.actor===id) advance(s,now); else s.queue=s.queue.filter(x=>x!==id);
  return s;
}
export function view(s,id) {
  if(!s) return null;
  return {...s,players:s.players.map(p=>{const {cards,...safe}=p; return {...safe,cards:p.id===id&&(p.seen||s.status!=='playing')?cards:null};}),legal:legal(s,id)};
}
export function botAction(s,id,difficulty='normal') {
  const p=s.players.find(p=>p.id===id),a=legal(s,id); if(!a) return null;
  if(a.look && Math.random()<.7) return {type:'look'};
  // Only this bot's visible hand and public state inform its decision.
  const strength=p.seen?rank(p.cards)[0]:1;
  if(!a.canCall || (p.seen&&strength===0&&Math.random()<(difficulty==='easy'?.08:.28))) return {type:'fold'};
  if(a.targets.length && Math.random()<.3) return {type:'compare',payload:{target:a.targets[Math.floor(Math.random()*a.targets.length)].id}};
  if(a.raises.length && strength>=2 && Math.random()<.3) return {type:'raise',payload:{q:a.raises[0].q}};
  return {type:'call'};
}
