#!/bin/bash
# Usage: step-receipt.sh <receipt-dir> <name> <inputs (colon-separated)> <outputs (colon-separated)> -- <env assignments...> <binary> <args...>
# Runs one step under a deny-network sandbox with only the given environment and writes a raw receipt.
set -u
D=$1; N=$2; IN=$3; OUT=$4; shift 4; [ "$1" = "--" ] && shift
PROFILE='(version 1)(allow default)(deny network*)'
R=$D/$N.receipt.txt; L=$D/$N.log
mkdir -p "$D"
envs=(); while [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
BIN=$1; shift
{
  echo "name: $N"; echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "cwd: $PWD"
  echo "sandbox_profile: $PROFILE"
  echo "binary: $BIN"; echo "binary_sha256: $(shasum -a 256 "$BIN" | cut -c1-64)"
  printf 'command:'; printf ' %q' /usr/bin/sandbox-exec -p "$PROFILE" env -i "${envs[@]}" "$BIN" "$@"; echo
  echo "--- inputs sha256"; IFS=: read -ra a <<< "$IN"; for f in ${a[@]+"${a[@]}"}; do [ -n "$f" ] && { [ -f "$f" ] && shasum -a 256 "$f" || echo "MISSING $f"; }; done
  echo "--- expanded environment inside the sandbox"
  /usr/bin/sandbox-exec -p "$PROFILE" env -i "${envs[@]}" /usr/bin/env
} > "$R" 2>&1
/usr/bin/sandbox-exec -p "$PROFILE" env -i "${envs[@]}" "$BIN" "$@" > "$L" 2>&1
rc=$?
{
  echo "--- exit"; echo "EXIT=$rc"
  echo "--- outputs sha256"; IFS=: read -ra b <<< "$OUT"; for f in ${b[@]+"${b[@]}"}; do [ -n "$f" ] && { [ -f "$f" ] && shasum -a 256 "$f" || echo "MISSING $f"; }; done
  echo "--- log sha256"; shasum -a 256 "$L"
} >> "$R"
echo "$N EXIT=$rc"
exit $rc
