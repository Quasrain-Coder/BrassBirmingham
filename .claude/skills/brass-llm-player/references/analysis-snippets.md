# bench trace 分析 snippets

读 `bench/out/<runId>/decisions.jsonl`（每步决策）+ `games.jsonl`（每局结果）。字段见 `bench/drive-game.ts` DecisionTrace。

## action kind 分布 + rank0 + pass 率

```bash
cd packages/llm && node -e "
const fs=require('fs');
const lines=fs.readFileSync('bench/out/<runId>/decisions.jsonl','utf8').trim().split('\n').map(JSON.parse);
const kinds={};
for(const d of lines){const k=d.chosen.startsWith('贷款')?'loan':d.chosen.startsWith('在')?'build':d.chosen.startsWith('铺')?'network':d.chosen.startsWith('卖出')?'sell':d.chosen.startsWith('研发')?'develop':d.chosen.startsWith('侦察')?'scout':d.chosen.startsWith('跳过')?'pass':'?'; kinds[k]=(kinds[k]??0)+1;}
console.log('kinds:',Object.entries(kinds).sort((a,b)=>b[1]-a[1]).map(([k,n])=>k+':'+n+'('+(n/lines.length*100).toFixed(0)+'%)').join(' '));
const ranks=lines.map(d=>d.chosenRank);
console.log('rank0:',(ranks.filter(r=>r===0).length/ranks.length*100).toFixed(0)+'%');
"
```

## 看 pass 理由（判断是"模型误判"还是"真无路可走"）

```bash
cd packages/llm && node -e "
const fs=require('fs');
const lines=fs.readFileSync('bench/out/<runId>/decisions.jsonl','utf8').trim().split('\n').map(JSON.parse);
for(const p of lines.filter(d=>d.chosen.startsWith('跳过')).slice(0,8)) console.log('  r'+p.round+': '+p.reason?.slice(0,90));
"
```

## 输局早期决策抽样（运河前 3 轮，rank 偏离 0 的）

```bash
node_modules/.bin/vite-node packages/llm/bench/analyze.ts packages/llm/bench/out/<runId>
```

## 候选列表验证（改了 prescreen 后看模型实际看到啥）

```bash
cd packages/llm && cat > /tmp/t.ts <<'EOF'
import { newGame, enumerateActions } from '@brass/engine';
import { prescreen } from './src/heuristic.js';
import { describeAction } from './src/summarize.js';
const s = newGame(2, 301); const p = s.turnOrder[s.currentPlayerIdx]!;
prescreen(s, p, enumerateActions(s, p), 20).forEach((a,i)=>console.log(i+'. '+describeAction(s,p,a).slice(0,60)));
EOF
npx vite-node /tmp/t.ts; rm /tmp/t.ts
```
