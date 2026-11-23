import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  createPost,
  initStore,
  readPost,
  resolveBlogRoot,
  saveAsset,
  savePost,
  setActiveTarget
} from '../core/blog-store.mjs';
import { loadSiteTheme } from '../core/site-theme.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_HTML_PATH = path.join(REPO_ROOT, 'dist', 'editor.html');
export const BLOG_EDITOR_RESOURCE_URI = 'ui://blog-studio/editor.html';

function toWorkspaceUri(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return undefined;
  if (workspacePath.startsWith('file://')) return workspacePath;
  return pathToFileURL(path.resolve(workspacePath)).href;
}

function jsonToolSuccess(summaryText, structuredContent) {
  return {
    content: [{ type: 'text', text: summaryText }],
    structuredContent
  };
}

function jsonToolError(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: err instanceof Error ? err.message : 'Operation failed.' }]
  };
}

export function createBlogStudioMcpServer(options = {}) {
  const server = new McpServer({
    name: 'markdown-blog-studio',
    version: '0.1.0'
  });

  let cachedBlogRoot = options.blogRoot || null;

  async function ensureBlogRoot(workspacePath) {
    if (options.blogRoot) {
      return resolveBlogRoot({ blogRoot: options.blogRoot });
    }
    const workspaceUri = toWorkspaceUri(workspacePath);
    if (!cachedBlogRoot || workspaceUri) {
      cachedBlogRoot = await resolveBlogRoot({ workspaceUri });
    }
    return cachedBlogRoot;
  }

  registerAppResource(
    server,
    'Markdown Blog Studio UI',
    BLOG_EDITOR_RESOURCE_URI,
    {
      description:
        'Minimalist 3-view Markdown blog editor (Medium-style Visual Edit, Raw Markdown monospace, Read Preview) with Light/Dark mode.'
    },
    async () => {
      const html = await fs.readFile(DIST_HTML_PATH, 'utf8');
      return {
        contents: [
          {
            uri: BLOG_EDITOR_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']
                }
              }
            }
          }
        ]
      };
    }
  );

  registerAppTool(
    server,
    'open_blog_editor',
    {
      title: 'Open Blog Editor',
      description:
        'Opens the interactive 3-view Markdown Blog Studio UI (Medium-style editable preview, raw Markdown, read-only preview) for a project.',
      inputSchema: {
        project: z.string().optional().describe('Target project folder name inside the blog directory.'),
        slug: z.string().optional().describe('Optional post slug (without .md) to open immediately.'),
        workspacePath: z.string().optional().describe('Optional local workspace directory path to infer project name.')
      },
      _meta: {
        ui: {
          resourceUri: BLOG_EDITOR_RESOURCE_URI
        }
      }
    },
    async ({ project, slug, workspacePath }) => {
      try {
        const workspaceUri = toWorkspaceUri(workspacePath);
        const blogRoot = await ensureBlogRoot(workspacePath);
        const payload = await initStore({
          blogRoot,
          workspaceUri,
          preferredProject: project,
          preferredSlug: slug
        });
        if (slug && payload.currentPost) {
          await setActiveTarget(blogRoot, payload.currentPost.project, payload.currentPost.slug).catch(() => {});
        }
        const summary = [
          `Opened Markdown Blog Studio for project "${payload.activeProject}".`,
          `Active file: ${payload.currentPost.fullPath}`,
          `Available drafts (${payload.posts.length}): ${payload.posts.map((p) => p.filename).join(', ')}`
        ].join('\n');
        return jsonToolSuccess(summary, payload);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_init',
    {
      title: 'List Blog Projects & Drafts',
      description: 'Lists available blog projects and drafts, returning the active post content.',
      inputSchema: {
        project: z.string().optional().describe('Optional project name to select.'),
        slug: z.string().optional().describe('Optional post slug to load.'),
        workspacePath: z.string().optional().describe('Optional workspace directory path.')
      }
    },
    async ({ project, slug, workspacePath }) => {
      try {
        const workspaceUri = toWorkspaceUri(workspacePath);
        const blogRoot = await ensureBlogRoot(workspacePath);
        const payload = await initStore({
          blogRoot,
          workspaceUri,
          preferredProject: project,
          preferredSlug: slug
        });
        if (slug && payload.currentPost) {
          await setActiveTarget(blogRoot, payload.currentPost.project, payload.currentPost.slug).catch(() => {});
        }
        return jsonToolSuccess(JSON.stringify(payload), payload);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_read_post',
    {
      title: 'Read Blog Post',
      description: 'Reads a Markdown blog post and its YAML frontmatter from disk.',
      inputSchema: {
        project: z.string().min(1).describe('Project directory name.'),
        slug: z.string().min(1).describe('Post slug (with or without .md).')
      }
    },
    async ({ project, slug }) => {
      try {
        const blogRoot = await ensureBlogRoot();
        const post = await readPost(blogRoot, project, slug);
        return jsonToolSuccess(post.content, post);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_save_post',
    {
      title: 'Save Blog Post',
      description: 'Saves updated Markdown content (including YAML frontmatter) to disk.',
      inputSchema: {
        project: z.string().min(1).describe('Project directory name.'),
        slug: z.string().min(1).describe('Post slug (with or without .md).'),
        content: z.string().describe('Full Markdown document content including frontmatter.')
      }
    },
    async ({ project, slug, content }) => {
      try {
        const blogRoot = await ensureBlogRoot();
        const saved = await savePost(blogRoot, project, slug, content);
        return jsonToolSuccess(`Saved ${saved.fullPath}`, saved);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_create_post',
    {
      title: 'Create Blog Post',
      description: 'Creates a new Markdown blog post scaffolded with YAML frontmatter.',
      inputSchema: {
        project: z.string().min(1).describe('Project directory name.'),
        title: z.string().min(1).describe('Article title.'),
        slug: z.string().optional().describe('Optional kebab-case slug.'),
        status: z.enum(['idea', 'draft', 'unlisted', 'review', 'published']).optional().describe('Initial article status.')
      }
    },
    async ({ project, title, slug, status }) => {
      try {
        const blogRoot = await ensureBlogRoot();
        const created = await createPost(blogRoot, project, { title, slug, status });
        return jsonToolSuccess(`Created ${created.fullPath}`, created);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_upload_asset',
    {
      title: 'Upload Blog Image Asset',
      description: 'Validates and saves a PNG/JPEG/WebP/GIF image into the project assets/ directory.',
      inputSchema: {
        project: z.string().min(1).describe('Project directory name.'),
        filename: z.string().min(1).describe('Original filename.'),
        base64Data: z.string().min(1).describe('Base64-encoded image bytes.'),
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).describe('Image MIME type.')
      }
    },
    async ({ project, filename, base64Data, mimeType }) => {
      try {
        const blogRoot = await ensureBlogRoot();
        const result = await saveAsset(blogRoot, project, { filename, base64Data, mimeType });
        const payload = {
          ...result,
          dataUrl: `data:${result.mimeType};base64,${base64Data.replace(/^data:[^;]+;base64,/, '').trim()}`
        };
        return jsonToolSuccess(`Saved image to ${result.relativeMarkdownPath}`, payload);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_get_site_theme',
    {
      title: 'Load Personal Blog Site Theme',
      description: 'Reads and scopes the live blog CSS and local fonts from public/resources/ next to the blog root.',
      inputSchema: {
        workspacePath: z.string().optional().describe('Optional local workspace directory path.')
      }
    },
    async ({ workspacePath }) => {
      try {
        const blogRoot = await ensureBlogRoot(workspacePath);
        const theme = await loadSiteTheme(blogRoot);
        return jsonToolSuccess(
          theme.available ? `Loaded site theme for ${theme.siteName}` : 'No site theme detected.',
          theme
        );
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  server.registerTool(
    'blog_focus_post',
    {
      title: 'Focus Post in Open Blog Editor',
      description:
        'Signals an open Markdown Blog Studio sidecar pane to switch directly to the specified project and slug (use "_root" for standalone blog/*.md essays).',
      inputSchema: {
        project: z.string().min(1).describe('Project directory name, or "_root" for standalone blog/*.md posts.'),
        slug: z.string().min(1).describe('Post slug (with or without .md).')
      }
    },
    async ({ project, slug }) => {
      try {
        const blogRoot = await ensureBlogRoot();
        const target = await setActiveTarget(blogRoot, project, slug);
        return jsonToolSuccess(`Focused ${target.slug}.md (${target.project}) in Blog Studio.`, target);
      } catch (err) {
        return jsonToolError(err);
      }
    }
  );

  return server;
}

async function main() {
  const server = createBlogStudioMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Markdown Blog Studio MCP server running on stdio');
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error('MCP server fatal error:', err?.message || err);
    process.exit(1);
  });
}
