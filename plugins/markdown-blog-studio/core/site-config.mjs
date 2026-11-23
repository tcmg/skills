import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILENAME = '.blog-studio.json';

export const COMMON_CONTENT_DIRS = [
  'blog',
  path.join('content', 'posts'),
  path.join('content', 'blog'),
  path.join('src', 'content', 'blog'),
  path.join('src', 'content', 'posts'),
  '_posts',
  'posts'
];

export const COMMON_STATIC_DIRS = ['public', 'static', 'dist', '_site', 'out', 'build'];

export function workspaceUriToPath(workspaceUri) {
  if (typeof workspaceUri !== 'string' || !workspaceUri.trim()) return null;
  try {
    const raw = workspaceUri.trim();
    return path.resolve(raw.startsWith('file://') ? fileURLToPath(raw) : raw);
  } catch {
    return null;
  }
}

export function resolveSafeRelativePath(rootDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('Relative path must be a non-empty string.');
  }
  if (path.isAbsolute(relPath) || relPath.includes('\0')) {
    throw new Error('Absolute paths and null bytes are not allowed in .blog-studio.json.');
  }
  const base = path.resolve(rootDir);
  const resolved = path.resolve(base, relPath.trim());
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path "${relPath}" escapes workspace root.`);
  }
  return resolved;
}

function sanitizeClassList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => String(c || '').trim())
    .filter((c) => /^[a-zA-Z_-][a-zA-Z0-9_-]{0,63}$/.test(c));
}

function sanitizeGoogleFonts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => String(f || '').trim())
    .filter((f) => /^[a-zA-Z0-9+:;,@._-]{1,120}$/.test(f));
}

function sanitizeColor(raw) {
  const val = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(val) || /^rgba?\([0-9.,\s%]+\)$/i.test(val)) {
    return val;
  }
  return '';
}

/**
 * Load and validate `.blog-studio.json` from a site root if present.
 */
export async function loadSiteConfig(siteRoot) {
  if (!siteRoot) return null;
  const resolvedRoot = path.resolve(siteRoot);
  const configPath = path.join(resolvedRoot, CONFIG_FILENAME);
  try {
    const stat = await fs.stat(configPath);
    if (!stat.isFile() || stat.size > 128 * 1024) return null;
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const fontMap = {};
    if (parsed.fontMap && typeof parsed.fontMap === 'object') {
      for (const [from, to] of Object.entries(parsed.fontMap)) {
        if (/^[a-zA-Z0-9 _-]{1,64}$/.test(from) && typeof to === 'string' && to.trim().length > 0 && to.length <= 200) {
          fontMap[from] = to.replace(/[;{}<>]/g, '').trim();
        }
      }
    }

    const chromeColumns = [];
    if (parsed.chrome && Array.isArray(parsed.chrome.columns)) {
      for (const col of parsed.chrome.columns.slice(0, 4)) {
        if (!col || typeof col !== 'object') continue;
        const className = String(col.className || '').trim();
        if (!/^[a-zA-Z_-][a-zA-Z0-9_-]{0,63}$/.test(className)) continue;
        chromeColumns.push({
          className,
          wrapperClasses: sanitizeClassList(col.wrapperClasses || [className]),
          ariaLabel: String(col.ariaLabel || className).slice(0, 80)
        });
      }
    }

    return {
      siteRoot: resolvedRoot,
      configPath,
      mtimeMs: stat.mtimeMs,
      siteName: String(parsed.siteName || path.basename(resolvedRoot)).slice(0, 100),
      contentDir: typeof parsed.contentDir === 'string' ? parsed.contentDir.trim() : '',
      staticDir: typeof parsed.staticDir === 'string' ? parsed.staticDir.trim() : '',
      cssFiles: Array.isArray(parsed.cssFiles)
        ? parsed.cssFiles.filter((f) => typeof f === 'string' && f.trim().length > 0).slice(0, 10)
        : [],
      fontMap,
      googleFonts: sanitizeGoogleFonts(parsed.googleFonts),
      palette: {
        contentBg: sanitizeColor(parsed.palette?.contentBg),
        contentSelector:
          typeof parsed.palette?.contentSelector === 'string' &&
          /^\.[a-zA-Z_-][a-zA-Z0-9_-]{0,63}$/.test(parsed.palette.contentSelector.trim())
            ? parsed.palette.contentSelector.trim()
            : '',
        navBg: sanitizeColor(parsed.palette?.navBg),
        accentBg: sanitizeColor(parsed.palette?.accentBg)
      },
      articleClasses: sanitizeClassList(parsed.articleClasses),
      innerClasses: sanitizeClassList(parsed.innerClasses),
      chrome:
        parsed.chrome && typeof parsed.chrome.sourceHtml === 'string' && chromeColumns.length > 0
          ? {
              sourceHtml: parsed.chrome.sourceHtml.trim(),
              columns: chromeColumns
            }
          : null,
      overrideCss: typeof parsed.overrideCss === 'string' ? parsed.overrideCss.slice(0, 32 * 1024) : ''
    };
  } catch {
    return null;
  }
}

/**
 * Walk upward from blogRoot (up to 3 parent levels) to find a `.blog-studio.json` site root.
 */
export async function findSiteConfigFromBlogRoot(blogRoot) {
  let cursor = path.resolve(blogRoot);
  for (let i = 0; i < 4; i += 1) {
    const cfg = await loadSiteConfig(cursor);
    if (cfg) return cfg;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Auto-detect a Markdown content directory inside a workspace root.
 */
export async function autoDetectContentDir(workspaceDir) {
  if (!workspaceDir) return null;
  const cfg = await loadSiteConfig(workspaceDir);
  if (cfg?.contentDir) {
    try {
      const target = resolveSafeRelativePath(workspaceDir, cfg.contentDir);
      await fs.access(target, fsConstants.R_OK | fsConstants.W_OK);
      return target;
    } catch {
      // Fall through to common directory detection.
    }
  }

  for (const rel of COMMON_CONTENT_DIRS) {
    const candidate = path.join(workspaceDir, rel);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        await fs.access(candidate, fsConstants.R_OK | fsConstants.W_OK);
        return candidate;
      }
    } catch {
      // Try next common SSG content directory.
    }
  }
  return null;
}
