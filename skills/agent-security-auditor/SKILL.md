---
name: agent-security-auditor
description: >-
  Audits and hardens the local security setup of AI coding agents on macOS: Claude Code (CLI and the
  Claude desktop app's Code tab), Claude Desktop, Google Antigravity (app, IDE and agy CLI) and Gemini
  CLI. Checks sandbox mode, permission modes and allow/deny rules, which folders agents can read or
  write, MCP servers, plaintext tokens, remote control, automations and macOS privacy grants. Runs a
  live probe of the agent's own sandbox, then proposes hardened configs that confine agents to the
  user's code folder (e.g. ~/Code) and applies them only with approval. Use this whenever the user asks
  to secure, lock down, sandbox, harden or audit Claude / Antigravity / AI agent settings, worries that
  agents can read personal files, SSH keys, tokens or .env files, asks about prompt-injection
  exfiltration, or wants agents restricted to one folder, even if they never say "audit".
---

# AI Agent Security Auditor (Claude + Antigravity)

Use this skill to answer "how exposed is my machine to my AI agents?" and then close the gaps. It
measures the setup against three goals the user cares about, plus general hygiene:

| Goal id | Meaning |
|---|---|
| `personal_files` | Personal files and credentials (Documents, Desktop, ~/.ssh, cloud tokens, browser data) are unreadable by agents |
| `sandbox` | Agent shell commands run inside an OS sandbox, and nothing quietly turns it off |
| `scope` | Agents can work in the code folder (default `~/Code`) and reach little else |
| `hygiene` | No plaintext secrets in agent config, no surprise remote control, MCP/hooks reviewed |

## Ground rules

These exist because a security tool that leaks or breaks things is worse than none.

- **Scan read-only first.** The scanner never edits config. It prints key names, modes and booleans,
  never secret values. Do the same in your own reads: when you open a config file to confirm a
  finding, quote key names and structure, never token values.
- **Change nothing without explicit approval**, one product at a time, after showing the diff. Back up
  every file before replacing it (`<file>.bak-YYYYmmdd-HHMMSS`).
- **Never weaken a control to make something work.** If the hardened config breaks a tool, add the
  narrowest `allowRead` path or grant. Do not disable the sandbox.
- **Some changes belong to the user.** macOS privacy grants (System Settings > Privacy & Security),
  app toggles that live only in a GUI, FileVault and anything needing `sudo` are theirs to make. Give
  the exact click path or command and let them run it.
- **Your own sandbox may block the fix, and that is correct.** Claude Code write-protects
  `~/.claude/settings.json` from sandboxed commands. If a write is refused, don't look for a way
  around it. Hand the user a one-line `cp` command instead.
- **Antigravity rewrites `~/.gemini/config/config.json` while it runs.** The user must quit Antigravity
  before that file is replaced, or the change is lost.

## Workflow

### Phase 1: Scan

Resolve `<skill_dir>` as the folder containing this SKILL.md. Write output to your scratch or temp
folder, not into the user's repos. Ask which folder agents should be allowed to use if it isn't
`~/Code`.

```bash
python3 <skill_dir>/scripts/scan_agent_security.py \
  --code-dir ~/Code \
  --probe \
  --output "$TMPDIR/agent-audit/report.json" \
  --markdown "$TMPDIR/agent-audit/report.md" \
  --propose-dir "$TMPDIR/agent-audit/proposals"
```

The script needs only the Python 3.8+ standard library and takes a few seconds. `--probe` opens each
sensitive path and closes it again, reading zero bytes. This tests the sandbox of **the process
running the script**. Run from your Bash tool, it measures your own sandbox, which is the most honest
evidence in the report.

On an already-hardened machine, your sandbox will (correctly) stop the scanner reading agent config
files. Findings then come back as `*-UNREADABLE` with severity `unknown`. That is the lock-down
working, not a failure. Keep the in-agent run for the probe. Ask the user to run the same command in
their own terminal (outside any agent) for the configuration audit, then read the report they
produce.

### Phase 2: Understand and verify

Read `report.json`. The useful parts:

- `goals`: status per goal (`AT RISK` / `PARTIAL` / `UNVERIFIED` / `OK`)
- `findings[]`: each has `id`, `severity`, `goal`, `product`, `title`, `detail`, `evidence`, `fix`
- `inventory`: which products are installed, versions, MCP servers, workspaces, decoded policies
- `probe.results`: readable or blocked, per sensitive path
- `proposals`: paths to the proposed configs and diffs, plus `notes` explaining every change

The scanner uses heuristics, and some Antigravity keys were reverse-engineered. Before reporting a
high or critical finding, open the cited file and confirm it. Then look past the checklist. A
self-written MCP server, an odd hook or an unusually broad allow rule deserves comment even when no
rule fired. Read the reference file for each product you need to explain:

- [`references/claude_code_hardening.md`](./references/claude_code_hardening.md): the two
  enforcement layers (Bash sandbox vs built-in file tools), settings precedence, the recommended
  config, managed settings, and troubleshooting a hardened setup
- [`references/antigravity_hardening.md`](./references/antigravity_hardening.md): the three
  Antigravity surfaces, permission presets, grant syntax (grants also widen the sandbox), where each
  setting lives on disk, the decoded enum tables, and past incidents
- [`references/macos_os_layer.md`](./references/macos_os_layer.md): TCC folder grants, Full Disk
  Access, Accessibility, FileVault, and when to use a separate user account or VM

Things people commonly get wrong, worth explaining when they apply:

1. **Claude Code's sandbox covers Bash only.** Read/Grep/Glob run in the main process. They are
   bounded by `permissions.deny` and `blockReadsOutsideWorkingDirectories`, not by `sandbox.filesystem`.
2. **The sandbox's default read scope is the whole disk.** A denylist of a few folders always misses
   something. Denying `~/` and re-allowing `~/Code` plus toolchains inverts that.
   - **`allowRead` beats `denyRead`**, so re-allow narrow tool folders (`~/.cargo/bin`, not `~/.cargo`,
     which holds `credentials.toml`).
   - `.env` files inside `~/Code` stay openable by programs. Read deny rules only stop Claude itself
     from viewing them.
3. **Repositories can override user settings.** A repo's `.claude/settings.json` outranks
   `~/.claude/settings.json`. Only root-owned managed settings can't be overridden.
4. **In Antigravity, allow grants are sandbox mounts.** Every `read_file(...)` you once approved is
   readable by sandboxed commands from then on.
5. **MCP servers, hooks, plugins and desktop extensions run outside every sandbox.** Review them as
   ordinary programs with your full permissions.
6. **Agents can weaken each other.** An Antigravity agent with write access to `~/.claude` can
   loosen Claude's settings, and vice versa. The proposals add cross-agent write denies.
7. **macOS grants are inherited.** If Claude.app or a terminal holds Documents/Desktop/Downloads or
   Full Disk Access, everything it launches does too.

### Phase 3: Report

Write `agent_security_report.md` following
[`resources/audit_report_template.md`](./resources/audit_report_template.md). Lead with the
per-goal verdicts and the live probe result, then the findings by severity, each with evidence and
a fix. Keep it readable for a non-specialist: say what an attacker (usually a prompt injection in a
web page, issue or README) could actually do, not just which key is wrong. List what you could not
verify, such as TCC grants or GUI-only toggles, as manual checks.

### Phase 4: Harden (with approval)

Present the proposals one product at a time. Show the diff from `proposals/*.diff` and the notes,
and point out the trade-offs before asking:

- **Claude Code** (`claude-settings.proposed.json` replaces `~/.claude/settings.json`). The sandbox
  denies `~/` and re-allows `~/Code` plus toolchain folders found on this machine. Credentials and
  personal folders get Read/Edit deny rules. Antigravity config and shell startup files get Edit
  deny rules. Bypass mode is disabled, and built-in file tools stop at the working directory.
  - Trade-off: a tool that reads an un-allowed home folder will fail with "Operation not permitted"
    until that one path is added.
  - Trade-off: cross-repo reads need `--add-dir`.
  - `.env` files inside `~/Code` stay readable. Ask whether to add `Read(**/.env*)` denies. Some
    projects need agents to see them.
- **Antigravity** (`antigravity-config.proposed.json` replaces `~/.gemini/config/config.json`). The
  Default preset is stored explicitly. Non-workspace file access becomes Deny, and there are deny
  grants for credentials, personal folders, Claude config and shell startup files. Browser JS is
  set to Ask, and remote control and ADC are turned off if they were on.
  - Grants outside `~/Code` are listed but kept. The user decides whether to remove them.
  - Strict mode is offered as an optional extra.

Apply only after a clear yes:

```bash
f=~/.claude/settings.json; cp "$f" "$f.bak-$(date +%Y%m%d-%H%M%S)" && cp "<proposals>/claude-settings.proposed.json" "$f"
```

For Antigravity, the user quits the app first (Cmd+Q). Then run the same pattern on
`~/.gemini/config/config.json`. Check the result parses (`python3 -m json.tool <file> >/dev/null`).
If your sandbox refuses the write, give the user the command and wait for them to run it. Changes
that live only in a GUI (desktop-app toggles, Antigravity settings you could not verify in the
file) go in a short click-path checklist.

### Phase 5: Verify

Hardening that was never tested is a guess. After changes:

1. Ask the user to start a **new** session in each agent, because settings load at startup. Claude
   Code usually hot-reloads user settings into the running session, but new sessions are the reliable
   test.
2. Re-run the scanner and compare goal statuses with the first run. Once hardened, the config audit
   has to run from the user's own terminal (see Phase 1).
3. Re-run `--probe` from inside Claude Code (your Bash tool). For Antigravity, ask the user to have
   an Antigravity agent run the same command with `--probe`. That measures its sandbox, not yours.
4. Smoke-test the toolchain from a project in the code folder: `git status`, `node -v`, `python3 -V`,
   and the project's usual build or test command. If something breaks, find the path it needs, add
   that one path to `allowRead` (Claude) or a scoped grant (Antigravity), and re-test.

Report what changed, what was verified, and what is still open, with each open item owned by the
user or by a later session.

## Standalone use

The scanner also runs outside an agent (`--home` points it at another home folder; `--skip
claude,desktop,antigravity,ide,agy,gemini,macos` drops sections). Run from a normal terminal, the
probe shows what an unsandboxed process can read, which is a useful before/after contrast.
