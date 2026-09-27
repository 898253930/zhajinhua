import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../public/engine.mjs';
const c=(rank,suit=0)=>suit*13+rank-2;
test('牌型穷举：52 选 3 共 22100 个组合',()=>{
  const counts=Array(6).fill(0);
  for(let a=0;a<50;a++)for(let b=a+1;b<51;b++)for(let c=b+1;c<52;c++)counts[G.rank([a,b,c])[0]]++;
  assert.deepEqual(counts,[16440,3744,720,1096,48,52]);
});
test('A23 最小、AKQ 最大、KA2 非顺子、平局不比较花色',()=>{
  assert.equal(G.compare([c(14),c(2,1),c(3,2)],[c(2),c(3,1),c(4,2)]),-1);
  assert.equal(G.compare([c(14),c(13,1),c(12,2)],[c(13),c(12,1),c(11,2)]),1);
  assert.equal(G.rank([c(13),c(14,1),c(2,2)])[0],0);
  assert.equal(G.compare([c(7),c(7,1),c(4,2)],[c(7,2),c(7,3),c(4,1)]),0);
  assert.equal(G.compare([c(2),c(3,1),c(5,2)],[c(2),c(2,1),c(2,2)]),-1);
});
const players=Array.from({length:6},(_,i)=>({id:String(i),name:'玩家'+i,chips:10000}));
test('看牌不结束行动或重置计时，费用翻倍且非法操作不修改原状态',()=>{
  const s=G.start(players,{now:100});const id=s.actor,before=JSON.stringify(s);
  assert.throws(()=>G.act(s,'unknown','call'));assert.equal(JSON.stringify(s),before);
  const next=G.act(s,id,'look',{},1000);assert.equal(next.actor,id);assert.equal(next.deadline,s.deadline);assert.equal(next.turnId,s.turnId);assert.equal(G.legal(next,id).call,20);
  assert.throws(()=>G.act(next,id,'compare',{target:'0'}));
});
test('100 场随机合法操作：资产守恒、无负余额、必达终态',()=>{
  for(let i=0;i<100;i++){
    let s=G.start(players);const total=60000;let n=0;
    while(s.status==='playing'&&n++<500){const a=G.legal(s,s.actor),options=[{type:'fold'},...(a.canCall?[{type:'call'}]:[]),...(a.look?[{type:'look'}]:[]),...a.raises.map(r=>({type:'raise',payload:{q:r.q}})),...a.targets.map(t=>({type:'compare',payload:{target:t.id}}))];const o=options[G.secureInt(options.length)];s=G.act(s,s.actor,o.type,o.payload);assert.equal(s.pot+s.players.reduce((n,p)=>n+p.chips,0),total);assert.ok(s.players.every(p=>p.chips>=0));}
    assert.equal(s.status,'settled');assert.equal(s.pot,0);
  }
});
test('离桌弃牌、隐私视图、最大轮数强制结算',()=>{
  let s=G.start(players);for(const p of players){const v=G.view(s,p.id);assert.ok(v.players.every(p=>p.cards===null));}
  const actor=s.actor;s=G.act(s,actor,'look');assert.ok(G.view(s,actor).players.find(p=>p.id===actor).cards);assert.equal(G.view(s,'0').players.find(p=>p.id===actor).cards,null);
  s=G.leave(s,actor);assert.notEqual(s.actor,actor);
  while(s.status==='playing')s=G.act(s,s.actor,'call');assert.equal(s.round,20);assert.equal(s.status,'settled');
});
test('比牌平局发起者输',()=>{
  const cards=[c(14),c(9,1),c(5,2),c(14,1),c(9,2),c(5,3)];const deck=[...cards,...Array.from({length:52},(_,i)=>i).filter(c=>!cards.includes(c))];
  let s=G.start(players.slice(0,2),{deck});s=G.act(s,s.actor,'call');s=G.act(s,s.actor,'call');const actor=s.actor,target=s.players.find(p=>p.id!==actor).id;s=G.act(s,actor,'compare',{target});assert.deepEqual(s.winners,[target]);assert.equal(s.players.find(p=>p.id===actor).status,'eliminated');
});
