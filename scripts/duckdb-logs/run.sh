#!/usr/bin/env bash
# DuckDB log-analysis tool for Command Center — ad-hoc SQL over the NDJSON logs.
#
# Stateless: every command runs a fresh DuckDB process that reads prelude.sql
# (a typed `logs` view over the live log glob) then a query. Nothing is cached,
# so results are always current and there is no database file to build.
#
#   run.sh <question> [--since T] [--until T] [--limit N] [--format F]
#   run.sh trace <traceId>            drill into one request's timeline
#   run.sh slow-requests [N]          shortcut for --limit N
#   run.sh sql "SELECT … FROM logs"   ad-hoc query against the typed view
#   run.sh repl                       interactive shell with `logs` loaded
#   run.sh list                       list the built-in questions
#   run.sh selftest                   run every question against the fixture
#
# Questions: overview, slow-requests, endpoints, state-store, trace,
#            duplicate-work, external-commands, throughput, write-queue, errors
#
# Flags:
#   --since / --until <ISO>   time window (e.g. 2026-06-20 or 2026-06-20T12:00:00Z)
#   --limit <N>               row cap for ranked questions (default 30)
#   --format <box|markdown|csv|json|line>   output mode (default box)
#   --glob <path>             override the log source (file or glob)
#
# Log source: $CC_LOG_FILE if set, else the OS-default CC log glob (global.log*,
# spanning rotated backups). Override per-invocation with --glob.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRELUDE="$HERE/prelude.sql"
QDIR="$HERE/queries"

# Every command except help/list shells out to duckdb.
case "${1:-}" in
  ""|-h|--help|help|list) ;;
  *) command -v duckdb > /dev/null 2>&1 || {
       echo "duckdb not found on PATH. Install it: brew install duckdb" >&2
       exit 127
     } ;;
esac

default_glob() {
  case "$(uname -s)" in
    Darwin) printf '%s' "$HOME/Library/Application Support/cc/logs/global.log*" ;;
    *)      printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/cc/logs/global.log*" ;;
  esac
}

usage() { sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

list_questions() { for f in "$QDIR"/*.sql; do basename "$f" .sql; done; }

# Trim leading/trailing whitespace (incl. a stray CR from CSV/copy-paste) while
# preserving inner spaces, so e.g. --since "2026-06-20 10:00:00" survives but a
# trace id captured from CRLF output still matches.
trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# --- parse command + flags -------------------------------------------------
cmd="${1:-}"; [[ $# -gt 0 ]] && shift || true

SINCE="" UNTIL="" LIMIT="" FORMAT="box" GLOB_OVERRIDE=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)  SINCE="$2";  shift 2 ;;
    --until)  UNTIL="$2";  shift 2 ;;
    --limit)  LIMIT="$2";  shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --glob)   GLOB_OVERRIDE="$2"; shift 2 ;;
    --since=*)  SINCE="${1#*=}";  shift ;;
    --until=*)  UNTIL="${1#*=}";  shift ;;
    --limit=*)  LIMIT="${1#*=}";  shift ;;
    --format=*) FORMAT="${1#*=}"; shift ;;
    --glob=*)   GLOB_OVERRIDE="${1#*=}"; shift ;;
    --) shift; POSITIONAL+=("$@"); break ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)  POSITIONAL+=("$1"); shift ;;
  esac
done

CC_LOG_GLOB="${GLOB_OVERRIDE:-${CC_LOG_FILE:-$(default_glob)}}"
TRACE_ID=""

# command-specific positionals
case "$cmd" in
  trace)         TRACE_ID="${POSITIONAL[0]:-}" ;;
  slow-requests) [[ "$(trim "${POSITIONAL[0]:-}")" =~ ^[0-9]+$ ]] && LIMIT="${POSITIONAL[0]}" ;;
esac

SINCE="$(trim "$SINCE")"; UNTIL="$(trim "$UNTIL")"
LIMIT="$(trim "$LIMIT")"; TRACE_ID="$(trim "$TRACE_ID")"
export SINCE UNTIL LIMIT TRACE_ID CC_LOG_GLOB

require_log() {
  compgen -G "$CC_LOG_GLOB" > /dev/null 2>&1 || {
    echo "no log files match: $CC_LOG_GLOB" >&2
    echo "(set CC_LOG_FILE or pass --glob; CC writes logs once it has run)" >&2
    exit 1
  }
}

header() {
  echo "# source: $CC_LOG_GLOB" >&2
  echo "# window: ${SINCE:-(all)} .. ${UNTIL:-(now)}    format: $FORMAT" >&2
}

run_file() { duckdb -c ".mode $FORMAT" -c ".read $PRELUDE" -c ".read $1"; }

# --- dispatch --------------------------------------------------------------
case "$cmd" in
  ""|-h|--help|help) usage ;;

  list) list_questions ;;

  sql)
    require_log
    stmt="${POSITIONAL[0]:?usage: run.sh sql \"SELECT … FROM logs\"}"
    header
    duckdb -c ".mode $FORMAT" -c ".read $PRELUDE" -c "$stmt"
    ;;

  repl)
    require_log
    header
    exec duckdb -cmd ".mode $FORMAT" -cmd ".read $PRELUDE"
    ;;

  selftest)
    glob_fixture="$HERE/fixtures/sample.log"
    [[ -f "$glob_fixture" ]] || { echo "missing fixture: $glob_fixture" >&2; exit 1; }
    export CC_LOG_GLOB="$glob_fixture" TRACE_ID="" SINCE="" UNTIL="" LIMIT=""
    fails=0
    for f in "$QDIR"/*.sql; do
      name="$(basename "$f" .sql)"
      if err="$(run_file "$f" 2>&1 >/dev/null)"; then
        echo "ok   $name"
      else
        echo "FAIL $name"; echo "$err" | sed 's/^/       /'; fails=$((fails + 1))
      fi
    done
    echo "---"; echo "$fails failed"
    [[ $fails -eq 0 ]]
    ;;

  *)
    qfile="$QDIR/$cmd.sql"
    [[ -f "$qfile" ]] || { echo "unknown command/question: $cmd" >&2; echo >&2; usage; exit 2; }
    require_log
    header
    run_file "$qfile"
    ;;
esac
