# Claude Code and Claude Desktop hardening reference

Sources: code.claude.com/docs/en/settings, /settings-reference, /sandboxing, /permissions,
/managed-settings, /managed-mcp, /security, /desktop (read 2026-11). Items marked **[verify]** were
not confirmed in the docs. Check them with `/status` (the "Setting sources" line) or `claude doctor`.

## Contents
1. Two enforcement layers
2. Where settings live, and precedence
3. Recommended user settings
4. Key reference
5. Managed settings (tamper-resistant)
6. MCP servers, hooks, plugins
7. Claude desktop app
8. Troubleshooting a hardened setup

## 1. Two enforcement layers

| Layer | Covers | Controlled by | Enforced by |
|---|---|---|---|
| Bash sandbox | Every shell command Claude runs, and its children | `sandbox.*` | macOS Seatbelt / Linux bubblewrap (OS level) |
| Built-in tools | Read, Grep, Glob, Edit, Write, WebFetch, MCP tools | `permissions.*` | Claude Code itself (in-process) |

The sandbox does **not** cover the built-in file tools. Read/Edit deny rules also apply to commands
Claude Code recognises (`cat`, `head`, `tail`, `sed`, `tee`, redirections). They do not apply to
`grep -r` from a parent folder or to a script that opens files itself. Only the sandbox stops those,
so you need both layers.

Read scope defaults:
- **Sandbox:** the whole machine is readable except `filesystem.denyRead`. The docs say `~/.ssh` and
  `~/.aws/credentials` stay readable unless denied.
- **File tools:** reading needs no approval anywhere unless `permissions.deny` or
  `permissions.blockReadsOutsideWorkingDirectories` (v2.1.257+) says otherwise.

Write scope defaults:
- **Sandbox:** the working directory, `--add-dir` / `additionalDirectories`, and `$TMPDIR`.
- **File tools:** edits ask, depending on mode. `permissions.blockWritesOutsideWorkingDirectories`
  arrived in v2.1.314.

## 2. Where settings live, and precedence

Highest first:
1. **Managed:** `/Library/Application Support/ClaudeCode/managed-settings.json`, plus
   `managed-settings.d/*.json` merged alphabetically. Linux uses `/etc/claude-code/`. The MDM domain
   is `com.anthropic.claudecode`.
2. CLI `--settings`
3. Project local: `<repo>/.claude/settings.local.json`
4. Project shared: `<repo>/.claude/settings.json`
5. User: `~/.claude/settings.json` (moves if `CLAUDE_CONFIG_DIR` is set)

Notes:
- List settings such as `permissions.allow` and `deny` merge across files. Deny beats ask beats allow.
- **A repository's settings outrank yours.** A cloned repo with `"sandbox": {"enabled": false}` in
  `.claude/settings.json` turns the sandbox off for that project.
- Repo files can't set `defaultMode` to `auto` or `bypassPermissions`. Their allow rules and
  `additionalDirectories` wait until you trust the folder. Deny and ask rules apply immediately.
- `~/.claude.json` holds MCP servers (global and per-project), project trust decisions and history.
- The desktop app's Code tab reads the same `~/.claude/settings.json` and bundles its own Claude
  Code build under `~/Library/Application Support/Claude/claude-code/<version>/`. That build can be
  a different version from the `claude` on your PATH, and version-gated keys depend on it.

## 3. Recommended user settings (`~/.claude/settings.json`)

The scanner's `--propose-dir` writes a version tailored to the machine: it merges with existing
keys, lists only toolchain folders that exist, and denies only credential paths that exist. The
shape:

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "filesystem": {
      "denyRead": ["~/"],
      "allowRead": ["~/Code", "~/.gitconfig", "~/.config/git", "~/.npm", "~/.nvm", "~/.cargo/bin",
                    "~/Library/Caches/pip", "~/Library/Caches/Homebrew", "~/.claude/skills",
                    "~/.claude/plugins", "~/.claude/shell-snapshots"]
    }
  },
  "permissions": {
    "disableBypassPermissionsMode": "disable",
    "blockReadsOutsideWorkingDirectories": true,
    "deny": [
      "Read(~/.ssh/**)", "Edit(~/.ssh/**)",
      "Read(~/.aws/**)", "Read(~/.config/gcloud/**)", "Read(~/.gnupg/**)", "Read(~/.netrc)",
      "Read(~/Documents/**)", "Read(~/Desktop/**)", "Read(~/Downloads/**)",
      "Edit(~/.gemini/config/config.json)", "Edit(~/.zshrc)", "Edit(~/Library/LaunchAgents/**)"
    ]
  }
}
```

Why each piece matters:
- `denyRead: ["~/"]` + `allowRead` inverts the sandbox from a denylist to an allowlist.
  - **`allowRead` takes precedence over `denyRead`** for everything under it. A broad allow such as
    `~/Library/Caches` (which holds browser caches) or `~/.cargo` (which holds
    `credentials.toml`) silently re-opens what it contains, and a narrower `denyRead` can't close it
    again. Allow the specific tool folders instead (`~/Library/Caches/pip`, `~/.cargo/bin`). The
    scanner never proposes an allow entry that contains a known credential.
  - In **user** settings, write explicit `~/...` paths. `.` would resolve to `~/.claude`.
  - Keep `~/.claude/shell-snapshots` readable. Sandboxed Bash sources your shell snapshot from there.
- `allowUnsandboxedCommands: false` removes the `dangerouslyDisableSandbox` retry path.
- `failIfUnavailable: true` makes Claude Code exit instead of silently running unsandboxed.
- `disableBypassPermissionsMode: "disable"` means one flag or toggle can't remove every approval.
- `blockReadsOutsideWorkingDirectories` bounds the in-process file tools (v2.1.257+). Leave the deny
  rules in as a second layer: they also catch `cat ~/.ssh/id_ed25519` in Bash.
- Absolute paths in permission rules need `//` (`Read(//opt/secrets/**)`). A **single** leading `/`
  is relative to the settings file's folder. That is a common mistake, and the rule then protects
  nothing.

Optional, decide with the user:
- `Read(**/.env*)` denies: agents in `~/Code` can otherwise read every project's secrets.
- `sandbox.network.allowedDomains`: an explicit list (registry.npmjs.org, pypi.org,
  files.pythonhosted.org, github.com, ...) tightens exfiltration control further.
- `permissions.additionalDirectories: ["~/Code"]` lets one session read and write sibling repos.
  That is convenient but widens write scope. Prefer `--add-dir` per session.

## 4. Key reference

| Key | Values / default | Secure value | Notes |
|---|---|---|---|
| `sandbox.enabled` | default off | `true` | |
| `sandbox.allowUnsandboxedCommands` | retry allowed when unset **[verify]** | `false` | |
| `sandbox.failIfUnavailable` | false when unset **[verify]** | `true` | |
| `sandbox.autoAllowBashIfSandboxed` | | your choice | Fine once the sandbox is strict |
| `sandbox.excludedCommands` | `[]` | empty | Listed commands run fully unsandboxed |
| `sandbox.filesystem.denyRead` / `allowRead` | | `["~/"]` / code + specific toolchain folders | `allowRead` beats `denyRead` |
| `sandbox.credentials.files` | `[{path, mode: "deny"}]` | credential files | Extra read block inside the sandbox (`mask` degrades to `deny` on macOS) |
| `sandbox.filesystem.allowWrite` / `denyWrite` | | caches only | Never `~` |
| `sandbox.network.allowedDomains` | `[]` = prompt | specific hosts | `"*"` defeats it |
| `sandbox.network.allowUnixSockets` / `allowAllUnixSockets` | | none | `docker.sock` = full escape |
| `sandbox.enableWeakerNestedSandbox` | | `false` | Containers only |
| `permissions.defaultMode` | default, acceptEdits, plan, auto, dontAsk, bypassPermissions | not `bypassPermissions` | In bypass mode non-allowlisted hosts connect without a prompt |
| `permissions.disableBypassPermissionsMode` | | `"disable"` | |
| `permissions.blockReadsOutsideWorkingDirectories` | v2.1.257+ | `true` | Also: a shell command naming a path outside the working dirs is asked about, and the sandbox denies such reads. Start a session at `~/Code` to work across repos |
| `permissions.blockWritesOutsideWorkingDirectories` | v2.1.314+ | `true` | |
| `permissions.additionalDirectories` | | inside code folder only | |
| `skipDangerousModePermissionPrompt` | | absent | |
| `enableAllProjectMcpServers` | | absent | Repos could start arbitrary servers |
| `enabledMcpjsonServers` / `disabledMcpjsonServers` | | | `disabled` applies even in untrusted folders |
| `allowedMcpServers` / `deniedMcpServers` | unset = all allowed | | Match by `serverUrl` / `serverCommand`, not `serverName` |
| `env` | | no secrets | Injected into every subprocess |
| `hooks` | | reviewed | Run outside the sandbox |
| `apiKeyHelper`, `otelHeadersHelper` | | scripts agents can't write | They execute commands |

Managed-only keys: `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`,
`allowManagedMcpServersOnly`, `strictKnownMarketplaces`, `sandbox.filesystem.allowManagedReadPathsOnly`,
`sandbox.network.allowManagedDomainsOnly`.

## 5. Managed settings (tamper-resistant)

User settings can be edited by anything running as the user. That includes another agent: an
Antigravity agent with non-workspace write access could loosen Claude's settings. Root-owned managed
settings can't be changed without `sudo`, and repos can't override them. The user installs them
themselves:

```bash
sudo mkdir -p "/Library/Application Support/ClaudeCode"
```

```bash
sudo cp ~/hardened-claude-settings.json "/Library/Application Support/ClaudeCode/managed-settings.json"
```

```bash
sudo chown root:wheel "/Library/Application Support/ClaudeCode/managed-settings.json" && sudo chmod 644 "/Library/Application Support/ClaudeCode/managed-settings.json"
```

Put only the security keys in the managed file (sandbox, permission deny rules,
`disableBypassPermissionsMode`). Leave personal preferences in user settings. Adding
`allowManagedPermissionRulesOnly: true` stops user and project allow rules from adding approvals.
That is very strict, so offer it rather than default to it.

## 6. MCP servers, hooks, plugins

- **MCP servers run as ordinary processes with your permissions, outside the sandbox.** Review
  `~/.claude.json` (`mcpServers` and `projects.*.mcpServers`), every repo's `.mcp.json`, and the
  desktop app's `claude_desktop_config.json`.
- Flag inline secrets in `env`, `headers` or args, filesystem servers rooted outside the code folder,
  and launchers that pipe `curl` into a shell.
- `managed-mcp.json` with `{"mcpServers": {}}` disables MCP except for admin-controlled servers.
- Hooks (user or repo) run shell commands on lifecycle events, outside the sandbox. Read every
  command. Repo hooks run once you trust the folder.
- Plugins can bundle hooks, MCP servers and skills. Review what each enabled plugin installs.
  `strictKnownMarketplaces` (managed) pins marketplace sources.

## 7. Claude desktop app

- MCP servers and desktop extensions: `~/Library/Application Support/Claude/claude_desktop_config.json`
  and `.../Claude Extensions/`. They run unsandboxed.
- Code-tab permission modes match the CLI. Bypass mode is a toggle under Settings > Claude Code for
  Pro, Max and Ultra plans; Team and Enterprise control it by policy.
- The scanner reads some **undocumented** preference keys from `claude_desktop_config.json`
  (`bypassPermissionsGateByAccount`, `ccRemoteControlDefaultEnabled`, scheduled-task flags,
  `launchPreviewPrivateNetworkTrustedOrigins`, `folderTccProbeResults`). Treat those findings as
  observations and confirm in the app's Settings.
- Remote Control lets claude.ai or the mobile app drive sessions on this Mac. Turn it off if unused,
  and keep 2-step verification on the account.
- `folderTccProbeResults` shows whether Claude.app holds the macOS Desktop/Documents/Downloads
  permission. Processes the app launches inherit it. See `macos_os_layer.md`.

## 8. Troubleshooting a hardened setup

| Symptom | Likely cause | Narrow fix |
|---|---|---|
| `Operation not permitted` reading a file under `~` | Not in `allowRead` | Add that tool's folder (e.g. `~/.pyenv`) |
| Commands lose PATH/aliases | Shell snapshot unreadable | Keep `~/.claude/shell-snapshots` in `allowRead` |
| A personal skill no longer loads its references | `blockReadsOutsideWorkingDirectories` | Keep skills inside the project (`.claude/skills`) or add `--add-dir ~/.claude/skills` |
| `git push` fails on credentials | Credential helper reads a denied file | Use the macOS Keychain helper (`git config --global credential.helper osxkeychain`) |
| Package install can't reach the registry | Network allowlist | Approve the domain when prompted, or add it to `allowedDomains` |
| Can't bind a dev-server port | Local binding off | `sandbox.network.allowLocalBinding: true` |
| Session refuses to start | `failIfUnavailable` and the sandbox can't start | Fix the sandbox (`claude doctor`). Don't remove the flag |
