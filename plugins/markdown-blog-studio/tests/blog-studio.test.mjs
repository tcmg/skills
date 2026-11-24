import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import {
  ALL_PROJECTS,
  ROOT_PROJECT,
  createPost,
  getActiveTarget,
  initStore,
  listPosts,
  readAsset,
  readPost,
  resolveSafePath,
  saveAsset,
  savePost,
  setActiveTarget,
  validateIdentifier
} from '../core/blog-store.mjs';
import { computeStats, extractFrontmatterExtras, parseDocument, serializeDocument } from '../core/frontmatter.mjs';
import { threeWayMerge } from '../core/merge.mjs';
import { loadSiteTheme } from '../core/site-theme.mjs';
import { checkWords } from '../core/spellchecker.mjs';
import { startHttpFallbackServer } from '../sidecar/http-fallback.mjs';
import { createHandlers } from '../sidecar/main.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_HTML_PATH = path.join(REPO_ROOT, 'dist', 'editor.html');

// Minimal valid 1x1 PNG buffer (89 50 4E 47 0D 0A 1A 0A + IHDR/IDAT/IEND)
const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('1. Build artifact exists, is >100 KB, and preserves SIDECAR_PRELOAD marker', async () => {
  const stat = await fs.stat(DIST_HTML_PATH);
  assert.ok(stat.size > 100 * 1024, `Expected dist/editor.html > 100KB, got ${stat.size}`);
  const html = await fs.readFile(DIST_HTML_PATH, 'utf8');
  assert.ok(html.includes('<!--SIDECAR_PRELOAD-->'), 'Missing <!--SIDECAR_PRELOAD--> placeholder');
});

test('2. Frontmatter lossless round-trip and word/reading-time stats', () => {
  const raw = [
    '---',
    'date: 2026-11-18',
    'title: "Dual-Host UI: Why Shared Core Wins"',
    'status: draft',
    'author: Tom Greenaway',
    '---',
    '',
    '# Dual-Host UI: Why Shared Core Wins',
    '',
    'This is **bold** prose with `inline code` and a [link](https://example.com).'
  ].join('\n');

  const parsed = parseDocument(raw);
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.meta.date, '2026-11-18');
  assert.equal(parsed.meta.title, 'Dual-Host UI: Why Shared Core Wins');
  assert.equal(parsed.meta.status, 'draft');
  assert.equal(parsed.extraLines.length, 1);
  assert.equal(parsed.extraLines[0].rawLine, 'author: Tom Greenaway');

  const reserialized = serializeDocument(parsed);
  assert.equal(reserialized, raw);

  const twoHundredWords = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const stats = computeStats(twoHundredWords);
  assert.equal(stats.words, 400);
  assert.equal(stats.readingMinutes, 2);
  assert.equal(computeStats('').words, 0);
  assert.equal(computeStats('').readingMinutes, 0);
});

test('3. Blog store blocks path traversal and validates image magic bytes', async (t) => {
  const tmpRoot = await makeTempDir('blog-studio-sec-');
  t.after(async () => fs.rm(tmpRoot, { recursive: true, force: true }));

  for (const bad of ['../etc/passwd', '..\\evil', 'a/b', 'foo\0bar', '.', '..']) {
    assert.throws(() => validateIdentifier(bad, 'slug'), /Invalid slug/);
  }
  assert.throws(() => resolveSafePath(tmpRoot, '../outside'), /Invalid path segment/);

  const siblingRoot = path.join(path.dirname(tmpRoot), `${path.basename(tmpRoot)}-malicious`);
  const safePath = resolveSafePath(tmpRoot, 'my-project', 'post.md');
  assert.ok(safePath.startsWith(path.resolve(tmpRoot) + path.sep));
  assert.equal(safePath.startsWith(siblingRoot + path.sep), false);

  await initStore({ blogRoot: tmpRoot, preferredProject: 'demo-proj' });

  const uploaded = await saveAsset(tmpRoot, 'demo-proj', {
    filename: '../../shot.png',
    base64Data: VALID_PNG_BASE64,
    mimeType: 'image/png'
  });
  assert.ok(uploaded.relativeMarkdownPath.startsWith('assets/shot-'));
  assert.ok(uploaded.relativeMarkdownPath.endsWith('.png'));

  const readBack = await readAsset(tmpRoot, 'demo-proj', uploaded.filename);
  assert.equal(readBack.mimeType, 'image/png');
  assert.ok(readBack.buffer.length > 0);

  const spoofedSvgBase64 = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8').toString('base64');
  await assert.rejects(
    () =>
      saveAsset(tmpRoot, 'demo-proj', {
        filename: 'fake.png',
        base64Data: spoofedSvgBase64,
        mimeType: 'image/png'
      }),
    /does not match declared MIME type/
  );
});

test('4. Hardened HTTP fallback server enforces 127.0.0.1, security headers, CSRF, method allow-list, and persistence', async (t) => {
  const tmpRoot = await makeTempDir('blog-studio-http-');
  const handlers = createHandlers({ blogRoot: tmpRoot });
  const srv = await startHttpFallbackServer({
    getHtml: () => fs.readFile(DIST_HTML_PATH, 'utf8'),
    handlers,
    port: 0
  });

  t.after(async () => {
    await srv.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  assert.ok(srv.url.startsWith('http://127.0.0.1:'));

  const pageRes = await fetch(`${srv.url}/`);
  assert.equal(pageRes.status, 200);
  assert.equal(pageRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pageRes.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(pageRes.headers.get('content-security-policy')?.includes("object-src 'none'"));

  const pageHtml = await pageRes.text();
  const csrfMatch = pageHtml.match(/<meta name="x-studio-csrf" content="([a-f0-9]+)">/);
  assert.ok(csrfMatch, 'Expected injected CSRF meta tag');
  const csrf = csrfMatch[1];

  const noCsrfRes = await fetch(`${srv.url}/api/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(noCsrfRes.status, 403);

  const delRes = await fetch(`${srv.url}/api/save`, { method: 'DELETE' });
  assert.equal(delRes.status, 405);

  const initRes = await fetch(`${srv.url}/api/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf },
    body: JSON.stringify({ preferredProject: 'alpha-project' })
  });
  assert.equal(initRes.status, 200);
  const initJson = await initRes.json();
  assert.equal(initJson.activeProject, 'alpha-project');

  const createRes = await fetch(`${srv.url}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf },
    body: JSON.stringify({ project: 'alpha-project', title: 'HTTP Test Post', status: 'draft' })
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.slug, 'http-test-post');

  const updatedContent = '---\ndate: 2026-11-18\ntitle: HTTP Test Post\nstatus: review\n---\n\nUpdated body prose.';
  const saveRes = await fetch(`${srv.url}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf },
    body: JSON.stringify({ project: 'alpha-project', slug: 'http-test-post', content: updatedContent })
  });
  assert.equal(saveRes.status, 200);

  const readRes = await fetch(`${srv.url}/api/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf },
    body: JSON.stringify({ project: 'alpha-project', slug: 'http-test-post' })
  });
  assert.equal(readRes.status, 200);
  const readJson = await readRes.json();
  assert.equal(readJson.content, updatedContent);

  const onDisk = await fs.readFile(path.join(tmpRoot, 'alpha-project', 'http-test-post.md'), 'utf8');
  assert.equal(onDisk, updatedContent);

  const themeRes = await fetch(`${srv.url}/api/site-theme`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf },
    body: '{}'
  });
  assert.equal(themeRes.status, 200);
  const themeJson = await themeRes.json();
  assert.equal(themeJson.available, false);
});

test('5. MCP App server exposes ui:// resource, open_blog_editor metadata, and round-trips posts to disk', async (t) => {
  const tmpRoot = await makeTempDir('blog-studio-mcp-');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(REPO_ROOT, 'mcp', 'server.mjs')],
    env: {
      ...process.env,
      BLOG_ROOT: tmpRoot
    }
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, {});

  t.after(async () => {
    await client.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await client.connect(transport);

  const resources = await client.listResources();
  const uiResEntry = resources.resources.find((r) => r.uri === 'ui://blog-studio/editor.html');
  assert.ok(uiResEntry, 'Expected ui://blog-studio/editor.html in resources/list');
  assert.equal(uiResEntry.mimeType, RESOURCE_MIME_TYPE);

  const uiResource = await client.readResource({ uri: 'ui://blog-studio/editor.html' });
  assert.equal(uiResource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(uiResource.contents[0].text.includes('<div id="app"></div>'));

  const tools = await client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === 'open_blog_editor');
  assert.ok(openTool, 'Expected open_blog_editor tool');
  assert.equal(openTool._meta?.ui?.resourceUri, 'ui://blog-studio/editor.html');

  const opened = await client.callTool({
    name: 'open_blog_editor',
    arguments: { project: 'mcp-proj' }
  });
  assert.equal(opened.isError, undefined);
  assert.equal(opened.structuredContent.activeProject, 'mcp-proj');

  await client.callTool({
    name: 'blog_create_post',
    arguments: { project: 'mcp-proj', title: 'Claude MCP Note', slug: 'claude-mcp-note', status: 'idea' }
  });

  const savedMd = '---\ndate: 2026-11-18\ntitle: Claude MCP Note\nstatus: published\n---\n\n# Claude MCP Note\n\nSaved over stdio MCP.';
  await client.callTool({
    name: 'blog_save_post',
    arguments: { project: 'mcp-proj', slug: 'claude-mcp-note', content: savedMd }
  });

  const readBack = await client.callTool({
    name: 'blog_read_post',
    arguments: { project: 'mcp-proj', slug: 'claude-mcp-note' }
  });
  assert.equal(readBack.structuredContent.content, savedMd);

  const diskContent = await fs.readFile(path.join(tmpRoot, 'mcp-proj', 'claude-mcp-note.md'), 'utf8');
  assert.equal(diskContent, savedMd);
});

test('6. Static frontend security audit: zero unsafe DOM sinks or native blocking dialogs', async () => {
  const uiDir = path.join(REPO_ROOT, 'ui');
  const entries = await fs.readdir(uiDir);
  const targetFiles = entries.filter((f) => f.endsWith('.ts') || f.endsWith('.html'));
  assert.ok(targetFiles.length >= 3, 'Expected UI source files');

  const forbiddenPatterns = [
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bdocument\.write\b/,
    /\bwindow\.prompt\b/,
    /(^|[^\w.])prompt\s*\(/,
    /(^|[^\w.])alert\s*\(/,
    /(^|[^\w.])confirm\s*\(/
  ];

  for (const file of targetFiles) {
    const content = await fs.readFile(path.join(uiDir, file), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `Forbidden pattern ${pattern} found in ui/${file}`
      );
    }
  }
});

test('7. Standalone root essays (_root), All Articles (_all), legacy state/unlisted frontmatter, and /blog assets', async (t) => {
  const tmpSite = await makeTempDir('blog-studio-root-');
  const tmpBlog = path.join(tmpSite, 'blog');
  await fs.mkdir(tmpBlog, { recursive: true });
  t.after(async () => fs.rm(tmpSite, { recursive: true, force: true }));

  const legacyMd = [
    '---',
    'date: 2026-11-04',
    'title: Legacy Standalone Essay',
    'state: unlisted',
    'tags: "AI", "thoughts"',
    'youtubeId: Ixy2ql7g3-I',
    '---',
    '',
    '# Legacy Standalone Essay',
    '',
    '![Meme](/blog/meme.png)'
  ].join('\n');

  await fs.writeFile(path.join(tmpBlog, 'legacy-essay.md'), legacyMd, 'utf8');
  await fs.writeFile(path.join(tmpBlog, 'meme.png'), Buffer.from(VALID_PNG_BASE64, 'base64'));
  await createPost(tmpBlog, 'sub-proj', { title: 'Sub Project Post', slug: 'sub-post', status: 'unlisted' });

  const parsedLegacy = parseDocument(legacyMd);
  assert.equal(parsedLegacy.meta.status, 'unlisted');
  assert.equal(parsedLegacy.statusKey, 'state');
  assert.equal(serializeDocument(parsedLegacy), legacyMd);
  const extras = extractFrontmatterExtras(parsedLegacy);
  assert.deepEqual(extras.tags, ['AI', 'thoughts']);
  assert.equal(extras.youtubeId, 'Ixy2ql7g3-I');

  const initHub = await initStore({ blogRoot: tmpBlog, workspaceUri: `file://${tmpSite}` });
  assert.equal(initHub.activeProject, ALL_PROJECTS);
  assert.ok(initHub.projects.includes(ALL_PROJECTS));
  assert.ok(initHub.projects.includes(ROOT_PROJECT));
  assert.ok(initHub.projects.includes('sub-proj'));
  assert.equal(initHub.posts.length, 2);
  assert.ok(initHub.posts.some((p) => p.project === ROOT_PROJECT && p.slug === 'legacy-essay'));
  assert.ok(initHub.posts.some((p) => p.project === 'sub-proj' && p.slug === 'sub-post'));

  const rootOnly = await listPosts(tmpBlog, ROOT_PROJECT);
  assert.equal(rootOnly.length, 1);
  assert.equal(rootOnly[0].slug, 'legacy-essay');

  const rootRead = await readPost(tmpBlog, ROOT_PROJECT, 'legacy-essay');
  assert.equal(rootRead.content, legacyMd);

  const rootImg = await readAsset(tmpBlog, ROOT_PROJECT, '/blog/meme.png');
  assert.equal(rootImg.mimeType, 'image/png');

  await assert.rejects(() => readAsset(tmpBlog, ROOT_PROJECT, '/blog/../secret.png'), /Invalid/);

  // Focus target handoff for opening a specific post in an already-open sidecar
  const target = await setActiveTarget(tmpBlog, ROOT_PROJECT, 'legacy-essay');
  assert.equal(target.project, ROOT_PROJECT);
  assert.equal(target.slug, 'legacy-essay');
  const readTarget = await getActiveTarget(tmpBlog);
  assert.equal(readTarget.slug, 'legacy-essay');
  const initFromFocus = await initStore({ blogRoot: tmpBlog, workspaceUri: `file://${tmpSite}` });
  assert.equal(initFromFocus.currentPost.slug, 'legacy-essay');
});

test('8. Site theme loader reads and scopes public/resources/base.css + highlight.css safely', async (t) => {
  const tmpSite = await makeTempDir('blog-studio-theme-');
  const tmpBlog = path.join(tmpSite, 'blog');
  const tmpRes = path.join(tmpSite, 'public', 'resources');
  await fs.mkdir(tmpBlog, { recursive: true });
  await fs.mkdir(tmpRes, { recursive: true });
  t.after(async () => fs.rm(tmpSite, { recursive: true, force: true }));

  await fs.writeFile(
    path.join(tmpRes, 'base.css'),
    [
      '@import url("https://evil.example/a.css");',
      '@font-face { font-family: "text"; src: url(./FakeFont.ttf); }',
      'html, body { font-family: "text"; line-height: 1.2; }',
      '.right-col { background: #94aadf; }',
      '@media only screen and (max-width: 992px) { .right-col { font-size: 1.75em; } }'
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(path.join(tmpRes, 'highlight.css'), '.hljs-keyword { color: #dcc6e0; }', 'utf8');
  await fs.writeFile(path.join(tmpRes, 'FakeFont.ttf'), Buffer.from('FAKEFONTBYTES', 'utf8'));

  const theme = await loadSiteTheme(tmpBlog);
  assert.equal(theme.available, true);
  assert.equal(theme.palette.contentBg, '#94aadf');
  assert.ok(theme.css.includes('--site-content-bg: #94aadf;'));
  assert.ok(theme.css.includes('@scope (.blog-site-theme-root) to (.blog-studio-ui-exempt)'));
  assert.ok(theme.css.includes('#94aadf'));
  assert.ok(theme.css.includes('.hljs-keyword'));
  assert.equal(theme.css.includes('@import'), false);
  assert.equal(theme.css.includes('font-size: 1.75em'), false);
});

test('9. Conflict-free 3-way auto-save merge and en-AU Hunspell spellcheck', async (t) => {
  const base = [
    '---',
    'title: Test Post',
    'status: draft',
    '---',
    '',
    'A few weeks ago I recreated Paris in 3D.',
    '',
    'And here is the next paragraph.'
  ].join('\n');

  // Agent adds a link on line 6 while user adds a bullet list at the bottom.
  const remote = base.replace(
    'recreated Paris in 3D',
    '[recreated Paris in 3D](/blog/eiffel-tower/paris-in-3d.html)'
  );
  const local = `${base}\n\n- Added bullet one\n- Added bullet two`;

  const merged = threeWayMerge(base, local, remote);
  assert.equal(merged.merged, true);
  assert.ok(merged.content.includes('[recreated Paris in 3D](/blog/eiffel-tower/paris-in-3d.html)'));
  assert.ok(merged.content.includes('- Added bullet one'));
  assert.equal(merged.content.includes('<<<<<<<'), false);

  // Same-line collision resolves cleanly to user's local edit with zero conflict markers.
  const collision = threeWayMerge(
    base,
    base.replace('next paragraph.', 'user rewritten paragraph.'),
    base.replace('next paragraph.', 'agent rewritten paragraph.')
  );
  assert.ok(collision.content.includes('user rewritten paragraph.'));
  assert.equal(collision.content.includes('<<<<<<<'), false);

  // End-to-end savePost with stale expectedMtimeMs merges cleanly on disk.
  const tmpRoot = await makeTempDir('blog-studio-merge-');
  t.after(async () => fs.rm(tmpRoot, { recursive: true, force: true }));
  const firstSave = await savePost(tmpRoot, ROOT_PROJECT, 'concurrent', base);
  await new Promise((r) => setTimeout(r, 25));
  await savePost(tmpRoot, ROOT_PROJECT, 'concurrent', remote);
  const mergedSave = await savePost(tmpRoot, ROOT_PROJECT, 'concurrent', local, {
    baseContent: base,
    expectedMtimeMs: firstSave.mtimeMs
  });
  assert.equal(mergedSave.merged, true);
  assert.ok(mergedSave.content.includes('[recreated Paris in 3D](/blog/eiffel-tower/paris-in-3d.html)'));
  assert.ok(mergedSave.content.includes('- Added bullet two'));

  // Real en-AU dictionary check.
  const spell = await checkWords('en-AU', ['colour', 'practising', 'practicing', 'speling', 'Antigravity']);
  assert.equal(spell.misspelled.colour, undefined);
  assert.equal(spell.misspelled.practising, undefined);
  assert.equal(spell.misspelled.Antigravity, undefined);
  assert.ok(Array.isArray(spell.misspelled.practicing));
  assert.ok(spell.misspelled.practicing.includes('practising'));
  assert.ok(spell.misspelled.speling.includes('spelling'));
});
