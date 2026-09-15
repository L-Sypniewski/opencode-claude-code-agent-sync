#!/usr/bin/env bash
# enforce-scope.sh - PreToolUse hook for generated Claude subagents.
#
# WHY: the OC→Claude frontmatter translation (sync-agents.ts) flattens nested
# permission.read / permission.bash / permission.edit (path/command-scoped,
# last-match-wins rules) down to tool-level allow/deny. This hook restores that
# scope by re-applying the original OC rules at runtime - including the GLOBAL
# rules from opencode.jsonc's top-level `permission` (secret-read denies, global
# bash denies), which sync-agents.ts merges global-first into every agent's
# rules JSON. One .claude/hooks/rules/<agent>.json per agent; this script is the
# shared evaluator invoked from each generated agent's PreToolUse hook.
#
# Usage (Claude Code pipes the tool-call JSON on stdin):
#   enforce-scope.sh <bash|edit|read> <agent-name>
#
# Exit codes (Claude Code PreToolUse contract):
#   0  allow / no-match / ask(→allow)   - tool call proceeds
#   2  deny                              - Claude blocks the call AND shows stderr
#
# Fail posture: this hook FAILS OPEN by default - a malfunction (malformed JSON,
# missing rules file, parse error, no-match) → exit 0, i.e. the call proceeds.
# Security implication: a broken hook silently WIDENS permissions vs OpenCode
# intent (e.g. a deleted rules file would let every denied path through). This
# is a usability trade-off: a misconfigured hook should not lock out all tool
# use. Set ENFORCE_SCOPE_FAIL_CLOSED=1 to flip to fail-closed - malfunction /
# no-match / missing-rules → exit 2 (block). The deny rules in
# .claude/hooks/rules/*.json are the source of truth for coverage.
#
# Matching: OpenCode-style globs. '*' = any run of chars (in bash's [[ == ]]
# pattern test it spans '/' too, so it crosses path separators); '**' collapses
# to '*' (equivalent here). ONLY '*' is intended - no source rule uses '?'/[].
# Divergence: the jq/bash path treats '?'/[] as live glob metacharacters, while
# the python3 fallback re.escape()s them to literals. Harmless in practice (no
# rule uses them); noted for correctness.
# Rules apply in source order, LAST-MATCH-WINS.
#
# Known gap: 'ask' maps to allow - a PreToolUse hook cannot interactively prompt.
# This is the one residual parity loss vs OpenCode (see sync-agents.ts header).
set -u

MODE="${1:-}"
AGENT="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_FILE="${SCRIPT_DIR}/rules/${AGENT}.json"

# Malfunction handler. Default FAIL-OPEN (exit 0): a broken hook must not lock
# out all tool use. ENFORCE_SCOPE_FAIL_CLOSED=1 → FAIL-CLOSED (exit 2 = block),
# so a missing/parseable rules file or no-match cannot silently widen perms.
malfunction() {
  if [[ "${ENFORCE_SCOPE_FAIL_CLOSED:-0}" == "1" ]]; then
    echo "enforce-scope: $* - ENFORCE_SCOPE_FAIL_CLOSED=1 → blocking (exit 2)" >&2
    exit 2
  fi
  echo "enforce-scope: $* - failing open (allow)" >&2
  exit 0
}

[[ -n "$MODE" && -n "$AGENT" ]] || { echo "usage: enforce-scope.sh <bash|edit|read> <agent-name>" >&2; exit 0; }
[[ "$MODE" == "bash" || "$MODE" == "edit" || "$MODE" == "read" ]] || malfunction "bad mode '$MODE' (want bash|edit|read)"
[[ -f "$RULES_FILE" ]] || malfunction "no rules file '$RULES_FILE' for agent '$AGENT'"

INPUT="$(cat)"
[[ -n "$INPUT" ]] || malfunction "empty stdin (no PreToolUse payload)"

# bash → tool_input.command; edit/read → tool_input.file_path.
FIELD="command"; [[ "$MODE" == "edit" || "$MODE" == "read" ]] && FIELD="file_path"

# Pick a JSON engine (prefer jq, fall back to python3).
if command -v jq >/dev/null 2>&1; then
  ENGINE=jq
elif command -v python3 >/dev/null 2>&1; then
  ENGINE=py
else
  malfunction "neither jq nor python3 available - cannot parse PreToolUse payload"
fi

# Extract the target string (bash → tool_input.command, edit/read → tool_input.file_path).
case "$ENGINE" in
  jq)
    VALUE="$(printf '%s' "$INPUT" | jq -r --arg f "$FIELD" '.tool_input[$f] // empty' 2>/dev/null)" \
      || malfunction "jq parse error on stdin payload"
    ;;
  py)
    VALUE="$(printf '%s' "$INPUT" | FIELD="$FIELD" python3 -c \
      'import json,os,sys; d=json.load(sys.stdin); print(((d.get("tool_input") or {}).get(os.environ["FIELD"])) or "",end="")' 2>/dev/null)" \
      || malfunction "python3 parse error on stdin payload"
    ;;
esac
[[ -n "$VALUE" ]] || malfunction "payload has no tool_input.${FIELD}"

# edit/read rule patterns (e.g. "docs/reviews/**") are repo-relative, matching
# OpenCode's own semantics - but Claude Code always resolves file_path to an
# ABSOLUTE path before this hook sees it, so a relative pattern could never
# match without this normalization (every relative allow-rule would silently
# fall through to the broader "*" deny). bash's $FIELD is a command string,
# not a path, so it's left untouched.
if [[ "$MODE" == "edit" || "$MODE" == "read" ]]; then
  REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
  if [[ -n "$REPO_ROOT" && "$VALUE" == "$REPO_ROOT"/* ]]; then
    VALUE="${VALUE#"$REPO_ROOT"/}"
  fi
fi

# Evaluate rules in source order, LAST-MATCH-WINS. jq emits pattern then action
# per rule on separate lines so patterns containing spaces survive intact.
FINAL_ACT=""; FINAL_PAT=""
case "$ENGINE" in
  jq)
    while IFS= read -r pat && IFS= read -r act; do
      [[ -z "$pat" ]] && continue
      norm="${pat//\*\*/\*}"          # '**' → '*' (equivalent under [[ == ]])
      # shellcheck disable=SC2053 # RHS unquoted ON PURPOSE - this is glob matching.
      [[ "$VALUE" == $norm ]] && { FINAL_ACT="$act"; FINAL_PAT="$pat"; }
    done < <(jq -r --arg mode "$MODE" '.[$mode][] | .pattern, .action' "$RULES_FILE" 2>/dev/null)
    ;;
  py)
    res="$(VALUE="$VALUE" MODE="$MODE" RULES_FILE="$RULES_FILE" python3 - <<'PY' 2>/dev/null || true
import json, os, re, sys
value, mode, rules_file = os.environ["VALUE"], os.environ["MODE"], os.environ["RULES_FILE"]
try:
    rules = json.load(open(rules_file)).get(mode, [])
except Exception:
    rules = []
# fnmatch '*' already spans '/'; '**' is collapsed to '*' for parity with the jq path.
def matches(v, p):
    rx = "^" + re.escape(p.replace("**", "*")).replace(r"\*", ".*") + "$"
    return re.fullmatch(rx, v, re.DOTALL) is not None
fa, fp = "", ""
for r in rules:
    if matches(value, r["pattern"]):
        fa, fp = r["action"], r["pattern"]
print(f"{fa}\t{fp}")
PY
)"
    FINAL_ACT="${res%%$'\t'*}"
    FINAL_PAT="${res#*$'\t'}"
    ;;
esac

# Decide + exit.
case "$FINAL_ACT" in
  deny)
    echo "Blocked by '${AGENT}' ${MODE} scope: matched \"${FINAL_PAT}\" (last-match-wins). Denied by OpenCode permission rule." >&2
    exit 2
    ;;
  allow|ask)
    # 'ask' → allow: a PreToolUse hook cannot interactively prompt (residual loss).
    exit 0
    ;;
  "")
    # No rule matched - malfunction (the usual "*" catch-all should prevent this).
    malfunction "no ${MODE} rule matched for '${AGENT}' on '${VALUE}'"
    ;;
  *)
    malfunction "unknown action '${FINAL_ACT}' for pattern '${FINAL_PAT}'"
    ;;
esac
