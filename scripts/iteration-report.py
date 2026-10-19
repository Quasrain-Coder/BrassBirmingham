#!/usr/bin/env python3
"""Brass Birmingham 迭代状态报告：在跑实验 + 最新判决 + 机器状态 → 系统推送。

数据源（全部只读）：
  /tmp/*status*.txt *summary*.txt     批次收官摘要（watcher 脚本产物）
  /tmp/e*-seg*.log                    分段进度（grep game 行计数）
  bb-lessons git log                  最近合入的迭代
  pgrep                               在跑进程
crontab（早 08:30 / 晚 21:00）:
  30 8,21 * * * cd /home/quasrain/repos/bb-lessons && python3 scripts/iteration-report.py >> /tmp/iteration-report.log 2>&1
"""
import glob
import json
import os
import re
import subprocess
import urllib.request
from datetime import datetime
from pathlib import Path

BB = Path("/home/quasrain/repos/bb-lessons")
TOKEN_FILE = Path("/home/quasrain/repos/QuasAssistant/backend/data/system-token")
API_BASE = "http://localhost:3001"
CHANNEL = os.environ.get("BRASS_REPORT_CHANNEL", "ch-e2bc8b16")
DRY = os.environ.get("BRASS_REPORT_DRY") == "1"


def sh(cmd: str) -> str:
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception:
        return ""


def running_experiments() -> list[str]:
    out = []
    pats = {
        "head2head.ts": "head2head 对决",
        "railmix-audit.ts": "railmix 审计",
        "tempo-probe.ts": "顺位探测",
        "playbook-instrument.ts": "playbook 插桩",
    }
    for pat, label in pats.items():
        # 按种子号去重数任务（wrapper+node 子进程 cmdline 同种子只计一次）
        n = sh(f"pgrep -fa '{pat}' | grep -v pgrep | grep -oE ' [0-9]{{3,5}}$' | sort -u | wc -l")
        if n and int(n) > 0:
            out.append(f"{label}×{n}")
    return out


def seg_progress() -> list[str]:
    """各分段日志的局数进度 + 最近一次收官摘要。"""
    lines = []
    logs = sorted(glob.glob("/tmp/*-seg*.log"), key=os.path.getmtime, reverse=True)[:8]
    fresh = [l for l in logs if (datetime.now().timestamp() - os.path.getmtime(l)) < 3 * 3600]
    groups: dict[str, list[tuple[str, int, int]]] = {}
    for l in fresh:
        m = re.match(r"/tmp/(.+)-seg\d+\.log", l)
        if not m:
            continue
        done = sh(f"grep -c '^game' {l}") or "0"
        total = 999
        # 从日志尾部找 [n/总] 进度行
        tail = sh(f"tail -5 {l} | grep -oE '\\[[0-9]+/[0-9]+\\]' | tail -1")
        if tail:
            total = int(tail.strip("[]").split("/")[1])
        groups.setdefault(m.group(1), []).append((os.path.basename(l), int(done), total))
    for name, segs in groups.items():
        if any(p[2] == 999 for p in segs):
            continue  # 无进度行格式，跳过
        d = sum(p[1] for p in segs)
        t = sum(p[2] for p in segs)
        if d < t:
            lines.append(f"{name}: {d}/{t} 局")
    return lines[:5]


def finished_summaries() -> list[str]:
    out = []
    files = sorted(
        glob.glob("/tmp/*status*.txt") + glob.glob("/tmp/*summary*.txt"),
        key=os.path.getmtime,
        reverse=True,
    )[:6]
    for f in files:
        age_h = (datetime.now().timestamp() - os.path.getmtime(f)) / 3600
        if age_h > 20:
            continue
        txt = Path(f).read_text(errors="ignore")
        # 判定行最直接可读
        for m in re.finditer(r"-- (\S+) --\n.*?合入判定.*?(✅ 可合入|✗ 不合入)", txt, re.S):
            pass
        verdicts = re.findall(r"合入判定（B 对 A）: (.+)", txt)
        for v in verdicts:
            out.append(f"{os.path.basename(f).replace('-status.txt','').replace('-summary.txt','')}: {v}")
        if len(out) >= 6:
            break
    return out


def main() -> None:
    now = datetime.now()
    hour = now.hour
    title = "早报" if hour < 12 else "晚报"
    default = sh(f"grep -m1 'export const DEFAULT_SPEC' {BB}/packages/llm/src/agents/registry.ts")
    recent = sh(f"git -C {BB} log --oneline -4 --since='36 hours ago'")
    running = running_experiments()
    segs = seg_progress()
    fin = finished_summaries()
    load = sh("cat /proc/loadavg").split()[:3]
    mem = sh("free -g | awk 'NR==2{{print $3\"/\"$2\"G\"}}'")

    parts = [f"🧪 Brass 迭代{title}（{now:%m-%d %H:%M}）", ""]
    if default:
        parts.append(f"默认: {default.split('=')[-1].strip().rstrip(';').strip(chr(39))}")
    if recent:
        parts.append("最近合入:\n  " + "\n  ".join(recent.splitlines()))
    if running:
        parts.append("在跑: " + "、".join(running))
    if segs:
        parts.append("进度: " + "；".join(segs))
    if fin:
        parts.append("近期收官:\n  " + "\n  ".join(fin))
    parts.append(f"机器: load {load[0]}({load[1]},{load[2]}) mem {mem}")
    text = "\n".join(parts)
    print(text)
    if DRY:
        return
    token = TOKEN_FILE.read_text().strip()
    body = json.dumps({"text": text, "source": "brass-report"}, ensure_ascii=False)
    req = urllib.request.Request(
        f"{API_BASE}/api/system/channels/{CHANNEL}/push",
        data=body.encode(),
        headers={"content-type": "application/json", "x-system-token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        print("[push]", r.status, r.read().decode())


if __name__ == "__main__":
    main()
