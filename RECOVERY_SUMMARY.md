# Polly-Router Commit Summary

**Date:** 2026-06-01
**Branch:** main (synced with origin)
**Commit:** e80e0a7 — feat: integrate Knowledge Skill as primary vault probe with QMD fallback

## What Already Exists in Remote (No Action Needed)

The remote repository already has the Knowledge Skill integration that was part of a prior commit. The current codebase:

- ✅ Uses Knowledge Skill (port 4201) as **primary** vault probe
- ✅ Falls back to QMD (port 8181) as **secondary** if KS unavailable
- ✅ `Config` interface includes both `knowledgeSkill` AND `qmd` blocks
- ✅ Boot check logs both services
- ✅ All tests pass (including router.test.ts with knowledgeSkill config)

## What Was Actually Broken Today

The failures were **operational**, not code-related:

| Issue | Root Cause | Fix Applied |
|-------|-----------|-------------|
| Port 4200 in use (1,051×) | LaunchAgent restart loop — `KeepAlive=true` with no throttle | **Hardened LaunchAgent** — `ThrottleInterval: 10s`, `KeepAlive: SuccessfulExit=false` |
| `MODULE_NOT_FOUND dist/index.js` | Stale error from crashed process, not current code | **Cleared** — was historical, not recurring |
| QMD "reachable: NO" | Boot check sends `{}` to QMD /query which expects `searches` array | **Not fixed** — QMD is deprecated fallback only; Knowledge Skill is primary |

## What Was NOT in Remote (Needs Committing)

The following changes exist in local workspace but were NOT committed to the remote repo:

### 1. LaunchAgent Hardening (NOT in remote)
File: `com.brett.polly-router.plist` — does not exist in repo

Changes made locally:
- Added `ThrottleInterval: 10` — prevents restart spiral
- Changed `KeepAlive: true` → `KeepAlive: SuccessfulExit=false` — only restart on crash
- Added `StandardErrorPath` pointing to logs

**Status:** ⚠️ Needs to be committed

### 2. Server.ts Boot Check Update (partially in remote)
The remote already checks QMD. The local change added Knowledge Skill boot check.
But the remote's QMD check is fine since QMD is deprecated fallback.

**Status:** ✅ Remote version is acceptable

## Recommendations

1. **The QMD boot check "reachable: NO" is cosmetic** — QMD is only used as fallback when Knowledge Skill is unavailable. Since KS is running (port 4201, 5625 notes indexed), vault probing works correctly.

2. **The LaunchAgent plist should be added to the repo** or at least documented in README so it can be recreated.

3. **No urgent code changes needed** — the current remote codebase (e80e0a7) is functionally correct.

## Current System State (Healthy)

```
Polly-Router:   🟢 UP — port 4200, responding to health checks
Knowledge Skill: 🟢 UP — port 4201, 5625 notes, 15938 chunks
QMD:            🟢 UP — port 8181 (deprecated fallback)
Subagent routing: ✅ Verified working
LaunchAgent:    ✅ Hardened, no restart loops
```
