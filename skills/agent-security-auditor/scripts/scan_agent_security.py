#!/usr/bin/env python3
"""
scan_agent_security.py - read-only security audit of local AI coding-agent setups.

Covers (macOS first-class, Linux partial):
  * Claude Code (CLI + the Claude desktop app's Code tab): user, managed and
    per-repo settings, ~/.claude.json MCP servers and project trust.
  * Claude desktop app: claude_desktop_config.json MCP servers and observed
    security-relevant preferences.
  * Google Antigravity 2.x (~/.gemini/config/config.json, projects, MCP,
    plugins, automations) and the legacy Antigravity IDE (VS Code fork,
    settings stored as protobuf in state.vscdb).
  * Gemini CLI (shares ~/.gemini).
  * macOS layer: FileVault, SIP, TCC folder grants, credential-file modes.

Measured against three goals:
  personal_files  - personal files and credentials are unreadable by agents
  sandbox         - agent shell commands run inside an OS sandbox
  scope           - agents can reach the code folder and little else

Safety properties of this script:
  * Never prints or stores secret values (only key names, modes, booleans).
  * Never modifies any config. It only writes the files you name with
    --output / --markdown / --propose-dir.
  * --probe opens sensitive paths (and immediately closes them, reading zero
    bytes) to test the sandbox of the process that runs it.

Python 3.8+ standard library only.
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import difflib
import json
import os
import platform
import plistlib
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
SENSITIVE_REF = SKILL_DIR / "references" / "sensitive_paths.json"


def _tolerate_sandbox_denials() -> None:
    """Inside a strict sandbox even stat() can fail with EPERM, which pathlib re-raises.

    exists() -> True ("something is there that we may not see"), is_dir()/is_file() -> False.
    """
    def wrap(name: str, on_denied: bool) -> None:
        orig = getattr(Path, name)

        def safe(self, *a, **k):  # type: ignore[no-untyped-def]
            try:
                return orig(self, *a, **k)
            except PermissionError:
                return on_denied
        setattr(Path, name, safe)

    wrap("exists", True)
    wrap("is_dir", False)
    wrap("is_file", False)


_tolerate_sandbox_denials()

SEVERITIES = ["critical", "high", "medium", "low", "unknown", "info", "pass"]
GOALS = {
    "personal_files": "Personal files and credentials stay private",
    "sandbox": "Agent commands run sandboxed",
    "scope": "Agents limited to the code folder",
    "hygiene": "Secrets and configuration hygiene",
}
IS_MAC = sys.platform == "darwin"

# Antigravity enum tables, recovered from the protobuf descriptors embedded in
# Antigravity 2.34 (language_server). Numbers are stable proto enum values.
AG_AUTO_EXEC = {0: "UNSPECIFIED", 1: "OFF", 2: "AUTO", 3: "EAGER", 4: "PROCEED_IN_SANDBOX"}
AG_ARTIFACT_REVIEW = {0: "UNSPECIFIED", 1: "ALWAYS", 2: "TURBO", 3: "AUTO"}
AG_BROWSER_JS = {0: "UNSPECIFIED", 1: "DISABLED", 2: "ALWAYS_ASK", 3: "MODEL_DECIDES", 4: "TURBO"}
AG_POLICY = {0: "UNSPECIFIED", 1: "ALLOW", 2: "ASK", 3: "DENY"}
AG_PRESET = {0: "UNSPECIFIED", 1: "DEFAULT", 2: "REQUEST_REVIEW", 3: "TURBO", 4: "VETTED", 5: "NONE", 6: "AUTO"}

SECRET_NAME_RE = re.compile(
    r"(TOKEN|SECRET|PASSW(OR)?D|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|BEARER|COOKIE|SESSION)",
    re.I,
)
SECRET_VALUE_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}"
    r"|ya29\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})"
)
RISKY_BASH_PREFIXES = [
    "python", "python3", "node", "bash", "sh", "zsh", "ruby", "perl", "php", "deno", "bun", "npx", "uvx",
    "pipx", "curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "osascript", "open", "eval", "sudo", "env",
    "xargs", "find", "docker", "kubectl", "gcloud", "aws", "az", "gh", "security", "cat", "cp", "mv", "rm",
]


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclass
class Finding:
    id: str
    severity: str
    goal: str
    product: str
    title: str
    detail: str = ""
    evidence: str = ""
    fix: str = ""


class Ctx:
    def __init__(self, home: Path, code_dir: Path, sensitive: Dict[str, Any]):
        self.home = home
        self.code = code_dir
        self.sensitive = sensitive
        self.findings: List[Finding] = []
        self.inventory: Dict[str, Any] = {}
        self.errors: List[str] = []
        # Raw parsed config needed for proposals (never emitted verbatim).
        self.raw: Dict[str, Any] = {}

    def add(self, id: str, severity: str, goal: str, product: str, title: str, detail: str = "",
            evidence: str = "", fix: str = "") -> None:
        self.findings.append(Finding(id, severity, goal, product, title, detail, evidence, fix))

    # path helpers -----------------------------------------------------------
    def t(self, p: Any) -> str:
        """Display a path with ~ for home."""
        s = str(p)
        h = str(self.home)
        if s == h:
            return "~"
        if s.startswith(h + os.sep):
            return "~" + s[len(h):]
        return s

    def exp(self, p: str, base: Optional[Path] = None) -> Path:
        """Expand ~, //abs, ./rel and plain paths (relative to base when given); symlinks resolved."""
        p = p.strip()
        if p in ("~", "~/"):
            return self.home
        if p.startswith("~/"):
            return real(self.home / p[2:])
        if p.startswith("//"):
            return real(Path("/" + p.lstrip("/")))
        if p.startswith("/"):
            return real(Path(p))
        if base is not None:
            return real(base / p) if p not in (".", "./") else base
        return Path(p)

    def sensitive_paths(self, *cats: str) -> List[Tuple[str, Path]]:
        out = []
        for c in cats:
            for raw in self.sensitive.get(c, []):
                p = self.exp(raw)
                if p.exists():
                    out.append((c, p))
        return out


# --------------------------------------------------------------------------- #
# Generic helpers
# --------------------------------------------------------------------------- #
def strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments and trailing commas outside strings."""
    out, i, n, in_str, esc = [], 0, len(text), False, False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j == -1 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def read_json(path: Path) -> Tuple[Optional[Any], Optional[str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, None
    except PermissionError:
        return None, "permission denied (possibly blocked by a sandbox - which is good)"
    except OSError as e:
        return None, str(e)
    if not text.strip():
        return {}, None
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        try:
            return json.loads(strip_jsonc(text)), None
        except json.JSONDecodeError as e:
            return None, f"invalid JSON: {e}"


def real(p: Path) -> Path:
    """Resolve symlinks (e.g. /tmp -> /private/tmp) without requiring the path to exist."""
    try:
        return Path(os.path.realpath(str(p)))
    except (OSError, ValueError):
        return Path(os.path.normpath(str(p)))


def is_under(child: Path, parent: Path) -> bool:
    try:
        c = str(real(child))
        p = str(real(parent))
    except Exception:
        return False
    if IS_MAC:  # default APFS volumes are case-insensitive
        c, p = c.lower(), p.lower()
    return c == p or c.startswith(p.rstrip(os.sep) + os.sep)


def strip_glob(p: str) -> str:
    """'~/.ssh/**' -> '~/.ssh'; '~/Library/X/*' -> '~/Library/X'."""
    p = p.strip()
    while True:
        new = re.sub(r"(/\*\*|/\*|\*\*|\*)$", "", p)
        if new == p:
            break
        p = new
    return p or "/"


def mode_str(path: Path) -> Optional[str]:
    try:
        return oct(stat.S_IMODE(path.stat().st_mode))
    except OSError:
        return None


def group_or_world_readable(path: Path) -> bool:
    try:
        return bool(stat.S_IMODE(path.stat().st_mode) & (stat.S_IRGRP | stat.S_IROTH))
    except OSError:
        return False


def run(cmd: List[str], timeout: int = 8) -> Optional[str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr or "").strip()
    except Exception:
        return None


def parse_version(s: Optional[str]) -> Optional[Tuple[int, ...]]:
    if not s:
        return None
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", s)
    return tuple(int(x) for x in m.groups()) if m else None


def vstr(v: Optional[Tuple[int, ...]]) -> str:
    return ".".join(map(str, v)) if v else "unknown"


def secret_env_names(env: Any) -> List[str]:
    if not isinstance(env, dict):
        return []
    return sorted(k for k, v in env.items() if SECRET_NAME_RE.search(k) and isinstance(v, str) and v and not v.startswith("${"))


def secret_like_args(args: Any) -> List[int]:
    if not isinstance(args, list):
        return []
    return [i for i, a in enumerate(args) if isinstance(a, str) and SECRET_VALUE_RE.search(a)]


def deep_merge(base: Dict[str, Any], over: Dict[str, Any]) -> Dict[str, Any]:
    """Merge `over` onto `base`; dicts recurse, lists union, scalars override."""
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        elif isinstance(v, list) and isinstance(out.get(k), list):
            out[k] = out[k] + [x for x in v if x not in out[k]]
        else:
            out[k] = copy.deepcopy(v)
    return out


def plist_version(app: Path) -> Optional[str]:
    try:
        with open(app / "Contents" / "Info.plist", "rb") as f:
            return plistlib.load(f).get("CFBundleShortVersionString")
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# MCP server analysis (shared by Claude Code, Claude desktop, Antigravity, Gemini CLI)
# --------------------------------------------------------------------------- #
FS_SERVER_HINTS = ("server-filesystem", "mcp-filesystem", "filesystem-mcp", "desktop-commander", "mcp-server-commands")


def analyze_mcp_servers(ctx: Ctx, servers: Any, product: str, source: str) -> List[Dict[str, Any]]:
    inv = []
    if not isinstance(servers, dict):
        return inv
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        cmd = cfg.get("command") or ""
        args = cfg.get("args") or []
        url = cfg.get("url") or cfg.get("serverUrl") or cfg.get("httpUrl") or ""
        kind = cfg.get("type") or ("http" if url else "stdio")
        disabled = bool(cfg.get("disabled"))
        entry = {"name": name, "type": kind, "command": os.path.basename(str(cmd)) if cmd else "", "url_host": "",
                 "disabled": disabled, "source": source}
        if url:
            m = re.match(r"https?://([^/]+)", str(url))
            entry["url_host"] = m.group(1) if m else ""
        inv.append(entry)
        ev = f"{source} -> mcpServers.{name}"
        names = secret_env_names(cfg.get("env"))
        hdrs = secret_env_names(cfg.get("headers"))
        idx = secret_like_args(args)
        if names or hdrs or idx or (url and SECRET_VALUE_RE.search(str(url))):
            parts = []
            if names:
                parts.append("env: " + ", ".join(names))
            if hdrs:
                parts.append("headers: " + ", ".join(hdrs))
            if idx:
                parts.append("args at positions " + ", ".join(map(str, idx)))
            if url and SECRET_VALUE_RE.search(str(url)):
                parts.append("token embedded in URL")
            ctx.add("MCP-INLINE-SECRET", "medium", "hygiene", product,
                    f"MCP server '{name}' stores a credential in plain text",
                    "Plain-text credentials in agent config are readable by any agent or tool that can read the file, "
                    "and get copied into backups and dotfile repos. (" + "; ".join(parts) + ")",
                    ev, "Move the secret to the macOS Keychain or an env var set outside agent config, and reference it "
                        "with ${VAR} expansion where the client supports it.")
        joined = " ".join([str(cmd)] + [str(a) for a in args])
        if any(h in joined for h in FS_SERVER_HINTS):
            roots = [a for a in args if isinstance(a, str) and (a.startswith("/") or a.startswith("~"))]
            broad = [r for r in roots if not is_under(ctx.exp(r), ctx.code)]
            if broad:
                sev = "high" if any(ctx.exp(r) in (ctx.home, Path("/")) or is_under(ctx.home, ctx.exp(r)) for r in broad) else "medium"
                ctx.add("MCP-FS-OUTSIDE-CODE", sev, "scope", product,
                        f"Filesystem MCP server '{name}' exposes folders outside {ctx.t(ctx.code)}",
                        "MCP tools run outside every agent sandbox, so this server bypasses sandbox and deny rules. "
                        "Exposed roots: " + ", ".join(ctx.t(ctx.exp(r)) for r in broad),
                        ev, f"Limit the server's root arguments to {ctx.t(ctx.code)} (or a single project).")
            elif not roots:
                ctx.add("MCP-FS-UNSCOPED", "medium", "scope", product,
                        f"Filesystem-style MCP server '{name}' has no explicit root folder",
                        "Servers like this often default to the user's home directory or allow any path.",
                        ev, f"Pass an explicit root such as {ctx.t(ctx.code)}.")
        if re.search(r"(curl|wget)[^|]*\|\s*(ba|z)?sh", joined):
            ctx.add("MCP-PIPE-TO-SHELL", "high", "hygiene", product,
                    f"MCP server '{name}' launches by piping a download into a shell",
                    "Every launch runs whatever the remote URL serves at that moment.", ev,
                    "Install a pinned version of the server and launch the local binary.")
    return inv


# --------------------------------------------------------------------------- #
# Claude Code
# --------------------------------------------------------------------------- #
def claude_versions(ctx: Ctx) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    exe = shutil.which("claude") or (str(ctx.home / ".local/bin/claude") if (ctx.home / ".local/bin/claude").exists() else None)
    if exe:
        out["cli"] = vstr(parse_version(run([exe, "--version"])))
    bundled = ctx.home / "Library/Application Support/Claude/claude-code"
    try:
        vs = sorted((parse_version(p.name) for p in bundled.iterdir() if parse_version(p.name)), reverse=True)
    except OSError:
        vs = []
    if vs:
        out["desktop_app_bundled"] = vstr(vs[0])
    return out


def claude_paths(ctx: Ctx) -> Dict[str, Path]:
    cfg_dir = Path(os.environ["CLAUDE_CONFIG_DIR"]).expanduser() if os.environ.get("CLAUDE_CONFIG_DIR") else ctx.home / ".claude"
    managed_dir = Path("/Library/Application Support/ClaudeCode") if IS_MAC else Path("/etc/claude-code")
    return {
        "dir": cfg_dir,
        "user": cfg_dir / "settings.json",
        "user_local": cfg_dir / "settings.local.json",
        "state": ctx.home / ".claude.json",
        "managed": managed_dir / "managed-settings.json",
        "managed_d": managed_dir / "managed-settings.d",
        "managed_mcp": managed_dir / "managed-mcp.json",
    }


def read_rule_prefix(ctx: Ctx, rule: str, tool: str, settings_dir: Path) -> Optional[Tuple[Path, bool]]:
    """For 'Read(~/x/**)' return (Path('~/x'), single_slash_abs_flag). None if not a path rule for tool."""
    m = re.match(r"^\s*" + tool + r"\((.*)\)\s*$", rule)
    if not m:
        return None
    pat = m.group(1).strip()
    single_slash = pat.startswith("/") and not pat.startswith("//")
    pat = strip_glob(pat)
    if pat.startswith("~") or pat.startswith("//"):
        return ctx.exp(pat), False
    if pat.startswith("/"):
        # Claude Code treats a single leading slash as relative to the settings file's directory.
        return Path(os.path.normpath(str(settings_dir) + pat)), single_slash
    return None  # cwd-relative pattern (applies inside projects only)


def sandbox_read_blocked(path: Path, deny: List[Path], allow: List[Path]) -> bool:
    """Claude Code semantics: allowRead re-opens paths inside denyRead and takes precedence over it."""
    if not any(is_under(path, d) for d in deny):
        return False
    return not any(is_under(path, a) for a in allow)


def evaluate_claude_settings(ctx: Ctx, eff: Dict[str, Any], versions: Dict[str, Optional[str]], src: str,
                             settings_dir: Path, has_managed: bool) -> None:
    P = "claude-code"
    sb = eff.get("sandbox") or {}
    perms = eff.get("permissions") or {}
    mode = perms.get("defaultMode", "default")
    min_v = min((parse_version(v) for v in versions.values() if parse_version(v)), default=None)

    # ---- Sandbox ----------------------------------------------------------
    if sb.get("enabled") is not True:
        ctx.add("CC-SANDBOX-OFF", "critical", "sandbox", P, "Claude Code Bash sandbox is not enabled",
                "Without the sandbox, any shell command Claude runs (or that a prompt injection talks it into) "
                "has your full user permissions: it can read every file you can and reach any host.",
                f"{src}: sandbox.enabled", 'Set "sandbox": {"enabled": true} in ~/.claude/settings.json.')
    else:
        ctx.add("CC-SANDBOX-ON", "pass", "sandbox", P, "Claude Code Bash sandbox is enabled", evidence=f"{src}: sandbox.enabled")
        if sb.get("allowUnsandboxedCommands") is not False:
            sev = "high" if mode in ("bypassPermissions", "auto", "dontAsk") else "medium"
            ctx.add("CC-SANDBOX-ESCAPE-HATCH", sev, "sandbox", P,
                    "Claude can retry commands outside the sandbox",
                    "With allowUnsandboxedCommands unset/true, a command that fails in the sandbox can be re-run with "
                    "dangerouslyDisableSandbox. In permissive modes that retry may not need your approval.",
                    f"{src}: sandbox.allowUnsandboxedCommands", 'Set "sandbox.allowUnsandboxedCommands": false.')
        else:
            ctx.add("CC-SANDBOX-NO-ESCAPE", "pass", "sandbox", P, "Unsandboxed retries are disabled",
                    evidence=f"{src}: sandbox.allowUnsandboxedCommands=false")
        if sb.get("failIfUnavailable") is not True:
            ctx.add("CC-SANDBOX-FAIL-OPEN", "low", "sandbox", P,
                    "Claude Code silently runs unsandboxed if the sandbox cannot start",
                    "If Seatbelt/bubblewrap is unavailable, sessions continue without OS isolation.",
                    f"{src}: sandbox.failIfUnavailable", 'Set "sandbox.failIfUnavailable": true.')
        exc = sb.get("excludedCommands") or []
        if exc:
            ctx.add("CC-SANDBOX-EXCLUDED", "medium", "sandbox", P,
                    f"{len(exc)} command pattern(s) bypass the sandbox entirely",
                    "Excluded commands run with full user access: " + ", ".join(map(str, exc[:10])),
                    f"{src}: sandbox.excludedCommands",
                    "Remove entries you do not strictly need; prefer allowing specific paths/domains instead.")
        if sb.get("enableWeakerNestedSandbox"):
            ctx.add("CC-SANDBOX-WEAK-NESTED", "medium", "sandbox", P, "Weaker nested sandbox mode is enabled",
                    "This mode trades isolation for compatibility inside containers.", f"{src}: sandbox.enableWeakerNestedSandbox",
                    "Only enable inside an already-isolated container.")
        net = sb.get("network") or {}
        if net.get("allowAllUnixSockets"):
            ctx.add("CC-SANDBOX-ALL-SOCKETS", "high", "sandbox", P, "Sandbox allows all Unix sockets",
                    "Local sockets (Docker, SSH agent, other agents' daemons) are sandbox escape routes.",
                    f"{src}: sandbox.network.allowAllUnixSockets", "Remove it and list only the sockets you need.")
        for s in net.get("allowUnixSockets") or []:
            if "docker" in str(s) or "ssh-agent" in str(s) or "agent.sock" in str(s):
                ctx.add("CC-SANDBOX-ESCAPE-SOCKET", "high", "sandbox", P, f"Sandbox allows socket {s}",
                        "Docker's socket lets a command start a container that mounts / - a full sandbox escape. "
                        "An SSH agent socket lets commands use your SSH keys.",
                        f"{src}: sandbox.network.allowUnixSockets", "Remove this socket from the allowlist.")
        doms = net.get("allowedDomains") or []
        if any(d in ("*", "*.*") for d in doms):
            ctx.add("CC-SANDBOX-NET-ANY", "medium", "sandbox", P, "Sandbox network allowlist permits any domain",
                    "A wildcard allowlist removes the exfiltration barrier.", f"{src}: sandbox.network.allowedDomains",
                    "List specific domains (registry.npmjs.org, pypi.org, github.com ...).")
        if mode == "bypassPermissions":
            ctx.add("CC-SANDBOX-NET-BYPASS", "high", "sandbox", P, "bypassPermissions mode skips network prompts",
                    "In bypassPermissions mode, hosts not on the sandbox allowlist are allowed without asking.",
                    f"{src}: permissions.defaultMode", "Use default, acceptEdits or auto mode instead.")
        fs = sb.get("filesystem") or {}
        for w in fs.get("allowWrite") or []:
            wp = ctx.exp(strip_glob(str(w)), settings_dir)
            if wp in (Path("/"), ctx.home) or is_under(ctx.home, wp):
                ctx.add("CC-SANDBOX-WRITE-HOME", "high", "scope", P, f"Sandbox allows writes to {ctx.t(wp)}",
                        "Sandboxed commands could modify shell startup files, agent configs or personal files.",
                        f"{src}: sandbox.filesystem.allowWrite", "Narrow allowWrite to tool caches you actually need.")

        # Read coverage of sensitive paths for sandboxed Bash.
        deny = [ctx.exp(strip_glob(str(d)), settings_dir) for d in (fs.get("denyRead") or [])]
        allow = [ctx.exp(strip_glob(str(a)), settings_dir) for a in (fs.get("allowRead") or [])]
        exposed = [(c, p) for c, p in ctx.sensitive_paths("credentials", "agent_secrets", "personal", "browsers_and_password_managers")
                   if not sandbox_read_blocked(p, deny, allow)]
        home_denied = sandbox_read_blocked(ctx.home / ".__probe__", deny, allow)
        if home_denied:
            ctx.add("CC-SANDBOX-HOME-DENIED", "pass", "scope", P, "Sandboxed commands cannot read your home folder by default",
                    "denyRead covers ~ and allowRead re-opens only specific folders: " + ", ".join(ctx.t(a) for a in allow[:12]),
                    f"{src}: sandbox.filesystem")
        else:
            ctx.add("CC-SANDBOX-READS-HOME", "medium", "scope", P,
                    "Sandboxed commands can read your entire home folder (minus a short denylist)",
                    "The sandbox's default read scope is the whole disk. Denylisting individual folders misses "
                    "anything you did not think of.",
                    f"{src}: sandbox.filesystem.denyRead",
                    f'Deny ~ and re-allow only {ctx.t(ctx.code)} plus toolchain folders: '
                    '"filesystem": {"denyRead": ["~/"], "allowRead": ["' + ctx.t(ctx.code) + '", ...]}. '
                    "Run with --propose-dir to get a list tailored to this machine.")
        if exposed:
            creds = [p for c, p in exposed if c in ("credentials", "agent_secrets")]
            pers = [p for c, p in exposed if c in ("personal", "browsers_and_password_managers")]
            if creds:
                ctx.add("CC-SANDBOX-CREDS-READABLE", "high", "personal_files", P,
                        f"{len(creds)} credential location(s) are readable by sandboxed commands",
                        ", ".join(ctx.t(p) for p in creds[:15]), f"{src}: sandbox.filesystem.denyRead",
                        "Add these to denyRead, or deny ~ entirely (preferred).")
            if pers:
                ctx.add("CC-SANDBOX-PERSONAL-READABLE", "high", "personal_files", P,
                        f"{len(pers)} personal-data location(s) are readable by sandboxed commands",
                        ", ".join(ctx.t(p) for p in pers[:15]), f"{src}: sandbox.filesystem.denyRead",
                        "Add these to denyRead, or deny ~ entirely (preferred).")

    # ---- Permission mode ----------------------------------------------------
    if mode == "bypassPermissions":
        ctx.add("CC-MODE-BYPASS", "critical", "sandbox", P, "Default permission mode is bypassPermissions",
                "Every tool call runs without approval, including edits and network access.",
                f"{src}: permissions.defaultMode", 'Set "defaultMode" to "default" or "acceptEdits".')
    elif mode in ("auto", "dontAsk", "acceptEdits"):
        ctx.add("CC-MODE-PERMISSIVE", "info", "sandbox", P, f"Default permission mode is {mode}",
                "Fine when the sandbox and deny rules are solid; those are what actually contain the agent.",
                f"{src}: permissions.defaultMode")
    if eff.get("skipDangerousModePermissionPrompt"):
        ctx.add("CC-SKIP-DANGER-PROMPT", "high", "sandbox", P, "Bypass-mode warning prompt is suppressed",
                "Entering bypassPermissions mode no longer asks for confirmation.",
                f"{src}: skipDangerousModePermissionPrompt", "Remove skipDangerousModePermissionPrompt.")
    if perms.get("disableBypassPermissionsMode") != "disable":
        ctx.add("CC-BYPASS-AVAILABLE", "medium", "sandbox", P, "bypassPermissions mode can be switched on",
                "One flag (--dangerously-skip-permissions) or a mode toggle removes all approvals.",
                f"{src}: permissions.disableBypassPermissionsMode",
                'Set "permissions": {"disableBypassPermissionsMode": "disable"}.')

    # ---- Allow rules ------------------------------------------------------
    for rule in perms.get("allow") or []:
        r = str(rule).strip()
        if re.match(r"^Bash(\(\s*(\*|:\*)?\s*\))?$", r):
            ctx.add("CC-ALLOW-ALL-BASH", "high", "sandbox", P, f"Allow rule '{r}' auto-approves every shell command",
                    "Combined with any sandbox gap this is unrestricted code execution.", f"{src}: permissions.allow",
                    "Replace with specific command prefixes, e.g. Bash(npm run test *).")
            continue
        m = re.match(r"^Bash\(\s*([A-Za-z0-9_.\-/]+)", r)
        if m and os.path.basename(m.group(1)) in RISKY_BASH_PREFIXES and not re.match(r"^Bash\(\s*\S+\s+[^*:\s]", r):
            ctx.add("CC-ALLOW-INTERPRETER", "medium", "sandbox", P, f"Allow rule '{r}' auto-approves a general-purpose tool",
                    "Interpreters, network tools and file movers can do anything, so approving them by prefix "
                    "approves arbitrary actions.", f"{src}: permissions.allow",
                    "Scope the rule to a specific script or subcommand.")
        for tool in ("Read", "Edit", "Write"):
            rp = read_rule_prefix(ctx, r, tool, settings_dir)
            if r in (tool, f"{tool}(*)", f"{tool}(//**)", f"{tool}(/**)"):
                rp = (Path("/"), False)
            if rp:
                prefix = rp[0]
                if prefix in (Path("/"), ctx.home) or is_under(ctx.home, prefix):
                    ctx.add("CC-ALLOW-BROAD-FILES", "high", "scope", P, f"Allow rule '{r}' covers your whole home folder",
                            "File tools can touch personal files without prompting.", f"{src}: permissions.allow",
                            f"Limit it to {ctx.t(ctx.code)}/** or remove it.")
                elif not is_under(prefix, ctx.code):
                    ctx.add("CC-ALLOW-OUTSIDE-CODE", "medium", "scope", P, f"Allow rule '{r}' reaches outside {ctx.t(ctx.code)}",
                            f"Pre-approved access to {ctx.t(prefix)}.", f"{src}: permissions.allow",
                            "Remove it unless this folder is genuinely needed.")
        if r == "WebFetch":
            ctx.add("CC-ALLOW-WEBFETCH-ANY", "low", "hygiene", P, "WebFetch is pre-approved for every domain",
                    "Fetched pages are a prompt-injection vector.", f"{src}: permissions.allow",
                    "Use WebFetch(domain:example.com) rules instead.")

    # ---- Working-directory scope -----------------------------------------
    for d in perms.get("additionalDirectories") or []:
        dp = ctx.exp(str(d), settings_dir)
        if dp in (Path("/"), ctx.home) or is_under(ctx.home, dp):
            ctx.add("CC-ADDDIR-HOME", "high", "scope", P, f"additionalDirectories includes {ctx.t(dp)}",
                    "Claude gets working-directory access (and sandbox write access) to your whole home.",
                    f"{src}: permissions.additionalDirectories", "Remove it.")
        elif not is_under(dp, ctx.code):
            ctx.add("CC-ADDDIR-OUTSIDE", "medium", "scope", P, f"additionalDirectories includes {ctx.t(dp)} (outside {ctx.t(ctx.code)})",
                    "Every session can read and write this folder.", f"{src}: permissions.additionalDirectories",
                    "Remove it, or add it per-session with --add-dir when needed.")

    block_reads = perms.get("blockReadsOutsideWorkingDirectories") is True
    if not block_reads:
        supported = min_v is not None and min_v >= (2, 1, 257)
        ctx.add("CC-READS-OUTSIDE-CWD", "medium", "scope", P,
                "Claude's Read/Grep/Glob tools can read files anywhere on disk",
                "The Bash sandbox does not cover Claude's built-in file tools; they run in the main process. "
                "Without this setting or matching Read deny rules they can read any file your user can, "
                "without asking." + ("" if supported else
                                     f" (Requires Claude Code 2.1.257+; oldest install found: {vstr(min_v)}.)"),
                f"{src}: permissions.blockReadsOutsideWorkingDirectories",
                'Set "permissions": {"blockReadsOutsideWorkingDirectories": true} and keep Read deny rules for '
                "credentials as a second layer.")
    else:
        ctx.add("CC-READS-SCOPED", "pass", "scope", P, "Built-in file tools cannot read outside working directories",
                evidence=f"{src}: permissions.blockReadsOutsideWorkingDirectories")

    # Read-tool coverage of credentials via deny rules.
    deny_prefixes: List[Path] = []
    for rule in perms.get("deny") or []:
        rp = read_rule_prefix(ctx, str(rule), "Read", settings_dir)
        if rp:
            deny_prefixes.append(rp[0])
            if rp[1]:
                ctx.add("CC-DENY-SINGLE-SLASH", "medium", "personal_files", P,
                        f"Deny rule '{rule}' probably does not protect what you intended",
                        "Claude Code resolves a single leading '/' relative to the settings file's folder. "
                        "Absolute paths need '//' (e.g. Read(//Users/me/.ssh/**)) or '~/'.",
                        f"{src}: permissions.deny", "Rewrite with '~/' or '//' prefixes.")
    if not block_reads:
        unprotected = [p for c, p in ctx.sensitive_paths("credentials", "agent_secrets")
                       if not any(is_under(p, d) for d in deny_prefixes)]
        if unprotected:
            ctx.add("CC-READTOOL-CREDS", "high", "personal_files", P,
                    f"{len(unprotected)} credential location(s) readable by Claude's Read tool without a prompt",
                    ", ".join(ctx.t(p) for p in unprotected[:15]), f"{src}: permissions.deny",
                    "Add Read deny rules (e.g. Read(~/.ssh/**)) or enable blockReadsOutsideWorkingDirectories.")

    # ---- Misc ------------------------------------------------------------
    if eff.get("enableAllProjectMcpServers"):
        ctx.add("CC-ALL-PROJECT-MCP", "medium", "hygiene", P, "All MCP servers declared by repositories are auto-approved",
                "Cloning a repo with a malicious .mcp.json would start its servers (which run unsandboxed).",
                f"{src}: enableAllProjectMcpServers", "Remove it; approve project servers individually.")
    names = secret_env_names(eff.get("env"))
    if names:
        ctx.add("CC-ENV-SECRETS", "medium", "hygiene", P, "Secrets are set in settings.json 'env'",
                "These are injected into every session and every subprocess: " + ", ".join(names),
                f"{src}: env", "Load secrets from the Keychain at the point of use instead.")
    hooks = eff.get("hooks") or {}
    if hooks:
        cmds = []
        for ev, groups in hooks.items():
            for g in groups or []:
                for h in (g or {}).get("hooks", []) if isinstance(g, dict) else []:
                    if isinstance(h, dict) and h.get("command"):
                        cmds.append(f"{ev}: {str(h['command'])[:80]}")
        ctx.inventory.setdefault("claude_code", {})["user_hooks"] = cmds
        ctx.add("CC-HOOKS-PRESENT", "info", "hygiene", P, f"{len(cmds)} user-level hook command(s) configured",
                "Hooks run outside the sandbox with your full permissions; make sure you recognise each one.",
                f"{src}: hooks")
    for k in ("apiKeyHelper", "awsCredentialExport", "awsAuthRefresh", "otelHeadersHelper"):
        if eff.get(k):
            ctx.add("CC-HELPER-CMD", "info", "hygiene", P, f"{k} runs a command to obtain credentials",
                    "Make sure the referenced script is not writable by agents.", f"{src}: {k}")
    if not has_managed:
        ctx.add("CC-NO-MANAGED", "low", "hygiene", P, "No managed (admin-owned) Claude Code settings",
                "User and project settings can be edited by any process running as you, including another agent, "
                "and a repository's .claude/settings.json can override your sandbox settings for that project. "
                "Root-owned managed settings cannot be overridden.",
                "managed-settings.json", "Optionally install your hardened settings as managed settings (requires sudo; see references).")


def scan_claude_code(ctx: Ctx) -> None:
    P = "claude-code"
    paths = claude_paths(ctx)
    present = paths["dir"].exists() or paths["state"].exists() or shutil.which("claude")
    if not present:
        ctx.inventory["claude_code"] = {"installed": False}
        return
    versions = claude_versions(ctx)
    inv = ctx.inventory.setdefault("claude_code", {})
    inv.update({"installed": True, "versions": versions, "config_dir": ctx.t(paths["dir"])})

    user, err = read_json(paths["user"])
    if err:
        ctx.add("CC-SETTINGS-UNREADABLE", "unknown", "hygiene", P, "Could not read ~/.claude/settings.json", err
                + ". If this scan runs inside an agent sandbox, that is the lock-down working: run the scanner from your "
                  "own terminal for the configuration audit, and use --probe inside agents.", ctx.t(paths["user"]))
        return  # never judge settings we could not read
    user = user if isinstance(user, dict) else {}
    ctx.raw["claude_user_settings"] = user
    ctx.raw["claude_user_settings_path"] = paths["user"]
    user_local, _ = read_json(paths["user_local"])
    managed, merr = read_json(paths["managed"])
    managed = managed if isinstance(managed, dict) else {}
    if paths["managed_d"].is_dir():
        for f in sorted(paths["managed_d"].glob("*.json")):
            d, _ = read_json(f)
            if isinstance(d, dict):
                managed = deep_merge(managed, d)
    has_managed = bool(managed)
    inv["managed_settings"] = has_managed
    eff = deep_merge(user, user_local if isinstance(user_local, dict) else {})
    eff = deep_merge(eff, managed)
    src = "managed+user settings" if has_managed else ctx.t(paths["user"])
    evaluate_claude_settings(ctx, eff, versions, src, paths["dir"], has_managed)

    # Credential file modes.
    for f in (paths["state"], paths["dir"] / ".credentials.json"):
        if f.exists() and group_or_world_readable(f):
            ctx.add("CC-STATE-PERMS", "medium", "hygiene", P, f"{ctx.t(f)} is readable by other users ({mode_str(f)})",
                    "This file holds account state and OAuth data.", ctx.t(f), f"chmod 600 {ctx.t(f)}")

    # ~/.claude.json: MCP servers + project history.
    state, serr = read_json(paths["state"])
    if isinstance(state, dict):
        mcp_inv = analyze_mcp_servers(ctx, state.get("mcpServers"), P, "~/.claude.json")
        projects = state.get("projects") or {}
        outside = []
        for proj, pdata in projects.items():
            pp = Path(proj)
            if not is_under(pp, ctx.code):
                outside.append(proj)
            if isinstance(pdata, dict):
                mcp_inv += analyze_mcp_servers(ctx, pdata.get("mcpServers"), P, f"~/.claude.json projects[{ctx.t(pp)}]")
                for rule in pdata.get("allowedTools") or []:
                    if re.match(r"^Bash(\(\s*(\*|:\*)?\s*\))?$", str(rule)):
                        ctx.add("CC-PROJECT-ALLOW-ALL-BASH", "high", "sandbox", P,
                                f"Project {ctx.t(pp)} pre-approves every shell command", f"allowedTools: {rule}",
                                f"~/.claude.json projects[{ctx.t(pp)}].allowedTools", "Remove the rule.")
        inv["mcp_servers"] = mcp_inv
        inv["projects_total"] = len(projects)
        inv["projects_outside_code_dir"] = [ctx.t(Path(p)) for p in outside]
        # Ignore the desktop app's own scratch workspaces and per-user temp folders.
        meaningful = [p for p in outside if "scratch-workspaces" not in p
                      and not re.match(r"^(/private)?/var/folders/", p)]
        if meaningful:
            ctx.add("CC-PROJECTS-OUTSIDE-CODE", "low", "scope", P,
                    f"Claude Code has been run in {len(meaningful)} folder(s) outside {ctx.t(ctx.code)}",
                    "Each session gets read/write working-directory access to the folder it starts in: "
                    + ", ".join(ctx.t(Path(p)) for p in meaningful[:8]),
                    "~/.claude.json projects", f"Start sessions from inside {ctx.t(ctx.code)}; move work folders there.")

    # Repo-level settings inside the code folder.
    scan_claude_project_files(ctx)


def iter_project_dirs(code: Path, depth: int = 2) -> Iterable[Path]:
    skip = {"node_modules", ".git", "venv", ".venv", "dist", "build", "Pods", "DerivedData", "__pycache__"}
    frontier = [code]
    for _ in range(depth):
        nxt = []
        for d in frontier:
            try:
                for e in os.scandir(d):
                    if e.is_dir(follow_symlinks=False) and e.name not in skip and not e.name.startswith("."):
                        nxt.append(Path(e.path))
            except OSError:
                continue
        for d in nxt:
            yield d
        frontier = nxt


def scan_claude_project_files(ctx: Ctx) -> None:
    P = "claude-code"
    if not ctx.code.is_dir():
        return
    repos_with_cfg = []
    for d in iter_project_dirs(ctx.code):
        for name in (".claude/settings.json", ".claude/settings.local.json"):
            f = d / name
            if not f.is_file():
                continue
            data, _ = read_json(f)
            if not isinstance(data, dict):
                continue
            repos_with_cfg.append(ctx.t(f))
            ev = ctx.t(f)
            sb = data.get("sandbox") or {}
            if sb.get("enabled") is False:
                ctx.add("CC-REPO-DISABLES-SANDBOX", "high", "sandbox", P, f"{ev} turns the sandbox OFF for that project",
                        "Project settings take precedence over ~/.claude/settings.json, so opening this repo runs "
                        "commands unsandboxed. A malicious repo can do the same.", ev,
                        "Delete the override, and consider managed settings so repos cannot weaken the sandbox.")
            if sb.get("allowUnsandboxedCommands") is True or sb.get("excludedCommands"):
                ctx.add("CC-REPO-WEAKENS-SANDBOX", "medium", "sandbox", P, f"{ev} weakens the sandbox",
                        "It enables unsandboxed retries or excludes commands from the sandbox.", ev, "Remove the override.")
            if (sb.get("filesystem") or {}).get("allowWrite") or (sb.get("network") or {}).get("allowedDomains"):
                ctx.add("CC-REPO-SANDBOX-ALLOWS", "low", "sandbox", P, f"{ev} widens sandbox write paths or domains",
                        "Review that these additions are expected.", ev)
            if data.get("hooks"):
                ctx.add("CC-REPO-HOOKS", "medium", "hygiene", P, f"{ev} defines hooks",
                        "Repository hooks run shell commands on your machine, outside the sandbox, once the folder is trusted.",
                        ev, "Read each hook command before trusting the folder.")
            if data.get("enableAllProjectMcpServers"):
                ctx.add("CC-REPO-ALL-MCP", "medium", "hygiene", P, f"{ev} auto-approves all of the repo's MCP servers", "", ev,
                        "Remove it.")
            for rule in (data.get("permissions") or {}).get("allow") or []:
                if re.match(r"^Bash(\(\s*(\*|:\*)?\s*\))?$", str(rule)):
                    ctx.add("CC-REPO-ALLOW-ALL-BASH", "high", "sandbox", P, f"{ev} pre-approves every shell command",
                            str(rule), ev, "Remove the rule.")
            names = secret_env_names(data.get("env"))
            if names:
                ctx.add("CC-REPO-ENV-SECRETS", "medium", "hygiene", P, f"{ev} contains secrets in 'env'", ", ".join(names), ev,
                        "Move secrets out of committed config.")
        mcp = d / ".mcp.json"
        if mcp.is_file():
            data, _ = read_json(mcp)
            if isinstance(data, dict):
                inv = analyze_mcp_servers(ctx, data.get("mcpServers"), P, ctx.t(mcp))
                ctx.inventory.setdefault("claude_code", {}).setdefault("repo_mcp_servers", []).extend(inv)
    ctx.inventory.setdefault("claude_code", {})["repo_settings_files"] = repos_with_cfg


# --------------------------------------------------------------------------- #
# Claude desktop app
# --------------------------------------------------------------------------- #
def scan_claude_desktop(ctx: Ctx) -> None:
    P = "claude-desktop"
    base = ctx.home / ("Library/Application Support/Claude" if IS_MAC else ".config/Claude")
    cfgp = base / "claude_desktop_config.json"
    app = Path("/Applications/Claude.app")
    if not base.exists() and not app.exists():
        ctx.inventory["claude_desktop"] = {"installed": False}
        return
    inv = ctx.inventory.setdefault("claude_desktop", {"installed": True})
    if app.exists():
        inv["version"] = plist_version(app)
    cfg, err = read_json(cfgp)
    if err:
        ctx.add("CD-CONFIG-UNREADABLE", "unknown", "hygiene", P, "Could not read claude_desktop_config.json", err, ctx.t(cfgp))
    if not isinstance(cfg, dict):
        return
    inv["mcp_servers"] = analyze_mcp_servers(ctx, cfg.get("mcpServers"), P, ctx.t(cfgp))
    prefs = cfg.get("preferences") or {}
    ev = ctx.t(cfgp) + " -> preferences"
    note = " (Observed app preference; key names are undocumented and may change - confirm in Settings.)"
    bp = prefs.get("bypassPermissionsGateByAccount")
    if isinstance(bp, dict) and any(v is True for v in bp.values()):
        ctx.add("CD-BYPASS-ENABLED", "high", "sandbox", P, "Bypass-permissions mode is enabled in the desktop app",
                "Code-tab sessions can be switched to run every action without approval." + note,
                ev + ".bypassPermissionsGateByAccount", "Settings > Claude Code: turn off 'Allow bypass permissions mode'.")
    if prefs.get("ccRemoteControlDefaultEnabled") is True:
        ctx.add("CD-REMOTE-CONTROL", "low", "hygiene", P, "Remote Control is on by default for new Code sessions",
                "Sessions can be driven from claude.ai or your phone. Anyone with access to your Claude account can "
                "then run agent actions on this Mac." + note,
                ev + ".ccRemoteControlDefaultEnabled", "Turn it off unless you use it; keep 2FA on your account.")
    sched = [k for k in ("coworkScheduledTasksEnabled", "ccdScheduledTasksEnabled") if prefs.get(k) is True]
    if sched:
        ctx.add("CD-SCHEDULED-TASKS", "info", "hygiene", P, "Scheduled (unattended) agent tasks are enabled",
                "Unattended runs act without a human watching; make sure each one has narrow permissions." + note, ev)
    origins = prefs.get("launchPreviewPrivateNetworkTrustedOrigins") or []
    if origins:
        ctx.add("CD-LAN-ORIGINS", "low", "scope", P, f"{len(origins)} private-network origin(s) trusted for previews",
                "The preview browser may reach these LAN hosts: " + ", ".join(map(str, origins[:5])) + note, ev,
                "Remove origins you no longer use.")
    tcc = prefs.get("folderTccProbeResults") or {}
    granted = [k for k in ("desktop", "documents", "downloads") if tcc.get(k) == "granted"]
    if granted:
        ctx.add("CD-TCC-FOLDERS", "high", "personal_files", P,
                "Claude.app holds macOS permission to " + ", ".join(g.title() for g in granted),
                "Processes started by the app inherit this permission. The sandbox and deny rules are then the "
                "only barrier between agents and these folders." + note,
                ev + ".folderTccProbeResults",
                "System Settings > Privacy & Security > Files and Folders > Claude: switch these off. "
                "Re-grant temporarily only when you need them.")
    if cfg.get("coworkUserFilesPath"):
        inv["cowork_files_path"] = ctx.t(Path(cfg["coworkUserFilesPath"]))
    ext_dir = base / "Claude Extensions"
    if ext_dir.is_dir():
        exts = sorted(p.name for p in ext_dir.iterdir() if p.is_dir())
        inv["desktop_extensions"] = exts
        if exts:
            ctx.add("CD-EXTENSIONS", "info", "hygiene", P, f"{len(exts)} desktop extension(s) installed",
                    "Desktop extensions are local MCP servers that run outside any sandbox: " + ", ".join(exts[:10]),
                    ctx.t(ext_dir), "Remove extensions you do not use.")


# --------------------------------------------------------------------------- #
# Antigravity 2.x
# --------------------------------------------------------------------------- #
def ag_enum(v: Any, table: Dict[int, str], prefix: str) -> str:
    """Normalise a protojson enum (string name or int) to its short name."""
    if v is None:
        return "UNSET"
    if isinstance(v, int):
        return table.get(v, str(v))
    s = str(v)
    return s[len(prefix):] if s.startswith(prefix) else s


def analyze_grants(ctx: Ctx, grants: Any, product: str, src: str) -> None:
    if not isinstance(grants, dict):
        return
    allow = grants.get("allow") or []
    for g in allow:
        g = str(g)
        m = re.match(r"^([a-z_]+)\((.*)\)$", g)
        tool, arg = (m.group(1), m.group(2).strip()) if m else (g, "")
        if arg in ("*", "") or g in ("*",):
            sev = "critical" if tool in ("unsandboxed", "command", "write_file") else "high"
            ctx.add("AG-GRANT-WILDCARD", sev, "sandbox" if tool in ("unsandboxed", "command") else "scope", product,
                    f"Permission grant '{g}' allows {tool} for anything",
                    "Wildcard grants silently approve every matching action.", src, "Remove it; grant specific items.")
            continue
        if tool in ("read_file", "write_file") and (arg.startswith("/") or arg.startswith("~")):
            p = ctx.exp(arg)
            if p in (Path("/"), ctx.home) or is_under(ctx.home, p):
                ctx.add("AG-GRANT-HOME", "high", "personal_files", product, f"Grant '{g}' covers your whole home folder",
                        "Allow grants also become sandbox mounts, so sandboxed commands can reach it too.", src, "Remove it.")
            elif not is_under(p, ctx.code):
                ctx.add("AG-GRANT-OUTSIDE-CODE", "medium", "scope", product, f"Grant '{g}' reaches outside {ctx.t(ctx.code)}",
                        "An approval you once clicked is remembered globally, and Antigravity mounts allow-granted paths "
                        "into the terminal sandbox (read_file = read-only, write_file = read-write).", src,
                        "Remove it unless still needed (Settings > Permissions, or edit the grant list).")
        if tool in ("read_url", "execute_url", "download_url") and arg in ("*", "*.*"):
            ctx.add("AG-GRANT-ANY-URL", "high", "hygiene", product, f"Grant '{g}' allows every website",
                    "read_url domains also join the sandbox network allowlist.", src, "Remove it.")
        if tool == "command" and arg.split()[0:1] and os.path.basename(arg.split()[0]) in RISKY_BASH_PREFIXES and len(arg.split()) == 1:
            ctx.add("AG-GRANT-INTERPRETER", "medium", "sandbox", product, f"Grant '{g}' auto-approves a general-purpose tool",
                    "Approving an interpreter or network tool by name approves arbitrary actions.", src,
                    "Scope it to a subcommand, e.g. command(npm run test).")


def evaluate_ag_user_settings(ctx: Ctx, us: Dict[str, Any], src: str) -> None:
    P = "antigravity"
    # In the "Updated" permission system (personal accounts, App 2.x) the Permission Preset decides
    # whether terminal commands are sandboxed: Default/Auto = sandbox on, Request Review = no sandbox but
    # every command asks, Turbo = no sandbox and full filesystem. enableTerminalSandbox is the toggle used
    # by the "Previous" system (business accounts), the IDE and the agy CLI.
    preset = ag_enum(us.get("permissionPreset"), AG_PRESET, "AGENT_PERMISSION_PRESET_")
    sandbox = us.get("enableTerminalSandbox")
    strict = us.get("secureModeEnabled") is True
    if strict:
        ctx.add("AG-STRICT-MODE", "pass", "sandbox", P, "Strict (secure) mode is on",
                "Forces the sandbox on with network denied, requires review for terminal and browser JS, and "
                "blocks access outside the workspace.", f"{src}: secureModeEnabled")
    if preset in ("TURBO", "NONE"):
        ctx.add("AG-PRESET-TURBO", "critical", "sandbox", P, f"Global permission preset is {preset}",
                "Turbo runs commands with no sandbox, full filesystem access, and MCP/web allowed without asking.",
                f"{src}: permissionPreset", "Settings > General > Global Permissions: choose Default (or Request Review).")
    elif preset == "AUTO":
        ctx.add("AG-PRESET-AUTO", "medium", "sandbox", P, "Global permission preset is Auto",
                "Commands are sandboxed, but the model decides which out-of-sandbox commands run without asking.",
                f"{src}: permissionPreset", "Choose Default so anything leaving the sandbox needs your approval.")
    elif preset == "REQUEST_REVIEW":
        ctx.add("AG-PRESET-REVIEW", "low", "sandbox", P, "Global permission preset is Request Review (no sandbox)",
                "Every command asks first, but approved commands run unsandboxed with your full permissions.",
                f"{src}: permissionPreset", "Default runs commands inside the sandbox and still asks for anything outside it.")
    elif preset in ("DEFAULT", "UNSET", "UNSPECIFIED") and sandbox is not False:
        ctx.add("AG-PRESET-DEFAULT", "pass", "sandbox", P,
                "Global permission preset is Default (commands run in the sandbox)" + (" - implicit" if preset != "DEFAULT" else ""),
                "Default falls back to Request Review if the sandbox is unavailable." +
                (" The preset is not stored explicitly, so a future default change would apply silently." if preset != "DEFAULT" else ""),
                f"{src}: permissionPreset")
    if sandbox is False and not strict:
        ctx.add("AG-SANDBOX-OFF", "high", "sandbox", P, "Antigravity terminal sandbox is switched off",
                "Agent terminal commands run with your full user permissions.", f"{src}: enableTerminalSandbox",
                "Turn the terminal sandbox back on (enableTerminalSandbox: true).")
    if us.get("sandboxAllowNetwork") is True:
        ctx.add("AG-SANDBOX-NET", "medium", "sandbox", P, "Sandboxed commands may use the network",
                "Network access lets a prompt-injected command send your code elsewhere.", f"{src}: sandboxAllowNetwork",
                "Turn it off and approve network-needing commands case by case.")

    ae = ag_enum(us.get("autoExecutionPolicy"), AG_AUTO_EXEC, "CASCADE_COMMANDS_AUTO_EXECUTION_")
    if ae == "EAGER":
        ctx.add("AG-AUTOEXEC-TURBO", "high", "sandbox", P, "Terminal commands auto-run in Turbo (eager) mode",
                "The agent runs any command without asking.", f"{src}: autoExecutionPolicy",
                "Use 'Proceed in sandbox' (PROCEED_IN_SANDBOX) or 'Off'.")
    elif ae == "AUTO":
        ctx.add("AG-AUTOEXEC-AUTO", "medium", "sandbox", P, "Terminal commands auto-run when the model judges them safe",
                "The model, not you, decides which commands need review.", f"{src}: autoExecutionPolicy",
                "Use 'Proceed in sandbox' together with the sandbox, or 'Off'.")
    elif ae == "PROCEED_IN_SANDBOX" and sandbox is False:
        ctx.add("AG-AUTOEXEC-SANDBOX-NOT-ON", "high", "sandbox", P, "'Proceed in sandbox' is selected but the sandbox is off",
                "", f"{src}: autoExecutionPolicy", "Enable the terminal sandbox.")
    inv = ctx.inventory.setdefault("antigravity", {})
    inv["policies"] = {"autoExecutionPolicy": ae, "permissionPreset": preset}

    nwf = ag_enum(us.get("nonWorkspaceFileAccessPolicy"), AG_POLICY, "AGENT_SETTING_POLICY_")
    legacy_nwf = us.get("allowAgentAccessNonWorkspaceFiles")
    inv["policies"]["nonWorkspaceFileAccessPolicy"] = nwf
    if nwf == "ALLOW" or legacy_nwf is True:
        ctx.add("AG-NONWORKSPACE-ALLOW", "high", "scope", P, "Agents may read/write files outside the workspace without asking",
                "This lets an agent reach personal files and other tools' configs.",
                f"{src}: nonWorkspaceFileAccessPolicy / allowAgentAccessNonWorkspaceFiles",
                "Set non-workspace file access to Deny (AGENT_SETTING_POLICY_DENY).")
    elif nwf == "DENY":
        ctx.add("AG-NONWORKSPACE-DENY", "pass", "scope", P, "Non-workspace file access is denied", evidence=f"{src}: nonWorkspaceFileAccessPolicy")
    else:
        ctx.add("AG-NONWORKSPACE-ASK", "low", "scope", P,
                f"Non-workspace file access policy is {nwf} (prompt-based or app default)",
                "Prompts can be approved by habit; Deny is the hard boundary.", f"{src}: nonWorkspaceFileAccessPolicy",
                "Set it to Deny (AGENT_SETTING_POLICY_DENY).")
    if us.get("allowAgentAccessGitignoreFiles") is True or us.get("allowCascadeAccessGitignoreFiles") is True:
        ctx.add("AG-GITIGNORE-ACCESS", "medium", "personal_files", P, "Agents may read git-ignored files",
                "Git-ignored files typically include .env files and local credentials.",
                f"{src}: allowAgentAccessGitignoreFiles", "Turn off 'Agent Gitignore Access'.")
    inet = ag_enum(us.get("internetAccessPolicy"), AG_POLICY, "AGENT_SETTING_POLICY_")
    inv["policies"]["internetAccessPolicy"] = inet
    if inet == "ALLOW":
        ctx.add("AG-INTERNET-ALLOW", "low", "hygiene", P, "Agent internet access is allowed without asking",
                "Web content is the main prompt-injection vector.", f"{src}: internetAccessPolicy", "Consider Ask.")
    js = ag_enum(us.get("browserJsExecutionPolicy"), AG_BROWSER_JS, "BROWSER_JS_EXECUTION_POLICY_")
    inv["policies"]["browserJsExecutionPolicy"] = js
    if js in ("TURBO", "MODEL_DECIDES"):
        ctx.add("AG-BROWSER-JS", "medium" if js == "MODEL_DECIDES" else "high", "hygiene", P,
                f"Browser-agent JavaScript execution policy is {js}",
                "Running page JavaScript without review lets an injected page act in your logged-in sessions.",
                f"{src}: browserJsExecutionPolicy", "Set it to Always ask or Disabled.")
    if us.get("secureModeEnabled") is True:
        ctx.add("AG-SECURE-MODE", "pass", "sandbox", P, "Secure mode is enabled", evidence=f"{src}: secureModeEnabled")
    if us.get("remoteControlEnabled") is True:
        ctx.add("AG-REMOTE-CONTROL", "medium", "hygiene", P, "Antigravity remote control is enabled",
                "Agents on this Mac can be driven remotely through your Google account. A compromised account "
                "then means remote code execution here.", f"{src}: remoteControlEnabled",
                "Turn it off unless you actively use it; make sure the Google account has 2-step verification.")
    if us.get("enableAdc") is True:
        ctx.add("AG-ADC", "medium", "personal_files", P, "Agents can use your Google Cloud Application Default Credentials",
                "Agent commands inherit your gcloud identity and every permission it has.", f"{src}: enableAdc",
                "Turn it off, or use a low-privilege service account for agent work.")
    if us.get("shellSetupScript"):
        ctx.add("AG-SHELL-SETUP", "info", "hygiene", P, "A shell setup script runs before agent commands",
                "Make sure agents cannot edit that script.", f"{src}: shellSetupScript")
    for k in ("allowedCommands", "deniedCommands"):
        if us.get(k):
            inv.setdefault("command_lists", {})[k] = us.get(k)
    analyze_grants(ctx, us.get("globalPermissionGrants"), P, f"{src}: globalPermissionGrants")
    deny = (us.get("globalPermissionGrants") or {}).get("deny") or []
    deny_paths = []
    for g in deny:
        m = re.match(r"^read_file\((.+)\)$", str(g))
        if m:
            deny_paths.append(ctx.exp(m.group(1).strip()))
    missing = [p for c, p in ctx.sensitive_paths("credentials", "agent_secrets") if not any(is_under(p, d) for d in deny_paths)]
    if missing and nwf != "DENY":
        ctx.add("AG-NO-CRED-DENY", "high" if nwf == "ALLOW" or legacy_nwf is True else "medium", "personal_files", P,
                f"No deny grants protect {len(missing)} credential location(s) from Antigravity's file tools",
                "The terminal sandbox only mounts the workspace, but the agent's own file tools merely ask before "
                "reading outside it - one habitual 'Allow' exposes the file, and the grant is remembered. "
                "Deny grants make it a hard block (Deny > Ask > Allow): " + ", ".join(ctx.t(p) for p in missing[:12]),
                f"{src}: globalPermissionGrants.deny",
                "Add read_file(<path>) deny grants for credential folders (the proposals do this).")


def scan_antigravity(ctx: Ctx) -> None:
    P = "antigravity"
    gem = ctx.home / ".gemini"
    cfgp = gem / "config" / "config.json"
    app = Path("/Applications/Antigravity.app")
    if not cfgp.exists() and not app.exists() and not (gem / "antigravity").exists():
        ctx.inventory["antigravity"] = {"installed": False}
        return
    inv = ctx.inventory.setdefault("antigravity", {})
    inv["installed"] = True
    if app.exists():
        inv["version"] = plist_version(app)
    cfg, err = read_json(cfgp)
    if err:
        ctx.add("AG-CONFIG-UNREADABLE", "unknown", "hygiene", P, "Could not read ~/.gemini/config/config.json", err, ctx.t(cfgp))
    if isinstance(cfg, dict):
        ctx.raw["antigravity_config"] = cfg
        ctx.raw["antigravity_config_path"] = cfgp
        us = cfg.get("userSettings") or {}
        evaluate_ag_user_settings(ctx, us, ctx.t(cfgp) + " userSettings")
        plugins = cfg.get("plugins") or {}
        inv["plugins"] = sorted(k for k, v in plugins.items() if isinstance(v, dict) and v.get("enabled"))
        for name in inv["plugins"]:
            if "chrome" in name or "browser" in name or "devtools" in name:
                ctx.add("AG-BROWSER-PLUGIN", "medium", "personal_files", P, f"Browser-automation plugin '{name}' is enabled",
                        "If it attaches to your everyday browser profile, agents can read cookies, sessions and "
                        "page contents of sites you are logged into.", ctx.t(cfgp) + " plugins",
                        "Point it at a dedicated, logged-out browser profile, or disable it when not in use.")
        sidecars = cfg.get("sidecars") or {}
        inv["automations"] = sorted(sidecars.keys())
        for sid, sc in sidecars.items():
            if isinstance(sc, dict):
                analyze_grants(ctx, sc.get("resolvedPermissions"), P, f"{ctx.t(cfgp)} sidecars[{sid}].resolvedPermissions")
        if sidecars:
            ctx.add("AG-AUTOMATIONS", "info", "hygiene", P, f"{len(sidecars)} automation(s)/sidecar(s) configured",
                    "Automations run unattended and inherit global grants: " + ", ".join(sorted(sidecars)[:8]),
                    ctx.t(cfgp) + " sidecars")
    # Projects.
    projdir = gem / "config" / "projects"
    outside = []
    if projdir.is_dir():
        for f in sorted(projdir.glob("*.json")):
            d, _ = read_json(f)
            if not isinstance(d, dict):
                continue
            name = d.get("name") or f.stem
            ev = f"{ctx.t(f)} ({name})"
            arm = (d.get("settings") or {}).get("artifactReviewMode")
            if arm and ag_enum(arm, AG_ARTIFACT_REVIEW, "ARTIFACT_REVIEW_MODE_") == "TURBO":
                ctx.add("AG-PROJECT-TURBO-REVIEW", "low", "hygiene", P, f"Project '{name}' skips plan/artifact review (Turbo)",
                        "The agent proceeds without you reviewing its plan.", ev, "Use Always or Auto review.")
            pg = d.get("permissionGrants") or {}
            analyze_grants(ctx, pg.get("permissionGrants") if isinstance(pg.get("permissionGrants"), dict) else pg, P, ev + " permissionGrants")
            for res in (d.get("projectResources") or {}).get("resources") or []:
                uri = (res.get("folderUri") or (res.get("gitFolder") or {}).get("folderUri") or "") if isinstance(res, dict) else ""
                if uri.startswith("file://"):
                    p = real(Path(re.sub(r"^file://", "", uri)))
                    if p in (Path("/"), ctx.home):
                        ctx.add("AG-WORKSPACE-HOME", "critical", "scope", P, f"Project '{name}' uses your whole home folder as its workspace",
                                "Every file you own is inside the agent's workspace.", ev, f"Re-create the project on a folder inside {ctx.t(ctx.code)}.")
                    elif not is_under(p, ctx.code):
                        outside.append(f"{name}: {ctx.t(p)}")
    if outside:
        ctx.add("AG-WORKSPACE-OUTSIDE-CODE", "medium", "scope", P, f"{len(outside)} Antigravity workspace folder(s) outside {ctx.t(ctx.code)}",
                "Agents get full workspace access to these folders: " + "; ".join(outside[:8]),
                ctx.t(projdir), f"Move the work into {ctx.t(ctx.code)} or remove the project.")
    # MCP.
    seen = set()
    for mp in (gem / "config" / "mcp_config.json", gem / "antigravity" / "mcp_config.json", gem / "antigravity-ide" / "mcp_config.json"):
        try:
            resolved = mp.resolve()
        except OSError:
            continue
        if resolved in seen or not mp.exists():
            continue
        seen.add(resolved)
        d, _ = read_json(mp)
        if isinstance(d, dict):
            inv.setdefault("mcp_servers", []).extend(analyze_mcp_servers(ctx, d.get("mcpServers"), P, ctx.t(mp)))
    # Credential file modes.
    for f in (gem / "oauth_creds.json", gem / "antigravity-cli" / "antigravity-oauth-token", gem / "google_accounts.json"):
        if f.exists() and group_or_world_readable(f) and f.name != "google_accounts.json":
            ctx.add("AG-TOKEN-PERMS", "medium", "hygiene", P, f"{ctx.t(f)} is readable by other users ({mode_str(f)})",
                    "This file holds an OAuth token.", ctx.t(f), f"chmod 600 {ctx.t(f)}")
    daemon = gem / "antigravity" / "daemon"
    if daemon.is_dir():
        for f in daemon.glob("*.json"):
            if group_or_world_readable(f):
                ctx.add("AG-DAEMON-PERMS", "medium", "hygiene", P, f"{ctx.t(f)} (local server CSRF token) is readable by other users",
                        "", ctx.t(f), f"chmod 600 {ctx.t(f)}")
    # Hooks can auto-approve tool calls or widen permissions.
    for hp in [gem / "config" / "hooks.json"] + [d / ".agents" / "hooks.json" for d in iter_project_dirs(ctx.code, depth=1)]:
        d, _ = read_json(hp)
        if not isinstance(d, (dict, list)) or not d:
            continue
        txt = json.dumps(d)
        widening = any(k in txt for k in ("auto_approve", "permissionOverrides"))
        ctx.add("AG-HOOKS", "medium" if widening or hp.parent.name == ".agents" else "info", "hygiene", P,
                f"Antigravity hooks configured in {ctx.t(hp)}",
                "Hooks run as host processes outside the sandbox." +
                (" At least one hook can auto-approve or override permissions." if widening else ""),
                ctx.t(hp), "Read each hook; remove any that auto-approve actions.")
    # Automations (sidecars) on disk.
    scd = gem / "config" / "sidecars"
    if scd.is_dir():
        for sj in scd.glob("*/sidecar.json"):
            d, _ = read_json(sj)
            if isinstance(d, dict):
                ap_ = d.get("agent_permissions") or {}
                grants = {"allow": ap_.get("access_grants") or []}
                analyze_grants(ctx, grants, P, f"{ctx.t(sj)} agent_permissions.access_grants")
                for u in ap_.get("workspace_uris") or []:
                    p = Path(re.sub(r"^file://", "", str(u)))
                    if not is_under(p, ctx.code):
                        ctx.add("AG-AUTOMATION-WORKSPACE", "medium", "scope", P,
                                f"Automation {sj.parent.name} has workspace access to {ctx.t(p)}",
                                "Automations run unattended.", ctx.t(sj), f"Keep automation workspaces inside {ctx.t(ctx.code)}.")
    # Legacy browser allowlist file (shipped with webhook.site in late 2025).
    bal = gem / "antigravity" / "browserAllowlist.txt"
    if bal.is_file():
        try:
            hosts = [l.strip() for l in bal.read_text(errors="replace").splitlines() if l.strip() and not l.startswith("#")]
        except OSError:
            hosts = []
        exfil = [h for h in hosts if re.search(r"(webhook\.site|requestbin|pipedream|ngrok|beeceptor|hookbin|interact\.sh|burpcollaborator)", h)]
        if exfil:
            ctx.add("AG-BROWSER-EXFIL-HOST", "high", "personal_files", P, "Browser allowlist contains data-capture hosts",
                    "These hosts exist to receive arbitrary data and were used in a published Antigravity exfiltration "
                    "attack: " + ", ".join(exfil), ctx.t(bal), "Delete those lines.")
    # Admin policy file (documented in changelog; path from third-party docs - treat as best effort).
    for adm in (Path("/Library/Application Support/Antigravity/admin_settings.json"),):
        if adm.exists():
            inv["admin_settings"] = str(adm)
    # agy remote-control LaunchAgent.
    la = ctx.home / "Library/LaunchAgents"
    if la.is_dir():
        agents = [p.name for p in la.glob("*.plist") if re.search(r"(antigravity|agy)", p.name, re.I)]
        if agents:
            ctx.add("AG-LAUNCHAGENT", "medium", "hygiene", P, "An Antigravity background agent starts at login",
                    "`agy remote-control start` installs a LaunchAgent that lets your Google account drive this Mac: "
                    + ", ".join(agents), ctx.t(la), "Run `agy remote-control stop` if you don't use it.")
    # Global instruction files are a persistence target for prompt injection.
    def _nonempty(p: Path) -> bool:
        try:
            return p.is_dir() or p.stat().st_size > 0
        except OSError:
            return False
    inv["global_instruction_files"] = [ctx.t(p) for p in (gem / "GEMINI.md", gem / "AGENTS.md", gem / "config" / "rules")
                                       if _nonempty(p)]
    helper = app / "Contents/Resources/bin/agy-desktop-helper"
    if helper.exists():
        ctx.add("AG-DESKTOP-CONTROL", "info", "personal_files", P, "Antigravity ships a desktop-control (computer use) helper",
                "If Antigravity has Accessibility or Screen Recording permission, agents can see and operate any app, "
                "which bypasses file-level controls.", ctx.t(helper),
                "System Settings > Privacy & Security > Accessibility / Screen & System Audio Recording: grant only while in use.")


# --------------------------------------------------------------------------- #
# Legacy Antigravity IDE (VS Code fork): protobuf blobs in state.vscdb
# --------------------------------------------------------------------------- #
def _varint(b: bytes, i: int) -> Tuple[int, int]:
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return r, i


def pb_fields(b: bytes) -> List[Tuple[int, Any]]:
    i, out = 0, []
    while i < len(b):
        k, i = _varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            n, i = _varint(b, i)
            v = b[i:i + n]
            i += n
        elif t == 1:
            v, i = b[i:i + 8], i + 8
        elif t == 5:
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError("bad wire type")
        out.append((f, v))
    return out


def pb_strings(b: bytes) -> List[str]:
    out = []
    try:
        for f, v in pb_fields(b):
            if isinstance(v, bytes):
                try:
                    s = v.decode()
                    if s and s.isprintable():
                        out.append(s)
                        continue
                except UnicodeDecodeError:
                    pass
                out.extend(pb_strings(v))
    except Exception:
        pass
    return out


def decode_sentinel_map(blob_b64: str) -> Dict[str, bytes]:
    """antigravityUnifiedStateSync.* values: map<string key, {1: base64(inner proto)}>."""
    out: Dict[str, bytes] = {}
    try:
        for f, entry in pb_fields(base64.b64decode(blob_b64)):
            if f != 1 or not isinstance(entry, bytes):
                continue
            key, inner = None, b""
            for ef, ev in pb_fields(entry):
                if ef == 1 and isinstance(ev, bytes):
                    key = ev.decode(errors="replace")
                elif ef == 2 and isinstance(ev, bytes):
                    for vf, vv in pb_fields(ev):
                        if vf == 1 and isinstance(vv, bytes):
                            try:
                                inner = base64.b64decode(vv)
                            except Exception:
                                inner = b""
            if key:
                out[key] = inner
    except Exception:
        pass
    return out


def first_varint(b: bytes) -> Optional[int]:
    try:
        for f, v in pb_fields(b):
            if isinstance(v, int):
                return v
    except Exception:
        pass
    return None


def scan_antigravity_ide(ctx: Ctx) -> None:
    P = "antigravity-ide"
    dbs = []
    for app_dir in ("Antigravity IDE", "Antigravity"):
        db = ctx.home / "Library/Application Support" / app_dir / "User/globalStorage/state.vscdb"
        if db.exists():
            dbs.append((app_dir, db))
    if not dbs:
        return
    inv_all = ctx.inventory.setdefault("antigravity_ide", {})
    for app_dir, db in dbs:
        ev = ctx.t(db)
        try:
            mtime = dt.datetime.fromtimestamp(db.stat().st_mtime).date().isoformat()
        except OSError as e:
            ctx.add("AGIDE-DB-UNREADABLE", "unknown", "hygiene", P, f"Could not read {ev}",
                    f"{e.strerror}. Inside a hardened agent sandbox this is expected; run the scanner from your own terminal.", ev)
            continue
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
            rows = dict(con.execute(
                "select key, value from ItemTable where key in ('antigravityUnifiedStateSync.agentPreferences',"
                "'antigravityUnifiedStateSync.browserPreferences')").fetchall())
            token_keys = [r[0] for r in con.execute(
                "select key from ItemTable where key in ('antigravityUnifiedStateSync.oauthToken','antigravityAuthStatus')"
                " and length(value) > 0").fetchall()]
            con.close()
            if token_keys:
                ctx.add("AGIDE-TOKEN-IN-DB", "medium", "personal_files", P,
                        f"{app_dir}: sign-in state stored in a plain SQLite file",
                        "Any process running as you that can read this database can lift the session "
                        f"(keys present: {', '.join(token_keys)}; values not printed). Other agents must not be able to read it.",
                        ev, "Deny agents read access to this folder (the proposals do this); sign out of IDE installs you no longer use.")
        except Exception as e:
            ctx.add("AGIDE-DB-UNREADABLE", "unknown", "hygiene", P, f"Could not read {ev}", str(e), ev)
            continue
        agent = decode_sentinel_map(rows.get("antigravityUnifiedStateSync.agentPreferences") or "")
        browser = decode_sentinel_map(rows.get("antigravityUnifiedStateSync.browserPreferences") or "")
        tag = f"{app_dir} (state last written {mtime})"
        summary: Dict[str, Any] = {"db": ev, "last_written": mtime}
        if "terminalAutoExecutionPolicySentinelKey" in agent:
            v = AG_AUTO_EXEC.get(first_varint(agent["terminalAutoExecutionPolicySentinelKey"]) or 0, "UNSET")
            summary["terminalAutoExecution"] = v
            if v in ("EAGER", "AUTO"):
                ctx.add("AGIDE-AUTOEXEC", "high" if v == "EAGER" else "medium", "sandbox", P,
                        f"{tag}: terminal auto-execution is {('Turbo' if v == 'EAGER' else 'Auto')}",
                        "The agent runs commands without asking you.", ev, "Settings > Agent > Terminal: set to Off / Request review.")
        for key, label in (("allowAgentAccessNonWorkspaceFilesSentinelKey", "non-workspace file access"),
                           ("allowCascadeAccessGitignoreFilesSentinelKey", "gitignored file access"),
                           ("secureModeSentinelKey", "secure mode")):
            if key in agent:
                val = bool(first_varint(agent[key]) or 0)
                summary[label] = val
                if label != "secure mode" and val:
                    ctx.add("AGIDE-FILE-ACCESS", "high" if "non-workspace" in label else "medium",
                            "scope" if "non-workspace" in label else "personal_files", P,
                            f"{tag}: agent {label} is ON", "", ev, f"Settings > Agent: turn off {label}.")
        if "permission_grants_global" in agent:
            fields = pb_fields(agent["permission_grants_global"]) if agent["permission_grants_global"] else []
            grants = {"allow": [], "deny": [], "ask": []}
            for f, v in fields:
                if isinstance(v, bytes) and f in (1, 2, 3):
                    grants[{1: "allow", 2: "deny", 3: "ask"}[f]].append(v.decode(errors="replace"))
            summary["permission_grants_global"] = grants
            analyze_grants(ctx, grants, P, f"{ev} permission_grants_global")
        for k in ("terminalAllowedCommandsSentinelKey", "terminalDeniedCommandsSentinelKey"):
            if k in agent:
                summary[k.replace("SentinelKey", "")] = pb_strings(agent[k])
        if "browser_js_execution_config_sentinel_key" in browser:
            v = AG_BROWSER_JS.get(first_varint(browser["browser_js_execution_config_sentinel_key"]) or 0, "UNSET")
            summary["browserJsExecution"] = v
            if v in ("TURBO", "MODEL_DECIDES"):
                ctx.add("AGIDE-BROWSER-JS", "medium", "hygiene", P, f"{tag}: browser JS execution is {v}", "", ev,
                        "Set browser JavaScript execution to Always ask or Disabled.")
        if "browser_allowlist_sentinel_key" in browser:
            summary["browserAllowlist"] = pb_strings(browser["browser_allowlist_sentinel_key"])
        inv_all[app_dir] = summary
    app = Path("/Applications/Antigravity IDE.app")
    if app.exists():
        inv_all["version"] = plist_version(app)


# --------------------------------------------------------------------------- #
# agy CLI (~/.gemini/antigravity-cli/settings.json; only non-default values are stored)
# --------------------------------------------------------------------------- #
def scan_agy_cli(ctx: Ctx) -> None:
    P = "agy-cli"
    d = ctx.home / ".gemini" / "antigravity-cli"
    if not d.is_dir():
        return
    sp = d / "settings.json"
    s, err = read_json(sp)
    s = s if isinstance(s, dict) else {}
    ev = ctx.t(sp)
    inv = ctx.inventory.setdefault("agy_cli", {"installed": True})
    mode = s.get("agentMode", "auto (default)")
    perm = s.get("toolPermission", "request-review (default)")
    sandbox = s.get("enableTerminalSandbox")
    inv.update({"agentMode": mode, "toolPermission": perm, "enableTerminalSandbox": sandbox})
    if perm == "always-proceed":
        ctx.add("AGY-ALWAYS-PROCEED", "critical", "sandbox", P, "agy CLI runs every tool call without asking",
                "toolPermission 'always-proceed' is the same as --dangerously-skip-permissions.", f"{ev}: toolPermission",
                "Use proceed-in-sandbox or strict.")
    auto_mode = str(mode).startswith("auto")
    if sandbox is not True and not auto_mode and perm not in ("proceed-in-sandbox", "strict"):
        ctx.add("AGY-SANDBOX-OFF", "medium", "sandbox", P, "agy CLI terminal sandbox is off",
                "enableTerminalSandbox defaults to false outside auto mode, so approved commands run with your full permissions.",
                f"{ev}: enableTerminalSandbox", 'Set "enableTerminalSandbox": true and "toolPermission": "proceed-in-sandbox".')
    if auto_mode:
        ctx.add("AGY-AUTO-MODE", "info", "sandbox", P, "agy CLI uses auto agent mode (forces the sandbox on)",
                "The model decides what runs without asking; the sandbox is what contains it.", f"{ev}: agentMode")
    if s.get("allowNonWorkspaceAccess") is True:
        ctx.add("AGY-NONWORKSPACE", "high", "scope", P, "agy CLI may access files outside the workspace", "",
                f"{ev}: allowNonWorkspaceAccess", "Set it to false.")
    for w in s.get("trustedWorkspaces") or []:
        p = ctx.exp(str(w))
        if p in (Path("/"), ctx.home):
            ctx.add("AGY-TRUST-HOME", "high", "scope", P, f"agy CLI trusts {ctx.t(p)} as a workspace", "", f"{ev}: trustedWorkspaces",
                    "Remove it.")
        elif not is_under(p, ctx.code):
            ctx.add("AGY-TRUST-OUTSIDE", "low", "scope", P, f"agy CLI trusts {ctx.t(p)} (outside {ctx.t(ctx.code)})", "",
                    f"{ev}: trustedWorkspaces", "Remove it if unused.")
    analyze_grants(ctx, s.get("permissions"), P, f"{ev}: permissions")
    tok = d / "antigravity-oauth-token"
    if tok.exists():
        inv["plaintext_token_file"] = ctx.t(tok)


# --------------------------------------------------------------------------- #
# Gemini CLI (shares ~/.gemini)
# --------------------------------------------------------------------------- #
def scan_gemini_cli(ctx: Ctx) -> None:
    P = "gemini-cli"
    gem = ctx.home / ".gemini"
    sp = gem / "settings.json"
    installed = bool(shutil.which("gemini"))
    if not sp.exists() and not installed:
        return
    inv = ctx.inventory.setdefault("gemini_cli", {"installed": installed})
    s, _ = read_json(sp)
    s = s if isinstance(s, dict) else {}
    tools = s.get("tools") or {}
    sandbox = tools.get("sandbox", s.get("sandbox"))
    inv["sandbox"] = sandbox
    if installed and not sandbox and not os.environ.get("GEMINI_SANDBOX"):
        ctx.add("GEM-SANDBOX-OFF", "medium", "sandbox", P, "Gemini CLI sandbox is not enabled",
                "Gemini CLI runs shell tools unsandboxed unless tools.sandbox (or GEMINI_SANDBOX) is set.",
                f"{ctx.t(sp)}: tools.sandbox", 'Set "tools": {"sandbox": true} (macOS Seatbelt) or use --sandbox.')
    if tools.get("autoAccept") is True or s.get("autoAccept") is True:
        ctx.add("GEM-AUTO-ACCEPT", "medium", "sandbox", P, "Gemini CLI auto-accepts tool calls", "", f"{ctx.t(sp)}: tools.autoAccept",
                "Turn it off.")
    inv["mcp_servers"] = analyze_mcp_servers(ctx, s.get("mcpServers"), P, ctx.t(sp))
    tf, _ = read_json(gem / "trustedFolders.json")
    if isinstance(tf, dict):
        trusted = [k for k, v in tf.items() if str(v).startswith("TRUST")]
        inv["trusted_folders"] = [ctx.t(Path(k)) for k in trusted]
        for k in trusted:
            p = real(Path(k))
            if p == Path("/") or (is_under(p, ctx.home) and is_under(ctx.home, p)):
                ctx.add("GEM-TRUST-HOME", "high", "scope", P, f"Gemini CLI trusts {ctx.t(p)}", "", ctx.t(gem / "trustedFolders.json"),
                        "Remove the entry; trust individual projects.")
            elif not is_under(p, ctx.code):
                ctx.add("GEM-TRUST-OUTSIDE", "low", "scope", P, f"Gemini CLI trusts {ctx.t(p)} (outside {ctx.t(ctx.code)})", "",
                        ctx.t(gem / "trustedFolders.json"), "Remove it if unused.")


# --------------------------------------------------------------------------- #
# macOS layer
# --------------------------------------------------------------------------- #
TCC_SERVICES = {
    "kTCCServiceSystemPolicyAllFiles": "Full Disk Access",
    "kTCCServiceSystemPolicyDocumentsFolder": "Documents",
    "kTCCServiceSystemPolicyDesktopFolder": "Desktop",
    "kTCCServiceSystemPolicyDownloadsFolder": "Downloads",
    "kTCCServiceSystemPolicyNetworkVolumes": "Network volumes",
    "kTCCServiceSystemPolicyRemovableVolumes": "Removable volumes",
    "kTCCServiceAccessibility": "Accessibility (control other apps)",
    "kTCCServiceScreenCapture": "Screen recording",
    "kTCCServicePhotos": "Photos",
    "kTCCServiceAddressBook": "Contacts",
    "kTCCServiceCalendar": "Calendar",
}
AGENT_HOST_RE = re.compile(r"(claude|anthropic|antigravity|google\.antigravity|terminal|iterm|ghostty|warp|wezterm|alacritty|kitty|vscode|cursor|windsurf|zed|codex)", re.I)


def scan_macos(ctx: Ctx) -> None:
    P = "macos"
    if not IS_MAC:
        return
    inv = ctx.inventory.setdefault("macos", {})
    inv["version"] = platform.mac_ver()[0]
    fv = run(["fdesetup", "status"])
    if fv:
        inv["filevault"] = fv.splitlines()[0]
        if "Off" in fv:
            ctx.add("OS-FILEVAULT-OFF", "medium", "personal_files", P, "FileVault disk encryption is off",
                    "Anyone with the machine can read every file, regardless of agent settings.", "fdesetup status",
                    "System Settings > Privacy & Security > FileVault: turn on.")
    sip = run(["csrutil", "status"])
    if sip:
        inv["sip"] = sip
        if "disabled" in sip.lower():
            ctx.add("OS-SIP-OFF", "medium", "sandbox", P, "System Integrity Protection is disabled",
                    "SIP protects the OS (including TCC) from tampering by processes running as you or root.", "csrutil status",
                    "Re-enable SIP from Recovery mode (csrutil enable).")
    # TCC grants (needs Full Disk Access to read; usually unreadable from inside an agent sandbox).
    grants: List[str] = []
    readable = False
    for db in (ctx.home / "Library/Application Support/com.apple.TCC/TCC.db", Path("/Library/Application Support/com.apple.TCC/TCC.db")):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = con.execute("select service, client, auth_value from access").fetchall()
            con.close()
            readable = True
        except Exception:
            continue
        for service, client, auth in rows:
            if auth == 2 and service in TCC_SERVICES and AGENT_HOST_RE.search(str(client)):
                grants.append(f"{client}: {TCC_SERVICES[service]}")
    if readable:
        inv["tcc_agent_grants"] = sorted(set(grants))
        fda = [g for g in grants if "Full Disk Access" in g]
        folders = [g for g in grants if any(x in g for x in ("Documents", "Desktop", "Downloads", "Photos", "Contacts", "Calendar"))]
        if fda:
            ctx.add("OS-TCC-FDA", "high", "personal_files", P, "Agent host apps have Full Disk Access",
                    "Full Disk Access lets unsandboxed processes read Mail, Messages, Safari data and more: " + "; ".join(fda),
                    "TCC.db", "System Settings > Privacy & Security > Full Disk Access: switch off for agent apps and terminals.")
        if folders:
            ctx.add("OS-TCC-FOLDERS", "medium", "personal_files", P, "Agent host apps hold personal-folder permissions",
                    "; ".join(folders), "TCC.db", "System Settings > Privacy & Security > Files and Folders: revoke what agents don't need.")
        ax = [g for g in grants if "Accessibility" in g or "Screen" in g]
        if ax:
            ctx.add("OS-TCC-CONTROL", "medium", "personal_files", P, "Agent host apps can control or record the screen",
                    "; ".join(ax), "TCC.db", "Grant Accessibility / Screen Recording only while you use computer-use features.")
    else:
        ctx.add("OS-TCC-UNKNOWN", "unknown", "personal_files", P, "macOS privacy grants (TCC) could not be read",
                "Reading TCC.db needs Full Disk Access, which this process (correctly) lacks. Check manually.",
                "~/Library/Application Support/com.apple.TCC/TCC.db",
                "System Settings > Privacy & Security: review Full Disk Access, Files and Folders, Accessibility and "
                "Screen Recording for Claude, Antigravity, Antigravity IDE and your terminal apps.")
    # Credential file permissions.
    loose = []
    ssh = ctx.home / ".ssh"
    if ssh.is_dir():
        try:
            for f in ssh.iterdir():
                if f.is_file() and not f.name.endswith(".pub") and f.name not in ("known_hosts", "known_hosts.old", "config", "authorized_keys") \
                        and group_or_world_readable(f):
                    loose.append(f"{ctx.t(f)} ({mode_str(f)})")
        except OSError:
            pass
    for rel in (".netrc", ".git-credentials", ".docker/config.json", ".pypirc", ".npmrc", ".vault-token"):
        f = ctx.home / rel
        if f.is_file() and group_or_world_readable(f):
            loose.append(f"{ctx.t(f)} ({mode_str(f)})")
    if loose:
        ctx.add("OS-LOOSE-CRED-PERMS", "medium", "personal_files", P, "Credential files are readable by other local users",
                ", ".join(loose), "file modes", "chmod 600 each file (and chmod 700 ~/.ssh).")
    dc, _ = read_json(ctx.home / ".docker/config.json")
    if isinstance(dc, dict) and any(isinstance(v, dict) and v.get("auth") for v in (dc.get("auths") or {}).values()):
        ctx.add("OS-DOCKER-PLAINTEXT", "low", "personal_files", P, "Docker registry credentials stored in plain text",
                "~/.docker/config.json contains base64 'auth' entries instead of a credential helper.", "~/.docker/config.json",
                'Set "credsStore": "osxkeychain" and log in again.')
    # .env files inside the code folder (names only).
    envs = []
    if ctx.code.is_dir():
        for d in [ctx.code] + list(iter_project_dirs(ctx.code, depth=2)):
            try:
                for e in os.scandir(d):
                    if e.is_file() and (e.name == ".env" or e.name.startswith(".env.")) and not e.name.endswith((".example", ".sample", ".template")):
                        envs.append(ctx.t(Path(e.path)))
            except OSError:
                continue
    if envs:
        ctx.inventory.setdefault("code_folder", {})["env_files"] = envs[:50]
        ctx.add("CODE-ENV-FILES", "low", "personal_files", "code-folder", f"{len(envs)} .env file(s) inside {ctx.t(ctx.code)}",
                "Agents allowed into the code folder can read these secrets. Decide per project whether agents "
                "should see them.", ", ".join(envs[:6]) + (" ..." if len(envs) > 6 else ""),
                "Claude: add Read deny rules such as Read(**/.env*) if agents don't need them. "
                "Antigravity: keep 'Agent Gitignore Access' off and gitignore .env files.")


# --------------------------------------------------------------------------- #
# Live probe (tests the sandbox of whatever process runs this script)
# --------------------------------------------------------------------------- #
def probe(ctx: Ctx) -> Dict[str, Any]:
    res: Dict[str, Any] = {"runner": {}, "results": []}
    for k in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GEMINI_CLI", "GEMINI_SANDBOX", "SANDBOX", "ANTIGRAVITY_AGENT", "AI_AGENT"):
        if os.environ.get(k):
            res["runner"][k] = "set"
    targets = ctx.sensitive_paths("credentials", "agent_secrets", "personal", "browsers_and_password_managers")
    targets.append(("code_folder", ctx.code))
    for cat, p in targets:
        status = "readable"
        try:
            os.stat(str(p))  # EPERM here means even the path's existence is hidden
        except PermissionError:
            res["results"].append({"category": cat, "path": ctx.t(p), "status": "blocked"})
            continue
        except OSError:
            continue  # vanished
        try:
            if p.is_dir():
                with os.scandir(p) as it:
                    next(it, None)  # touch one entry; nothing is recorded
            else:
                fd = os.open(str(p), os.O_RDONLY)
                os.close(fd)  # zero bytes read
        except PermissionError:
            status = "blocked"
        except OSError as e:
            status = f"error: {e.strerror}"
        res["results"].append({"category": cat, "path": ctx.t(p), "status": status})
    leaked = [r for r in res["results"] if r["status"] == "readable" and r["category"] != "code_folder"]
    code_ok = any(r["category"] == "code_folder" and r["status"] == "readable" for r in res["results"])
    runner = ", ".join(res["runner"]) or "no agent markers"
    if leaked:
        ctx.add("PROBE-READABLE", "high", "personal_files", "live-probe",
                f"{len(leaked)} sensitive location(s) were readable from this process ({runner})",
                ", ".join(r["path"] for r in leaked[:15]), "--probe",
                "Tighten the sandbox of the agent that ran this probe; re-run the probe to confirm.")
    else:
        ctx.add("PROBE-ALL-BLOCKED", "pass", "personal_files", "live-probe",
                f"All sensitive locations were blocked from this process ({runner})", evidence="--probe")
    if not code_ok:
        ctx.add("PROBE-CODE-BLOCKED", "medium", "scope", "live-probe", f"{ctx.t(ctx.code)} was not readable from this process",
                "The agent may be too locked down to work on your projects.", "--probe")
    return res


# --------------------------------------------------------------------------- #
# Proposals (hardened configs; never applied by this script)
# --------------------------------------------------------------------------- #
def rule_path(ctx: Ctx, p: Path) -> str:
    return ctx.t(p) if str(p).startswith(str(ctx.home)) else "//" + str(p).lstrip("/")


def looks_like_dir(p: Path) -> bool:
    """Existing paths: real type. Missing ones: 'rules' -> dir, 'GEMINI.md' / '.zshrc' -> file."""
    if p.exists():
        return p.is_dir()
    return not (p.name.startswith(".") or "." in p.name)


def propose_claude(ctx: Ctx) -> Tuple[Dict[str, Any], List[str]]:
    cur = ctx.raw.get("claude_user_settings") or {}
    s = copy.deepcopy(cur)
    notes: List[str] = []
    versions = ctx.inventory.get("claude_code", {}).get("versions", {})
    min_v = min((parse_version(v) for v in versions.values() if parse_version(v)), default=None)

    sb = s.setdefault("sandbox", {})
    sb["enabled"] = True
    sb["allowUnsandboxedCommands"] = False
    sb["failIfUnavailable"] = True
    fs = sb.setdefault("filesystem", {})
    deny_read = fs.setdefault("denyRead", [])
    if not any(strip_glob(str(d)) in ("~", "~/") for d in deny_read):
        deny_read.insert(0, "~/")
        notes.append("Sandbox: deny reading all of ~ by default, then re-allow only the folders below.")
    allow_read = fs.setdefault("allowRead", [])
    tl = ctx.sensitive["toolchain_read_allowlist"]
    secrets = [p for c, p in ctx.sensitive_paths("credentials", "agent_secrets", "personal", "browsers_and_password_managers")]
    wanted, skipped = [ctx.t(ctx.code)], []
    for p in (ctx.exp(x) for x in tl["paths"]):
        if not p.exists():
            continue
        # allowRead beats denyRead, so never re-open a folder that holds a credential.
        if any(is_under(s, p) for s in secrets):
            skipped.append(ctx.t(p))
            continue
        wanted.append(ctx.t(p))
    for w in wanted:
        if w not in allow_read:
            allow_read.append(w)
    if skipped:
        notes.append("Not re-allowed because they contain credentials: " + ", ".join(skipped))
    notes.append("Sandbox allowRead: " + ", ".join(allow_read) + ". Add a folder here if a tool breaks with 'Operation not permitted'. "
                 "allowRead beats denyRead, so keep entries narrow (specific tool caches, not all of ~/Library/Caches).")
    # Flag allowRead entries that re-open a sensitive location (allowRead takes precedence over denyRead).
    reopened = [ctx.t(p) for c, p in ctx.sensitive_paths("credentials", "agent_secrets", "personal", "browsers_and_password_managers")
                if any(is_under(p, ctx.exp(a)) for a in allow_read)]
    if reopened:
        notes.append("WARNING: existing allowRead entries re-open sensitive paths: " + ", ".join(reopened))

    perms = s.setdefault("permissions", {})
    if perms.get("defaultMode") == "bypassPermissions":
        perms["defaultMode"] = "default"
        notes.append("permissions.defaultMode: bypassPermissions -> default.")
    perms["disableBypassPermissionsMode"] = "disable"
    if min_v is None or min_v >= (2, 1, 257):
        perms["blockReadsOutsideWorkingDirectories"] = True
        notes.append("blockReadsOutsideWorkingDirectories: Claude's own Read/Grep/Glob tools stop at the working folder. "
                     "Verify personal skills still load afterwards.")
    else:
        notes.append(f"Update Claude Code (oldest install {vstr(min_v)}) to 2.1.257+ to enable blockReadsOutsideWorkingDirectories.")
    allow = perms.get("allow") or []
    removed = [r for r in allow if re.match(r"^Bash(\(\s*(\*|:\*)?\s*\))?$", str(r)) or str(r) in ("Read", "Read(*)", "Read(//**)", "Edit", "Edit(//**)", "Write")]
    if removed:
        perms["allow"] = [r for r in allow if r not in removed]
        notes.append("Removed over-broad allow rules: " + ", ".join(map(str, removed)))
    deny = perms.setdefault("deny", [])
    for cat, p in ctx.sensitive_paths("credentials", "agent_secrets", "personal", "browsers_and_password_managers"):
        rp = rule_path(ctx, p)
        for rule in ((f"Read({rp}/**)", f"Edit({rp}/**)") if p.is_dir() else (f"Read({rp})", f"Edit({rp})")):
            if rule not in deny:
                deny.append(rule)
    tamper = ctx.sensitive["agent_config_tamper_targets"]
    for raw in tamper["antigravity"] + tamper["shell_startup"]:
        p = ctx.exp(raw)
        rule = f"Edit({rule_path(ctx, p)}/**)" if looks_like_dir(p) else f"Edit({rule_path(ctx, p)})"
        if rule not in deny:
            deny.append(rule)
    notes.append("Deny rules: block Read/Edit of credentials and personal folders, and Edit of Antigravity config and shell startup files.")
    s.pop("skipDangerousModePermissionPrompt", None)
    if cur.get("enableAllProjectMcpServers"):
        s.pop("enableAllProjectMcpServers", None)
        notes.append("Removed enableAllProjectMcpServers.")
    return s, notes


def propose_antigravity(ctx: Ctx) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    cur = ctx.raw.get("antigravity_config")
    if not isinstance(cur, dict):
        return None, []
    cfg = copy.deepcopy(cur)
    us = cfg.setdefault("userSettings", {})
    notes: List[str] = []

    def setv(k: str, v: Any, why: str) -> None:
        if us.get(k) != v:
            notes.append(f"{k}: {us.get(k, '(unset)')} -> {v}. {why}")
            us[k] = v

    legacy = " ('Previous' permission-system key; ignored harmlessly where the preset governs.)"
    setv("enableTerminalSandbox", True, "Run agent terminal commands in the macOS sandbox." + legacy)
    setv("sandboxAllowNetwork", False, "Block network from sandboxed commands (approve installs case by case)." + legacy)
    ae = ag_enum(us.get("autoExecutionPolicy"), AG_AUTO_EXEC, "CASCADE_COMMANDS_AUTO_EXECUTION_")
    if ae not in ("OFF", "PROCEED_IN_SANDBOX"):
        setv("autoExecutionPolicy", "CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX", "Auto-run only inside the sandbox." + legacy)
    pr = ag_enum(us.get("permissionPreset"), AG_PRESET, "AGENT_PERMISSION_PRESET_")
    if pr != "DEFAULT":
        setv("permissionPreset", "AGENT_PERMISSION_PRESET_DEFAULT",
             "Default = commands run in the sandbox; anything outside it asks. Stored explicitly so app-default changes can't loosen it.")
    setv("nonWorkspaceFileAccessPolicy", "AGENT_SETTING_POLICY_DENY", "Agents cannot touch files outside the project folder." + legacy)
    setv("allowAgentAccessNonWorkspaceFiles", False, "Older switch for the same boundary.")
    if us.get("allowAgentAccessGitignoreFiles") is True:
        setv("allowAgentAccessGitignoreFiles", False, "Keep .env and other ignored secrets away from agents.")
    js = ag_enum(us.get("browserJsExecutionPolicy"), AG_BROWSER_JS, "BROWSER_JS_EXECUTION_POLICY_")
    if js not in ("DISABLED", "ALWAYS_ASK"):
        setv("browserJsExecutionPolicy", "BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK", "Review page scripts before they run.")
    if us.get("remoteControlEnabled") is True:
        setv("remoteControlEnabled", False, "Turn back on only if you drive agents remotely.")
    if us.get("enableAdc") is True:
        setv("enableAdc", False, "Do not hand agents your gcloud identity.")
    g = us.setdefault("globalPermissionGrants", {})
    allow = g.get("allow") or []
    broad = [x for x in allow if re.match(r"^[a-z_]+\((\*|/|~|" + re.escape(str(ctx.home)) + r")\)$", str(x)) or str(x) == "*"]
    if broad:
        g["allow"] = [x for x in allow if x not in broad]
        notes.append("Removed wildcard grants: " + ", ".join(map(str, broad)))
    deny = g.setdefault("deny", [])
    added = 0
    for cat, p in ctx.sensitive_paths("credentials", "agent_secrets", "personal", "browsers_and_password_managers"):
        for rule in (f"read_file({p})", f"write_file({p})"):
            if rule not in deny:
                deny.append(rule)
                added += 1
    for raw in ctx.sensitive["agent_config_tamper_targets"]["claude"] + ctx.sensitive["agent_config_tamper_targets"]["shell_startup"]:
        p = ctx.exp(raw)  # write_file(<dir>) applies recursively; missing paths are included so agents can't create them
        if f"write_file({p})" not in deny:
            deny.append(f"write_file({p})")
            added += 1
    if added:
        notes.append(f"Added {added} deny grants for credentials, personal folders, Claude config and shell startup files.")
    out_of_scope = [x for x in g.get("allow") or [] if re.match(r"^(read|write)_file\((.+)\)$", str(x))
                    and not is_under(ctx.exp(re.match(r"^(read|write)_file\((.+)\)$", str(x)).group(2)), ctx.code)]
    if out_of_scope:
        notes.append("Review (kept, your call): allow grants outside the code folder, which are also mounted into the "
                     "sandbox - " + ", ".join(map(str, out_of_scope)))
    if us.get("secureModeEnabled") is not True:
        notes.append("Optional maximum lock-down (not applied): secureModeEnabled true (Strict mode) forces the sandbox on "
                     "with no network and review for every terminal command.")
    return cfg, notes


def write_proposals(ctx: Ctx, outdir: Path) -> Dict[str, Any]:
    outdir.mkdir(parents=True, exist_ok=True)
    result: Dict[str, Any] = {}
    if ctx.inventory.get("claude_code", {}).get("installed"):
        new, notes = propose_claude(ctx)
        cur = ctx.raw.get("claude_user_settings") or {}
        target = ctx.raw.get("claude_user_settings_path")
        f = outdir / "claude-settings.proposed.json"
        f.write_text(json.dumps(new, indent=2) + "\n")
        diff = "".join(difflib.unified_diff(json.dumps(cur, indent=2).splitlines(True), json.dumps(new, indent=2).splitlines(True),
                                            fromfile=ctx.t(target) if target else "settings.json", tofile="proposed"))
        (outdir / "claude-settings.diff").write_text(diff)
        result["claude_code"] = {"proposed_file": str(f), "diff_file": str(outdir / "claude-settings.diff"),
                                 "target": str(target) if target else None, "notes": notes}
    new_ag, notes = propose_antigravity(ctx)
    if new_ag is not None:
        cur = ctx.raw.get("antigravity_config") or {}
        target = ctx.raw.get("antigravity_config_path")
        f = outdir / "antigravity-config.proposed.json"
        f.write_text(json.dumps(new_ag, indent=2) + "\n")
        diff = "".join(difflib.unified_diff(json.dumps(cur, indent=2).splitlines(True), json.dumps(new_ag, indent=2).splitlines(True),
                                            fromfile=ctx.t(target) if target else "config.json", tofile="proposed"))
        (outdir / "antigravity-config.diff").write_text(diff)
        result["antigravity"] = {"proposed_file": str(f), "diff_file": str(outdir / "antigravity-config.diff"),
                                 "target": str(target) if target else None, "notes": notes,
                                 "apply_requires": "Quit Antigravity first; it rewrites config.json while running."}
    return result


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def goal_status(findings: List[Finding], goal: str) -> str:
    sev = [f.severity for f in findings if f.goal == goal]
    if "critical" in sev or "high" in sev:
        return "AT RISK"
    if "medium" in sev:
        return "PARTIAL"
    if "unknown" in sev and not any(s == "pass" for s in sev):
        return "UNVERIFIED"
    return "OK"


def to_markdown(ctx: Ctx, meta: Dict[str, Any]) -> str:
    fs = sorted(ctx.findings, key=lambda f: (SEVERITIES.index(f.severity), f.product, f.id))
    lines = [f"# Agent security scan - {meta['generated']}", "",
             f"Home: `{meta['home']}` - code folder: `{meta['code_dir']}`", "", "## Goals", "",
             "| Goal | Status |", "|---|---|"]
    for g, label in GOALS.items():
        lines.append(f"| {label} | {goal_status(ctx.findings, g)} |")
    counts = {s: sum(1 for f in ctx.findings if f.severity == s) for s in SEVERITIES}
    lines += ["", "Findings: " + ", ".join(f"{k} {v}" for k, v in counts.items() if v), ""]
    for sev in SEVERITIES:
        group = [f for f in fs if f.severity == sev]
        if not group:
            continue
        lines += [f"## {sev.upper()}", ""]
        for f in group:
            lines.append(f"- **[{f.id}] {f.title}** ({f.product}, goal: {f.goal})")
            if f.detail:
                lines.append(f"  - {f.detail}")
            if f.evidence:
                lines.append(f"  - Evidence: `{f.evidence}`")
            if f.fix:
                lines.append(f"  - Fix: {f.fix}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only security audit of Claude / Antigravity agent setups.")
    ap.add_argument("--home", default=str(Path.home()), help="Home directory to audit (default: current user's).")
    ap.add_argument("--code-dir", default=None, help="The one folder agents should be able to reach (default: ~/Code).")
    ap.add_argument("--output", default=None, help="Write the full JSON report here.")
    ap.add_argument("--markdown", default=None, help="Write a Markdown summary here.")
    ap.add_argument("--propose-dir", default=None, help="Write hardened config proposals + diffs to this folder.")
    ap.add_argument("--probe", action="store_true", help="Test which sensitive paths THIS process can open (zero bytes read).")
    ap.add_argument("--skip", default="", help="Comma list of sections to skip: claude,desktop,antigravity,ide,agy,gemini,macos")
    args = ap.parse_args()

    home = Path(args.home).expanduser().resolve()
    if args.code_dir:
        code = Path(args.code_dir).expanduser().resolve()
    else:
        code = next((home / n for n in ("Code", "code", "Developer", "dev", "src", "Projects", "projects") if (home / n).is_dir()), home / "Code")
    sensitive, err = read_json(SENSITIVE_REF)
    if not isinstance(sensitive, dict):
        print(f"cannot load {SENSITIVE_REF}: {err}", file=sys.stderr)
        return 2
    ctx = Ctx(home, code, sensitive)
    if not code.is_dir():
        ctx.add("CODE-DIR-MISSING", "unknown", "scope", "scanner", f"Code folder {ctx.t(code)} does not exist",
                "Pass --code-dir with the folder agents should be allowed to use.", "--code-dir")
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    sections = [("claude", scan_claude_code), ("desktop", scan_claude_desktop), ("antigravity", scan_antigravity),
                ("ide", scan_antigravity_ide), ("agy", scan_agy_cli), ("gemini", scan_gemini_cli), ("macos", scan_macos)]
    for name, fn in sections:
        if name in skip:
            continue
        try:
            fn(ctx)
        except Exception as e:  # keep going; report the failure
            ctx.errors.append(f"{name}: {type(e).__name__}: {e}")
            ctx.add("SCANNER-ERROR", "unknown", "hygiene", "scanner", f"Section '{name}' failed", f"{type(e).__name__}: {e}")
    probe_res = probe(ctx) if args.probe else None
    proposals = write_proposals(ctx, Path(args.propose_dir).expanduser()) if args.propose_dir else None

    meta = {"generated": dt.datetime.now().isoformat(timespec="seconds"), "home": str(home), "code_dir": ctx.t(code),
            "platform": platform.platform(), "python": platform.python_version(), "scanner_version": "1.0.0"}
    report = {
        "meta": meta,
        "goals": {g: {"label": l, "status": goal_status(ctx.findings, g)} for g, l in GOALS.items()},
        "counts": {s: sum(1 for f in ctx.findings if f.severity == s) for s in SEVERITIES},
        "findings": [asdict(f) for f in sorted(ctx.findings, key=lambda f: (SEVERITIES.index(f.severity), f.product, f.id))],
        "inventory": ctx.inventory,
        "probe": probe_res,
        "proposals": proposals,
        "errors": ctx.errors,
    }
    text = json.dumps(report, indent=2, default=str)
    if args.output:
        Path(args.output).expanduser().write_text(text + "\n")
    if args.markdown:
        Path(args.markdown).expanduser().write_text(to_markdown(ctx, meta) + "\n")
    if not args.output:
        print(text)
    else:
        print(f"Report: {args.output}")
        for g, v in report["goals"].items():
            print(f"  {v['label']}: {v['status']}")
        print("  " + ", ".join(f"{k}={v}" for k, v in report["counts"].items() if v))
        if proposals:
            print(f"Proposals: {args.propose_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
