# Google Antigravity hardening reference

Sources: antigravity.google/docs (permissions, sandbox, agent-settings, settings, browser,
ide/allowlist-denylist, remote-control, mcp, sidecars, hooks, enterprise, changelog). Append `.md` to
any docs URL to get raw markdown. Research read 2026-11.

Field names and enum numbers for `~/.gemini/config/config.json` were recovered from the protobuf
descriptors embedded in Antigravity 2.34 (`language_server`). The docs don't publish them.
**Confirm any change in the app's Settings after relaunching.**

## Contents
1. Surfaces and where they store settings
2. Permission presets (what actually decides sandboxing)
3. Permission rules (grants)
4. The terminal sandbox
5. Settings keys in config.json
6. Legacy IDE state (state.vscdb)
7. agy CLI
8. Browser, MCP, plugins, hooks, automations, remote control
9. Known incidents
10. Recommended configuration

## 1. Surfaces and where they store settings

| Surface | App / binary | Data | Settings |
|---|---|---|---|
| Antigravity app (2.x, Electron) | `/Applications/Antigravity.app` (`com.google.antigravity`) | `~/.gemini/antigravity/` | `~/.gemini/config/config.json` (`userSettings`), `~/.gemini/config/projects/<uuid>.json` |
| Antigravity IDE (VS Code fork) | `/Applications/Antigravity IDE.app` | `~/.gemini/antigravity-ide/` | `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb` (protobuf blobs) |
| agy CLI | `agy` | `~/.gemini/antigravity-cli/` | `~/.gemini/antigravity-cli/settings.json` (only non-default values are written) |
| Gemini CLI (separate product) | `gemini` | `~/.gemini/` | `~/.gemini/settings.json`, `~/.gemini/trustedFolders.json` |

Before the IDE was renamed, the v1 IDE stored state under `~/Library/Application Support/Antigravity/`.
Data left there is stale, but it can still hold a sign-in token.

Shared files and folders:

| Path | Contents |
|---|---|
| `~/.gemini/config/mcp_config.json` | MCP servers (`~/.gemini/antigravity/mcp_config.json` is often a symlink to it) |
| `~/.gemini/config/hooks.json` | Hooks |
| `~/.gemini/config/plugins/` | Plugins |
| `~/.gemini/config/sidecars/*/sidecar.json` | Automations |
| `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/rules/` | Global instructions |
| `~/.gemini/antigravity/mcp_oauth_tokens.json` | MCP OAuth tokens |

Personal accounts use the **"Updated"** permission system. Business and enterprise accounts use the
**"Previous"** one, with separate toggles for terminal auto-execution, sandbox and outside-folder
access.

## 2. Permission presets

Set in Settings > General > Global Permissions; projects can override. Key:
`userSettings.permissionPreset`.

| Preset | Enum | Sandbox | Behaviour | Verdict |
|---|---|---|---|---|
| Request Review | `AGENT_PERMISSION_PRESET_REQUEST_REVIEW` (2) | off | Every command asks; approved ones run with full user rights | OK, but no OS containment |
| **Default** | `AGENT_PERMISSION_PRESET_DEFAULT` (1) | **on** | Commands run in the sandbox; anything outside asks; workspace + temp dirs | **Recommended** |
| Auto | `AGENT_PERMISSION_PRESET_AUTO` (6) | on | The model decides which out-of-sandbox commands run unasked | Avoid for sensitive work |
| Turbo | `AGENT_PERMISSION_PRESET_TURBO` (3) | **off** | No sandbox, full filesystem, MCP and web allowed | Never outside a disposable VM |

Other values: `UNSPECIFIED` (0) means the app default (currently Default), `VETTED` (4), `NONE` (5).
Default falls back to Request Review when the sandbox is unavailable. Since v2.30 the message-box
picker changes the mode per conversation, so the global preset is the baseline, not a ceiling.

Plan/artifact review (`artifactReviewMode`, per project): `ARTIFACT_REVIEW_MODE_ALWAYS` (1),
`TURBO` (2), `AUTO` (3). Turbo skips your review of the agent's plan.

## 3. Permission rules (grants)

Syntax: `action(target)` in `allow`, `ask` and `deny` lists. Precedence is **Deny > Ask > Allow**.

| Action | Target | Notes |
|---|---|---|
| `read_file(path)` / `write_file(path)` | absolute or workspace-relative path, recursive | write implies read; denying read also denies write |
| `command(prefix)` / `command(regex:...)` | command line | If the line contains shell metacharacters or substitution, only an exact full-line match counts |
| `read_url(domain)` / `execute_url(domain)` / `download_url(domain)` | domain (+ subdomains); `localhost` matched per port | |
| `mcp(server/tool)` / `mcp(server/*)` | | never `mcp(*)` |
| `unsandboxed(...)` | | business accounts only; personal accounts ignore it |

Defaults: workspace files allowed. Non-workspace files, web and MCP all ask.

**Grants widen the sandbox.** Allowed `read_file` paths become read-only sandbox mounts, `write_file`
paths become read-write mounts, and `read_url` domains join the sandbox network allowlist. Audit
every remembered grant: approving a dialog once can permanently expose a path to sandboxed commands.

Where grants live:
- Global: `userSettings.globalPermissionGrants {allow, deny, ask}` in `config.json`.
- Per project: `permissionGrants` in `projects/<uuid>.json`.
- IDE: the `permission_grants_global` entry in `state.vscdb`.
- CLI: `permissions` in the CLI's `settings.json`.

## 4. The terminal sandbox

- macOS uses `sandbox-exec` with a generated Seatbelt profile (`(deny default)` plus explicit
  mounts). The profile is an **allowlist**: the project is read-write, temp and build caches are
  writable, and `/usr` and `/etc` are readable. `~/.ssh`, `.env`, `~/Library/Application Support`,
  `~/.docker`, `~/.kube` and most of `~/.config` are blocked. Anything not mounted is invisible.
- There is no network by default, apart from `read_url`-granted domains.
- Hardening has improved release by release (CLI 1.1 to 1.5), so older builds exposed more.
  **Test empirically:** ask an Antigravity agent to run the scanner with `--probe`.
- The sandbox covers terminal commands only. The agent's own file tools are governed by grants and
  the non-workspace policy. MCP servers, hooks, plugins and automations run as host processes.

## 5. Settings keys in config.json (`userSettings`, protojson names)

| JSON key | Type / values | Secure value |
|---|---|---|
| `permissionPreset` | enum, see section 2 | `AGENT_PERMISSION_PRESET_DEFAULT` |
| `globalPermissionGrants` | `{allow:[], deny:[], ask:[]}` | denies for credentials and personal folders; no wildcards |
| `enableTerminalSandbox` | bool ("Previous" system / IDE / CLI) | `true` |
| `sandboxAllowNetwork` | bool | `false` |
| `autoExecutionPolicy` | `CASCADE_COMMANDS_AUTO_EXECUTION_` + `OFF`(1) / `AUTO`(2) / `EAGER`(3, "Turbo") / `PROCEED_IN_SANDBOX`(4) | `PROCEED_IN_SANDBOX` or `OFF` |
| `nonWorkspaceFileAccessPolicy` | `AGENT_SETTING_POLICY_` + `ALLOW`(1) / `ASK`(2) / `DENY`(3) | `DENY` |
| `allowAgentAccessNonWorkspaceFiles` | bool (older switch) | `false` |
| `allowAgentAccessGitignoreFiles` | bool | `false` |
| `internetAccessPolicy` | `AGENT_SETTING_POLICY_*` | `ASK` |
| `browserJsExecutionPolicy` | `BROWSER_JS_EXECUTION_POLICY_` + `DISABLED`(1) / `ALWAYS_ASK`(2) / `MODEL_DECIDES`(3) / `TURBO`(4) | `DISABLED` or `ALWAYS_ASK` |
| `secureModeEnabled` | bool, "Strict mode" | `true` for maximum lock-down |
| `remoteControlEnabled` / `remoteControlHostname` | bool / string | `false` unless used |
| `enableAdc` | bool: agents use gcloud Application Default Credentials | `false` |
| `shellSetupScript` | string, runs before agent commands | empty, or a file agents can't write |
| `sandboxProxy` | `{http:{address,certFile,username,password}}` | no inline password |
| `permissionGrantsV2Migrated`, `sandboxEnabledAtV2Migration` | migration markers | leave as they are |

Strict mode does the following:
- Sets terminal commands, browser JS and artifact review to Request Review.
- Ignores the terminal allowlist.
- Respects `.gitignore`.
- Blocks access outside the workspace.
- Turns the sandbox on with network denied.

Admin policy (`admin_settings.json`, v2.33+) can lock these settings and cap permissions. The docs
don't publish its path; third parties give `/Library/Application Support/Antigravity/admin_settings.json`.

**Editing config.json:** quit Antigravity first, back the file up, replace it, relaunch, and check
Settings shows the new values. Unknown keys may make the app reject the file. The scanner's
proposals use only keys present in the 2.34 schema.

## 6. Legacy IDE state (state.vscdb)

`ItemTable` keys `antigravityUnifiedStateSync.agentPreferences` and `.browserPreferences` hold
base64 protobuf maps. Each entry is `{1: key, 2: {1: base64(inner)}}`.

| Sentinel key | Decoded value |
|---|---|
| `terminalAutoExecutionPolicySentinelKey` | `CASCADE_COMMANDS_AUTO_EXECUTION_*` (above) |
| `artifactReviewPolicySentinelKey` | review policy |
| `allowAgentAccessNonWorkspaceFilesSentinelKey` | bool |
| `allowCascadeAccessGitignoreFilesSentinelKey` | bool |
| `secureModeSentinelKey` | bool |
| `terminalAllowedCommandsSentinelKey` / `terminalDeniedCommandsSentinelKey` | string lists |
| `permission_grants_global` | `{1: allow[], 2: deny[], 3: ask[]}` |
| `browser_js_execution_config_sentinel_key` | `BROWSER_JS_EXECUTION_POLICY_*` |
| `browser_allowlist_sentinel_key` | hosts |

Change these only through the IDE's Settings UI. Don't write to the database.

`antigravityUnifiedStateSync.oauthToken` and `antigravityAuthStatus` hold sign-in state in a plain
SQLite file. Other agents must not be able to read that folder.

## 7. agy CLI (`~/.gemini/antigravity-cli/settings.json`, mode 0600)

| Key | Values (default) | Secure value |
|---|---|---|
| `agentMode` | `auto` (default since 1.5.7; forces the sandbox on), `""`, `accept-edits`, `plan` | `""` or `accept-edits` |
| `toolPermission` | `request-review` (default), `proceed-in-sandbox`, `strict`, `always-proceed` (same as `--dangerously-skip-permissions`) | `proceed-in-sandbox` or `strict` |
| `enableTerminalSandbox` | false outside auto mode | `true` |
| `allowNonWorkspaceAccess` | false | `false` |
| `trustedWorkspaces` | list | code-folder projects only |
| `permissions` | `{allow, ask, deny}` grants | same rules as section 3 |

`agy remote-control start` installs a LaunchAgent. `agy remote-control stop` removes it.

## 8. Browser, MCP, plugins, hooks, automations, remote control

**Browser**
- Settings > Browser > Browser Actuation Rules: Allow / Ask / Deny lists for execute and download
  URLs. Deny wins even under Turbo.
- Built in: identity-provider and payment hosts are blocked, every upload prompts, and redirects to
  the LAN or cloud metadata are blocked.

**Chrome DevTools plugin / `/browser`**
- It drives **your real Chrome profile and its sign-ins** over remote debugging.
- Use a separate, logged-out profile and turn remote debugging off afterwards.

**Legacy browser allowlist**
- `~/.gemini/antigravity/browserAllowlist.txt` once shipped with `webhook.site`, which was used in a
  published exfiltration attack. Remove that line if the file exists.

**MCP**
- Default is Ask. Never grant `mcp(*)`.
- `env` and `headers` in `mcp_config.json` often hold plaintext secrets.

**Plugins**
- Plugins can bundle hooks, MCP servers and automations. Review each one.

**Hooks**
- Hooks can return `auto_approve` or `permissionOverrides`, which silently widens permissions.
- Repo hooks (`.agents/hooks.json`) are gated by Workspace Trust.

**Automations (sidecars)**
- They run unattended and inherit global grants plus their own `agent_permissions.access_grants`
  and `workspace_uris`.

**Remote control**
- Settings > Application > Enable Remote Control. Anyone signed in to the same Google account can
  then drive agents on this Mac.
- Off unless used. Keep 2-step verification on the account.

**Global instruction files** (`GEMINI.md`, `AGENTS.md`, `config/rules/`)
- A prompt injection that writes these persists across sessions. Deny agents write access to them.

## 9. Known incidents

| Date | Source | What happened | Status |
|---|---|---|---|
| Nov 2025 | PromptArmor | A prompt injection read `.env` with `cat` despite the gitignore setting, then exfiltrated it via the browser to webhook.site | Disclosed |
| Nov 2025 | Embrace The Red | Auto-execute RCE, hidden Unicode instructions, MCP calls without approval, exfiltration via `read_url_content` and markdown images | Acknowledged as known issues |
| Apr 2026 | Pillar Security | `find_by_name` flag injection gave RCE and a sandbox escape even with Secure Mode on | Fixed 2026-02-28 |
| Oct 2026 | Forum report | Unencrypted OAuth refresh token in IDE `state.vscdb` (Linux) | Unconfirmed on macOS |

Google's advice: stay on Default or Request Review, and use Turbo / Always Proceed only in isolated
containers or disposable branches.

## 10. Recommended configuration

**Global settings**
- Preset **Default**, stored explicitly.
- Non-workspace file access **Deny**.
- Deny grants for credentials, personal folders, other agents' config and shell startup files.
- No wildcard allow grants, and no allow grants outside the code folder.

**Browser and network**
- Browser JS **Always ask** or **Disabled**; Chrome DevTools pointed at a separate profile.
- Remote control **off**; `enableAdc` **off**.

**Workspaces and automations**
- Every project's workspace folder is inside `~/Code`.
- No Turbo review on projects.
- Automations scoped to one project.

**Extras**
- Optionally enable Strict mode.
- agy CLI: `proceed-in-sandbox` with `enableTerminalSandbox: true`.
