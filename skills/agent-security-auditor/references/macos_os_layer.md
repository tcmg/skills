# macOS layer: what holds when agent settings fail

Agent settings are enforced by the agent, or by a sandbox the agent sets up. The OS layer below them
still holds if an agent has a bug, a setting is reset by an update, or an MCP server or hook runs
outside every sandbox. These checks are mostly manual: reading the privacy database needs Full Disk
Access, and changing it is the user's decision. **Never change these settings for the user. Give the
click path.**

## 1. Privacy grants (TCC) are inherited

macOS checks folder and data access per *responsible app*. Processes launched by Claude.app, by
Antigravity, or by a terminal app inherit that app's grants. If Claude.app holds "Documents Folder",
an unsandboxed process launched from it can read `~/Documents` too. Examples are an MCP server, a
hook, or a command excluded from the sandbox.

Review System Settings > Privacy & Security for **Claude**, **Antigravity**, **Antigravity IDE**,
**Terminal / iTerm / Ghostty / Warp** and any editor that runs agents:

| Pane | What it grants | Recommendation |
|---|---|---|
| Full Disk Access | Mail, Messages, Safari, Time Machine, other apps' data | Off for every agent host and terminal |
| Files and Folders | Desktop, Documents, Downloads, iCloud Drive, network/removable volumes | Off; grant briefly when needed |
| Accessibility | Control other apps (clicks, keystrokes) | Only while using computer-use features |
| Screen & System Audio Recording | See anything on screen | Only while in use |
| Automation | Script other apps via Apple Events | Review; revoke unknown pairs |
| Photos / Contacts / Calendars / Reminders | Personal databases | Off |

If the code folder lives inside Documents or Desktop (common with iCloud "Desktop & Documents"
sync), agents need that grant. Moving code to `~/Code` (outside synced folders) lets the grant stay
off.

Command-line inspection, which needs Full Disk Access for the terminal running it, so the user runs
it themselves:

```bash
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select service, client, auth_value from access where auth_value=2"
```

`tccutil reset <Service> <bundle-id>` revokes a grant (e.g. `tccutil reset SystemPolicyDocumentsFolder com.anthropic.claudefordesktop`).
This too is the user's command to run.

## 2. Disk encryption and integrity

- **FileVault** (`fdesetup status`) protects files at rest if the Mac is lost. Turn it on in
  System Settings > Privacy & Security > FileVault.
- **SIP** (`csrutil status`) protects TCC and the OS itself. It should say "enabled".

## 3. Credential hygiene that reduces blast radius

- Prefer Keychain-backed helpers to plaintext files:
  - `git config --global credential.helper osxkeychain`
  - Docker: `"credsStore": "osxkeychain"`
  - gh, gcloud and op already use the Keychain or their own encrypted stores.
- SSH keys: passphrase-protected, `~/.ssh` mode 700, private keys 600. Use `ssh-add --apple-use-keychain`.
- Don't point agents at `SSH_AUTH_SOCK` or the Docker socket. Both let a sandboxed command act as you.
- Plaintext files to minimise: `~/.netrc`, `~/.git-credentials`, `~/.npmrc` / `~/.pypirc` with
  tokens, `.env` files, and agent OAuth tokens (`~/.gemini/oauth_creds.json`).

## 4. Stronger isolation options

When "completely secure" really has to mean completely, configuration isn't enough on its own:

| Option | Effort | What it buys |
|---|---|---|
| Separate macOS user account for agent work, with only `~/Code` in it | Low-medium | macOS file permissions keep agents out of your real home entirely |
| Dev container or VM (Docker, OrbStack, UTM, Lima) with only the repo mounted | Medium | Nothing outside the mount exists for the agent |
| Claude cloud sessions / remote dev environments | Low | Agents never touch the laptop |

Recommend these for untrusted repos, autonomous or unattended runs, or anyone handling client data.
