#!/usr/bin/env bash
# Post-cutover parallel-x6 harness for the state-persistence-optimization spec
# (Requirement 9.1). Mirrors the Phase 1 baseline methodology recorded in
# memory-bank/phase-1-findings.md:
#
#   1. Stand up a fresh CC_CONFIG_DIR with a SQLite store seeded to a
#      production-equivalent corpus (≥7 projects / ≥190 sessions / ≥700
#      conversations).
#   2. Start the Next dev server pointed at that temp dir on port 3100.
#   3. Pre-warm /diff once so the route compile cost lands on the warmup,
#      not on the measured run (the same pre-warming Phase 1 used).
#   4. Issue 6 concurrent GET /diff requests; record per-request wall time
#      and parse `state.read.timing` + `diff.timing` events from the
#      structured NDJSON log file.
#   5. Compute p50 / p95 / max for state-read totalMs and end-to-end totalMs.
#
# Usage:  bash scripts/bench-cutover-run.sh
set -euo pipefail

HARNESS_PORT=${HARNESS_PORT:-3100}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d -t cc-bench-cutover-XXXXXX)
LOG=$TMP/logs/global.log
CURL_LOG=$TMP/curl-parallel.tsv
echo "harness.tmp_dir=$TMP"
echo "harness.port=$HARNESS_PORT"

cleanup() {
  local rc=$?
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

# --- 1. Seed the corpus ----------------------------------------------------
SEED_OUT=$(CC_CONFIG_DIR="$TMP" "$ROOT/node_modules/.bin/tsx" \
  "$ROOT/scripts/bench-cutover-seed.ts" | tail -n 1)
echo "seed.output=$SEED_OUT"

PROJECT_NAME=$(printf '%s' "$SEED_OUT" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["targetProjectName"])')
SESSION_NAME=$(printf '%s' "$SEED_OUT" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["targetSessionName"])')
echo "harness.target=$PROJECT_NAME/$SESSION_NAME"

# --- 2. Boot dev server pointing at the seeded temp config dir -------------
cd "$ROOT"
CC_CONFIG_DIR="$TMP" PORT="$HARNESS_PORT" \
  "$ROOT/node_modules/.bin/next" dev --port "$HARNESS_PORT" --turbopack \
  > "$TMP/dev-server.log" 2>&1 &
SERVER_PID=$!
echo "harness.server_pid=$SERVER_PID"

# --- 3. Wait for the dev server to be ready --------------------------------
URL="http://localhost:$HARNESS_PORT/api/projects/$PROJECT_NAME/sessions/$SESSION_NAME/diff"
for i in $(seq 1 90); do
  if curl -fsS -o /dev/null "$URL"; then
    echo "harness.ready_attempt=$i"
    break
  fi
  sleep 1
  if [[ $i -eq 90 ]]; then
    echo "harness.ready_timeout=true"
    tail -40 "$TMP/dev-server.log"
    exit 1
  fi
done

# --- 4. Pre-warm: compile the /diff route + warm OS page cache -------------
for _ in 1 2; do
  curl -fsS -o /dev/null "$URL" || true
  sleep 0.2
done

# --- 5. Parallel x6 measurement --------------------------------------------
: > "$CURL_LOG"
echo "harness.parallel_x6.start"
PARALLEL_LOG_MARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)
echo "$PARALLEL_LOG_MARK" > "$TMP/log-mark.txt"

PIDS=()
for i in 1 2 3 4 5 6; do
  (
    /usr/bin/time -f "p${i}\t%e" -o "$CURL_LOG.p${i}" \
      curl -fsS -o /dev/null \
        -w "p${i}\thttp_total=%{time_total}\thttp_starttx=%{time_starttransfer}\thttp_status=%{http_code}\n" \
        "$URL"
  ) &
  PIDS+=("$!")
done
for pid in "${PIDS[@]}"; do
  wait "$pid"
done
cat "$CURL_LOG".p* > "$CURL_LOG"
echo "harness.parallel_x6.end"

sleep 1   # ensure async log writes have flushed

# --- 6. Summarize parallel-x6 timings from log files -----------------------
# Logs route through `withTracing` to per-session files when the request carries
# session scope; collect from both the global log and any per-session log.
python3 - "$TMP" "$PROJECT_NAME" "$SESSION_NAME" <<'PY'
import json, sys, statistics, pathlib

tmp = pathlib.Path(sys.argv[1])
project, session = sys.argv[2], sys.argv[3]

paths = [tmp / "logs" / "global.log"]
session_dir = tmp / "logs" / "sessions" / f"{project}__{session}"
if session_dir.exists():
    paths.extend(session_dir.rglob("*.log"))

state_reads = []
diff_entries = []
trace_state = {}
trace_diff = {}

for p in paths:
    if not p.exists():
        continue
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = entry.get("message")
        trace_id = entry.get("traceId")
        if msg == "state.read.timing" and entry.get("accessor") == "getSession":
            if trace_id and trace_id in trace_state:
                continue
            state_reads.append(float(entry["totalMs"]))
            if trace_id:
                trace_state[trace_id] = float(entry["totalMs"])
        elif msg == "diff.timing":
            if trace_id and trace_id in trace_diff:
                continue
            diff_entries.append({
                "totalMs": float(entry["totalMs"]),
                "resolveMs": float(entry.get("resolveMs", 0.0)),
                "sessionMs": float(entry.get("sessionMs", 0.0)),
                "diffMs": float(entry.get("diffMs", 0.0)),
                "serializeMs": float(entry.get("serializeMs", 0.0)),
                "traceId": trace_id,
            })
            if trace_id:
                trace_diff[trace_id] = entry["totalMs"]

diff_timings = [d["totalMs"] for d in diff_entries]

# parallel-x6 = last 6 entries (chronological order in NDJSON)
state_x6 = state_reads[-6:]
diff_x6 = diff_timings[-6:]

def stats(label, vals):
    if not vals:
        print(f"{label}: NONE")
        return None
    s = sorted(vals)
    n = len(s)
    p50 = statistics.median(s)
    p95 = s[max(0, int(round(0.95 * (n - 1))))]
    mx = max(s)
    print(f"{label}: n={n} p50={p50:.2f}ms p95={p95:.2f}ms max={mx:.2f}ms vals={[round(v,2) for v in s]}")
    return {"n": n, "p50": p50, "p95": p95, "max": mx, "values": s}

print("--- timings (parallel-x6, last 6 entries) ---")
state_stats = stats("state.read.timing.totalMs (getSession)", state_x6)
diff_stats = stats("diff.timing.totalMs (e2e)", diff_x6)

(tmp / "summary.json").write_text(json.dumps({
    "stateReadParallelX6": state_x6,
    "diffParallelX6": diff_x6,
    "diffParallelX6Entries": diff_entries[-6:],
    "stateReadStats": state_stats,
    "diffStats": diff_stats,
    "totalStateReadEntries": len(state_reads),
    "totalDiffEntries": len(diff_timings),
}, indent=2))
PY

cat "$CURL_LOG"
echo "---"
echo "harness.tmp_dir=$TMP"
echo "harness.summary=$TMP/summary.json"
