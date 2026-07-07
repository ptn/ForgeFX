#!/usr/bin/env bash
# PreToolUse guard for Bash commands. Exit 2 blocks the command (stderr = reason).
# Any other exit allows it. No network calls, no secrets printed.
set -euo pipefail

input="$(cat)"

# Extract the command string. Prefer jq; fall back to a conservative grep.
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"
else
  cmd="$(printf '%s' "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//')"
fi

block() { echo "blocked: $1" >&2; exit 2; }

# rm -rf targeting / or ~ (root or home).
if printf '%s' "$cmd" | grep -Eq 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*[[:space:]]+)+(-[a-zA-Z]*[[:space:]]+)*(/|~)([[:space:]]|$)'; then
  block "recursive delete of / or ~ is not allowed"
fi

# git push with a force flag (--force or -f, including clustered short flags).
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push' \
   && printf '%s' "$cmd" | grep -Eq '(--force([-=a-z]*)?|[[:space:]]-[a-zA-Z]*f[a-zA-Z]*)([[:space:]]|$)'; then
  block "force push is not allowed"
fi

# Reading the capture log or env secrets via common readers.
if printf '%s' "$cmd" | grep -Eq '(cat|head|tail|less|more|bat|strings|grep)([[:space:]]|$)' \
   && printf '%s' "$cmd" | grep -Eq '(tap\.log|server/\.env|/\.env([[:space:]]|$))'; then
  block "reading capture log or env files is not allowed"
fi

# Redirection or in-place edits onto anything under server/dist/.
if printf '%s' "$cmd" | grep -Eq '(>>?|tee|sed[[:space:]]+-i[^[:space:]]*)' \
   && printf '%s' "$cmd" | grep -Eq 'server/dist/'; then
  block "writing to build output server/dist/ is not allowed"
fi

# git commit while the current branch is main.
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+commit'; then
  branch="$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null || true)"
  if [ "$branch" = "main" ]; then
    block "on branch main; create a feature/fix branch first"
  fi
fi

exit 0
