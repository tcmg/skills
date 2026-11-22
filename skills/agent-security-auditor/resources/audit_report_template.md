# AI Agent Security Report: <machine / user>

_Generated <date> by agent-security-auditor. Code folder in scope: `<~/Code>`._

## Summary

| Goal | Status | One-line reason |
|---|---|---|
| Personal files and credentials stay private | AT RISK / PARTIAL / OK / UNVERIFIED | |
| Agent commands run sandboxed | | |
| Agents limited to the code folder | | |
| Secrets and configuration hygiene | | |

**Biggest risk in plain words:** <e.g. "A prompt injection in a web page Claude reads could make a
sandboxed command read ~/.ssh and your Gemini token, because the sandbox can read all of your home
folder.">

## What is installed

| Product | Version | Config files reviewed |
|---|---|---|
| Claude Code (CLI / desktop-bundled) | | |
| Claude desktop app | | |
| Antigravity app / IDE / agy CLI | | |
| Gemini CLI | | |

## Live sandbox probe

Run from: <which agent / process>.

| Location | Category | Result |
|---|---|---|
| ~/.ssh | credentials | readable / blocked |
| ~/Documents | personal | |
| ~/Code | code folder | should be readable |

## Findings

Group by severity (Critical, High, Medium, Low). For each finding:

### [ID] Title
- **Product / goal:** claude-code / personal_files
- **What it means:** what an attacker or a misbehaving agent could actually do.
- **Evidence:** `file -> key` (never secret values)
- **Fix:** exact setting, snippet, or click path. Say whether the agent can apply it or the user must.

## Proposed changes

One subsection per product. For each:
- the diff
- the trade-offs
- the backup and apply command
- the status: applied, pending user, or declined

## Manual checks for the user

- [ ] System Settings > Privacy & Security > Full Disk Access: no agent apps or terminals
- [ ] Files and Folders: revoke Desktop / Documents / Downloads for Claude, Antigravity and terminals
- [ ] Accessibility / Screen Recording: only while using computer-use features
- [ ] Desktop app toggles (bypass mode, Remote Control) confirmed in Settings
- [ ] Antigravity Settings show the new preset, file access and browser policies after relaunch

## Verification after changes

- New sessions started: yes / no
- Re-scan goal statuses: before -> after
- Probe from Claude Code: … / from Antigravity: …
- Toolchain smoke test (`git status`, `node -v`, `python3 -V`, project build/test): pass / issues

## Still open

| Item | Owner | Next step |
|---|---|---|
