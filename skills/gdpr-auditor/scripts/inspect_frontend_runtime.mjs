#!/usr/bin/env node
/**
 * GDPR & ePrivacy Active Frontend Runtime Inspector
 *
 * Performs a 3-State Browser Compliance Audit against a live URL:
 *   - State 1 (Pre-Consent / Zero Interaction): Captures all cookies, localStorage,
 *     sessionStorage, security headers, and third-party network requests fired BEFORE
 *     any user interaction with a consent banner.
 *   - State 2 (Consent Banner & Dark Patterns): Detects the cookie banner DOM, verifies
 *     whether a first-layer "Reject All" button exists alongside "Accept All", and checks
 *     visual symmetry (bounding box area, visibility, contrast).
 *   - State 3 (Post-Rejection Enforcement): Clicks the "Reject All" button, reloads the
 *     page, and verifies that non-essential cookies and tracking beacons remain blocked.
 *
 * Automatically uses Playwright (chromium) if available, or falls back to a zero-dependency
 * HTTP/DOM/Set-Cookie static response inspector if Playwright is not installed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadKnownTrackers() {
  const refPath = path.resolve(__dirname, '../references/known_tracker_domains.json');
  try {
    return JSON.parse(fs.readFileSync(refPath, 'utf-8'));
  } catch {
    return { tracker_domains: [], non_essential_cookie_prefixes: [], non_essential_storage_keys: [] };
  }
}

function parseArgs(argv) {
  const args = { url: null, output: null, screenshotDir: null, timeoutMs: 15000 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (arg === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (arg === '--screenshot-dir' && argv[i + 1]) args.screenshotDir = argv[++i];
    else if (arg === '--timeout' && argv[i + 1]) args.timeoutMs = parseInt(argv[++i], 10) || 15000;
  }
  return args;
}

function validateTargetUrl(rawUrl) {
  if (!rawUrl) throw new Error('Missing required --url argument.');
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`);
  }
  return parsed;
}

function matchTrackerDomain(requestUrl, knownTrackers) {
  try {
    const parsed = new URL(requestUrl);
    const hostAndPath = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    for (const item of knownTrackers.tracker_domains) {
      if (hostAndPath.includes(item.domain.toLowerCase())) {
        return item;
      }
    }
  } catch {
    // ignore malformed URLs
  }
  return null;
}

function classifyCookie(cookieName, knownTrackers) {
  const lower = cookieName.toLowerCase();
  for (const item of knownTrackers.non_essential_cookie_prefixes) {
    if (lower.startsWith(item.prefix.toLowerCase())) {
      return { isNonEssentialTracker: true, vendor: item.vendor, category: item.category };
    }
  }
  return { isNonEssentialTracker: false, vendor: null, category: 'Unknown / First-Party' };
}

async function runPlaywrightAudit(playwright, targetUrl, args, knownTrackers) {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const preConsentRequests = [];
    const preConsentTrackers = [];
    let mainResponseHeaders = {};

    const onRequest = (req) => {
      const reqUrl = req.url();
      try {
        const reqHost = new URL(reqUrl).hostname;
        const isThirdParty = reqHost !== targetUrl.hostname && !reqHost.endsWith(`.${targetUrl.hostname}`);
        const trackerMatch = matchTrackerDomain(reqUrl, knownTrackers);
        if (isThirdParty || trackerMatch) {
          preConsentRequests.push({
            url: reqUrl,
            hostname: reqHost,
            resourceType: req.resourceType(),
            isThirdParty,
            tracker: trackerMatch,
          });
        }
        if (trackerMatch) {
          preConsentTrackers.push({
            url: reqUrl,
            vendor: trackerMatch.vendor,
            category: trackerMatch.category,
            gdprReference: trackerMatch.gdpr_reference,
          });
        }
      } catch {
        // ignore non-standard URLs (e.g. data:)
      }
    };

    page.on('request', onRequest);

    const response = await page.goto(targetUrl.toString(), {
      waitUntil: 'networkidle',
      timeout: args.timeoutMs,
    });
    if (response) {
      mainResponseHeaders = response.headers();
    }

    await page.waitForTimeout(1500);
    page.off('request', onRequest);

    // State 1: Capture Pre-Consent Cookies & Storage
    const rawCookies = await context.cookies();
    const preConsentCookies = rawCookies.map((c) => {
      const classification = classifyCookie(c.name, knownTrackers);
      return {
        name: c.name,
        domain: c.domain,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expires: c.expires,
        ...classification,
      };
    });

    const storageSnapshot = await page.evaluate(() => {
      const readStore = (store) => {
        const keys = [];
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k) keys.push(k);
          }
        } catch {
          // ignore storage access errors
        }
        return keys;
      };
      return {
        localStorageKeys: readStore(window.localStorage),
        sessionStorageKeys: readStore(window.sessionStorage),
      };
    });

    const screenshots = {};
    if (args.screenshotDir) {
      const resolvedDir = path.resolve(args.screenshotDir);
      fs.mkdirSync(resolvedDir, { recursive: true });
      const preConsentShot = path.join(resolvedDir, 'state1_pre_consent.png');
      await page.screenshot({ path: preConsentShot, fullPage: false });
      screenshots.preConsent = preConsentShot;
    }

    // State 2: Inspect Consent Banner & Dark Patterns
    const bannerAnalysis = await page.evaluate(() => {
      const bannerSelectors = [
        '#onetrust-banner-sdk',
        '#CybotCookiebotDialog',
        '[id*="cookie" i]',
        '[class*="cookie" i]',
        '[id*="consent" i]',
        '[class*="consent" i]',
        '[aria-label*="cookie" i]',
        '[aria-label*="consent" i]',
        '[role="dialog"]',
      ];

      let bannerEl = null;
      for (const sel of bannerSelectors) {
        const candidates = Array.from(document.querySelectorAll(sel));
        const visible = candidates.find((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 120 &&
            rect.height > 40 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity || '1') > 0.1 &&
            /cookie|consent|privacy|tracking|gdpr/i.test(el.innerText || '')
          );
        });
        if (visible) {
          bannerEl = visible;
          break;
        }
      }

      if (!bannerEl) {
        return { bannerDetected: false };
      }

      const clickables = Array.from(
        bannerEl.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });

      const summarizeControl = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
          tagName: el.tagName.toLowerCase(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          area: Math.round(rect.width * rect.height),
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontSize: style.fontSize,
        };
      };

      const controls = clickables.map(summarizeControl);
      const acceptBtn = controls.find((c) => /\b(accept|agree|allow all|got it|ok)\b/i.test(c.text));
      const rejectBtn = controls.find((c) =>
        /\b(reject|decline|deny|necessary only|essential only|refuse|continue without)\b/i.test(c.text)
      );
      const manageBtn = controls.find((c) => /\b(manage|preferences|settings|customize|options)\b/i.test(c.text));

      const darkPatternFlags = [];
      if (acceptBtn && !rejectBtn) {
        darkPatternFlags.push(
          'MISSING_FIRST_LAYER_REJECT: Banner shows an "Accept" button on the first layer without an equivalent 1-click "Reject / Necessary Only" button (violates EDPB 03/2022 dark pattern guidelines).'
        );
      }
      if (acceptBtn && rejectBtn && acceptBtn.area > rejectBtn.area * 2.2) {
        darkPatternFlags.push(
          `ASYMMETRIC_BUTTON_PROMINENCE: "Accept" control area (${acceptBtn.area}px²) is more than 2.2x larger than "Reject" control (${rejectBtn.area}px²).`
        );
      }
      if (acceptBtn && rejectBtn && acceptBtn.tagName === 'button' && rejectBtn.tagName === 'a') {
        darkPatternFlags.push(
          'DECEPTIVE_LINK_STYLING: "Accept" is rendered as a button while "Reject" is demoted to an inline anchor link.'
        );
      }

      const preTickedInBanner = Array.from(bannerEl.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => cb.checked && !cb.disabled)
        .map((cb) => cb.name || cb.id || cb.getAttribute('aria-label') || 'unnamed_checkbox');

      if (preTickedInBanner.length > 0) {
        darkPatternFlags.push(
          `PRETICKED_BANNER_CHECKBOXES: Enabled checkboxes pre-selected inside consent banner: ${preTickedInBanner.join(', ')}`
        );
      }

      return {
        bannerDetected: true,
        acceptControl: acceptBtn || null,
        rejectControl: rejectBtn || null,
        manageControl: manageBtn || null,
        allControls: controls,
        darkPatternFlags,
      };
    });

    // State 3: Click "Reject All" (if present) and verify post-rejection behavior
    const postRejectAudit = {
      rejectClicked: false,
      newTrackersFiredAfterReject: [],
      nonEssentialCookiesAfterReject: [],
    };

    if (bannerAnalysis.bannerDetected && bannerAnalysis.rejectControl) {
      const postRejectTrackers = [];
      const onPostRejectRequest = (req) => {
        const trackerMatch = matchTrackerDomain(req.url(), knownTrackers);
        if (trackerMatch) {
          postRejectTrackers.push({
            url: req.url(),
            vendor: trackerMatch.vendor,
            category: trackerMatch.category,
          });
        }
      };

      try {
        const rejectText = bannerAnalysis.rejectControl.text;
        const locator = page.getByText(rejectText, { exact: false }).first();
        await locator.click({ timeout: 3000 });
        postRejectAudit.rejectClicked = true;
        await page.waitForTimeout(1000);

        page.on('request', onPostRejectRequest);
        await page.reload({ waitUntil: 'networkidle', timeout: args.timeoutMs });
        await page.waitForTimeout(1000);
        page.off('request', onPostRejectRequest);

        postRejectAudit.newTrackersFiredAfterReject = postRejectTrackers;
        const afterCookies = await context.cookies();
        postRejectAudit.nonEssentialCookiesAfterReject = afterCookies
          .map((c) => ({ name: c.name, ...classifyCookie(c.name, knownTrackers) }))
          .filter((c) => c.isNonEssentialTracker);

        if (args.screenshotDir) {
          const postRejectShot = path.join(path.resolve(args.screenshotDir), 'state3_post_reject.png');
          await page.screenshot({ path: postRejectShot, fullPage: false });
          screenshots.postReject = postRejectShot;
        }
      } catch {
        page.off('request', onPostRejectRequest);
      }
    }

    return {
      mode: 'playwright_headless_browser',
      inspectedUrl: targetUrl.toString(),
      timestamp: new Date().toISOString(),
      securityAndPrivacyHeaders: {
        strictTransportSecurity: mainResponseHeaders['strict-transport-security'] || null,
        contentSecurityPolicy: mainResponseHeaders['content-security-policy'] || null,
        referrerPolicy: mainResponseHeaders['referrer-policy'] || null,
        permissionsPolicy: mainResponseHeaders['permissions-policy'] || null,
        xFrameOptions: mainResponseHeaders['x-frame-options'] || null,
      },
      state1PreConsent: {
        totalCookiesSetBeforeConsent: preConsentCookies.length,
        nonEssentialCookiesBeforeConsent: preConsentCookies.filter((c) => c.isNonEssentialTracker),
        allCookiesBeforeConsent: preConsentCookies,
        preConsentTrackersFired: preConsentTrackers,
        thirdPartyRequestsCount: preConsentRequests.length,
        storageSnapshot,
      },
      state2ConsentBanner: bannerAnalysis,
      state3PostRejection: postRejectAudit,
      screenshots,
    };
  } finally {
    await browser.close();
  }
}

async function runStaticHttpFallback(targetUrl, knownTrackers) {
  const res = await fetch(targetUrl.toString(), { redirect: 'follow' });
  const html = await res.text();
  const headers = Object.fromEntries(res.headers.entries());
  const setCookieHeader = res.headers.getSetCookie ? res.headers.getSetCookie() : [];

  const embeddedTrackers = [];
  for (const item of knownTrackers.tracker_domains) {
    if (html.toLowerCase().includes(item.domain.toLowerCase())) {
      embeddedTrackers.push({
        domain: item.domain,
        vendor: item.vendor,
        category: item.category,
        gdprReference: item.gdpr_reference,
      });
    }
  }

  return {
    mode: 'http_fetch_fallback (install playwright for full 3-state DOM & network execution)',
    inspectedUrl: targetUrl.toString(),
    timestamp: new Date().toISOString(),
    httpStatus: res.status,
    securityAndPrivacyHeaders: {
      strictTransportSecurity: headers['strict-transport-security'] || null,
      contentSecurityPolicy: headers['content-security-policy'] || null,
      referrerPolicy: headers['referrer-policy'] || null,
      permissionsPolicy: headers['permissions-policy'] || null,
      xFrameOptions: headers['x-frame-options'] || null,
    },
    setCookieHeadersOnInitialResponse: setCookieHeader,
    embeddedTrackerDomainsInHtml: embeddedTrackers,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const targetUrl = validateTargetUrl(args.url);
  const knownTrackers = loadKnownTrackers();

  let playwright = null;
  try {
    playwright = await import('playwright');
  } catch {
    // Playwright not installed in current node path; use fallback
  }

  let report;
  if (playwright && playwright.chromium) {
    report = await runPlaywrightAudit(playwright, targetUrl, args, knownTrackers);
  } else {
    report = await runStaticHttpFallback(targetUrl, knownTrackers);
  }

  const serialized = JSON.stringify(report, null, 2);
  if (args.output) {
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf-8');
    console.log(`GDPR runtime inspection completed (${report.mode}). Report saved to ${outPath}`);
  } else {
    console.log(serialized);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
