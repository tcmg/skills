# GDPR & ePrivacy Technical Compliance Audit Report

**Target Workspace**: `<workspace_path>`  
**Inspected URL (Runtime)**: `<url_or_static_only>`  
**Audit Date**: `<YYYY-MM-DD>`  
**Overall Posture**: `<CRITICAL_GAPS_DETECTED | NEEDS_REMEDIATION | LARGELY_COMPLIANT>`

> [!IMPORTANT]
> **Executive Summary**: `<2-3 sentence summary of the highest-impact findings across the consumer-facing frontend, database rules/retention, and backend data handling.>`

---

## 1. Compliance Scorecard by Pillar

| Audit Pillar | Status | Critical Violations | Architectural Risks | Needs Legal Review |
| :--- | :--- | :---: | :---: | :---: |
| **A. Consumer Frontend UI & Active Consent Runtime** | `<PASS / WARN / FAIL>` | `<0>` | `<0>` | `<0>` |
| **B. Database Rules, Schema & Retention / Erasure** | `<PASS / WARN / FAIL>` | `<0>` | `<0>` | `<0>` |
| **C. Backend Data Handling, Logging & Egress** | `<PASS / WARN / FAIL>` | `<0>` | `<0>` | `<0>` |
| **D. Transparency & Subprocessor Disclosures** | `<PASS / WARN / FAIL>` | `<0>` | `<0>` | `<0>` |

---

## 2. Pillar A: Consumer-Facing Frontend & Active Consent Audit

### 2.1 Consumer Routes & PII Collection Forms
| Route / Component | PII Collected | Consent Mechanism | Pre-Ticked? | Privacy Link? | Disposition |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `[<component.tsx:L10>](file:///abs/path#L10)` | `<email, name>` | `<Checkbox / Implicit>` | `<Yes/No>` | `<Yes/No>` | `<COMPLIANT / CRITICAL_VIOLATION>` |

### 2.2 Active Runtime Inspection (3-State Browser Audit)
- **State 1 — Zero-Interaction Pre-Consent Baseline**:
  - **Cookies set before consent**: `<None / List of non-essential cookies>`
  - **Third-party trackers & IP-leaking requests fired on load**: `<None / List of domains e.g. google-analytics.com, fonts.googleapis.com>`
  - **Local/Session storage tracking keys**: `<None / List of keys>`
- **State 2 — Consent Banner & Dark Pattern Assessment**:
  - **Banner detected**: `<Yes / No>`
  - **First-layer "Reject All" button**: `<Present & Symmetric / Missing (Dark Pattern)>`
  - **Visual prominence comparison**: `<Details on button sizing, contrast, and click depth>`
- **State 3 — Post-Rejection Verification**:
  - **Trackers blocked after clicking Reject**: `<Verified / Failed>`

### 2.3 Self-Service Data Subject Rights (DSAR) UI
- **Right to Erasure (Delete Account UI — Art. 17)**: `<Present at [file](file:///...) / Missing>`
- **Right to Data Portability (Export Data UI — Art. 20)**: `<Present at [file](file:///...) / Missing>`
- **Consent Withdrawal Trigger (Re-open Cookie Settings — Art. 7(3))**: `<Present / Missing>`

---

## 3. Pillar B: Database Rules, Schema & Data Lifecycle

### 3.1 PII & Special Category Data Inventory
| Model / Table | PII Fields | Category (`Standard` / `Art. 9 Special`) | Access Control (RLS / Rules) | Encryption / Hashing | Retention / TTL |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `[<schema:L10>](file:///abs/path#L10)` | `<email, ip>` | `<Standard>` | `<RLS Enabled / Missing>` | `<Plaintext / Hashed>` | `<Unbounded / 30d TTL>` |

### 3.2 Database Security Rules & Access Isolation (Art. 25 & 32)
- `<Findings on Supabase RLS policies, Firestore rules, or SQL privileges>`

### 3.3 Right to Erasure Cascade & Soft-Delete Audit (Art. 17)
- `<Trace of account deletion handler: hard delete vs. soft-delete-only, foreign key cascades, object storage cleanup>`

---

## 4. Pillar C: Backend Data Handling, Logging & Subprocessor Egress

### 4.1 Unredacted PII in Logs & Observability Sinks
| Location | Sink Type | Leaked Fields | Severity | Disposition |
| :--- | :--- | :--- | :--- | :--- |
| `[<handler.ts:L42>](file:///abs/path#L42)` | `<console.log / Sentry>` | `<req.body, email>` | `<HIGH>` | `<ARCHITECTURAL_RISK>` |

### 4.2 Outbound Third-Party Subprocessors & Cross-Border Transfers
| Vendor / SDK | Evidence in Code | Data Transmitted | Disclosed in Privacy Policy? | Disposition |
| :--- | :--- | :--- | :---: | :--- |
| `<OpenAI / Stripe / Segment>` | `[<file:L15>](file:///abs/path#L15)` | `<User prompt, email>` | `<Yes / No / No Policy Found>` | `<NEEDS_LEGAL_REVIEW>` |

---

## 5. Prioritized Findings & Actionable Remediations

### `[GDPR-001]` `<Finding Title>`
- **Disposition**: `<CRITICAL_VIOLATION | ARCHITECTURAL_RISK | NEEDS_LEGAL_REVIEW>`
- **GDPR Reference**: `<e.g., ePrivacy Directive Art. 5(3) & GDPR Art. 7>`
- **Location**: `[<filename:L10-L25>](file:///absolute/path/to/file#L10-L25)`
- **Issue**: `<Clear explanation of the technical compliance failure and privacy risk.>`
- **Recommended Fix**:
```diff
- // Vulnerable / non-compliant pattern
+ // Compliant remediation pattern
```
