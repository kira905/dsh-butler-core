#!/usr/bin/env sh
# quickstart.sh - run one tick and print the artifact paths.
# POSIX sh, ASCII only. Default state home = .ops-demo-home under $PWD;
# set OPS_CORE_HOME to point somewhere else. Never touches ~/.dsh.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_HOME=${OPS_CORE_HOME:-"$PWD/.ops-demo-home"}
NODE=${NODE:-node}
TICK="$ROOT/bin/ops-tickd.mjs"

if [ ! -f "$TICK" ]; then
  printf '[quickstart] not found: %s\n' "$TICK" >&2
  exit 2
fi

printf '[quickstart] package root : %s\n' "$ROOT"
printf '[quickstart] state home   : %s\n\n' "$STATE_HOME"

set +e
"$NODE" "$TICK" --once --home "$STATE_HOME"
code=$?
set -e
if [ "$code" -ne 0 ]; then
  printf '[quickstart] ops-tickd exited with %s\n' "$code" >&2
  exit "$code"
fi

printf '\n[quickstart] artifacts:\n'
REPORT=$(ls -1t "$STATE_HOME"/ops-reports/*.md 2>/dev/null | head -n 1 || true)
if [ -n "$REPORT" ]; then
  printf '  report  : %s\n' "$REPORT"
else
  printf '  report  : (missing)\n'
fi

AUDIT=$(ls -1t "$STATE_HOME"/ops-audit/*.jsonl 2>/dev/null | head -n 1 || true)
if [ -n "$AUDIT" ]; then
  printf '  audit   : %s\n' "$AUDIT"
else
  printf '  audit   : (missing)\n'
fi

if [ -f "$STATE_HOME/ops-notify-outbox.jsonl" ]; then
  printf '  outbox  : %s\n' "$STATE_HOME/ops-notify-outbox.jsonl"
else
  printf '  outbox  : (empty - add an item to ops-queue.json to produce one)\n'
fi

printf '\n[quickstart] next: open the report above, or run again to check that the report is not rewritten.\n'
