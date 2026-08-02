# M1 规则引擎（packages/engine）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Brass: Birmingham 完整规则引擎：纯函数 `enumerateActions` / `applyAction`、双时代全流程、RandomAgent fuzz 数千局无异常且必然终止、种子化重放逐字节一致。

**Architecture:** pnpm 风格 npm workspaces monorepo；engine 为纯 TS 零依赖包（`@brass/engine`），被未来 server/web/llm 复用。状态为可 JSON 序列化纯数据；所有随机性来自注入的种子 RNG；规则数值全部收在 `src/data/`，从 `docs/rules-reference.md` 转录。

**Tech Stack:** TypeScript strict、npm workspaces、Vitest（含 coverage）、GitHub Actions。

**Rules data source of truth:** `docs/rules-reference.md`（已入库，官方规则书 + 官方美术 + 两个开源实现三方核对）。转录数值时以该文件为准；文末"容易实现错的点"20 条是验收清单。

## Global Constraints

- 引擎零运行时依赖（devDependencies 只允许 typescript/vitest/@types）
- `GameState` 必须 `JSON.stringify` 可往返；禁止 Date.now/Math.random 进入引擎——随机性只用 `src/rng.ts` 的种子 RNG
- 非法行动：`applyAction` 抛出带 `code` 的 `IllegalActionError`（`src/errors.ts`），不得静默修正
- 数值表以 `docs/rules-reference.md` 为准；制造 IV 成本 = £14+1铁（采用官方面板，做常量注释）
- 行动枚举规范化：资源来源默认"最便宜/最短路"自动解析，仅当来源选择有实质差异（商人啤酒奖励、耗干对手酒厂翻面）才拆分为不同行动
- Git 工作流：禁直推 main；分支 `feat/m1-*`；commit 带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；新增模块必须同步 CI test/coverage 步骤
- 每个 commit 前 `npm run typecheck && npm test` 全绿

---

### Task 1: Monorepo 脚手架 + engine 包骨架 + CI

**Files:**
- Create: `package.json`（root, workspaces）
- Create: `tsconfig.base.json`、`packages/engine/tsconfig.json`
- Create: `packages/engine/package.json`、`packages/engine/vitest.config.ts`
- Create: `packages/engine/src/rng.ts`、`packages/engine/src/errors.ts`、`packages/engine/src/serialize.ts`
- Create: `.github/workflows/ci.yml`
- Test: `packages/engine/test/rng.test.ts`

**Interfaces:**
- Produces（后续所有 task 依赖）:
  - `createRng(seed: number): Rng`；`Rng = { next(): number; nextInt(maxExclusive: number): number; shuffle<T>(arr: T[]): T[]; getState(): number }`（mulberry32；`shuffle` 为 Fisher-Yates，返回新数组；`getState` 用于重放校验）
  - `class IllegalActionError extends Error { code: string }`
  - `stableStringify(v: unknown): string`（key 排序的确定性序列化，重放测试用）

- [ ] **Step 1: 写脚手架文件**

Root `package.json`：

```json
{
  "name": "brass-birmingham",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm test --workspaces --if-present"
  },
  "devDependencies": { "typescript": "^5.5.0" }
}
```

`tsconfig.base.json`：`strict: true`、`target: ES2022`、`module: NodeNext`、`declaration: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`。

`packages/engine/package.json`：name `@brass/engine`，`"type": "module"`，scripts: `test: vitest run --coverage`、`typecheck: tsc --noEmit`；devDeps: vitest、@vitest/coverage-v8、typescript。

- [ ] **Step 2: 写 rng 失败测试**

`test/rng.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { createRng } from '../src/rng.js';
import { stableStringify } from '../src/serialize.js';

describe('rng', () => {
  it('same seed produces identical sequence', () => {
    const a = createRng(42), b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('different seeds diverge', () => {
    const a = createRng(1), b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });
  it('shuffle is deterministic and a permutation', () => {
    const input = Array.from({ length: 52 }, (_, i) => i);
    const s1 = createRng(7).shuffle(input);
    const s2 = createRng(7).shuffle(input);
    expect(s1).toEqual(s2);
    expect([...s1].sort((x, y) => x - y)).toEqual(input);
    expect(input[0]).toBe(0); // 原数组不被修改
  });
});

describe('stableStringify', () => {
  it('sorts object keys', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } }))
      .toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/engine && npm install && npx vitest run test/rng.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 rng.ts / errors.ts / serialize.ts**

mulberry32；`getState()` 返回内部 32 位状态。`stableStringify` 递归排序对象 key，数组保序。

- [ ] **Step 5: 跑测试确认通过 + 写 CI**

`.github/workflows/ci.yml`：node 20，`npm ci` → `npm run typecheck` → `npm test`（engine 的 vitest 已带 --coverage）。**此 workflow 后续每个新增 package 都要加对应 job/step。**

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/m1-scaffold
git add -A
git commit -m "feat(engine): monorepo 脚手架 + 种子RNG + CI"
gh pr create ...
```

---

### Task 2: 版图数据（board.ts）

**Files:**
- Create: `packages/engine/src/types.ts`
- Create: `packages/engine/src/data/board.ts`
- Test: `packages/engine/test/board.test.ts`

**Interfaces:**
- Produces:
  - `type IndustryType = 'cotton'|'manufacturer'|'pottery'|'coal'|'iron'|'brewery'`
  - `type Era = 'canal' | 'rail'`
  - `type PlayerIndex = number`
  - `type MerchantId = 'shrewsbury'|'gloucester'|'oxford'|'warrington'|'nottingham'`
  - `type LocationId = string`（20 个 named location + `'farm-north'`、`'farm-south'`）
  - `interface IndustrySlot { industries: IndustryType[] }`（1 或 2 个图标）
  - `LOCATIONS: Record<LocationId, { name: string; region: 'derbyshire'|'staffordshire'|'midlands'|'black-country'|'birmingham'|'farm'; slots: IndustrySlot[] }>`
  - `interface Link { a: LocationId | MerchantId; b: LocationId | MerchantId; canal: boolean; rail: boolean }`
  - `LINKS: Link[]`（39 条，按 rules-reference §1.2）
  - `MERCHANTS: Record<MerchantId, { slots: number; bonus: { type: 'vp'|'income'|'money'|'develop'; amount: number }; links: LocationId[] }>`
  - `neighborsOf(id: LocationId | MerchantId, era: Era): (LocationId | MerchantId)[]`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { LOCATIONS, LINKS, MERCHANTS, neighborsOf } from '../src/data/board.js';

describe('board data', () => {
  it('has 20 named locations + 2 farm breweries', () => {
    const ids = Object.keys(LOCATIONS);
    expect(ids).toHaveLength(22);
    expect(ids.filter((id) => LOCATIONS[id]!.region === 'farm')).toHaveLength(2);
  });
  it('has 39 links; 30 both-era, 1 canal-only, 8 rail-only', () => {
    expect(LINKS).toHaveLength(39);
    expect(LINKS.filter((l) => l.canal && l.rail)).toHaveLength(30);
    expect(LINKS.filter((l) => l.canal && !l.rail)).toHaveLength(1);
    expect(LINKS.filter((l) => !l.canal && l.rail)).toHaveLength(8);
  });
  it('burton-walsall is the only canal-only link', () => {
    const l = LINKS.find((x) => x.canal && !x.rail);
    expect(new Set([l!.a, l!.b])).toEqual(new Set(['burton-on-trent', 'walsall']));
  });
  it('every link endpoint is a known location or merchant', () => {
    for (const l of LINKS) {
      const ok = (id: string) => id in LOCATIONS || id in MERCHANTS;
      expect(ok(l.a) && ok(l.b)).toBe(true);
    }
  });
  it('graph is connected in canal era (excluding farms is NOT allowed: farms reachable)', () => {
    // BFS from birmingham over canal edges; 22 locations + 5 merchants all reachable
    const seen = new Set<string>(['birmingham']);
    const queue = ['birmingham'];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const n of neighborsOf(cur as never, 'canal'))
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    expect(seen.size).toBe(27);
  });
  it('farm slots accept only brewery', () => {
    for (const id of ['farm-north', 'farm-south']) {
      expect(LOCATIONS[id]!.slots).toEqual([{ industries: ['brewery'] }]);
    }
  });
  it('merchant bonuses match rulebook', () => {
    expect(MERCHANTS.shrewsbury.bonus).toEqual({ type: 'vp', amount: 4 });
    expect(MERCHANTS.oxford.bonus).toEqual({ type: 'income', amount: 2 });
    expect(MERCHANTS.warrington.bonus).toEqual({ type: 'money', amount: 5 });
    expect(MERCHANTS.nottingham.bonus).toEqual({ type: 'vp', amount: 3 });
    expect(MERCHANTS.gloucester.bonus).toEqual({ type: 'develop', amount: 1 });
  });
  it('birmingham has 4 slots, first is cotton/manufacturer', () => {
    expect(LOCATIONS.birmingham.slots).toHaveLength(4);
    expect(LOCATIONS.birmingham.slots[0]!.industries).toEqual(['cotton', 'manufacturer']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run test/board.test.ts`，Expected: FAIL

- [ ] **Step 3: 转录数据**

`types.ts` 先定义 `IndustryType`/`MerchantId`/`LocationId`/`Era`。`data/board.ts` 按 rules-reference §1.1（20 地点槽位表 + 2 农场）、§1.2（39 边表逐行转录）、§1.3（商人表）写成常量。注意：Kidderminster–Worcester 边同时连 farm-south（建模为两条边：`kidderminster–farm-south`、`farm-south–worcester` 是**错的**——规则是"同一条 Link 连接三者"。正确建模：LINKS 里仍是 39 条，其中表内 #30 的端点记为 `kidderminster`/`worcester`，另在 `LINK_EXTRA_ENDPOINTS: Record<number, LocationId[]>` 记录（**0 基下标**）`{ 29: ['farm-south'] }`；`neighborsOf` 遍历时把 extra endpoints 并入）。Cannock–farm-north 是普通边 #17。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): 版图拓扑数据（20地点+39边+5商人）"`

---

### Task 3: 产业板块数值表 + 收入轨 + 市场数据

**Files:**
- Create: `packages/engine/src/data/tiles.ts`
- Create: `packages/engine/src/data/income.ts`
- Create: `packages/engine/src/data/market.ts`
- Test: `packages/engine/test/tiles.test.ts`、`packages/engine/test/income.test.ts`、`packages/engine/test/market-data.test.ts`

**Interfaces:**
- Produces:
  - `interface TileDef { industry: IndustryType; level: number; count: number; costMoney: number; costCoal: number; costIron: number; beerToFlip: number; resourcesPlaced: number; vp: number; incomeAdvance: number; linkIcons: number; railEraBuildable: boolean; developable: boolean; sellable: boolean; flipsBy: 'sell'|'resource-exhaustion' }`
  - `TILES: TileDef[]`（每名玩家 6 产业 × 各等级，转录 rules-reference §2.1–2.6 全部 30 行）
  - `tilesOf(playerStack, industry)` 相关 helper 在 Task 5
  - `INCOME_LEVEL_SPACES: (level: number) => [startSpace, endSpace]`、`incomeLevelAt(space: number): number`、`advanceIncomeSpace(space: number, n: number): number`（上限等级 30 = space 99）、`loanBacktrack(space: number): number`（退 3 个**等级**，落新等级最高格，下限等级 −10 = space 0）
  - `COAL_MARKET_PRICES = [1,1,2,2,3,3,4,4,5,5,6,6,7,7]`、`COAL_MARKET_INITIAL_FILLED = 13`、`COAL_FALLBACK_PRICE = 8`
  - `IRON_MARKET_PRICES = [1,1,2,2,3,3,4,4,5,5]`、`IRON_MARKET_INITIAL_FILLED = 8`、`IRON_FALLBACK_PRICE = 6`
  - `BREWERY_BARRELS: Record<Era, number> = { canal: 1, rail: 2 }`

- [ ] **Step 1: 写失败测试**

```ts
// tiles.test.ts
import { TILES } from '../src/data/tiles.js';
it('45 tiles per player with rulebook distribution', () => {
  expect(TILES.reduce((s, t) => s + t.count, 0)).toBe(45);
  const by = (i: string) => TILES.filter((t) => t.industry === i).reduce((s, t) => s + t.count, 0);
  expect(by('cotton')).toBe(11);
  expect(by('manufacturer')).toBe(11);
  expect(by('brewery')).toBe(7);
  expect(by('pottery')).toBe(5);
  expect(by('iron')).toBe(4);
  expect(by('coal')).toBe(7);
});
it('manufacturer level 4 costs £14+1iron (official player mat)', () => {
  const m4 = TILES.find((t) => t.industry === 'manufacturer' && t.level === 4)!;
  expect(m4.costMoney).toBe(14);
  expect(m4.costIron).toBe(1);
});
it('pottery 1 and 3 are not developable (lightbulb)', () => {
  expect(TILES.find((t) => t.industry === 'pottery' && t.level === 1)!.developable).toBe(false);
  expect(TILES.find((t) => t.industry === 'pottery' && t.level === 3)!.developable).toBe(false);
});
it('level-1 tiles of cotton/manufacturer/coal/iron/brewery are not rail-era buildable; pottery 1 IS', () => {
  for (const t of TILES.filter((x) => x.level === 1)) {
    expect(t.railEraBuildable).toBe(t.industry === 'pottery');
  }
});
it('manufacturer 3 and 7 need no beer to sell', () => {
  expect(TILES.find((t) => t.industry === 'manufacturer' && t.level === 3)!.beerToFlip).toBe(0);
  expect(TILES.find((t) => t.industry === 'manufacturer' && t.level === 7)!.beerToFlip).toBe(0);
});
```

```ts
// income.test.ts — 对照 rules-reference §4 收入轨表
import { incomeLevelAt, advanceIncomeSpace, loanBacktrack } from '../src/data/income.js';
it('level bands', () => {
  expect(incomeLevelAt(0)).toBe(-10);
  expect(incomeLevelAt(10)).toBe(0);   // 起始位置
  expect(incomeLevelAt(11)).toBe(1);
  expect(incomeLevelAt(30)).toBe(10);
  expect(incomeLevelAt(31)).toBe(11);
  expect(incomeLevelAt(99)).toBe(30);
});
it('advance caps at level 30', () => {
  expect(advanceIncomeSpace(95, 100)).toBe(99);
});
it('loan backtracks 3 LEVELS and lands on highest space of the new level', () => {
  // space 10 = level 0；退 3 级 = level -3 = space 7
  expect(loanBacktrack(10)).toBe(7);
  // level 1 占 space 11-12；从 space 12(level 1) 退 3 级到 level -2 = space 8
  expect(loanBacktrack(12)).toBe(8);
  // 下限 level -10
  expect(loanBacktrack(2)).toBe(0);
});
```

```ts
// market-data.test.ts — 常量形状校验（与 Task 6 的 market.test.ts 不同文件）
import { COAL_MARKET_PRICES, IRON_MARKET_PRICES } from '../src/data/market.js';
it('coal 14 spaces £1-7 pairs; iron 10 spaces £1-5 pairs', () => {
  expect(COAL_MARKET_PRICES).toHaveLength(14);
  expect(IRON_MARKET_PRICES).toHaveLength(10);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 转录实现**

按 rules-reference §2 六张表逐行转录全部 29 个 TileDef（4 棉 + 8 制造 + 5 陶 + 4 煤 + 4 铁 + 4 酿；每行核对：成本/煤/铁/啤酒/资源块/VP/收入/连接VP/禁建/灯泡）。`flipsBy`：cotton/manufacturer/pottery = `'sell'`，coal/iron/brewery = `'resource-exhaustion'`。`sellable` 仅前三者 true。`railEraBuildable`：level≥2 全 true；level 1 仅 pottery；另 pottery 5 与 brewery 4 仅铁路时代可建（加 `canalEraBuildable: boolean` 字段或在 TileDef 加 `railEraOnly: boolean`——采用后者，pottery5/brewery4 为 true）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): 产业板块数值表+收入轨+市场常量"`

---

### Task 4: 牌组数据（cards.ts）

**Files:**
- Create: `packages/engine/src/data/cards.ts`
- Test: `packages/engine/test/cards.test.ts`

**Interfaces:**
- Consumes: `IndustryType`、`LocationId`（Task 2）
- Produces:
  - `type Card = { id: string } & ({ kind: 'location'; location: LocationId } | { kind: 'industry'; industries: IndustryType[] } | { kind: 'wild-location' } | { kind: 'wild-industry' })`（industry 卡 `industries` 长度 1 或 2——双图标卡）
  - `buildDeck(playerCount: 2|3|4): Card[]`（不含 wild；wild 单独供应堆）
  - `WILD_LOCATION_COUNT = 4`、`WILD_INDUSTRY_COUNT = 4`

牌组明细按 rules-reference §3（4p 64 张全量表为基准；3p/2p 按移除规则生成——用每类卡的"人数标"字段实现：`minPlayers: 2|3|4`，4p 卡 minPlayers=4 等。注意双图标卡 8 张里 2 张是 3p+ 专用（3p=6 张… 按 §3：4p 8 张、3p 6 张、2p 0 张）；Uttoxeter 两张卡其一为 4p 专用）。

- [ ] **Step 1: 写失败测试**

```ts
import { buildDeck } from '../src/data/cards.js';
it('deck sizes 40/54/64 for 2/3/4 players', () => {
  expect(buildDeck(2)).toHaveLength(40);
  expect(buildDeck(3)).toHaveLength(54);
  expect(buildDeck(4)).toHaveLength(64);
});
it('4p deck composition', () => {
  const deck = buildDeck(4);
  const loc = deck.filter((c) => c.kind === 'location');
  expect(loc).toHaveLength(41);
  expect(loc.filter((c) => c.kind === 'location' && c.location === 'birmingham')).toHaveLength(3);
  expect(loc.filter((c) => c.kind === 'location' && c.location === 'tamworth')).toHaveLength(1);
  const ind = deck.filter((c) => c.kind === 'industry');
  expect(ind).toHaveLength(23); // 15 单图标 + 8 双图标
  expect(ind.filter((c) => c.kind === 'industry' && c.industries.length === 2)).toHaveLength(8);
  expect(ind.filter((c) => c.kind === 'industry' && c.industries[0] === 'brewery')).toHaveLength(5);
  expect(ind.filter((c) => c.kind === 'industry' && c.industries[0] === 'iron')).toHaveLength(4);
});
it('2p deck: no derbyshire/staffordshire location cards, no dual industry cards', () => {
  const deck = buildDeck(2);
  expect(deck.filter((c) => c.kind === 'location' && ['leek','stoke-on-trent','stone','uttoxeter','belper','derby'].includes((c as never as {location:string}).location))).toHaveLength(0);
  expect(deck.filter((c) => c.kind === 'industry' && c.industries.length === 2)).toHaveLength(0);
});
it('3p deck keeps staffordshire, drops derbyshire', () => {
  const deck = buildDeck(3);
  expect(deck.filter((c) => c.kind === 'location' && c.location === 'leek')).toHaveLength(2);
  expect(deck.filter((c) => c.kind === 'location' && c.location === 'derby')).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

用一个 `CARD_SPECS: { minPlayers: 2|3|4; card: Omit<Card,'id'> }[]` 列表展开生成，`id` 为 `loc-birmingham-0` 式稳定 id。转录 rules-reference §3 的 4p 明细，再给每张卡标 minPlayers 使 2p/3p 子集满足：3p 移除 Belper×2、Derby×3、Uttoxeter×1、Coal×1、Pottery×1、双图标×2；2p 再移除 Leek×2、Stoke×3、Stone×2、Uttoxeter×1、双图标×6。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): 牌组构成（2/3/4人 40/54/64张）"`

---

### Task 5: GameState 与对局初始化（state.ts）

**Files:**
- Create: `packages/engine/src/state.ts`
- Test: `packages/engine/test/state.test.ts`

**Interfaces:**
- Consumes: 全部 data 模块 + `createRng`
- Produces（全项目核心类型）:

```ts
interface PlacedTile { tile: TileDef; player: PlayerIndex; flipped: boolean; resources: number } // resources: 煤/铁方块数或啤酒桶数
interface BuiltLink { linkIndex: number; player: PlayerIndex }
interface PlayerState {
  hand: Card[]; // wild 卡也是 hand 里的 Card（kind: 'wild-location'|'wild-industry'）
  tiles: TileDef[]; // 面板堆叠（未建），按产业分组、等级升序，建造即取栈顶
  money: number; incomeSpace: number; vp: number; spentThisRound: number;
}
type MerchantTile = 'any' | 'cotton' | 'manufacturer' | 'pottery' | 'blank';
interface GameState {
  playerCount: 2|3|4; era: Era; round: number; // round 从 1 起
  board: { slots: Record<LocationId, (PlacedTile | null)[]>; links: BuiltLink[] };
  merchants: Record<MerchantId, { tiles: MerchantTile[]; beer: number }>; // MerchantTile = 'any'|'cotton'|'manufacturer'|'pottery'|'blank'
  coalMarket: number; ironMarket: number; // 已填充方块数（索引语义见 market.ts helper）
  deck: Card[]; discard: Card[];
  players: PlayerState[];
  turnOrder: PlayerIndex[]; // 本轮顺位
  currentPlayerIdx: number; // turnOrder 内下标
  actionsThisTurn: number;  // 当前玩家本轮已行动数
  rngState: number;         // 每步快照，供重放校验
  lastEvents: GameEvent[];  // 上一步 applyAction 产生的事件（Task 11 起写入；此前 task 可初始化为 []）
  phase: 'action' | 'game-over';
  winner: PlayerIndex[] | null;
}
function newGame(playerCount: 2|3|4, seed: number): GameState
```

设置规则（rules-reference §4 + §8）：起始 £17、incomeSpace=10（level 0）、手牌 8、弃牌堆底 1 张面朝下、煤市场 13 块/铁市场 8 块、商人板块按人数洗混铺位（2p 不放 warrington/nottingham、3p 不放 nottingham）、角色块洗混定首轮顺位、`round=1`、`era='canal'`。玩家面板 `tiles`：按 TILES 展开排序（建造时取该产业最低级——栈顺序按等级升序排好）。

- [ ] **Step 1: 写失败测试**

```ts
import { newGame } from '../src/state.js';
it('4p initial state', () => {
  const s = newGame(4, 123);
  expect(s.players).toHaveLength(4);
  for (const p of s.players) {
    expect(p.money).toBe(17);
    expect(p.incomeSpace).toBe(10);
    expect(p.hand).toHaveLength(8);
    expect(p.tiles).toHaveLength(45);
  }
  expect(s.coalMarket).toBe(13);
  expect(s.ironMarket).toBe(8);
  expect(s.deck.length).toBe(64 - 4 * 8 - 1); // 发牌 + 弃牌堆底
  expect(s.discard).toHaveLength(1);
  expect(s.round).toBe(1);
  expect(s.era).toBe('canal');
});
it('2p merchants: warrington & nottingham empty', () => {
  const s = newGame(2, 7);
  expect(s.merchants.warrington.tiles).toHaveLength(0);
  expect(s.merchants.nottingham.tiles).toHaveLength(0);
  const total = Object.values(s.merchants).reduce((n, m) => n + m.tiles.length, 0);
  expect(total).toBe(5);
});
it('same seed identical setup; different seed differs', () => {
  expect(stableStringify(newGame(4, 42))).toBe(stableStringify(newGame(4, 42)));
  expect(stableStringify(newGame(4, 42))).not.toBe(stableStringify(newGame(4, 43)));
});
it('player tile stacks sorted by level ascending per industry', () => {
  const s = newGame(4, 1);
  const cottonLevels = s.players[0]!.tiles.filter((t) => t.industry === 'cotton').map((t) => t.level);
  expect(cottonLevels).toEqual([...cottonLevels].sort((a, b) => a - b));
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 newGame**

商人板块构成按 rules-reference §1.4（2p {any,cotton,manufacturer,blank,blank}；3p +{pottery,blank}；4p +{cotton,manufacturer}），洗混后铺到可用商人位。每非 blank 板块旁 `beer: 1`。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): GameState 与对局初始化"`

---

### Task 6: 网络连通 + 市场买卖机制

**Files:**
- Create: `packages/engine/src/network.ts`
- Create: `packages/engine/src/market.ts`
- Test: `packages/engine/test/network.test.ts`、`packages/engine/test/market.test.ts`

**Interfaces:**
- Consumes: state/board/market 数据
- Produces:
  - `playerNetwork(state, player): Set<LocationId | MerchantId>`——玩家 network 覆盖的节点：有其板块的地点 + 其 Link 两端点（含商人位）
  - `isConnected(state, player, target: LocationId | MerchantId): boolean`
  - `connectedMerchants(state, player): MerchantId[]`（network 可达的商人位——注意"商人位"连通不要求该位有板块，rules-reference §9.2）
  - `coalSources(state, player, at: LocationId): { tile: PlacedTile; location: LocationId }[]`——连通未翻面煤矿，按"距离最近、耗尽取下近者"排序；以及 `canBuyCoalFromMarket(state, player): boolean`（连通任一商人位图标）
  - `buyCoalCost(state, n): number` / `buyIronCost(state, n): number`（从最便宜格起，买空走兜底价 £8/£6）
  - `sellCoalToMarket(state, n): { revenue: number; sold: number }` / `sellIronToMarket(...)`（从最贵空格起填）
  - `ironSources(state): { tile; location }[]`——全图未翻面铁厂（无需连通，rules-reference §9.1）

- [ ] **Step 1: 写失败测试**（手工构造小状态，直接 newGame 后改 board）

```ts
// network.test.ts 关键用例
it('network includes tile locations and both endpoints of owned links', () => { /* 放一块板 + 一条 link，断言集合 */ });
it('merchant connection does not require a merchant tile (2p warrington still connects market)', () => {
  // 2p 局，玩家在 stoke-on-trent 有板块 → connectedMerchants 含 warrington
});
it('coal sources sorted by distance, nearest first', () => { /* 两个连通煤矿不同距离 */ });

// market.test.ts 关键用例
it('buy coal: cheapest first, fallback £8 when empty', () => {
  const s = newGame(4, 1); // 13 块：£1×1, £2×2, ...
  expect(buyCoalCost(s, 1)).toBe(1);
  expect(buyCoalCost(s, 3)).toBe(1 + 2 + 2);
  s.coalMarket = 0;
  expect(buyCoalCost(s, 2)).toBe(16);
});
it('sell iron fills most-expensive empty space first', () => {
  const s = newGame(4, 1); // 铁市场 8 块 → 空格 £1×2
  expect(sellIronToMarket(s, 1)).toEqual({ revenue: 1, sold: 1 });
  s.ironMarket = 0; // 全空 → 最贵空格 £5
  expect(sellIronToMarket(s, 2)).toEqual({ revenue: 10, sold: 2 });
});
it('buy iron fallback £6, no connectivity required', () => {
  const s = newGame(4, 1);
  s.ironMarket = 0;
  expect(buyIronCost(s, 1)).toBe(6);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

市场语义：`coalMarket` 字段存"当前在市场上的方块数"；买的顺序 = 从索引 0（£1 第一格）起取空格…实现 `marketBuyCost(prices, filled, n, fallback)` 与 `marketSellRevenue(prices, filled, n)` 两个纯函数。BFS 距离用于 coal 最近源；并列时按 LocationId 字典序（规范化要求——确定性优先）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): 网络连通与市场买卖机制"`

---

### Task 7: 资源消耗结算（resources.ts）

**Files:**
- Create: `packages/engine/src/resources.ts`
- Test: `packages/engine/test/resources.test.ts`

**Interfaces:**
- Consumes: network/market
- Produces:
  - `consumeCoal(state, player, at: LocationId, n: number): { state; flipped: FlipEvent[] }`——优先连通最近未翻面煤矿（免费），不足从市场买（需连通商人位，否则抛 `IllegalActionError('coal-not-connected')`）；每移走一块检查"该矿耗尽→翻面"
  - `consumeIron(state, player, n): { state; flipped: FlipEvent[] }`——任意未翻面铁厂（选方块最多者先？规范化：按 LocationId 字典序首个有足够方块的铁厂，不足则跨厂混源），不足市场买
  - `consumeBeer(state, player, n: number, opts: { at: LocationId | MerchantId; useMerchantBeer: boolean }): { state; flipped: FlipEvent[]; merchantBonus?: MerchantBonusEvent }`——来源自动解析（规范化）：自己未翻面酒厂（全图可用）→ 对手连通用酒处的未翻面酒厂（LocationId 字典序）；`useMerchantBeer: true` 时优先取 `at` 所涉商人的桶并触发该商人奖励（仅 Sell 行动传 true）
  - `type FlipEvent = { kind: 'flip'; player: PlayerIndex; location: LocationId; incomeAdvance: number }`
  - `type MerchantBonusEvent = { kind: 'merchant-bonus'; player: PlayerIndex; merchant: MerchantId }`
  - `type GameEvent = FlipEvent | MerchantBonusEvent`（后续 task 的 apply* 返回 `events: GameEvent[]`；本类型定义放 `types.ts`，本 task 首次引入）
  - `applyFlip(state, location, slotIdx): { state; event: FlipEvent }`——翻面 + 收入轨前进（`advanceIncomeSpace`，上限等级 30）

啤酒规则（rules-reference §6.5/§9.3）：自己未翻面酒厂全图可用（不需连通）；对手酒厂须连通"用酒处"；商人啤酒仅 Sell 且只可用所卖向商人的桶，用了发商人奖励。来源选择按上方 `consumeBeer` 的规范化顺序自动解析；`useMerchantBeer` 由行动显式给出（影响奖励，属实质差异）。

- [ ] **Step 1: 写失败测试**

```ts
it('coal consumption flips mine when last cube removed, advancing income', () => { /* 矿上 2 块煤取 2 块 → flipped event, owner incomeSpace +4 */ });
it('coal from market requires merchant connection, else throws coal-not-connected', () => { /* 无连通 & 无免费煤 → expect(() => ...).toThrowError(/coal-not-connected/) */ });
it('iron consumption needs no connectivity', () => { /* 不连通铁厂也能取 */ });
it('opponent brewery requires connectivity to point of use', () => { ... });
it('merchant beer triggers merchant bonus', () => { /* sell 用 oxford 商人啤酒 → incomeSpace +2 */ });
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): 煤/铁/啤酒消耗结算与翻面触发"`

---

### Task 8: Build 行动（枚举 + 执行 + Overbuild）

**Files:**
- Create: `packages/engine/src/actions/build.ts`
- Test: `packages/engine/test/build.test.ts`

**Interfaces:**
- Consumes: 全部前置模块
- Produces:
  - `enumerateBuilds(state, player): Action[]`（Action 见下方 types 补全）
  - `applyBuild(state, player, action): { state; events: GameEvent[] }`

Action union 本 task 固定在 `types.ts`：

```ts
type Action =
  | { type: 'build'; cardId: string; industry: IndustryType; location: LocationId }
  | { type: 'network'; cardId: string; links: number[]; beerFromOpponentBrewery?: LocationId } // links = LINKS 下标，len 1|2
  | { type: 'develop'; cardId: string; removals: IndustryType[] } // len 1|2
  | { type: 'sell'; cardId: string; sales: { location: LocationId; slotIndex: number; merchant: MerchantId; useMerchantBeer: boolean }[] }
  | { type: 'loan'; cardId: string }
  | { type: 'scout'; cardIds: [string, string, string] }
  | { type: 'pass'; cardId: string };
```

Build 规则（rules-reference §6.1/§6.2）：
- Location 卡 → 该地任意产业（不要求 network）；Industry 卡 → network 内地点；Wild Location 不可用于 farm；Wild Industry 可
- 槽位匹配：先单图标槽后双图标槽；取面板该产业最低级板块
- 煤消耗：`consumeCoal`（建造地点）；铁：`consumeIron`
- 运河时代每地点限自己 1 块；禁建等级铁路时代不可建（pottery1 例外）；pottery5/brewery4 仅铁路时代
- 建成放资源块/酒桶（BREWERY_BARRELS[era]）；煤矿连通商人位→立即卖市场、铁厂无条件卖市场；卖空立即翻面（event）
- Overbuild：自己任意产业可覆盖（资源退回供应，被覆盖板块移出游戏）；对手仅煤/铁厂且全图（含市场）该类方块为 0。**Overbuild 目标规范化**：铁路时代同地有多块己方同产业板块时，自动覆盖其中等级最低者（枚举不拆分目标选择）；覆盖对手板块时目标唯一（该槽位上那块），无需参数
- 场上无板块特例：产业卡可任意地点建、任意卡可在任意空线放 Link（network 枚举处理）

- [ ] **Step 1: 写失败测试**（覆盖：location 卡任意地点、industry 卡要求 network、槽位单图标优先、运河时代每地限一块、overbuild 对手煤矿的全图为零前置、建铁厂立即卖市场并翻面进收入、农场酒厂只能 industry/wild-industry 卡）

```ts
it('location card allows building outside network', () => {
  const s = newGame(4, 5);
  const p0 = s.players[0]!;
  p0.hand = [{ id: 'loc-worcester-0', kind: 'location', location: 'worcester' }];
  const builds = enumerateBuilds(s, 0);
  expect(builds.some((a) => a.type === 'build' && a.location === 'worcester' && a.industry === 'cotton')).toBe(true);
});
it('industry card: with no tiles on board can build anywhere; once placed, network-restricted', () => {
  const s = newGame(4, 5);
  s.players[0]!.hand = [{ id: 'ind-coal-0', kind: 'industry', industries: ['coal'] }];
  // 规则 §6.1：场上无任何板块时产业卡可建任意合法地点
  expect(enumerateBuilds(s, 0).length).toBeGreaterThan(0);
  // 在 dudley 放一块自己的板块后：只能建 dudley 及其 link 可达处
  withTile(s, 0, 'dudley', 'coal');
  const builds = enumerateBuilds(s, 0);
  const locations = new Set(builds.map((a) => a.type === 'build' ? a.location : ''));
  expect([...locations].every((l) => ['dudley', 'birmingham', 'kidderminster', 'wolverhampton'].includes(l))).toBe(true);
});
it('built iron works immediately sells to market and flips if emptied', () => { /* coalbrookdale 铁厂 L1 放 4 块 → 市场空格 2×£1 → 卖 2 块收 £2，剩 2 块不翻面 */ });
it('cannot build level-1 cotton in rail era; can build pottery 1', () => { /* era='rail' 断言 */ });
it('overbuild opponent coal mine only when global coal cubes == 0', () => { ... });
it('farm brewery rejects wild-location card', () => { ... });
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): build 行动枚举与执行（含overbuild/市场售卖）"`

---

### Task 9: Network / Develop / Loan / Scout / Pass 行动

**Files:**
- Create: `packages/engine/src/actions/network.ts`、`develop.ts`、`loan.ts`、`scout.ts`
- Test: `packages/engine/test/actions.test.ts`

**Interfaces:**
- Produces: `enumerateNetwork/Develop/Loan/Scout(state, player): Action[]` 与对应 `applyX`

细则（rules-reference §6.3–6.7）：
- Network：运河 £3 单条；铁路 £5 单条或 £15+1啤酒双条（啤酒必须来自酿酒厂、不可用商人啤酒；用对手酒厂时须连通第二条铁路放置后的位置）；每条铁路各耗 1 煤（分别判定煤源连通——煤源连通点 = 该条铁路放置后的两端）；新 Link 须与己方 network 相邻；场上无板块时任意空线；同一条边只能放 1 条 Link
- Develop：弃 1 卡，移除 1–2 块当前最低级（逐块判定），每块 1 铁；灯泡陶不可
- Loan：+£30，`loanBacktrack`（§data），下限 −10
- Scout：弃 3 卡（1 行动卡 + 2 手牌），拿 wild-location + wild-industry；手有 wild 不可
- Pass：弃 1 卡

- [ ] **Step 1: 写失败测试**

```ts
import { newGame } from '../src/state.js';
import { enumerateNetwork, applyNetwork } from '../src/actions/network.js';
import { enumerateDevelop, applyDevelop } from '../src/actions/develop.js';
import { applyLoan } from '../src/actions/loan.js';
import { enumerateScout, applyScout } from '../src/actions/scout.js';

// 辅助：给玩家一块板和初始 network（直接改 state.board.slots）
function withTile(state, player, location, industry, level = 1) { /* 放最低级板块到该地首槽 */ }

it('canal link costs £3 and must be adjacent to own network', () => {
  const s = newGame(4, 3);
  withTile(s, 0, 'coventry', 'pottery');
  s.players[0]!.hand = [{ id: 'c1', kind: 'industry', industries: ['coal'] }];
  const nets = enumerateNetwork(s, 0);
  const links = nets.flatMap((a) => a.type === 'network' ? a.links : []);
  // coventry 相邻边：birmingham-coventry（表内 #3 → 0 基下标 2）、coventry-nuneaton（#23 → 下标 22）
  expect(new Set(links)).toEqual(new Set([2, 22]));
});
it('rail era: double link costs £15 + 1 brewery beer, each link consumes 1 coal', () => {
  const s = newGame(4, 3);
  s.era = 'rail';
  withTile(s, 0, 'coventry', 'pottery');
  withTile(s, 0, 'birmingham', 'brewery', 2); // 自己的酒厂供啤酒（铁路时代 2 桶）
  s.players[0]!.money = 30;
  const nets = enumerateNetwork(s, 0);
  const doubles = nets.filter((a) => a.type === 'network' && a.links.length === 2);
  expect(doubles.length).toBeGreaterThan(0);
  const after = applyNetwork(s, 0, doubles[0]!);
  // 场上无煤矿 → 2 条铁路的 2 块煤走市场：£1 + £2 = £3（初始市场 £1 格只有 1 块）
  expect(after.players[0]!.money).toBe(30 - 15 - 3);
});
it('double-link beer cannot come from merchant beer', () => {
  // 只有商人啤酒可用、无酒厂 → 不枚举任何双轨行动
});
it('develop removes 1-2 lowest-level tiles, 1 iron each; lightbulb pottery not removable', () => {
  const s = newGame(4, 3);
  const devs = enumerateDevelop(s, 0);
  // 开局面板最低级：每产业 level 1；pottery 1 是灯泡 → 不在 removals 候选
  const removals = devs.flatMap((a) => a.type === 'develop' ? a.removals : []);
  expect(removals).not.toContain('pottery');
  expect(removals).toContain('cotton');
});
it('loan: +£30, back 3 income LEVELS landing on highest space', () => {
  const s = newGame(4, 3);
  const after = applyLoan(s, 0, { type: 'loan', cardId: s.players[0]!.hand[0]!.id });
  expect(after.players[0]!.money).toBe(47);
  expect(after.players[0]!.incomeSpace).toBe(7); // level 0 → level -3
});
it('scout enumerates all 3-card discard combos (C(8,3)=56), grants both wilds; forbidden while holding a wild', () => {
  const s = newGame(4, 3);
  // 弃哪 3 张有策略意义（甩废卡），不做组合规范化
  expect(enumerateScout(s, 0)).toHaveLength(56);
  const real = s.players[0]!.hand.slice(0, 3).map((c) => c.id) as [string, string, string];
  const after = applyScout(s, 0, { type: 'scout', cardIds: real });
  expect(after.players[0]!.hand.filter((c) => c.kind.startsWith('wild'))).toHaveLength(2);
  expect(enumerateScout(after, 0)).toHaveLength(0);
});
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(engine): network/develop/loan/scout/pass 行动"`

---

### Task 10: Sell 行动

**Files:**
- Create: `packages/engine/src/actions/sell.ts`
- Test: `packages/engine/test/sell.test.ts`

**Interfaces:**
- Produces: `enumerateSells(state, player): Action[]`、`applySell(state, player, action): { state; events }`

细则（rules-reference §6.5、§1.3）：连通印有对应图标的商人板块（any 板块收任意货）；每块板块各自检查连通与啤酒；一次行动可翻多块（混合产业）；商人啤酒可选、用了发奖励、只能用所卖向商人的桶；啤酒不足整行动不可枚举；连锁翻面（对手酒厂耗尽→对手进收入）。

枚举规范化：sale 的组合 = 每块可卖板块 × 可达匹配商人 × useMerchantBeer∈{true,false}（仅当该商人有桶时 true 分支存在）。多板块组合 sell 枚举为"全部可卖集合的单次行动"——v1 简化：**只枚举"卖出全部可卖组合"与"每块单独卖"**？否——这会漏合法策略。正确做法：枚举每个非空子集会爆炸；采用"贪心规范化"：对每组（板块集合固定为单块）枚举全部单块 sale，另枚举"可卖全集"一个行动。多块的中间子集在 v1 不枚举（LLM/前端可用连续两次 sell 行动逼近）。**这是已知简化，写进代码注释与测试。**

- [ ] **Step 1: 写失败测试**

```ts
import { enumerateSells, applySell } from '../src/actions/sell.js';

it('sell requires connection to merchant tile with matching icon; any-tile accepts all', () => {
  const s = newGame(4, 9);
  // 摆一块未翻面 cotton 在 coventry，network 只连到 oxford；把 oxford 商人板块设为 'pottery'
  // → 无 cotton 可卖枚举；改为 'any' → 有
});
it('using merchant beer grants that merchant bonus (oxford +2 income spaces)', () => {
  // sell 行动 useMerchantBeer: true 且目标 oxford → applySell 后 incomeSpace +2、vp/现金不变
});
it('merchant beer usable only from the merchant you sell to', () => {
  // 卖到 oxford 时 beerFrom 不能取 shrewsbury 的桶：枚举中不存在该组合
});
it('drinking opponent brewery last barrel flips it (opponent gains income)', () => {
  // 对手酒厂 1 桶 → sell 用之 → FlipEvent player=对手, 对手 incomeSpace 前进
});
it('sale needing 2 beer not enumerated when only 1 available', () => {
  // manufacturer 5 (beerToFlip=2)，全图只有 1 桶 → 该板块不出现在任何 sell 枚举
});
it('one sell action can flip multiple tiles of mixed industries', () => {
  // sales 数组 len=2（cotton + pottery），各自 merchant/beer 校验通过 → 一次行动两翻面
});
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(engine): sell 行动（商人奖励/啤酒来源/连锁翻面）"`

---

### Task 11: applyAction 调度 + 回合/轮结构（turn.ts）

**Files:**
- Create: `packages/engine/src/apply.ts`、`packages/engine/src/turn.ts`
- Test: `packages/engine/test/turn.test.ts`

**Interfaces:**
- Produces:
  - `enumerateActions(state, player): Action[]`（六大行动 + pass 汇总；`phase==='game-over'` 返回 []）
  - `applyAction(state, action): GameState`——校验 `action` 属于 `enumerateActions` 输出（规范化比较），执行后处理：弃牌（wild 卡回供应堆）、补牌到 8、`spentThisRound` 累计（含市场买卖现金）、行动计数。执行产生的事件写入 `state.lastEvents: GameEvent[]`（每步覆盖；序列化进状态，重放可比对，server 端 M2 用于广播动画）
  - `endTurnIfNeeded(state): GameState`——每人每轮 2 行动（运河时代 round 1 只 1 行动）；轮到下一人；一轮结束：按 spentThisRound 升序重排顺位（稳定）、发收入（负收入扣钱→半价拆板块→扣 VP 兜底，rules-reference §4）、`round+1`。**例外：全局最后一轮（铁路时代末轮）结束后不收收入**（rules-reference §4）。运河时代末轮是否发收入需实现时对照规则书 p.6 原文核实并在测试中固化（rules-reference 未明确，标注为待核项）
  - 牌堆与全部手牌同时空 → 时代结束（Task 12）

- [ ] **Step 1: 写失败测试**

```ts
it('first canal round allows only 1 action per player', () => { /* applyAction 一次后 currentPlayer 前进 */ });
it('normal round allows 2 actions', () => { ... });
it('hand refills to 8 after action', () => { ... });
it('turn order next round: least spent first, ties keep relative order', () => { ... });
it('income collected at round end; negative income forces payment', () => { ... });
it('money spent on market purchases counts toward spentThisRound', () => { ... });
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(engine): applyAction 调度与回合轮结构"`

---

### Task 12: 时代切换与终局计分

**Files:**
- Create: `packages/engine/src/era.ts`
- Test: `packages/engine/test/era.test.ts`

**Interfaces:**
- Produces: `checkEraEnd(state): GameState`（在 `endTurnIfNeeded` 里被调）、`scoreEraLinks(state)`、`finalScore(state)`

细则（rules-reference §7）：Link 计分（两端相邻地点内**已翻面**板块的连接图标数 = VP；含 `LINK_EXTRA_ENDPOINTS` 的附加端点——kidderminster–worcester 边的 Link 同时计入 farm-south 的翻面酒厂图标）→ Link 移除 → 翻面产业 VP 入账；运河末额外：移除 1 级产业、商人啤酒按"每块非空白板块 1 桶"补满、弃牌合洗（wild 不回弃牌堆——wild 弃时本就回供应）、重抽 8 张、era→rail；铁路时代第 1 轮正常 2 行动；终局 phase='game-over'，winner 判定（VP → 收入等级 → 现金 → 共同获胜）；钱/收入不折 VP。

- [ ] **Step 1: 写失败测试**

```ts
import { checkEraEnd } from '../src/era.js';

it('link scores 1 VP per link-icon on FLIPPED tiles in both endpoint locations', () => {
  // link birmingham-walsall；birmingham 有翻面 cotton L1(linkIcons=1) + 未翻面 iron(linkIcons=1 但未翻)
  // walsall 有翻面 brewery(linkIcons=2) → 该 link = 1 + 2 = 3 VP；未翻面铁厂不计
});
it('canal era end: level-1 tiles removed, level-2+ kept (score again in rail era)', () => {
  // 场上 level1 coal + level2 coal（均翻面）→ 时代清算后 level1 消失、level2 保留且 VP 已入账
});
it('merchant beer refills to one barrel per non-blank tile at canal era end', () => {
  // oxford 有 2 块非空白商人板块、beer=0 → 清算后 beer=2；shrewsbury 1 块非空白 → beer=1
  // blank 板块不产生补充
});
it('discards reshuffle into new deck, hands redeal to 8, era becomes rail', () => {
  const after = checkEraEnd(eraEndingState);
  expect(after.era).toBe('rail');
  expect(after.players.every((p) => p.hand.length === 8)).toBe(true);
});
it('rail era round 1 is a normal 2-action round', () => { /* actionsThisTurn 上限 2 */ });
it('game over: winner by VP, ties broken by income level then cash; money not converted to VP', () => {
  // 构造 vp 相等、incomeSpace 不同 → 高收入者胜
  // 构造 vp/income 都等、money 不同 → 现金多者胜
});
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(engine): 时代切换清算与终局计分"`

---

### Task 13: RandomAgent + Fuzz 对局 + 重放一致性

**Files:**
- Create: `packages/engine/src/agents/random.ts`
- Test: `packages/engine/test/fuzz.test.ts`、`packages/engine/test/replay.test.ts`

**Interfaces:**
- Produces:
  - `interface PlayerAgent { chooseAction(state: GameState, legal: Action[]): Action }`
  - `class RandomAgent implements PlayerAgent`（构造参数 seed；`chooseAction` 用独立 RNG 均匀随机选）
  - `playGame(playerCount, seed, agents?): { state; log: Action[] }`——驱动整局直到 phase='game-over'

- [ ] **Step 1: 写 fuzz 测试**

```ts
it('300 random 4p games all terminate with sane final state', { timeout: 300_000 }, () => {
  for (let seed = 0; seed < 300; seed++) {
    const { state, log } = playGame(4, seed);
    expect(state.phase).toBe('game-over');
    expect(state.winner!.length).toBeGreaterThan(0);
    expect(log.length).toBeGreaterThan(100);
    // 不变量：钱非负、收入轨在 [0,99]、VP 非负
    for (const p of state.players) {
      expect(p.money).toBeGreaterThanOrEqual(0);
      expect(p.incomeSpace).toBeGreaterThanOrEqual(0);
      expect(p.incomeSpace).toBeLessThanOrEqual(99);
    }
  }
});
it('fuzz 2p and 3p (100 games each)', { timeout: 180_000 }, () => { ... });
```

`playGame(playerCount, seed)` 内部确定性派生 agent 种子（`seed * 10 + seatIndex`），同 seed 必现同一局。`applyAction` 的合法性校验（重枚举比对）在 fuzz 中保持开启——它是 fuzz 的主要断言之一；若 CI 实测超时再降局数而非关校验。

- [ ] **Step 2: 写重放测试**

```ts
it('replay: re-applying logged actions reproduces byte-identical final state', () => {
  for (let seed = 0; seed < 20; seed++) {
    const { state: final1, log } = playGame(4, seed);
    let s = newGame(4, seed); // 同种子重新开局
    for (const a of log) s = applyAction(s, a); // 纯重放，无需 agent
    expect(stableStringify(s)).toBe(stableStringify(final1));
  }
});
```

- [ ] **Step 3: 跑 fuzz——失败则修引擎 bug 直到全绿**（这是 M1 的验收门：fuzz 暴露的规则实现 bug 逐条修，每修一条补一条针对性单测）

- [ ] **Step 4: Commit + PR 合入**

---

### Task 14: M1 收尾——公共导出 + README + 覆盖率核对

**Files:**
- Create: `packages/engine/src/index.ts`（公共 API barrel：`newGame`、`enumerateActions`、`applyAction`、`RandomAgent`、`playGame`、全部类型）
- Modify: `README.md`（repo 根，补 M1 状态）
- Modify: `.github/workflows/ci.yml`（确认 coverage 步骤在跑）

- [ ] **Step 1: 从包外 import 冒烟测试**（`test/public-api.test.ts` 只从 `../src/index.js` import，禁用深路径）
- [ ] **Step 2: `npx vitest run --coverage` 确认 engine 行覆盖 ≥ 85%（data 文件豁免）**
- [ ] **Step 3: 对照 rules-reference §9 "容易实现错的点" 20 条逐条确认有测试覆盖，缺的补**
- [ ] **Step 4: Commit + PR，M1 完成**
