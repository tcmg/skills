# `gdpr-auditor` — Universal GDPR & ePrivacy Technical Compliance Skill

An open [Agent Skill](https://agentskills.io) for **Google Antigravity**, **Claude Code**, **OpenAI Codex**, **Gemini CLI**, and **Cursor** that performs an end-to-end **technical and architectural GDPR & ePrivacy Directive (Art. 5(3)) compliance audit** on web applications and backend servers.

Unlike static legal checklists, `gdpr-auditor` combines **static codebase/schema analysis** with **active 3-state headless browser inspection** to verify what your application actually does in production.

---

## Quick Install

### 1. Universal Installer (`npx skills` — Antigravity, Claude Code, Codex, Cursor)
```bash
npx skills add tcmg/skills
```

### 2. Google Antigravity (`agy` / Antigravity IDE)
Copy or clone the skill into your global Antigravity skills directory or `.agents/skills/` inside any repository:
```bash
git clone https://github.com/tcmg/skills.git /tmp/tcmg-skills
cp -r /tmp/tcmg-skills/skills/gdpr-auditor ~/.gemini/config/skills/gdpr-auditor
```

### 3. Claude Code
```bash
git clone https://github.com/tcmg/skills.git /tmp/tcmg-skills
cp -r /tmp/tcmg-skills/skills/gdpr-auditor ~/.claude/skills/gdpr-auditor
```

### 4. OpenAI Codex
```bash
# Prompt Codex:
$skill-installer install https://github.com/tcmg/skills

# Or copy to your global Codex skills directory:
cp -r skills/gdpr-auditor ~/.codex/skills/gdpr-auditor
```

---

## What It Audits (3 Core Pillars)

### Pillar A: Consumer-Facing Frontend UI & Active Consent Runtime
1. **Static Consumer Route & Form Discovery**:
   - Separates consumer-facing routes from internal/admin dashboards.
   - Audits every PII collection `<form>` for **pre-ticked consent checkboxes** (`defaultChecked`, `checked={true}` — violating GDPR Art. 7 & CJEU *Planet49*), bundled consent, and missing Privacy Policy links (Art. 13).
   - Verifies self-service Data Subject Rights (DSAR) UI controls: **Delete Account** (Art. 17), **Export Data** (Art. 20), and **Revoke Cookie Consent** (Art. 7(3)).
2. **Active 3-State Browser Inspection (`scripts/inspect_frontend_runtime.mjs`)**:
   - **State 1 — Zero-Interaction Pre-Consent Baseline**: Captures all cookies (`context.cookies()`), `localStorage`, `sessionStorage`, and third-party network beacons fired *before* the user touches the consent banner. Flags analytics (`_ga`, `_fbp`, `ph_`, `mp_`, `_hj`) and third-party IP leaks (`fonts.googleapis.com`).
   - **State 2 — Consent Banner & Dark Patterns (EDPB 03/2022)**: Checks whether a 1-click **"Reject All"** button exists on the first layer alongside **"Accept All"**, and measures bounding-box area and styling symmetry.
   - **State 3 — Post-Rejection Enforcement**: Programmatically clicks **"Reject All"**, reloads the page, and verifies that non-essential cookies and trackers remain blocked.

### Pillar B: Database Rules, Schema & Data Lifecycle
- **PII vs. Art. 9 Special Category Inventory**: Scans Prisma, Drizzle, SQL migrations, TypeORM, and Mongoose schemas for Standard PII (`email`, `phone`, `ip_address`, `dob`) and **Art. 9 Special Category Data** (`health`, `biometric`, `genetic`, `religion`, `political`).
- **Row-Level Security & Access Rules (Art. 25 & 32)**: Audits Supabase/PostgreSQL RLS policies (`USING (true)`) and Firebase `firestore.rules` / `storage.rules` (`allow read: if true`, `allow read: if request.auth != null`) to enforce strict row ownership.
- **Retention & Right to Erasure Cascade (Art. 5(1)(e) & Art. 17)**: Detects "soft-delete traps" (`deleted_at` set without hard-purge or PII anonymization) and traces account deletion across foreign keys, object storage buckets, and search indexes.

### Pillar C: Backend Data Handling, Logging & Subprocessor Egress
- **Unredacted PII in Logs (Art. 5(1)(f) & 32)**: Flags `console.log(req.body)`, unredacted structured logs, and error trackers configured with `sendDefaultPii: true`.
- **Subprocessor & Privacy Policy Cross-Check (Art. 13 & 28)**: Detects outbound SDKs (OpenAI, Anthropic, Gemini, Stripe, SendGrid, Resend, Sentry, PostHog, Segment, Mixpanel, HubSpot, Intercom) and checks whether each vendor is disclosed in the repository's Privacy Policy page.

---

## Standalone CLI Usage

You can also run both bundled audit scripts directly from your terminal or CI pipeline:

```bash
# 1. Static codebase, UI route, database rules & subprocessor scanner (Zero dependencies, Python 3)
python3 skills/gdpr-auditor/scripts/scan_gdpr_codebase.py \
  --workspace /path/to/your/webapp \
  --output /tmp/gdpr_static_scan.json

# 2. Active 3-state browser runtime inspector (Uses Playwright Chromium if installed, or HTTP fallback)
node skills/gdpr-auditor/scripts/inspect_frontend_runtime.mjs \
  --url http://localhost:3000 \
  --output /tmp/gdpr_runtime_audit.json \
  --screenshot-dir /tmp/gdpr_screenshots
```

---

## Also in this repo: `agent-security-auditor`

Audits and hardens the local security setup of your AI coding agents on macOS: **Claude Code** (CLI and the desktop app's Code tab), **Claude Desktop**, **Google Antigravity** (app, IDE and `agy` CLI) and **Gemini CLI**. It checks three goals:

1. Personal files and credentials stay private.
2. Agents run sandboxed.
3. Agents can reach your code folder (e.g. `~/Code`) and little else.

What it does:
- A read-only scanner covers each tool's settings:
  - sandbox mode, permission modes and allow/deny rules
  - MCP servers, hooks and automations
  - remembered permission grants
  - plaintext tokens and remote control
  - macOS privacy grants
- A **live probe** shows which sensitive paths the agent's own sandbox can actually open (zero bytes read).
- It proposes hardened configs (diffs, nothing applied automatically) and walks you through applying and verifying them.

```bash
cp -r skills/agent-security-auditor ~/.claude/skills/agent-security-auditor        # Claude Code
cp -r skills/agent-security-auditor ~/.gemini/config/skills/agent-security-auditor  # Antigravity
```

```bash
# Standalone (Python 3.8+ stdlib only)
python3 skills/agent-security-auditor/scripts/scan_agent_security.py --code-dir ~/Code --probe \
  --output /tmp/agent_audit.json --markdown /tmp/agent_audit.md --propose-dir /tmp/agent_audit_proposals

# Self-tests (fixture home with deliberately risky configs)
python3 skills/agent-security-auditor/tests/test_scanner.py
```

---

## Repository Structure

```text
skills/
├── README.md
├── LICENSE
└── skills/
    ├── agent-security-auditor/      # AI agent lock-down auditor (Claude + Antigravity)
    │   ├── SKILL.md
    │   ├── scripts/scan_agent_security.py
    │   ├── references/              # claude_code_hardening.md, antigravity_hardening.md,
    │   │                            # macos_os_layer.md, sensitive_paths.json
    │   ├── resources/audit_report_template.md
    │   └── tests/test_scanner.py
    └── gdpr-auditor/                # Universal Agent Skill package
        ├── SKILL.md                 # Multi-phase orchestrator instructions
        ├── scripts/
        │   ├── scan_gdpr_codebase.py
        │   └── inspect_frontend_runtime.mjs
        ├── references/
        │   ├── gdpr_technical_checklist.md
        │   └── known_tracker_domains.json
        └── resources/
            └── audit_report_template.md
```

---

## Disclaimer

This skill audits **technical, architectural, and UI/UX implementation** against GDPR and ePrivacy requirements. It does not constitute formal legal advice; items requiring legal text evaluation (such as Legitimate Interest Assessments or Data Processing Agreements) are flagged as `NEEDS_LEGAL_REVIEW`.
