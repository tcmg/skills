import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, serializeDocument, todayIsoDate } from './frontmatter.mjs';
import {
  COMMON_STATIC_DIRS,
  autoDetectContentDir,
  findSiteConfigFromBlogRoot,
  resolveSafeRelativePath,
  workspaceUriToPath
} from './site-config.mjs';
import { detectSiteThemeMeta } from './site-theme.mjs';

export const ROOT_PROJECT = '_root';
export const ALL_PROJECTS = '_all';
const FOCUS_TARGET_FILENAME = '.blog-studio-target.json';
const RECENT_FOCUS_WINDOW_MS = 60_000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_POST_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_IMAGE_MIME_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);

/**
 * Validate a project name, post slug, or single filename segment against strict allow-list rules.
 */
export function validateIdentifier(value, label = 'identifier') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new Error(`Invalid ${label}: must be a non-empty string up to 100 characters.`);
  }
  if (
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.basename(value) !== value
  ) {
    throw new Error(`Invalid ${label}: path traversal or directory separators are forbidden.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) {
    throw new Error(`Invalid ${label}: only alphanumeric characters, dots, underscores, and hyphens are allowed.`);
  }
  return value;
}

/**
 * Validate a project specifier: allows ROOT_PROJECT ('_root'), optionally ALL_PROJECTS ('_all'),
 * or a standard safe directory identifier.
 */
export function validateProject(value, { allowAll = false } = {}) {
  if (value === ROOT_PROJECT) return ROOT_PROJECT;
  if (allowAll && value === ALL_PROJECTS) return ALL_PROJECTS;
  return validateIdentifier(value, 'project');
}

/**
 * Resolve a path safely within rootDir, strictly enforcing a trailing path separator prefix check.
 */
export function resolveSafePath(rootDir, ...segments) {
  const base = path.resolve(rootDir);
  const safeSegments = segments.map((seg, idx) => validateIdentifier(seg, `path segment ${idx}`));
  const target = path.resolve(base, ...safeSegments);
  if (!target.startsWith(base + path.sep)) {
    throw new Error('Security boundary violation: resolved path escapes root directory.');
  }
  return target;
}

function normalizeSlug(slugOrName) {
  let clean = String(slugOrName ?? '').trim();
  if (clean.toLowerCase().endsWith('.md')) {
    clean = clean.slice(0, -3);
  }
  return validateIdentifier(clean, 'slug');
}

export function slugifyTitle(title) {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base || `draft-${Date.now()}`;
}

async function isDirectoryWritable(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.access(dirPath, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function extractProjectFromWorkspaceUri(workspaceUri) {
  if (typeof workspaceUri !== 'string' || !workspaceUri.trim()) {
    return null;
  }
  try {
    let fsPath = workspaceUri.trim();
    if (fsPath.startsWith('file://')) {
      fsPath = fileURLToPath(fsPath);
    }
    const base = path.basename(path.resolve(fsPath));
    return validateIdentifier(base, 'workspace project');
  } catch {
    return null;
  }
}

/**
 * Resolve the active blog content directory.
 * Priority:
 *   1. Explicit options.blogRoot
 *   2. process.env.BLOG_ROOT
 *   3. Active workspace `.blog-studio.json` contentDir or auto-detected SSG content dir
 *      (blog/, content/posts/, content/blog/, src/content/blog/, _posts/, posts/)
 *   4. Fallback (~/.markdown-blog-studio/blog or repo blog-data/)
 */
export async function resolveBlogRoot(options = {}) {
  if (options?.blogRoot) {
    const resolved = path.resolve(options.blogRoot);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }

  if (process.env.BLOG_ROOT && process.env.BLOG_ROOT.trim()) {
    const resolved = path.resolve(process.env.BLOG_ROOT.trim());
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }

  const wsPath = workspaceUriToPath(options?.workspaceUri);
  if (wsPath) {
    const detected = await autoDetectContentDir(wsPath);
    if (detected) {
      return detected;
    }
  }

  const repoFallback = path.join(REPO_ROOT, 'blog-data');
  if (await isDirectoryWritable(repoFallback)) {
    return repoFallback;
  }

  const homeFallback = path.join(os.homedir(), '.markdown-blog-studio', 'blog');
  await fs.mkdir(homeFallback, { recursive: true });
  return homeFallback;
}

function buildStarterArticle(project) {
  const date = todayIsoDate();
  return serializeDocument({
    hasFrontmatter: true,
    meta: {
      date,
      title: `${project}: Architecture & Concept Notes`,
      status: 'idea'
    },
    body: `# ${project}: Architecture & Concept Notes

## The Hook

Write your opening in media res here. Select any text in **Visual Edit** to reveal the floating Medium-style toolbar, or press \`⌘B\` / \`⌘I\` / \`⌘K\` while drafting.

## Why It Matters

- Switch seamlessly between **Visual Edit**, **Raw Markdown**, and **Read Preview**
- Auto-saves directly to disk with YAML frontmatter intact
- Drag and drop screenshots straight into \`assets/\`

> Tip: Place your cursor on any empty line to reveal the \`+\` block insertion menu.
`
  });
}

async function verifyNoSymlinkEscape(rootDir, targetPath) {
  const realRoot = await fs.realpath(path.resolve(rootDir));
  try {
    const realTarget = await fs.realpath(targetPath);
    if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
      throw new Error('Security boundary violation: symlink escapes blog root.');
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const parent = path.dirname(targetPath);
      const realParent = await fs.realpath(parent);
      if (!realParent.startsWith(realRoot + path.sep) && realParent !== realRoot) {
        throw new Error('Security boundary violation: parent symlink escapes blog root.');
      }
      return;
    }
    throw err;
  }
}

function resolveProjectDir(blogRoot, project) {
  const safeProject = validateProject(project);
  if (safeProject === ROOT_PROJECT) {
    return path.resolve(blogRoot);
  }
  return resolveSafePath(blogRoot, safeProject);
}

function resolvePostPath(blogRoot, project, filename) {
  const safeProject = validateProject(project);
  if (safeProject === ROOT_PROJECT) {
    return resolveSafePath(blogRoot, filename);
  }
  return resolveSafePath(blogRoot, safeProject, filename);
}

function isWorkspaceBlogHub(blogRoot, workspaceUri) {
  const wsPath = workspaceUriToPath(workspaceUri);
  if (!wsPath) return false;
  const resolvedBlog = path.resolve(blogRoot);
  return resolvedBlog === wsPath || resolvedBlog.startsWith(wsPath + path.sep);
}

export async function listProjects(blogRoot) {
  const root = path.resolve(blogRoot);
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'assets') continue;
    try {
      projects.push(validateIdentifier(entry.name, 'project'));
    } catch {
      // Skip directories that do not match safe identifier rules.
    }
  }
  projects.sort((a, b) => a.localeCompare(b));
  return projects;
}

async function listPostsInSingleDir(blogRoot, project) {
  const safeProject = validateProject(project);
  const projectDir = resolveProjectDir(blogRoot, safeProject);
  if (safeProject !== ROOT_PROJECT) {
    await fs.mkdir(projectDir, { recursive: true });
  }
  await verifyNoSymlinkEscape(blogRoot, projectDir);

  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  const posts = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let filename;
    try {
      filename = validateIdentifier(entry.name, 'filename');
    } catch {
      continue;
    }
    const fullPath = resolvePostPath(blogRoot, safeProject, filename);
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_POST_BYTES) continue;

    const raw = await fs.readFile(fullPath, 'utf8');
    const parsed = parseDocument(raw);
    const slug = filename.slice(0, -3);

    posts.push({
      project: safeProject,
      slug,
      filename,
      title: parsed.meta.title || slug,
      status: parsed.meta.status || 'idea',
      date: parsed.meta.date || '',
      mtimeMs: stat.mtimeMs,
      fullPath
    });
  }

  posts.sort((a, b) => {
    if (safeProject !== ROOT_PROJECT) {
      const aConcept = a.filename.endsWith('-CONCEPT.md') ? 0 : 1;
      const bConcept = b.filename.endsWith('-CONCEPT.md') ? 0 : 1;
      if (aConcept !== bConcept) return aConcept - bConcept;
    }
    return b.mtimeMs - a.mtimeMs;
  });

  return posts;
}

export async function listPosts(blogRoot, project) {
  const safeProject = validateProject(project, { allowAll: true });
  if (safeProject === ALL_PROJECTS) {
    const subProjects = await listProjects(blogRoot);
    const rootPosts = await listPostsInSingleDir(blogRoot, ROOT_PROJECT);
    const subPostLists = await Promise.all(subProjects.map((p) => listPostsInSingleDir(blogRoot, p)));
    const combined = [...rootPosts, ...subPostLists.flat()];
    combined.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return combined;
  }
  return listPostsInSingleDir(blogRoot, safeProject);
}

export async function readPost(blogRoot, project, slug) {
  const safeProject = validateProject(project);
  const safeSlug = normalizeSlug(slug);
  const filename = `${safeSlug}.md`;
  const fullPath = resolvePostPath(blogRoot, safeProject, filename);
  await verifyNoSymlinkEscape(blogRoot, fullPath);

  const stat = await fs.stat(fullPath);
  if (stat.size > MAX_POST_BYTES) {
    throw new Error(`Post exceeds maximum allowed size (${MAX_POST_BYTES} bytes).`);
  }
  const content = await fs.readFile(fullPath, 'utf8');
  return {
    project: safeProject,
    slug: safeSlug,
    filename,
    content,
    mtimeMs: stat.mtimeMs,
    fullPath
  };
}

export async function savePost(blogRoot, project, slug, content) {
  if (typeof content !== 'string') {
    throw new Error('Post content must be a UTF-8 string.');
  }
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_POST_BYTES) {
    throw new Error(`Post content exceeds maximum size (${MAX_POST_BYTES} bytes).`);
  }

  const safeProject = validateProject(project);
  const safeSlug = normalizeSlug(slug);
  const filename = `${safeSlug}.md`;
  const projectDir = resolveProjectDir(blogRoot, safeProject);
  await fs.mkdir(projectDir, { recursive: true });
  if (safeProject !== ROOT_PROJECT) {
    const assetsDir = resolveSafePath(blogRoot, safeProject, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
  }

  const fullPath = resolvePostPath(blogRoot, safeProject, filename);
  await verifyNoSymlinkEscape(blogRoot, fullPath);

  const tempFilename = `tmp-${safeSlug}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tempPath = resolvePostPath(blogRoot, safeProject, tempFilename);

  await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o644 });
  await fs.rename(tempPath, fullPath);
  const stat = await fs.stat(fullPath);

  return {
    saved: true,
    project: safeProject,
    slug: safeSlug,
    filename,
    mtimeMs: stat.mtimeMs,
    fullPath
  };
}

export async function createPost(blogRoot, project, { title, slug, status } = {}) {
  const targetProject = project === ALL_PROJECTS ? ROOT_PROJECT : validateProject(project);
  const cleanTitle = String(title || 'Untitled Draft').replace(/\r?\n/g, ' ').trim() || 'Untitled Draft';
  const safeSlug = normalizeSlug(slug || slugifyTitle(cleanTitle));
  const cleanStatus = ['idea', 'draft', 'unlisted', 'review', 'published'].includes(status) ? status : 'idea';
  const filename = `${safeSlug}.md`;
  const fullPath = resolvePostPath(blogRoot, targetProject, filename);

  await fs.mkdir(resolveProjectDir(blogRoot, targetProject), { recursive: true });
  await verifyNoSymlinkEscape(blogRoot, fullPath);

  let existsAndNonEmpty = false;
  try {
    const stat = await fs.stat(fullPath);
    if (stat.size > 0) {
      existsAndNonEmpty = true;
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  if (existsAndNonEmpty) {
    throw new Error(`Draft "${filename}" already exists.`);
  }

  const content = serializeDocument({
    hasFrontmatter: true,
    meta: {
      date: todayIsoDate(),
      title: cleanTitle,
      status: cleanStatus
    },
    body: `# ${cleanTitle}\n\n`
  });

  await savePost(blogRoot, targetProject, safeSlug, content);
  return readPost(blogRoot, targetProject, safeSlug);
}

export async function getPostMtime(blogRoot, project, slug) {
  const safeProject = validateProject(project);
  const safeSlug = normalizeSlug(slug);
  const fullPath = resolvePostPath(blogRoot, safeProject, `${safeSlug}.md`);
  await verifyNoSymlinkEscape(blogRoot, fullPath);
  const stat = await fs.stat(fullPath);
  return {
    project: safeProject,
    slug: safeSlug,
    mtimeMs: stat.mtimeMs
  };
}

/**
 * Record an active target post so an open Blog Editor pane automatically switches to it.
 */
export async function setActiveTarget(blogRoot, project, slug) {
  const safeProject = validateProject(project);
  const safeSlug = normalizeSlug(slug);
  const fullPath = resolvePostPath(blogRoot, safeProject, `${safeSlug}.md`);
  await verifyNoSymlinkEscape(blogRoot, fullPath);
  await fs.stat(fullPath); // Ensure target post exists

  const payload = {
    project: safeProject,
    slug: safeSlug,
    requestedAt: Date.now()
  };
  const targetFile = path.join(path.resolve(blogRoot), FOCUS_TARGET_FILENAME);
  const tempFile = path.join(
    path.resolve(blogRoot),
    `.tmp-target-${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  await fs.writeFile(tempFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o644 });
  await fs.rename(tempFile, targetFile);
  return payload;
}

/**
 * Read the latest requested focus target if present and valid.
 */
export async function getActiveTarget(blogRoot) {
  const targetFile = path.join(path.resolve(blogRoot), FOCUS_TARGET_FILENAME);
  try {
    const raw = await fs.readFile(targetFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const safeProject = validateProject(parsed.project);
    const safeSlug = normalizeSlug(parsed.slug);
    const requestedAt = Number(parsed.requestedAt) || 0;
    if (requestedAt <= 0) return null;
    return { project: safeProject, slug: safeSlug, requestedAt };
  } catch {
    return null;
  }
}

export function detectImageMagicMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return null;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const gifHead = buffer.subarray(0, 6).toString('ascii');
  if (gifHead === 'GIF87a' || gifHead === 'GIF89a') {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function saveAsset(blogRoot, project, { filename, base64Data, mimeType } = {}) {
  const safeProject = project === ALL_PROJECTS ? ROOT_PROJECT : validateProject(project);
  if (typeof mimeType !== 'string' || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('Unsupported image MIME type. Allowed: image/png, image/jpeg, image/webp, image/gif.');
  }
  if (typeof base64Data !== 'string' || base64Data.length === 0) {
    throw new Error('Image payload is empty.');
  }

  const strippedBase64 = base64Data.replace(/^data:[^;]+;base64,/, '').trim();
  const buffer = Buffer.from(strippedBase64, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) {
    throw new Error(`Image exceeds allowed size (1 byte to ${MAX_ASSET_BYTES} bytes).`);
  }

  const detectedMime = detectImageMagicMime(buffer);
  if (!detectedMime || detectedMime !== mimeType) {
    throw new Error('Security validation failed: image binary header does not match declared MIME type.');
  }

  const ext = ALLOWED_IMAGE_MIME_TYPES.get(detectedMime);
  const rawBase = path.basename(String(filename || 'image'));
  const rawStem = rawBase.replace(/\.[^.]+$/, '');
  const sanitizedStem =
    rawStem
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'asset';

  // TODO(security): Integrate sandboxed antivirus/CDR scanning if untrusted multi-tenant uploads are ever exposed.
  const uniqueFilename = `${sanitizedStem}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const assetsDir =
    safeProject === ROOT_PROJECT
      ? resolveSafePath(blogRoot, 'assets')
      : resolveSafePath(blogRoot, safeProject, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  const targetPath =
    safeProject === ROOT_PROJECT
      ? resolveSafePath(blogRoot, 'assets', uniqueFilename)
      : resolveSafePath(blogRoot, safeProject, 'assets', uniqueFilename);
  await verifyNoSymlinkEscape(blogRoot, targetPath);

  await fs.writeFile(targetPath, buffer, { mode: 0o644 });

  return {
    project: safeProject,
    filename: uniqueFilename,
    mimeType: detectedMime,
    relativeMarkdownPath: `assets/${uniqueFilename}`,
    bytes: buffer.length
  };
}

async function readValidatedImageFile(boundaryRoot, targetPath, displayFilename) {
  await verifyNoSymlinkEscape(boundaryRoot, targetPath);
  const stat = await fs.stat(targetPath);
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error('Asset exceeds maximum allowed size.');
  }
  const buffer = await fs.readFile(targetPath);
  const mimeType = detectImageMagicMime(buffer);
  if (!mimeType) {
    throw new Error('Asset failed magic-byte image validation.');
  }
  return {
    buffer,
    mimeType,
    filename: displayFilename
  };
}

export async function readAsset(blogRoot, project, assetFilename) {
  const rawRef = String(assetFilename ?? '').trim();

  // Support site-absolute blog & resource paths used in standalone/published essays
  // e.g. "/blog/whats-worth-meme.png", "/blog/<project>/assets/<file>", "/resources/<file>"
  if (rawRef.startsWith('/blog/')) {
    const segments = rawRef.slice('/blog/'.length).split('/').filter(Boolean);
    if (segments.length === 0 || segments.length > 3) {
      throw new Error('Invalid blog asset path.');
    }
    const targetPath = resolveSafePath(blogRoot, ...segments);
    return readValidatedImageFile(blogRoot, targetPath, segments[segments.length - 1]);
  }

  if (rawRef.startsWith('/')) {
    const segments = rawRef.slice(1).split('/').filter(Boolean);
    if (segments.length === 0 || segments.length > 4) {
      throw new Error('Invalid site asset path.');
    }
    const cfg = await findSiteConfigFromBlogRoot(blogRoot);
    const siteRoot = cfg ? cfg.siteRoot : path.dirname(path.resolve(blogRoot));
    const staticRoots = [];
    if (cfg?.staticDir) {
      try {
        staticRoots.push(resolveSafeRelativePath(siteRoot, cfg.staticDir));
      } catch {
        // Ignore invalid staticDir
      }
    }
    for (const dirName of COMMON_STATIC_DIRS) {
      const candidate = path.join(siteRoot, dirName);
      if (!staticRoots.includes(candidate)) staticRoots.push(candidate);
    }
    for (const staticRoot of staticRoots) {
      try {
        const targetPath = resolveSafePath(staticRoot, ...segments);
        return await readValidatedImageFile(staticRoot, targetPath, segments[segments.length - 1]);
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
    }
    throw new Error('Site asset not found.');
  }

  const safeProject = validateProject(project);
  const cleanRel = rawRef.replace(/^\.\//, '').replace(/^assets\//, '');
  const safeFile = validateIdentifier(cleanRel, 'asset filename');

  const candidates =
    safeProject === ROOT_PROJECT
      ? [resolveSafePath(blogRoot, 'assets', safeFile), resolveSafePath(blogRoot, safeFile)]
      : [resolveSafePath(blogRoot, safeProject, 'assets', safeFile), resolveSafePath(blogRoot, safeProject, safeFile)];

  let lastErr;
  for (const candidate of candidates) {
    try {
      return await readValidatedImageFile(blogRoot, candidate, safeFile);
    } catch (err) {
      lastErr = err;
      if (err && err.code !== 'ENOENT') throw err;
    }
  }
  throw lastErr || new Error('Asset not found.');
}

/**
 * Initialize or refresh store state for an active workspace URI or preferred project/slug.
 */
export async function initStore(options = {}) {
  const blogRoot = await resolveBlogRoot(options);
  const workspaceProject = extractProjectFromWorkspaceUri(options.workspaceUri);
  const inBlogHubWorkspace = isWorkspaceBlogHub(blogRoot, options.workspaceUri);
  let preferredProject = null;
  if (options.preferredProject) {
    preferredProject = validateProject(options.preferredProject, { allowAll: true });
  }

  let subProjects = await listProjects(blogRoot);
  const rootPosts = await listPostsInSingleDir(blogRoot, ROOT_PROJECT);
  const hasRoot = rootPosts.length > 0;

  let activeProject;
  if (preferredProject) {
    activeProject = preferredProject;
  } else if (inBlogHubWorkspace && (hasRoot || subProjects.length > 1)) {
    activeProject = ALL_PROJECTS;
  } else if (!workspaceProject && (hasRoot || subProjects.length > 1)) {
    activeProject = ALL_PROJECTS;
  } else {
    activeProject = workspaceProject || (hasRoot ? ROOT_PROJECT : subProjects[0]) || 'markdown-blog-studio';
  }
  activeProject = validateProject(activeProject, { allowAll: true });

  if (activeProject !== ALL_PROJECTS && activeProject !== ROOT_PROJECT && !subProjects.includes(activeProject)) {
    const conceptSlug = `${activeProject}-CONCEPT`;
    await savePost(blogRoot, activeProject, conceptSlug, buildStarterArticle(activeProject));
    subProjects = await listProjects(blogRoot);
  }

  let posts = await listPosts(blogRoot, activeProject);
  if (posts.length === 0) {
    const fallbackProject =
      activeProject === ALL_PROJECTS ? (subProjects[0] || ROOT_PROJECT) : activeProject;
    const conceptSlug =
      fallbackProject === ROOT_PROJECT ? 'first-draft' : `${fallbackProject}-CONCEPT`;
    await savePost(blogRoot, fallbackProject, conceptSlug, buildStarterArticle(fallbackProject));
    subProjects = await listProjects(blogRoot);
    posts = await listPosts(blogRoot, activeProject);
  }

  const latestRootPosts = activeProject === ROOT_PROJECT ? posts : await listPostsInSingleDir(blogRoot, ROOT_PROJECT);
  const projects = [];
  if (latestRootPosts.length > 0 || subProjects.length > 1 || activeProject === ALL_PROJECTS) {
    projects.push(ALL_PROJECTS);
  }
  if (latestRootPosts.length > 0 || activeProject === ROOT_PROJECT) {
    projects.push(ROOT_PROJECT);
  }
  projects.push(...subProjects);

  let targetPost = posts[0];
  let desiredSlug = options.preferredSlug || null;
  let desiredPostProject = options.preferredPostProject || null;

  if (!desiredSlug) {
    const recentTarget = await getActiveTarget(blogRoot);
    if (recentTarget && Date.now() - recentTarget.requestedAt <= RECENT_FOCUS_WINDOW_MS) {
      desiredSlug = recentTarget.slug;
      desiredPostProject = recentTarget.project;
    }
  }

  if (desiredSlug) {
    const safePreferredSlug = normalizeSlug(desiredSlug);
    const match = posts.find(
      (p) =>
        p.slug === safePreferredSlug &&
        (!desiredPostProject || p.project === desiredPostProject)
    );
    if (match) {
      targetPost = match;
    }
  }

  const currentPost = await readPost(blogRoot, targetPost.project, targetPost.slug);
  const siteTheme = await detectSiteThemeMeta(blogRoot);

  return {
    blogRoot,
    activeProject,
    projects,
    posts,
    currentPost,
    siteTheme
  };
}
