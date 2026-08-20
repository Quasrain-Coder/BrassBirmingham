# CLAUDE.md

> BrassBirmingham — 《Brass: Birmingham》桌游的浏览器实现（多人 + LLM AI + 赛后复盘）。**开发前先阅读 `docs/superpowers/specs/2026-08-02-brass-birmingham-design.md`（v1.0）**，架构/协议/里程碑的既有决策以它为准。

## 开发原则

1. **禁止直接向 `main` 提交或推送代码，没有任何例外**（包括文档、配置、Claude 自己的提交）。所有改动必须：新建分支 → 提交 → push 分支 → 开 PR → 合并进 `main`。
2. **新增或修改模块时，必须同步更新 CI 的 test/coverage 步骤**，不得遗漏。
3. 设计层面的变更（包划分、同步协议、行动/状态 schema、LLM 接口）必须与 `docs/superpowers/specs/2026-08-02-brass-birmingham-design.md` 同步更新，设计文档与代码不分离。
4. **规则只在 `packages/engine` 结算**：engine 为纯函数、零依赖；server/web/llm 不得各自实现规则逻辑。LLM 只做选择，行动合法性永远由引擎裁决。
5. **允许使用原版游戏素材**（美术、卡牌文字等）——本项目为个人非商用游玩（见 README Legal note）；无现成素材可用的部分再自绘简化 SVG 兜底。素材随仓库分发于 `packages/web/public/assets/`（个人非商用，来源见 `packages/web/scripts/asset-manifest.json`）；`npm run fetch-assets -w @brass/web` 可从源头重新下载加工（`raw/` 缓存不进 git）。
6. 随机性必须来自注入的种子随机数，保证 action log 重放逐字节一致。

## Git 工作流

- 分支命名：`feat/...`、`fix/...`、`docs/...`、`refactor/...`
- PR 合并前 CI 必须通过
- commit message 中英文均可；Claude 参与的提交带 `Co-Authored-By` 尾注

## Project Structure（规划，见设计文档 §2）

```
packages/
├── engine/   # 纯 TS 规则引擎：状态机 + enumerateActions + applyAction
├── server/   # WebSocket 权威服务器 + 房间 + SQLite(Drizzle)
├── web/      # React + Vite + SVG 棋盘
└── llm/      # PlayerAgent: LLM/Random（MCTS 预留接口）+ 复盘教练（Claude API）
```
