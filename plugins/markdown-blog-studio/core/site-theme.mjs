import fs from 'node:fs/promises';
import path from 'node:path';
import {
  COMMON_STATIC_DIRS,
  findSiteConfigFromBlogRoot,
  resolveSafeRelativePath
} from './site-config.mjs';

const MAX_CSS_BYTES = 512 * 1024; // 512 KB

/** @type {Map<string, { key: string, payload: object }>} */
const themeCache = new Map();

async function resolveInsideDir(rootDir, targetPath) {
  const realRoot = await fs.realpath(path.resolve(rootDir));
  const realTarget = await fs.realpath(path.resolve(targetPath));
  if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
    throw new Error('Security boundary violation: site theme asset escapes site root.');
  }
  return realTarget;
}

/**
 * Strip balanced `@media ... (max-width: 992px)` blocks so narrow desktop side-panes
 * render crisp desktop typography instead of unscaled mobile-zoom overrides.
 */
function stripMobileMediaBlocks(css) {
  const mediaRe = /@media[^{]*max-width\s*:\s*992px[^{]*\{/gi;
  let out = '';
  let lastIndex = 0;
  let match;
  while ((match = mediaRe.exec(css)) !== null) {
    out += css.slice(lastIndex, match.index);
    let depth = 1;
    let i = mediaRe.lastIndex;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    lastIndex = i;
    mediaRe.lastIndex = i;
  }
  out += css.slice(lastIndex);
  return out;
}

function stripCssComments(css) {
  return String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract the effective background color of a top-level class selector (e.g. `.right-col`)
 * from a stylesheet so the Studio canvas matches the live site automatically.
 */
function extractLastBackgroundForSelector(rawCss, selectorLiteral) {
  if (!selectorLiteral) return '';
  const clean = stripCssComments(rawCss);
  const escaped = selectorLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleRe = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'g');
  let found = '';
  let match;
  while ((match = ruleRe.exec(clean)) !== null) {
    const body = match[1];
    const bgRe = /background(?:-color)?\s*:\s*([^;]+);/gi;
    let bgMatch;
    while ((bgMatch = bgRe.exec(body)) !== null) {
      const candidate = bgMatch[1].trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(candidate) || /^rgba?\([^)]+\)$/i.test(candidate)) {
        found = candidate;
      }
    }
  }
  return found;
}

function sanitizeSiteCss(css) {
  return String(css ?? '')
    .replace(/<\/style/gi, '')
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[\s\S]*?\}/gi, '')
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/javascript\s*:/gi, 'blocked:')
    .replace(/url\(\s*(['"]?)\s*https?:[^)]*\)/gi, 'none');
}

function sanitizeResetCss(rawResetCss) {
  if (!rawResetCss) return '';
  return sanitizeSiteCss(rawResetCss)
    .replace(/\bhtml\s*,\s*body\s*,/gi, '')
    .replace(/\bbody\s*\{[^}]*\}/gi, '');
}

function extractDivInnerHtmlByClass(html, markerClass) {
  if (!html || !markerClass) return '';
  const escaped = markerClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRe = new RegExp(`<(?:div|aside|nav|header)\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>`, 'i');
  const match = openRe.exec(html);
  if (!match) return '';
  const tagNameMatch = match[0].match(/^<([a-z]+)/i);
  const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : 'div';
  const contentStart = match.index + match[0].length;
  const tagRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return html
          .slice(contentStart, m.index)
          .replace(/<script\b[\s\S]*?<\/script>/gi, '')
          .trim();
      }
    } else {
      depth += 1;
    }
  }
  return '';
}

async function readOptionalFile(siteRoot, filePath) {
  try {
    const safePath = await resolveInsideDir(siteRoot, filePath);
    const stat = await fs.stat(safePath);
    if (!stat.isFile() || stat.size > MAX_CSS_BYTES) return { text: '', mtimeMs: 0 };
    const text = await fs.readFile(safePath, 'utf8');
    return { text, mtimeMs: stat.mtimeMs };
  } catch {
    return { text: '', mtimeMs: 0 };
  }
}

function applyFontMap(css, fontMap) {
  let out = css;
  for (const [from, to] of Object.entries(fontMap || {})) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`font-family\\s*:\\s*['"]${escaped}['"]`, 'gi');
    out = out.replace(re, `font-family: ${to}`);
  }
  return out;
}

async function autoDiscoverFallbackCss(siteRoot) {
  const candidates = [
    path.join('public', 'resources', 'base.css'),
    path.join('public', 'styles.css'),
    path.join('public', 'style.css'),
    path.join('public', 'css', 'style.css'),
    path.join('static', 'style.css'),
    path.join('static', 'css', 'style.css'),
    path.join('dist', 'style.css')
  ];
  for (const rel of candidates) {
    const full = path.join(siteRoot, rel);
    const loaded = await readOptionalFile(siteRoot, full);
    if (loaded.text) {
      const siblingHighlight = await readOptionalFile(siteRoot, path.join(path.dirname(full), 'highlight.css'));
      return {
        cssFiles: [
          { rel, ...loaded },
          ...(siblingHighlight.text ? [{ rel: 'highlight.css', ...siblingHighlight }] : [])
        ]
      };
    }
  }
  return { cssFiles: [] };
}

/**
 * Dynamically load and safely scope a blog's live CSS theme driven by `.blog-studio.json`
 * (or zero-config CSS discovery if no `.blog-studio.json` exists yet).
 */
export async function loadSiteTheme(blogRoot) {
  const resolvedBlogRoot = path.resolve(blogRoot);
  const cfg = await findSiteConfigFromBlogRoot(resolvedBlogRoot);
  const siteRoot = cfg ? cfg.siteRoot : path.dirname(resolvedBlogRoot);
  const siteName = cfg ? cfg.siteName : path.basename(siteRoot);

  let loadedCssFiles = [];
  if (cfg && cfg.cssFiles.length > 0) {
    loadedCssFiles = await Promise.all(
      cfg.cssFiles.map(async (rel) => {
        try {
          const abs = resolveSafeRelativePath(siteRoot, rel);
          const file = await readOptionalFile(siteRoot, abs);
          return { rel, ...file };
        } catch {
          return { rel, text: '', mtimeMs: 0 };
        }
      })
    );
    loadedCssFiles = loadedCssFiles.filter((f) => f.text.length > 0);
  } else {
    const fallback = await autoDiscoverFallbackCss(siteRoot);
    loadedCssFiles = fallback.cssFiles;
  }

  if (loadedCssFiles.length === 0) {
    return {
      available: false,
      siteName: '',
      css: '',
      palette: {},
      articleClasses: [],
      innerClasses: [],
      googleFonts: [],
      chrome: { columns: [] }
    };
  }

  let chromeSource = { text: '', mtimeMs: 0 };
  if (cfg?.chrome?.sourceHtml) {
    try {
      const absHtml = resolveSafeRelativePath(siteRoot, cfg.chrome.sourceHtml);
      chromeSource = await readOptionalFile(siteRoot, absHtml);
    } catch {
      chromeSource = { text: '', mtimeMs: 0 };
    }
  }

  const cacheKey = [
    cfg ? cfg.mtimeMs : 0,
    ...loadedCssFiles.map((f) => `${f.rel}:${f.mtimeMs}`),
    chromeSource.mtimeMs
  ].join('|');

  const cached = themeCache.get(siteRoot);
  if (cached && cached.key === cacheKey) {
    return cached.payload;
  }

  const combinedRawCss = loadedCssFiles.map((f) => f.text).join('\n');
  const detectedBg =
    (cfg?.palette?.contentSelector && extractLastBackgroundForSelector(combinedRawCss, cfg.palette.contentSelector)) ||
    extractLastBackgroundForSelector(combinedRawCss, '.right-col') ||
    cfg?.palette?.contentBg ||
    '';
  const contentBg = detectedBg || '#ffffff';
  const navBg = cfg?.palette?.navBg || '#1e293b';
  const accentBg = cfg?.palette?.accentBg || '#475569';

  const scopedBlocks = loadedCssFiles.map((file) => {
    const isReset = /(^|[\\/])reset\.css$/i.test(file.rel);
    if (isReset) return sanitizeResetCss(file.text);
    const cleaned = sanitizeSiteCss(stripMobileMediaBlocks(file.text)).replace(/\bhtml\s*,\s*body\s*\{[^}]*\}/gi, '');
    return applyFontMap(cleaned, cfg?.fontMap);
  });

  const primaryFontFamily = cfg?.fontMap
    ? Object.values(cfg.fontMap)[0] || ''
    : '';
  const scopeBaseRule = primaryFontFamily
    ? `:scope { font-family: ${primaryFontFamily}; line-height: 1.5; }`
    : '';

  const safeOverrideCss = cfg?.overrideCss ? sanitizeSiteCss(cfg.overrideCss) : '';

  const scopedCss = [
    `:root[data-theme="blog"] {`,
    `  --site-content-bg: ${contentBg};`,
    `  --site-nav-bg: ${navBg};`,
    `  --site-accent-bg: ${accentBg};`,
    `}`,
    '@scope (.blog-site-theme-root) to (.blog-studio-ui-exempt) {',
    ...scopedBlocks,
    scopeBaseRule,
    '}',
    safeOverrideCss
  ]
    .filter(Boolean)
    .join('\n\n');

  const chromeColumns = [];
  if (cfg?.chrome?.columns && chromeSource.text) {
    for (const col of cfg.chrome.columns) {
      const html = extractDivInnerHtmlByClass(chromeSource.text, col.className);
      if (html) {
        chromeColumns.push({
          className: col.className,
          wrapperClasses: col.wrapperClasses,
          ariaLabel: col.ariaLabel,
          html
        });
      }
    }
  }

  const payload = {
    available: true,
    siteName,
    configured: Boolean(cfg),
    palette: { contentBg, navBg, accentBg },
    articleClasses: cfg?.articleClasses || [],
    innerClasses: cfg?.innerClasses || [],
    googleFonts: cfg?.googleFonts || [],
    chrome: { columns: chromeColumns },
    css: scopedCss
  };

  themeCache.set(siteRoot, { key: cacheKey, payload });
  return payload;
}

/**
 * Inspect whether a blog site theme is available without reading full CSS.
 */
export async function detectSiteThemeMeta(blogRoot) {
  const resolvedBlogRoot = path.resolve(blogRoot);
  const cfg = await findSiteConfigFromBlogRoot(resolvedBlogRoot);
  if (cfg && cfg.cssFiles.length > 0) {
    return { available: true, siteName: cfg.siteName, configured: true };
  }
  const siteRoot = path.dirname(resolvedBlogRoot);
  for (const staticDir of COMMON_STATIC_DIRS) {
    for (const candidate of [path.join(staticDir, 'resources', 'base.css'), path.join(staticDir, 'style.css'), path.join(staticDir, 'styles.css')]) {
      try {
        const full = path.join(siteRoot, candidate);
        const stat = await fs.stat(full);
        if (stat.isFile() && stat.size <= MAX_CSS_BYTES) {
          return { available: true, siteName: path.basename(siteRoot), configured: false };
        }
      } catch {
        // Keep probing
      }
    }
  }
  return { available: false, siteName: '', configured: false };
}
