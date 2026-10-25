#!/usr/bin/env python3
"""auto-iter：持续自动迭代守护（cron */5，flock 单实例）。

状态机（/tmp/auto-iter-state.json）：
  current 批次在跑（检测 bench/head2head 进程）→ 等待
  current 批次跑完（进程归零）→ 结算 → 判定 → 状态文件补记（供
    iteration-report.py 推送 🏁）→ AUTO-ITER-LOG.md 落档 → git 提交
    + PR 自动合入 → 若双高且有 escalate_games 则把放量批次插队首
  无 current 且队列非空且机器空闲 → 取队首发射（setsid 4 段并行）

队列：scripts/auto-iter-queue.json（仓库内版本化，人工维护）。
用法：auto-iter.py [--dry]   （cron: flock -n /tmp/auto-iter.lock auto-iter.py）
"""
import json, os, re, subprocess, sys, time
from datetime import datetime

REPO = os.path.expanduser("~/repos/bb-lessons")
LLM = f"{REPO}/packages/llm"
QUEUE_F = f"{REPO}/scripts/auto-iter-queue.json"
STATE_F = "/tmp/auto-iter-state.json"
LOG_F = "/tmp/auto-iter.log"
TOKEN_F = os.path.expanduser("~/.config/brass-gh-token")
MAX_SEGS = 4

def log(msg):
    line = f"[{datetime.now():%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=REPO, **kw)

def load(f, default):
    try:
        return json.load(open(f))
    except Exception:
        return default

def save_state(st):
    json.dump(st, open(STATE_F, "w"), ensure_ascii=False, indent=1)

def busy():
    # 任何 head2head 在跑即视为忙（含人工手发的批次）
    return sh("pgrep -fc 'bench/head2head'").stdout.strip() not in ("", "0")

# ---------- 结算 ----------
GAME_RE = re.compile(r"^game \d+: ((?:[AB]=\d+ ?){4})")

def parse_seg(path):
    pts = {"A": 0, "B": 0}; vp = {"A": 0, "B": 0}; n = 0
    try:
        lines = open(path)
    except OSError:
        return pts, vp, n
    for l in lines:
        m = GAME_RE.match(l)
        if not m:
            continue
        nums = [(k, int(v)) for k, v in re.findall(r"([AB])=(\d+)", m.group(1))]
        sc = [(k, v) for k, v in nums]
        for rank, kk in enumerate(sorted(range(4), key=lambda k: -sc[k][1])):
            pts[sc[kk][0]] += [3, 1, -1, -3][rank]
        vp["A"] += sum(v for k, v in nums if k == "A")
        vp["B"] += sum(v for k, v in nums if k == "B")
        n += 1
    return pts, vp, n

def finalize(item):
    name = item["name"]; T = {"pts": {"A": 0, "B": 0}, "vp": {"A": 0, "B": 0}, "n": 0}
    for i in range(item.get("segs", MAX_SEGS)):
        p, v, n = parse_seg(f"/tmp/{name}-seg{i}.log")
        for k in "AB":
            T["pts"][k] += p[k]; T["vp"][k] += v[k]
        T["n"] += n
    n = max(1, T["n"])
    ptsA, ptsB = T["pts"]["A"] / n, T["pts"]["B"] / n
    vpA, vpB = T["vp"]["A"] / (2 * n), T["vp"]["B"] / (2 * n)
    pas = ptsB > ptsA and vpB > vpA
    verdict = "✅ 可合入" if pas else "✗ 不合入"
    with open(f"/tmp/{name}-status.txt", "a") as f:
        f.write(f"== {name} finished at {datetime.now():%Y-%m-%d %H:%M}（auto-iter 结算）==\n")
        f.write(f"{item.get('agentA','?')}: 人均 {vpA:.1f} | 名次积分 {ptsA:+.3f}/局\n")
        f.write(f"{item.get('agentB','?')}: 人均 {vpB:.1f} | 名次积分 {ptsB:+.3f}/局\n")
        f.write(f"合入判定（B 对 A）: 名次积分 {'高' if ptsB>ptsA else '低'}（{ptsB:+.3f} vs {ptsA:+.3f}），人均 VP {'高' if vpB>vpA else '低'}（{vpB:.1f} vs {vpA:.1f}）→ {verdict}\n")
    log(f"{name}: n={T['n']} A {ptsA:+.3f}/{vpA:.1f} | B {ptsB:+.3f}/{vpB:.1f} → {verdict}")
    return dict(n=T["n"], ptsA=ptsA, ptsB=ptsB, vpA=vpA, vpB=vpB, passed=pas, verdict=verdict)

def record_and_merge(item, r):
    # AUTO-ITER-LOG.md 追加 + commit + PR 自动合入
    entry = (f"| {datetime.now():%Y-%m-%d} | {item['name']} | {item['agentB']} vs {item['agentA']}"
             f" ×{r['n']} | {r['ptsB']:+.3f} vs {r['ptsA']:+.3f}/局；{r['vpB']:.1f} vs {r['vpA']:.1f}"
             f" | {r['verdict']} | {item.get('note','')} |\n")
    p = f"{LLM}/bench/docs/AUTO-ITER-LOG.md"
    if not os.path.exists(p):
        open(p, "w").write("# 自动迭代日志（auto-iter.py）\n\n| 日期 | 批次 | 对局 | 积分/VP | 判定 | 备注 |\n|---|---|---|---|---|---|\n")
    with open(p, "a") as f:
        f.write(entry)
    b = f"auto-iter/{item['name']}-{int(time.time())}"
    msg = f"docs(llm): auto-iter {item['name']} → {r['verdict']}"
    sh(f"git checkout -q -B {b} origin/main && git add packages/llm/bench/docs/AUTO-ITER-LOG.md"
       f" && git commit -q -m '{msg}' && git push -q origin {b}")
    try:
        tok = open(TOKEN_F).read().strip()
        pr_body = json.dumps({'title': f"auto-iter: {item['name']} {r['verdict']}", 'head': b, 'base': 'main'})
        d = json.loads(sh(
            "curl -sS -X POST https://api.github.com/repos/Quasrain-Coder/BrassBirmingham/pulls"
            f" -H 'Authorization: Bearer {tok}' -H 'Accept: application/vnd.github+json'"
            f" -d '{pr_body}'"
        ).stdout)
        if "number" in d:
            mg = json.dumps({'merge_method': 'merge'})
            sh(f"curl -sS -X PUT https://api.github.com/repos/Quasrain-Coder/BrassBirmingham/pulls/{d['number']}/merge"
               f" -H 'Authorization: Bearer {tok}' -H 'Accept: application/vnd.github+json'"
               f" -d '{mg}'")
            sh("git fetch -q origin && git checkout -q -B mainwork origin/main")
            log(f"{item['name']}: PR #{d['number']} 已合入")
    except Exception as e:
        log(f"PR 合入异常（不阻塞）: {e}")

def launch(item):
    name = item["name"]; gps = item["games_per_seg"]; segs = min(item.get("segs", MAX_SEGS), MAX_SEGS)
    with open(f"/tmp/{name}-status.txt", "w") as f:
        f.write(f"{name} launched by auto-iter at {datetime.now():%Y-%m-%d %H:%M}\n")
    for i in range(segs):
        seed = item["seed0"] + i * gps
        sh(f"cd {LLM} && setsid nohup npx vite-node bench/head2head.ts {item['agentA']} {item['agentB']} {gps} {seed}"
           f" > /tmp/{name}-seg{i}.log 2>&1 &")
    log(f"{name}: 已发射 {segs}×{gps}（seeds {item['seed0']}+，{item['agentA']} vs {item['agentB']}）")

def main():
    dry = "--dry" in sys.argv
    st = load(STATE_F, {"history": []})
    q = load(QUEUE_F, [])
    if not isinstance(q, list):
        q = q.get("queue", [])
    if st.get("current"):
        if busy():
            log("current 在跑，等待"); return
        item = st["current"]
        r = finalize(item)
        if not dry:
            record_and_merge(item, r)
        done = {"name": item["name"], **{k: round(v, 3) if isinstance(v, float) else v for k, v in r.items()}, "ts": int(time.time())}
        st["history"].append(done); st["current"] = None
        # 双高 → 放量插队首
        if r["passed"] and item.get("escalate_games") and not dry:
            q.insert(0, {**item, "name": "{0}-x{1}".format(item['name'], item['escalate_games'] * MAX_SEGS),
                         "games_per_seg": item["escalate_games"], "segs": MAX_SEGS,
                         "seed0": item["seed0"] + 10000, "escalate_games": None, "note": f"放量（{item['name']} 双高）"})
            json.dump(q, open(QUEUE_F, "w"), ensure_ascii=False, indent=1)
    if not st.get("current") and q and not busy():
        names = [h["name"] for h in st["history"]]
        item = next((x for x in q if x["name"] not in names), None)
        if item is None:
            log("队列全部完成"); return
        if not dry:
            launch(item)
            st["current"] = item
        log(f"取队首: {item['name']}（dry={'跳过发射' if dry else '已发射'}）")
    if not dry:
        save_state(st)

if __name__ == "__main__":
    main()
