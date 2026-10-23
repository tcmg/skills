---
name: gdpr-auditor
description: >-
  Comprehensive GDPR and ePrivacy technical compliance auditor for web applications
  and servers. Actively inspects consumer-facing frontend UI (consent banners, dark
  patterns, pre-consent cookies/trackers, collection forms, self-service DSAR controls),
  analyzes database schemas, security rules (RLS/Firestore), retention/erasure cascades,
  and traces backend PII logging and third-party subprocessor egress.
---

# GDPR & ePrivacy Technical Compliance Auditor

Use this skill when the user asks to verify whether a website, web application, or backend server is **GDPR compliant**, audit privacy/cookie behavior, inspect database rules for PII protection, or review data handling and retention practices.

> [!IMPORTANT]
> **Technical vs. Legal Scope**: This skill verifies **technical, architectural, and UI/UX compliance** with GDPR and the ePrivacy Directive (Art. 5(3)). Where compliance depends on legal adequacy (e.g., whether a Legitimate Interest Assessment or Data Processing Agreement is legally sufficient), flag the item as **`NEEDS_LEGAL_REVIEW`** rather than declaring legal certainty.

---

## Audit Architecture (4 Phases)

Execute the audit systematically across four phases:

1. **Phase 1 — Static Codebase, UI Route & Database Scan**: Run [`scripts/scan_gdpr_codebase.py`](./scripts/scan_gdpr_codebase.py) and inspect source files to inventory consumer-facing UI routes, PII collection forms, database schemas/rules, retention/deletion logic, backend logging sinks, and third-party subprocessors.
2. **Phase 2 — Active Frontend Runtime Inspection**: Run [`scripts/inspect_frontend_runtime.mjs`](./scripts/inspect_frontend_runtime.mjs) (or use the browser tool) against the live application URL to verify pre-consent zero-interaction behavior, cookie banner dark patterns, and post-rejection tracker blocking.
3. **Phase 3 — Deep-Dive Architectural Verification**: Trace high-risk data flows (Right to Erasure cascade, Row-Level Security / Firestore rules, unredacted PII in logs, undisclosed subprocessors). For large repositories, delegate pillars to parallel subagents.
4. **Phase 4 — Compliance Report Generation**: Synthesize all findings into a structured `gdpr_compliance_report.md` artifact using [`resources/audit_report_template.md`](./resources/audit_report_template.md) and [`references/gdpr_technical_checklist.md`](./references/gdpr_technical_checklist.md).

---

## Phase 1: Static Codebase, Consumer UI & Database Audit

### Step 1.1: Run the Automated Codebase Scanner
Run the bundled static scanner (resolve `scripts/scan_gdpr_codebase.py` relative to this `SKILL.md` file's directory, `<skill_dir>`) against the target workspace root:

```bash
python3 <skill_dir>/scripts/scan_gdpr_codebase.py \
  --workspace <workspace_root> \
  --output /tmp/gdpr_static_scan.json
```

Read `/tmp/gdpr_static_scan.json` to review discovered routes, PII fields, database rules, logging sinks, and third-party SDKs.

### Step 1.2: Verify Consumer-Facing Frontend UI (Static Pass)
Using the scanner output and targeted file reads, verify:

1. **Consumer Route Classification**:
   - Distinguish **consumer-facing routes** (marketing pages, signup/login, checkout, user dashboard, profile settings) from internal admin/ops routes.
2. **Lawful Collection & Consent UI (Art. 6, 7, 13)**:
   - Inspect every consumer `<form>`, input component, and validation schema (`zod`, `yup`, etc.) collecting PII:
     - **No Pre-Ticked Boxes (Art. 7 / C-673/17 Planet49)**: Flag any marketing, newsletter, analytics, or third-party sharing checkbox with `defaultChecked`, `checked={true}`, or initial state set to `true`.
     - **Granular Consent**: Ensure Terms of Service acceptance is not bundled into a single checkbox with marketing consent.
     - **Point-of-Collection Disclosure (Art. 13)**: Verify forms collecting PII link visibly to the Privacy Policy and state the purpose of collection.
3. **Data Subject Rights (DSAR) Self-Service UI (Art. 15, 17, 20)**:
   - Check consumer account settings for:
     - **Right to Erasure (Art. 17)**: Self-service "Delete Account" button and confirmation flow.
     - **Right to Data Portability (Art. 20) & Access (Art. 15)**: Self-service "Export / Download My Data" control (JSON/CSV export).
     - **Right to Withdraw Consent (Art. 7(3))**: Persistent footer link or settings toggle allowing users to re-open cookie preferences and revoke consent as easily as they gave it.

### Step 1.3: Verify Database Rules, Schema & Data Lifecycle
Inspect ORM schemas (`schema.prisma`, Drizzle, TypeORM, Mongoose), SQL migrations, and security rules (`firestore.rules`, Supabase RLS policies):

1. **PII & Special Category Inventory (Art. 5 & Art. 9)**:
   - Classify fields into **Standard PII** (`email`, `phone`, `full_name`, `ip_address`, `location`, `user_agent`, `payment_info`) and **Special Category Data (Art. 9)** (`health`, `biometric`, `genetic`, `political`, `religion`, `sexual_orientation`, `ethnic_origin`).
   - Flag any Special Category Data lacking explicit consent tracking and field-level/column-level encryption.
2. **Database Access Rules & Row-Level Security (Art. 25 & 32)**:
   - **Supabase / PostgreSQL RLS**: Check if tables containing PII have `ENABLE ROW LEVEL SECURITY` and policies enforcing row ownership (`auth.uid() = user_id`). Flag `USING (true)` on `SELECT`/`UPDATE`/`DELETE` for PII tables.
   - **Firebase / Firestore / Storage Rules**: Flag `allow read: if true` or `allow read: if request.auth != null` (any logged-in user can read all other users' documents) on collections containing PII.
3. **Storage Limitation & Retention (Art. 5(1)(e))**:
   - Flag tables storing raw IP addresses, session logs, audit trails, or unverified signups without an `expires_at` / TTL index or a scheduled cleanup cron job.
4. **Right to Erasure Completeness (Art. 17)**:
   - Trace the account deletion endpoint (`DELETE /api/user`, `deleteAccount`, etc.) end-to-end:
     - **Soft-Delete Trap**: Does deletion only set `deleted_at = NOW()` or `is_active = false` while retaining plaintext `email`, `name`, `phone`, and `ip_address` indefinitely? If soft-delete is used for fraud/accounting grace periods, verify there is an automated hard-purge or PII anonymization job after a bounded window (e.g., 30 days).
     - **Cascade & External Sinks**: Verify foreign keys (`ON DELETE CASCADE`), object storage buckets (S3/GCS avatars/uploads), and third-party search/analytics indexes (Algolia, Typesense, Stripe customer records) are purged or anonymized on erasure.

### Step 1.4: Verify Backend Data Handling, Logging & Subprocessor Egress
1. **Unredacted PII in Logs (Art. 5(1)(f) & 32)**:
   - Flag `console.log`, `logger.info`, `logger.error`, or request-logging middleware that dumps raw `req.body`, `req.headers`, `user` objects, email addresses, or IP addresses without redaction.
   - Check error monitoring SDK configs (Sentry, Datadog, LogRocket, Highlight) for `sendDefaultPii: true` or unmasked session replay (`maskAllInputs: false`).
2. **Third-Party Subprocessor Egress & Cross-Border Transfers (Art. 28 & 44)**:
   - Trace all outbound API calls and SDK integrations receiving user data (e.g., OpenAI/Anthropic LLM prompts, SendGrid/Resend, HubSpot, Segment, Stripe).
   - Verify data minimization: Are full database user rows sent to external APIs (especially LLM APIs) when only anonymized/pseudonymized fields are needed?
   - Cross-check discovered third-party SDKs against the application's Privacy Policy / Cookie Policy routes to flag **undisclosed subprocessors**.

---

## Phase 2: Active Frontend Runtime Inspection

Whenever the web application is running locally (or a staging/production URL is provided) — or can be started locally on `127.0.0.1` / `localhost` — perform an **active runtime inspection** of the consumer-facing frontend.

### Step 2.1: Run the Headless Browser Runtime Inspector
Execute [`scripts/inspect_frontend_runtime.mjs`](./scripts/inspect_frontend_runtime.mjs) (resolved relative to this `SKILL.md` file's directory, `<skill_dir>`) against the target URL:

```bash
node <skill_dir>/scripts/inspect_frontend_runtime.mjs \
  --url http://localhost:3000 \
  --output /tmp/gdpr_runtime_audit.json \
  --screenshot-dir /tmp/gdpr_screenshots
```

*(Note: If Playwright is not installed in the environment, the script automatically falls back to a static HTTP + HTML/header/cookie inspection mode and reports what requires a full browser).*

### Step 2.2: Evaluate the 3 Runtime Compliance States
Inspect `/tmp/gdpr_runtime_audit.json` (and screenshots in `/tmp/gdpr_screenshots` using `read_file` if generated):

1. **State 1 — Zero-Interaction Baseline (Pre-Consent)**:
   - **Non-Essential Cookies Before Consent (ePrivacy Art. 5(3))**: Any analytics (`_ga`, `_gid`, `_fbp`, `mp_`, `ph_`, `_hj`), advertising, or tracking cookie set before the user clicks "Accept" is a **CRITICAL violation**.
   - **Pre-Consent Network Beacons & IP Leakage**: Any request to known tracking domains (see [`references/known_tracker_domains.json`](./references/known_tracker_domains.json)) or third-party asset CDNs like `fonts.googleapis.com` / `fonts.gstatic.com` (ruled unlawful without consent by German/EU courts, e.g., LG München, due to automatic IP address disclosure to third parties) on initial page load is flagged.
   - **Local/Session Storage**: Check for tracking IDs or unencrypted PII written to `localStorage` or `sessionStorage` prior to consent.
   - **Cookie Security Flags (Art. 32)**: Verify session/auth cookies use `Secure`, `HttpOnly`, and `SameSite=Lax` or `Strict`.

2. **State 2 — Consent Banner UX & Dark Patterns (EDPB Guidelines 03/2022)**:
   - **Missing Banner**: If trackers/non-essential cookies exist and no consent banner is rendered, flag as **CRITICAL**.
   - **First-Layer "Reject All"**: Verify a clear "Reject All" / "Decline" / "Only Necessary" button exists on the **very first layer** of the banner. Forcing users to click "Manage Preferences" -> "Confirm" (2+ clicks to reject vs. 1 click to accept) is a dark pattern violation.
   - **Visual Symmetry**: Compare button dimensions, contrast, and styling. Flag deceptive patterns where "Accept All" is a prominent button and "Reject" is a tiny text link or hidden in body copy.

3. **State 3 — Post-Rejection Enforcement**:
   - After clicking "Reject All" and navigating to another consumer route:
     - Verify no new tracking cookies or third-party analytics requests are fired.
     - Verify the consent choice was persisted so the banner does not repeatedly nag the user on every page load.

---

## Phase 3: Parallel Subagent Deep-Dive (For Large Codebases)

If the codebase has more than ~30 source files, launch up to **3 parallel `research` subagents** (`invoke_subagent`) to keep your main context lean:

1. **`Frontend & Consent UI Auditor`**: Reviews consumer routes, signup/checkout forms, cookie banner implementation, script gating, and runtime inspection output.
2. **`Database, RLS & Retention Auditor`**: Reviews schemas, RLS/Firestore rules, encryption at rest, TTL jobs, and traces the `DELETE` account cascade across all tables and storage buckets.
3. **`Backend Data-Flow & Egress Auditor`**: Traces API handlers, logging middleware, Sentry/observability configs, LLM/third-party SDK calls, and compares subprocessors against the privacy policy text.

---

## Phase 4: Generate the GDPR Compliance Audit Report

Compile all verified findings into a comprehensive artifact named `gdpr_compliance_report.md` in the conversation's artifact directory, following the structure in [`resources/audit_report_template.md`](./resources/audit_report_template.md).

### Mandatory Reporting Standards
- **Clickable Source Citations**: Every code or schema finding MUST include a clickable file and line link (`[filename:L10-L25](file:///absolute/path/to/file#L10-L25)`).
- **GDPR Article Mapping**: Cite the specific GDPR Article or ePrivacy rule for every finding (refer to [`references/gdpr_technical_checklist.md`](./references/gdpr_technical_checklist.md)).
- **Clear Dispositions**:
  - `CRITICAL_VIOLATION` — Direct technical breach (e.g., trackers firing before consent, public PII table missing RLS, pre-ticked consent checkbox, no account deletion capability).
  - `ARCHITECTURAL_RISK` — High/Medium technical gap (e.g., soft-delete retaining raw PII indefinitely without purge job, PII in server logs, remote Google Fonts leaking IPs, missing data export).
  - `NEEDS_LEGAL_REVIEW` — Technical behavior discovered that must be verified against legal documentation (e.g., third-party subprocessor in code not listed in `/privacy`, retention duration justification).
  - `COMPLIANT` — Verified passing controls.
- **Actionable Remediations**: Provide concrete drop-in code fixes or schema migration snippets for every technical violation.
