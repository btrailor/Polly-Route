#!/bin/zsh
#
# codemap-drift-check.sh — Verify polly-router-codemap SKILL.md matches codebase.
# Run as a pre-commit hook or standalone. Exits non-zero if drift detected.
#
# Checks:
#   1. Every .ts file in src/ and src/providers/ is listed in the codemap
#   2. Line counts in the codemap are within ±20% of actual
#   3. No codemap-listed files have been deleted
#
# Usage:
#   ./scripts/codemap-drift-check.sh
#   # or as a git hook:
#   # cp scripts/codemap-drift-check.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -euo pipefail
setopt nullglob 2>/dev/null || true
setopt globstar 2>/dev/null || true

# Resolve repo root: check PWD, then walk up from script location
if [[ -n "${REPO_ROOT:-}" ]]; then
  : # already set (env override)
elif [[ -d "$PWD/src" ]]; then
  REPO_ROOT="$PWD"
else
  # Walk up from script dir until we find src/
  _dir="$(cd "$(dirname "$0")" && pwd)"
  while [[ "$_dir" != "/" && ! -d "$_dir/src" ]]; do
    _dir="$(dirname "$_dir")"
  done
  REPO_ROOT="$_dir"
fi
cd "$REPO_ROOT"
# Try multiple locations: workspace skills dir, repo-local, or env override
CODEMAP="${CODEMAP_PATH:-$HOME/.openclaw/workspace/skills/polly-router-codemap/SKILL.md}"
# Fall back to repo-relative for monorepo setups
if [[ ! -f "$CODEMAP" ]]; then
  CODEMAP="$REPO_ROOT/../skills/polly-router-codemap/SKILL.md"
fi

if [[ ! -f "$CODEMAP" ]]; then
  echo "⚠  Codemap SKILL.md not found at $CODEMAP — skipping drift check."
  exit 0
fi

errors=0
warnings=0

# --- Check 1: every src/*.ts file is in the codemap ---
for f in "$REPO_ROOT"/src/*.ts "$REPO_ROOT"/src/providers/*.ts; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  # Check if the basename appears anywhere in the codemap
  if ! grep -q "$base" "$CODEMAP"; then
    echo "❌ MISSING FROM CODEMAP: $base"
    errors=$((errors + 1))
  fi
done

# --- Check 2: line counts within ±20% ---
# Extract lines from codemap table rows like "| src/server.ts | 748 |"
while IFS='|' read -r _ file_path lines rest; do
  # Trim whitespace
  file_path="${file_path// /}"
  lines="${lines// /}"

  # Skip header rows and non-file entries
  [[ "$file_path" == src/*.ts ]] || continue
  # Skip entries that are directory summaries (no numeric line count)
  [[ "$lines" =~ ^[0-9]+$ ]] || continue

  full_path="$REPO_ROOT/$file_path"
  if [[ ! -f "$full_path" ]]; then
    echo "❌ CODEMAP REFERENCES MISSING FILE: $file_path"
    errors=$((errors + 1))
    continue
  fi

  actual=$(wc -l < "$full_path" | tr -d ' ')
  codemap_lines=$lines
  # 20% tolerance
  lower=$((codemap_lines * 80 / 100))
  upper=$((codemap_lines * 120 / 100))

  if [[ $actual -lt $lower || $actual -gt $upper ]]; then
    echo "⚠  LINE COUNT DRIFT: $file_path — codemap=$codemap_lines actual=$actual (±20% = $lower-$upper)"
    warnings=$((warnings + 1))
  fi
done < <(grep -E '^\| src/.*\.ts \|' "$CODEMAP")

# --- Summary ---
if [[ $errors -gt 0 ]]; then
  echo ""
  echo "❌ $errors error(s) — codemap is out of date. Update SKILL.md before committing."
  exit 1
fi

if [[ $warnings -gt 0 ]]; then
  echo ""
  echo "⚠  $warnings warning(s) — line counts have drifted. Consider updating SKILL.md."
  # Warnings don't block the commit, just notify.
  exit 0
fi

echo "✅ Codemap is in sync with codebase."
exit 0
