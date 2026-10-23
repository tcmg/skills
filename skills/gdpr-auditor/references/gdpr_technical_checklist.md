# GDPR & ePrivacy Technical Compliance Checklist

This reference maps specific **GDPR Articles** and **ePrivacy Directive** rules to concrete engineering checks across the frontend UI, browser runtime, database layer, and backend server.

---

## 1. ePrivacy Directive Art. 5(3) & GDPR Art. 6 / Art. 7 (Cookies, Trackers & Consent UI)

| Legal Requirement | Technical Verification Target | Violation Pattern (Fail) | Compliant Pattern (Pass) |
| :--- | :--- | :--- | :--- |
| **Prior Opt-In for Non-Essential Storage** (ePrivacy Art. 5(3), CJEU *Planet49* C-673/17) | Browser `document.cookie`, `localStorage`, `sessionStorage`, and network requests on initial load (State 1). | Analytics (`_ga`, `ph_`, `mp_`), ad pixels (`_fbp`), or session replay scripts load before the user interacts with the consent banner. | Strictly necessary cookies only on load; analytics/marketing scripts are gated behind explicit opt-in state. |
| **Freely Given, Specific & Unambiguous Consent** (GDPR Art. 4(11), Art. 7) | Consumer signup, checkout, contact, and waitlist `<form>` elements. | `<input type="checkbox" defaultChecked />` or `checked={true}` on marketing/newsletter/tracking consent, or bundling Terms of Service with marketing consent. | Unchecked by default (`defaultChecked={false}`); separate checkboxes for distinct processing purposes. |
| **No Deceptive Dark Patterns on Consent Banners** (EDPB Guidelines 03/2022) | First layer of the cookie/consent banner DOM and computed styles. | First layer only shows "Accept All" and "Manage Settings" (requiring 2+ clicks to reject), or "Reject" is rendered as a low-contrast inline link instead of a button. | First layer has both "Accept All" and "Reject All / Necessary Only" buttons with symmetric sizing, contrast, and 1-click interaction. |
| **Easy Withdrawal of Consent** (GDPR Art. 7(3)) | Consumer UI footer or account privacy settings. | Once accepted, the cookie banner disappears forever with no UI button to reopen preferences or revoke consent. | Persistent "Cookie Settings" or "Privacy Choices" trigger in the site footer or user profile that immediately halts tracking upon withdrawal. |
| **Unauthorized IP Transmission via Third-Party Assets** (GDPR Art. 6(1), LG München *Az. 3 O 17493/20*) | HTML `<link>`, `<script>`, and CSS `@import` tags loading external assets on initial render. | Loading Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`), Adobe Typekit, or third-party JS CDNs directly from visitor browsers without prior consent. | Self-host web fonts (`next/font/local` or bundled `.woff2` files) and first-party static assets. |

---

## 2. GDPR Art. 12, 13 & 14 (Transparency & Consumer Disclosures)

| Legal Requirement | Technical Verification Target | Violation Pattern (Fail) | Compliant Pattern (Pass) |
| :--- | :--- | :--- | :--- |
| **Information Provided at Collection** (GDPR Art. 13) | Public routes (`/privacy`, `/cookies`) and consumer forms collecting PII. | App collects email/phone/payment data with no `/privacy` route in the app router, or forms lack any notice/link explaining how data is used. | Dedicated, accessible Privacy Policy and Cookie Policy pages linked in the global footer and adjacent to every PII collection form. |
| **Subprocessor & Tracker Disclosure Accuracy** (GDPR Art. 13(1)(e), Art. 28) | Cross-check `package.json` / backend SDKs (OpenAI, Stripe, Resend, Sentry, Segment, PostHog) against Privacy Policy text. | Backend sends user data to OpenAI, Sentry, or Segment, but the `/privacy` page does not mention those categories/subprocessors. | Every active third-party subprocessor receiving PII in code is accurately reflected in the Privacy Policy / Subprocessor list. |

---

## 3. GDPR Art. 15, 17 & 20 (Data Subject Rights — DSAR Architecture)

| Legal Requirement | Technical Verification Target | Violation Pattern (Fail) | Compliant Pattern (Pass) |
| :--- | :--- | :--- | :--- |
| **Right to Erasure ("Right to be Forgotten")** (GDPR Art. 17) | Account settings UI + `DELETE /user` backend handler + DB foreign keys + external storage. | 1) No account deletion endpoint/UI exists.<br>2) Handler only sets `deletedAt = now()` or `isDeleted = true` while keeping plaintext `email`, `name`, `ip`, and profile data forever.<br>3) Orphans remain in S3/GCS buckets or 3rd-party tools. | Self-service deletion UI triggers hard deletion (or irreversible anonymization of PII fields where transaction records must be kept for tax/legal obligations) plus cascade cleanup of storage buckets and external indexes within a bounded retention window (e.g., <= 30 days). |
| **Right of Access & Data Portability** (GDPR Art. 15 & Art. 20) | Account settings UI + data export API endpoint. | No mechanism or API endpoint exists to export a user's personal data in a structured, commonly used, machine-readable format (JSON/CSV). | Dedicated endpoint/button exporting the authenticated user's profile, activity, and user-generated records as JSON or CSV. |

---

## 4. GDPR Art. 5(1)(c), 5(1)(e) & Art. 9 (Data Minimization, Storage Limitation & Special Categories)

| Legal Requirement | Technical Verification Target | Violation Pattern (Fail) | Compliant Pattern (Pass) |
| :--- | :--- | :--- | :--- |
| **Data Minimization** (GDPR Art. 5(1)(c)) | Database schemas and API payloads. | Storing full raw credit card numbers, unnecessary birthdates/gender/phone when not needed for core service, or returning other users' PII in public API responses. | Collect only fields strictly required for the stated feature; use DTOs/`select` projections so sensitive fields are never over-fetched. |
| **Storage Limitation / Retention TTL** (GDPR Art. 5(1)(e)) | Tables storing session logs, IP addresses, audit events, password reset tokens, or unverified leads. | Ephemeral or behavioural tables with PII (`ip_address`, `user_agent`, `email`) grow forever with no `expires_at` column, TTL index, or scheduled purge cron job. | Explicit retention policy enforced in code via database TTL indexes, `pg_cron`, or scheduled background cleanup workers. |
| **Special Category Data Protection** (GDPR Art. 9) | Schemas storing health, biometric, genetic, political, religious, or sexual orientation data. | Storing Art. 9 fields in plaintext columns alongside general profile data without explicit Art. 9(2) consent records or application-level encryption. | Application-level envelope encryption (AES-256-GCM / KMS) for Art. 9 fields, strict RBAC/RLS isolation, and explicit audit logging. |

---

## 5. GDPR Art. 25 & Art. 32 (Data Protection by Design, Database Rules & Security of Processing)

| Legal Requirement | Technical Verification Target | Violation Pattern (Fail) | Compliant Pattern (Pass) |
| :--- | :--- | :--- | :--- |
| **Database Row-Level Security / Access Rules** (GDPR Art. 25, Art. 32) | Supabase/Postgres migrations (`ENABLE ROW LEVEL SECURITY`), Firebase `firestore.rules` & `storage.rules`. | Supabase tables with PII missing RLS, or policies using `USING (true)` for `SELECT`; Firestore rules with `allow read: if true` or `allow read: if request.auth != null` on user collections. | Strict tenant/user isolation: `auth.uid() = user_id` in Postgres RLS or `request.auth.uid == userId` in Firestore rules. |
| **PII Leakage in Server Logs & Error Trackers** (GDPR Art. 5(1)(f), Art. 32) | Backend logging statements (`console.log`, `pino`, `winston`) and Sentry/Datadog SDK initialization. | `console.log("Signup:", req.body)` logging plaintext passwords/emails/tokens, or Sentry initialized with `sendDefaultPii: true` without scrubbing hooks (`beforeSend`). | Structured logger with PII redaction paths (`redact: ['req.headers.authorization', '*.password', '*.email']`) and `sendDefaultPii: false`. |
| **Session & Cookie Hardening** (GDPR Art. 32) | Backend `Set-Cookie` headers and session middleware. | Session cookies missing `HttpOnly`, `Secure`, or `SameSite` flags, or storing bearer/session JWTs in `localStorage`. | `HttpOnly; Secure; SameSite=Lax` (or `Strict`) cookies with bounded `Max-Age`/`Expires`. |
| **LLM & Third-Party API PII Egress** (GDPR Art. 25, Art. 28, Art. 44) | Outbound calls to OpenAI, Anthropic, Gemini, or analytics APIs. | Passing full database `User` objects (including `email`, `phone`, `ip_address`) into LLM prompt templates when not required. | Strip or pseudonymize direct identifiers before constructing external API/LLM payloads. |
