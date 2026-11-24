import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPost,
  getActiveTarget,
  getPostMtime,
  initStore,
  isFallbackBlogRoot,
  readAsset,
  readPost,
  rememberLastOpenedPost,
  resolveBlogRoot,
  saveAsset,
  savePost,
  setActiveTarget,
  validateIdentifier,
  validateProject
} from '../core/blog-store.mjs';
import { loadSiteTheme } from '../core/site-theme.mjs';
import { addWordToUserDictionary, checkWords } from '../core/spellchecker.mjs';
import { startHttpFallbackServer } from './http-fallback.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_HTML_PATH = path.join(REPO_ROOT, 'dist', 'editor.html');

export function createHandlers(options = {}) {
  let cachedBlogRoot = options.blogRoot ? path.resolve(options.blogRoot) : null;
  const knownBlogRoots = new Set(cachedBlogRoot ? [cachedBlogRoot] : []);

  async function ensureBlogRoot(payload = {}) {
    if (options.blogRoot) {
      const resolved = await resolveBlogRoot({ blogRoot: options.blogRoot });
      knownBlogRoots.add(resolved);
      return resolved;
    }

    if (typeof payload?.blogRoot === 'string' && payload.blogRoot.trim()) {
      const requested = path.resolve(payload.blogRoot.trim());
      if (knownBlogRoots.has(requested)) {
        return requested;
      }
    }

    const hasWorkspaceHint =
      Boolean(payload?.workspaceUri) || (Array.isArray(payload?.workspaceUris) && payload.workspaceUris.length > 0);

    if (!cachedBlogRoot || hasWorkspaceHint) {
      const resolved = await resolveBlogRoot({
        workspaceUri: payload?.workspaceUri,
        workspaceUris: payload?.workspaceUris
      });
      knownBlogRoots.add(resolved);
      // Never let a non-blog workspace's fallback blog-data/ clobber an already-resolved real blog root.
      if (!cachedBlogRoot || !isFallbackBlogRoot(resolved) || isFallbackBlogRoot(cachedBlogRoot)) {
        cachedBlogRoot = resolved;
      }
      return resolved;
    }

    return cachedBlogRoot;
  }

  return {
    selectDefaultBlogRoot(blogRoot) {
      if (typeof blogRoot === 'string' && blogRoot.trim()) {
        const normalized = path.resolve(blogRoot.trim());
        if (knownBlogRoots.has(normalized)) {
          cachedBlogRoot = normalized;
        }
      }
    },

    async init(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      return initStore({
        blogRoot,
        workspaceUri: payload.workspaceUri,
        workspaceUris: payload.workspaceUris,
        preferredProject: payload.preferredProject,
        preferredSlug: payload.preferredSlug,
        preferredPostProject: payload.preferredPostProject
      });
    },

    async siteTheme(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      return loadSiteTheme(blogRoot);
    },

    async read(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      const post = await readPost(blogRoot, payload.project, payload.slug);
      await rememberLastOpenedPost(blogRoot, post.project, post.slug);
      return post;
    },

    async save(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      const saved = await savePost(blogRoot, payload.project, payload.slug, payload.content, {
        baseContent: payload.baseContent,
        expectedMtimeMs: payload.expectedMtimeMs
      });
      await rememberLastOpenedPost(blogRoot, saved.project, saved.slug);
      return saved;
    },

    async create(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      const created = await createPost(blogRoot, payload.project, {
        title: payload.title,
        slug: payload.slug,
        status: payload.status
      });
      await rememberLastOpenedPost(blogRoot, created.project, created.slug);
      return created;
    },

    async mtime(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      const [mtimeRes, focusTarget] = await Promise.all([
        getPostMtime(blogRoot, payload.project, payload.slug),
        getActiveTarget(blogRoot)
      ]);
      return {
        ...mtimeRes,
        focusTarget
      };
    },

    async focusPost(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      return setActiveTarget(blogRoot, payload.project, payload.slug);
    },

    async uploadAsset(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      return saveAsset(blogRoot, payload.project, {
        filename: payload.filename,
        base64Data: payload.base64Data,
        mimeType: payload.mimeType
      });
    },

    async readAssetBinary(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      return readAsset(blogRoot, payload.project, payload.filename);
    },

    async readAssetDataUrl(payload = {}) {
      const blogRoot = await ensureBlogRoot(payload);
      const asset = await readAsset(blogRoot, payload.project, payload.filename);
      return {
        filename: asset.filename,
        mimeType: asset.mimeType,
        dataUrl: `data:${asset.mimeType};base64,${asset.buffer.toString('base64')}`
      };
    },

    async spellcheck(payload = {}) {
      return checkWords(payload.lang, payload.words);
    },

    async spellcheckAdd(payload = {}) {
      return addWordToUserDictionary(payload.word);
    }
  };
}

async function readBuiltEditorHtml() {
  return fs.readFile(DIST_HTML_PATH, 'utf8');
}

function launchInChrome(url) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Google Chrome', url], (err) => {
        if (!err) {
          resolve();
          return;
        }
        execFile('open', [url], (fallbackErr) => {
          if (fallbackErr) reject(fallbackErr);
          else resolve();
        });
      });
      return;
    }
    if (process.platform === 'linux') {
      execFile('xdg-open', [url], (err) => (err ? reject(err) : resolve()));
      return;
    }
    execFile('cmd', ['/c', 'start', '', url], (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const handlers = createHandlers();

  let sidecarSdk = null;
  try {
    sidecarSdk = await import('sidecar_sdk');
  } catch {
    sidecarSdk = null;
  }

  if (sidecarSdk?.SidecarApp) {
    const app = new sidecarSdk.SidecarApp();
    let popoutServerPromise = null;

    async function ensurePopoutServer() {
      if (!popoutServerPromise) {
        // Prefer stable loopback port 3489 so Chrome preserves localStorage preferences (theme, sidebars)
        // across reloads and restarts; fall back to an ephemeral port if 3489 is already occupied.
        popoutServerPromise = startHttpFallbackServer({
          getHtml: readBuiltEditorHtml,
          handlers,
          port: 3489
        })
          .catch(() =>
            startHttpFallbackServer({
              getHtml: readBuiltEditorHtml,
              handlers,
              port: 0
            })
          )
          .catch((err) => {
            popoutServerPromise = null;
            throw err;
          });
      }
      return popoutServerPromise;
    }

    app.page('/', async () => {
      const html = await readBuiltEditorHtml();
      return html.replace('<!--SIDECAR_PRELOAD-->', '<script src="/preload.js"></script>');
    });

    app.api('/api/init', (data) => handlers.init(data));
    app.api('/api/read', (data) => handlers.read(data));
    app.api('/api/save', (data) => handlers.save(data));
    app.api('/api/create', (data) => handlers.create(data));
    app.api('/api/mtime', (data) => handlers.mtime(data));
    app.api('/api/focus', (data) => handlers.focusPost(data));
    app.api('/api/upload-asset', (data) => handlers.uploadAsset(data));
    app.api('/api/read-asset', (data) => handlers.readAssetDataUrl(data));
    app.api('/api/site-theme', (data) => handlers.siteTheme(data));
    app.api('/api/spellcheck', (data) => handlers.spellcheck(data));
    app.api('/api/spellcheck-add', (data) => handlers.spellcheckAdd(data));
    app.api('/api/popout', async (data = {}) => {
      if (typeof data.blogRoot === 'string' && data.blogRoot.trim()) {
        handlers.selectDefaultBlogRoot(data.blogRoot);
      }
      const srv = await ensurePopoutServer();
      const params = new URLSearchParams();
      if (typeof data.project === 'string' && data.project.trim()) {
        params.set('project', validateProject(data.project.trim(), { allowAll: true }));
      }
      if (typeof data.slug === 'string' && data.slug.trim()) {
        const cleanSlug = data.slug.trim().replace(/\.md$/i, '');
        params.set('slug', validateIdentifier(cleanSlug, 'slug'));
      }
      if (typeof data.sidebars === 'boolean') {
        params.set('sidebars', data.sidebars ? '1' : '0');
      }
      const query = params.toString();
      const targetUrl = query ? `${srv.url}/?${query}` : `${srv.url}/`;
      await launchInChrome(targetUrl);
      return { opened: true, url: targetUrl };
    });

    if (typeof app.run === 'function') {
      app.run();
    } else if (typeof app.listen === 'function') {
      app.listen();
    }
    return;
  }

  const instance = await startHttpFallbackServer({
    getHtml: readBuiltEditorHtml,
    handlers
  });
  console.log(`Markdown Blog Studio listening on ${instance.url}`);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error('Failed to start Markdown Blog Studio sidecar:', err?.message || err);
    process.exit(1);
  });
}
