#!/usr/bin/env python3
"""
GDPR & ePrivacy Static Codebase, UI, Database Rules & Data-Flow Scanner.
Scans a target web application workspace for:
1. Consumer-facing routes, PII collection forms, pre-ticked checkboxes, and DSAR UI (Delete/Export/Privacy).
2. Database schemas (Prisma, SQL, Drizzle, Mongoose), Standard vs. Art. 9 PII fields, soft-delete traps, and RLS/Firestore rules.
3. Backend PII logging sinks, session/cookie flags, and third-party subprocessors vs. Privacy Policy disclosures.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Set

IGNORE_DIRS: Set[str] = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "out",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    ".turbo",
    ".vercel",
    "vendor",
    "target",
}

MAX_FILE_BYTES = 2 * 1024 * 1024  # 2 MB cap per file for safety

CODE_EXTENSIONS: Set[str] = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".svelte",
    ".html",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".php",
    ".prisma",
    ".sql",
    ".rules",
    ".md",
    ".mdx",
}

STANDARD_PII_FIELDS: Set[str] = {
    "email",
    "phone",
    "phone_number",
    "phonenumber",
    "mobile",
    "first_name",
    "firstname",
    "last_name",
    "lastname",
    "full_name",
    "fullname",
    "address",
    "street_address",
    "postal_code",
    "zip_code",
    "city",
    "country",
    "ip_address",
    "ipaddress",
    "client_ip",
    "remote_addr",
    "user_agent",
    "useragent",
    "birth_date",
    "birthdate",
    "date_of_birth",
    "dob",
    "ssn",
    "national_id",
    "passport_number",
    "tax_id",
    "iban",
    "credit_card",
    "latitude",
    "longitude",
    "geolocation",
}

ART9_SPECIAL_CATEGORY_FIELDS: Set[str] = {
    "health",
    "medical_history",
    "diagnosis",
    "prescription",
    "biometric",
    "fingerprint",
    "face_id",
    "voiceprint",
    "genetic",
    "dna",
    "religion",
    "religious_belief",
    "political_opinion",
    "political_party",
    "trade_union",
    "sexual_orientation",
    "sex_life",
    "ethnic_origin",
    "ethnicity",
    "race",
}

KNOWN_SUBPROCESSORS: List[Dict[str, str]] = [
    {"id": "openai", "vendor": "OpenAI", "pattern": r"\bopenai\b", "category": "AI / LLM Subprocessor (US Transfer)"},
    {"id": "anthropic", "vendor": "Anthropic", "pattern": r"@anthropic-ai|anthropic", "category": "AI / LLM Subprocessor (US Transfer)"},
    {"id": "google_genai", "vendor": "Google Gemini / Vertex AI", "pattern": r"@google/genai|@google/generative-ai", "category": "AI / LLM Subprocessor"},
    {"id": "stripe", "vendor": "Stripe", "pattern": r"\bstripe\b|@stripe/", "category": "Payment Processor"},
    {"id": "sendgrid", "vendor": "SendGrid (Twilio)", "pattern": r"@sendgrid/mail|\bsendgrid\b", "category": "Transactional Email"},
    {"id": "resend", "vendor": "Resend", "pattern": r"\bresend\b", "category": "Transactional Email"},
    {"id": "mailgun", "vendor": "Mailgun", "pattern": r"\bmailgun\b", "category": "Transactional Email"},
    {"id": "sentry", "vendor": "Sentry", "pattern": r"@sentry/|sentry[_-]sdk", "category": "Error & Crash Monitoring"},
    {"id": "posthog", "vendor": "PostHog", "pattern": r"\bposthog\b|posthog-js|posthog-node", "category": "Product Analytics / Session Replay"},
    {"id": "mixpanel", "vendor": "Mixpanel", "pattern": r"\bmixpanel\b", "category": "Product Analytics"},
    {"id": "segment", "vendor": "Twilio Segment", "pattern": r"@segment/|analytics-node", "category": "Customer Data Platform"},
    {"id": "amplitude", "vendor": "Amplitude", "pattern": r"@amplitude/|\bamplitude\b", "category": "Product Analytics"},
    {"id": "hotjar", "vendor": "Hotjar", "pattern": r"\bhotjar\b", "category": "Session Replay / Heatmaps"},
    {"id": "google_analytics", "vendor": "Google Analytics / GTM", "pattern": r"googletagmanager\.com|google-analytics\.com|\bgtag\s*\(", "category": "Web Analytics"},
    {"id": "meta_pixel", "vendor": "Meta Pixel", "pattern": r"connect\.facebook\.net|\bfbq\s*\(", "category": "Advertising Pixel"},
    {"id": "hubspot", "vendor": "HubSpot", "pattern": r"@hubspot/|js\.hs-scripts\.com", "category": "CRM / Marketing"},
    {"id": "intercom", "vendor": "Intercom", "pattern": r"intercom|widget\.intercom\.io", "category": "Customer Messaging"},
    {"id": "algolia", "vendor": "Algolia", "pattern": r"algoliasearch|\balgolia\b", "category": "Hosted Search Index"},
    {"id": "supabase", "vendor": "Supabase", "pattern": r"@supabase/supabase-js", "category": "Database & Auth BaaS"},
    {"id": "firebase", "vendor": "Google Firebase", "pattern": r"firebase/firestore|firebase-admin", "category": "Database & Auth BaaS"},
]


def safe_walk_files(workspace_root: Path) -> List[Path]:
    """Safely enumerate workspace files without escaping workspace_root."""
    discovered: List[Path] = []
    for root, dirs, files in os.walk(workspace_root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".git")]
        for fname in files:
            fpath = Path(root) / fname
            try:
                resolved = fpath.resolve()
                if not resolved.is_relative_to(workspace_root):
                    continue
                if resolved.is_symlink():
                    continue
                if resolved.suffix.lower() in CODE_EXTENSIONS or fname in ("package.json", "requirements.txt", "pyproject.toml", "firestore.rules", "storage.rules"):
                    if resolved.stat().st_size <= MAX_FILE_BYTES:
                        discovered.append(resolved)
            except OSError:
                continue
    return discovered


def scan_workspace(workspace_root: Path) -> Dict[str, Any]:
    files = safe_walk_files(workspace_root)

    consumer_routes: List[Dict[str, Any]] = []
    legal_pages_found: Dict[str, List[str]] = {
        "privacy_policy": [],
        "cookie_policy": [],
        "terms_of_service": [],
    }
    dsar_capabilities: Dict[str, List[Dict[str, Any]]] = {
        "account_deletion_erasure": [],
        "data_export_portability": [],
        "consent_management_ui": [],
    }
    frontend_findings: List[Dict[str, Any]] = []
    database_pii_fields: List[Dict[str, Any]] = []
    database_rule_findings: List[Dict[str, Any]] = []
    backend_logging_findings: List[Dict[str, Any]] = []
    detected_subprocessors: Dict[str, Dict[str, Any]] = {}
    privacy_policy_text_blobs: List[str] = []

    # Regex patterns
    pre_ticked_re = re.compile(
        r"(defaultChecked(?:\s*=\s*\{?\s*true\s*\}?|\b)|checked\s*=\s*\{?\s*true\s*\}?)",
        re.IGNORECASE,
    )
    google_fonts_re = re.compile(r"fonts\.(googleapis|gstatic)\.com", re.IGNORECASE)
    local_storage_auth_re = re.compile(
        r"(localStorage|sessionStorage)\.setItem\s*\(\s*['\"]([^'\"]*(?:token|jwt|session|email|user|ssn|phone)[^'\"]*)['\"]",
        re.IGNORECASE,
    )
    pii_log_re = re.compile(
        r"\b(console\.(?:log|info|warn|error|debug)|logger\.(?:info|warn|error|debug)|logging\.(?:info|warning|error|debug)|print)\s*\([^)]*\b(req\.body|request\.body|request\.json|user\.email|password|credit_card|ssn|x-forwarded-for|req\.ip)\b",
        re.IGNORECASE,
    )
    sentry_pii_re = re.compile(r"sendDefaultPii\s*:\s*true", re.IGNORECASE)
    soft_delete_re = re.compile(r"\b(deleted_at|deletedAt|is_deleted|isDeleted)\b")
    erasure_endpoint_re = re.compile(
        r"(delete[\s_-]*account|deleteUser|destroyUser|eraseUser|gdpr[\s_-]*delete|right[\s_-]*to[\s_-]*erasure)",
        re.IGNORECASE,
    )
    export_endpoint_re = re.compile(
        r"(export[\s_-]*(?:user[\s_-]*)?data|download[\s_-]*(?:my[\s_-]*)?data|data[\s_-]*portability)",
        re.IGNORECASE,
    )
    consent_ui_re = re.compile(
        r"(cookie[\s_-]*(?:banner|consent|preferences|settings)|CookieConsent|OneTrust|Cookiebot|Osano)",
        re.IGNORECASE,
    )

    for fpath in files:
        rel_path = str(fpath.relative_to(workspace_root))
        try:
            content = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = content.splitlines()

        # 1. Detect Consumer Routes & Legal Disclosures
        lower_rel = rel_path.lower()
        if any(seg in lower_rel for seg in ("app/", "pages/", "routes/", "views/", "src/pages", "src/app")):
            is_admin = any(adm in lower_rel for adm in ("/admin", "/internal", "/backoffice"))
            if any(fpath.name.startswith(p) for p in ("page.", "index.", "route.", "+page.")):
                consumer_routes.append({
                    "file": rel_path,
                    "scope": "admin_internal" if is_admin else "consumer_facing",
                })

        if "privacy" in lower_rel:
            legal_pages_found["privacy_policy"].append(rel_path)
            privacy_policy_text_blobs.append(content.lower())
        if "cookie" in lower_rel and any(ext in lower_rel for ext in (".md", ".mdx", ".tsx", ".jsx", ".html", ".vue")):
            legal_pages_found["cookie_policy"].append(rel_path)
            privacy_policy_text_blobs.append(content.lower())
        if "terms" in lower_rel or "legal" in lower_rel:
            legal_pages_found["terms_of_service"].append(rel_path)
            privacy_policy_text_blobs.append(content.lower())

        # 2. Scan Subprocessors across manifest & source files
        for sub in KNOWN_SUBPROCESSORS:
            if re.search(sub["pattern"], content, re.IGNORECASE):
                entry = detected_subprocessors.setdefault(
                    sub["id"],
                    {
                        "vendor": sub["vendor"],
                        "category": sub["category"],
                        "files": [],
                    },
                )
                if rel_path not in entry["files"] and len(entry["files"]) < 8:
                    entry["files"].append(rel_path)

        # 3. Line-by-line inspection for UI, DB, and Backend patterns
        is_schema_file = (
            fpath.suffix.lower() in (".prisma", ".sql")
            or "schema" in lower_rel
            or "models" in lower_rel
            or "migrations" in lower_rel
        )
        is_rules_file = fpath.name in ("firestore.rules", "storage.rules") or fpath.suffix.lower() == ".sql"

        for idx, line in enumerate(lines, start=1):
            # Pre-ticked checkbox check (Art. 7)
            if fpath.suffix.lower() in (".tsx", ".jsx", ".vue", ".svelte", ".html"):
                if pre_ticked_re.search(line):
                    context_window = "\n".join(lines[max(0, idx - 4): min(len(lines), idx + 4)])
                    if re.search(r"(consent|marketing|newsletter|subscribe|terms|privacy|analytics|agree)", context_window, re.IGNORECASE):
                        frontend_findings.append({
                            "rule": "GDPR_ART7_PRETICKED_CONSENT",
                            "severity": "CRITICAL",
                            "file": rel_path,
                            "line": idx,
                            "description": "Pre-ticked checkbox detected near consent/marketing/newsletter input (violates GDPR Art. 7 & Planet49 ruling).",
                            "snippet": line.strip()[:160],
                        })

                if google_fonts_re.search(line):
                    frontend_findings.append({
                        "rule": "GDPR_ART6_REMOTE_GOOGLE_FONTS",
                        "severity": "MEDIUM",
                        "file": rel_path,
                        "line": idx,
                        "description": "Remote Google Fonts loaded directly from client browser, leaking visitor IP address to Google without prior consent (LG München ruling). Self-host fonts instead.",
                        "snippet": line.strip()[:160],
                    })

            # LocalStorage / SessionStorage sensitive token or PII storage
            m_storage = local_storage_auth_re.search(line)
            if m_storage:
                frontend_findings.append({
                    "rule": "GDPR_ART32_INSECURE_BROWSER_STORAGE",
                    "severity": "HIGH",
                    "file": rel_path,
                    "line": idx,
                    "description": f"Sensitive key '{m_storage.group(2)}' stored in {m_storage.group(1)} (vulnerable to XSS exfiltration; use HttpOnly/Secure cookies).",
                    "snippet": line.strip()[:160],
                })

            # DSAR capabilities discovery
            if erasure_endpoint_re.search(line):
                dsar_capabilities["account_deletion_erasure"].append({"file": rel_path, "line": idx, "snippet": line.strip()[:120]})
            if export_endpoint_re.search(line):
                dsar_capabilities["data_export_portability"].append({"file": rel_path, "line": idx, "snippet": line.strip()[:120]})
            if consent_ui_re.search(line) and len(dsar_capabilities["consent_management_ui"]) < 15:
                dsar_capabilities["consent_management_ui"].append({"file": rel_path, "line": idx, "snippet": line.strip()[:120]})

            # Backend unredacted PII logging (Art. 5(1)(f) & Art. 32)
            if pii_log_re.search(line):
                backend_logging_findings.append({
                    "rule": "GDPR_ART32_UNREDACTED_PII_LOG",
                    "severity": "HIGH",
                    "file": rel_path,
                    "line": idx,
                    "description": "Potential unredacted PII or full request body logged to stdout/log sink.",
                    "snippet": line.strip()[:160],
                })

            if sentry_pii_re.search(line):
                backend_logging_findings.append({
                    "rule": "GDPR_ART32_SENTRY_SEND_DEFAULT_PII",
                    "severity": "HIGH",
                    "file": rel_path,
                    "line": idx,
                    "description": "Error tracker configured with sendDefaultPii: true, transmitting unredacted user IPs, cookies, and headers to third-party sink.",
                    "snippet": line.strip()[:160],
                })

            # Database Schema PII Inventory
            if is_schema_file:
                tokens = re.findall(r"\b[a-zA-Z_][a-zA-Z0-9_]*\b", line)
                for tok in tokens:
                    tok_lower = tok.lower()
                    sub_parts = set(re.findall(r"[a-z]+", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", tok).lower()))
                    if tok_lower in ART9_SPECIAL_CATEGORY_FIELDS or (sub_parts & ART9_SPECIAL_CATEGORY_FIELDS):
                        database_pii_fields.append({
                            "category": "ART9_SPECIAL_CATEGORY",
                            "field": tok,
                            "file": rel_path,
                            "line": idx,
                            "snippet": line.strip()[:140],
                        })
                    elif tok_lower in STANDARD_PII_FIELDS or (sub_parts & STANDARD_PII_FIELDS):
                        database_pii_fields.append({
                            "category": "STANDARD_PII",
                            "field": tok,
                            "file": rel_path,
                            "line": idx,
                            "snippet": line.strip()[:140],
                        })

                if soft_delete_re.search(line):
                    database_rule_findings.append({
                        "rule": "GDPR_ART17_SOFT_DELETE_RETENTION_CHECK",
                        "severity": "MEDIUM",
                        "file": rel_path,
                        "line": idx,
                        "description": "Soft-delete column detected on schema. Verify that account erasure (Art. 17) actually purges or anonymizes PII within a bounded retention period rather than keeping raw PII forever.",
                        "snippet": line.strip()[:140],
                    })

            # Database Security Rules (Firestore & Postgres RLS)
            if is_rules_file:
                if re.search(r"allow\s+(?:read|write|get|list)\s*:\s*if\s+true", line):
                    database_rule_findings.append({
                        "rule": "GDPR_ART32_PUBLIC_FIRESTORE_RULE",
                        "severity": "CRITICAL",
                        "file": rel_path,
                        "line": idx,
                        "description": "Permissive Firestore/Storage rule ('allow ...: if true') allows unauthenticated public access. Verify no PII is stored in this collection.",
                        "snippet": line.strip()[:140],
                    })
                elif re.search(r"allow\s+(?:read|list)\s*:\s*if\s+request\.auth\s*!=\s*null\s*;", line):
                    database_rule_findings.append({
                        "rule": "GDPR_ART25_BROAD_AUTH_READ_RULE",
                        "severity": "HIGH",
                        "file": rel_path,
                        "line": idx,
                        "description": "Rule allows ANY authenticated user ('request.auth != null') to read collection documents without checking row ownership (e.g. request.auth.uid == userId).",
                        "snippet": line.strip()[:140],
                    })
                elif re.search(r"USING\s*\(\s*true\s*\)", line, re.IGNORECASE):
                    database_rule_findings.append({
                        "rule": "GDPR_ART32_PERMISSIVE_SQL_RLS_POLICY",
                        "severity": "HIGH",
                        "file": rel_path,
                        "line": idx,
                        "description": "SQL Row-Level Security policy uses 'USING (true)', granting unrestricted row access. Verify table does not contain private user PII.",
                        "snippet": line.strip()[:140],
                    })

    # 4. Cross-check subprocessors against Privacy Policy text
    combined_policy_text = "\n".join(privacy_policy_text_blobs)
    subprocessor_disclosure_audit: List[Dict[str, Any]] = []
    for sub_id, info in detected_subprocessors.items():
        vendor_lower = info["vendor"].lower().split("(")[0].strip()
        disclosed = bool(combined_policy_text) and (
            vendor_lower in combined_policy_text or sub_id.replace("_", " ") in combined_policy_text
        )
        subprocessor_disclosure_audit.append({
            "vendor": info["vendor"],
            "category": info["category"],
            "evidence_files": info["files"],
            "disclosed_in_privacy_policy": disclosed if combined_policy_text else "NO_PRIVACY_POLICY_FOUND",
        })

    return {
        "workspace": str(workspace_root),
        "total_files_scanned": len(files),
        "summary": {
            "consumer_routes_count": sum(1 for r in consumer_routes if r["scope"] == "consumer_facing"),
            "admin_routes_count": sum(1 for r in consumer_routes if r["scope"] == "admin_internal"),
            "privacy_policy_present": len(legal_pages_found["privacy_policy"]) > 0,
            "cookie_policy_present": len(legal_pages_found["cookie_policy"]) > 0,
            "account_deletion_erasure_found": len(dsar_capabilities["account_deletion_erasure"]) > 0,
            "data_export_portability_found": len(dsar_capabilities["data_export_portability"]) > 0,
            "consent_ui_found": len(dsar_capabilities["consent_management_ui"]) > 0,
            "frontend_findings_count": len(frontend_findings),
            "database_pii_fields_count": len(database_pii_fields),
            "database_rule_findings_count": len(database_rule_findings),
            "backend_logging_findings_count": len(backend_logging_findings),
            "subprocessors_detected_count": len(subprocessor_disclosure_audit),
        },
        "legal_pages_found": legal_pages_found,
        "dsar_capabilities": dsar_capabilities,
        "consumer_routes": consumer_routes[:50],
        "frontend_findings": frontend_findings,
        "database_pii_fields": database_pii_fields[:100],
        "database_rule_findings": database_rule_findings,
        "backend_logging_findings": backend_logging_findings,
        "subprocessor_disclosure_audit": subprocessor_disclosure_audit,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="GDPR & ePrivacy Static Codebase Scanner")
    parser.add_argument("--workspace", required=True, help="Path to the target workspace root directory")
    parser.add_argument("--output", required=False, help="Optional file path to write JSON report")
    args = parser.parse_args()

    workspace_root = Path(args.workspace).resolve()
    if not workspace_root.exists() or not workspace_root.is_dir():
        print(json.dumps({"error": f"Workspace directory not found: {workspace_root}"}), file=sys.stderr)
        return 1

    report = scan_workspace(workspace_root)
    serialized = json.dumps(report, indent=2)

    if args.output:
        out_path = Path(args.output).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(serialized, encoding="utf-8")
        print(f"GDPR static scan completed. Report written to {out_path}")
    else:
        print(serialized)

    return 0


if __name__ == "__main__":
    sys.exit(main())
