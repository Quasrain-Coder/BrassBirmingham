#!/bin/bash
# 批量跨引擎校正：生成 N 局对方轨迹 → 我方对拍器逐局重放 → 汇总分歧。
# 用法: bench/batch-validate.sh [4p局数] [3p局数] [2p局数]
# 前置: /tmp/brass-assistant 已 cargo build --release --bin dump_trace
set -u
N4=${1:-50}; N3=${2:-10}; N2=${3:-10}
DUMP=/tmp/brass-assistant/target/release/dump_trace
OUT=/tmp/brass-traces
mkdir -p "$OUT"

echo "== 生成轨迹: 4p×$N4 3p×$N3 2p×$N2 =="
gen() { # seed players
  local f="$OUT/trace-$1-$2p.json"
  [ -s "$f" ] || "$DUMP" "$1" "$2" "$f" 2>/dev/null || echo "GEN_FAIL $f"
}
for ((s=0; s<N4; s++)); do gen $s 4 & done; wait
for ((s=0; s<N3; s++)); do gen $s 3 & done; wait
for ((s=0; s<N2; s++)); do gen $s 2 & done; wait
ls "$OUT" | wc -l

echo "== 逐局对拍 =="
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0; FAILED_FILES=()
for f in "$OUT"/trace-*.json; do
  if npx vite-node bench/cross-replay.ts "$f" 2>&1 | grep -q "^✓"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1)); FAILED_FILES+=("$f")
    echo "--- FAIL $f"
    npx vite-node bench/cross-replay.ts "$f" 2>&1 | grep -vE "时代清算|时代切换" | head -8
  fi
done
echo "== 结果: $PASS 通过 / $FAIL 失败 =="
[ ${#FAILED_FILES[@]} -gt 0 ] && printf '%s\n' "${FAILED_FILES[@]}" > /tmp/brass-failed.txt && echo "失败清单: /tmp/brass-failed.txt"
exit $FAIL
