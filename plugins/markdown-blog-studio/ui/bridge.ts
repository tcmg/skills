import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

export interface PostSummary {
  project: string;
  slug: string;
  filename: string;
  title: string;
  status: string;
  date: string;
  mtimeMs: number;
  fullPath: string;
}

export interface SiteThemeMeta {
  available: boolean;
  siteName: string;
}

export interface SiteChromeColumn {
  className: string;
  wrapperClasses: string[];
  ariaLabel: string;
  html: string;
}

export interface SiteThemePayload extends SiteThemeMeta {
  css: string;
  sourcePath?: string;
  articleClasses?: string[];
  innerClasses?: string[];
  googleFonts?: string[];
  chrome?: {
    columns: SiteChromeColumn[];
  };
}

export interface PostPayload {
  project: string;
  slug: string;
  filename: string;
  content: string;
  mtimeMs: number;
  fullPath: string;
}

export interface StoreInitPayload {
  blogRoot: string;
  activeProject: string;
  projects: string[];
  posts: PostSummary[];
  currentPost: PostPayload;
  siteTheme?: SiteThemeMeta;
}

export interface UploadAssetResult {
  project: string;
  filename: string;
  mimeType: string;
  relativeMarkdownPath: string;
  bytes: number;
  dataUrl?: string;
}

export interface FocusTargetPayload {
  project: string;
  slug: string;
  requestedAt: number;
}

export interface HostBridge {
  mode: 'sidecar' | 'http' | 'mcp';
  init(params?: { preferredProject?: string; preferredSlug?: string; preferredPostProject?: string }): Promise<StoreInitPayload>;
  getSiteTheme(): Promise<SiteThemePayload>;
  readPost(project: string, slug: string): Promise<PostPayload>;
  savePost(project: string, slug: string, content: string): Promise<{ saved: boolean; mtimeMs: number; fullPath: string }>;
  createPost(project: string, args: { title: string; slug?: string; status?: string }): Promise<PostPayload>;
  getMtime(project: string, slug: string): Promise<{ mtimeMs: number; focusTarget?: FocusTargetPayload | null } | null>;
  uploadAsset(project: string, file: { filename: string; base64Data: string; mimeType: string }): Promise<UploadAssetResult>;
  resolveAssetUrl(project: string, rawSrc: string): string;
  loadAssetDataUrl?(project: string, rawSrc: string): Promise<string | null>;
  sendToAgent(text: string): Promise<{ delivered: boolean; mode: string }>;
  popout?(project: string, slug: string, sidebars?: boolean): Promise<{ opened: boolean; url: string }>;
  syncModelContext?(summary: { project: string; slug: string; title: string; status: string; words: number }): Promise<void>;
  canToggleFullscreen?(): boolean;
  toggleFullscreen?(): Promise<'inline' | 'fullscreen' | 'pip' | null>;
  onExternalData?(cb: (payload: StoreInitPayload) => void): void;
  onHostThemeChange?(cb: (theme: 'light' | 'dark') => void): void;
}

declare global {
  interface Window {
    sidecar?: {
      fetch?: typeof window.fetch;
      getWorkspaceUris?: () => Promise<string[] | undefined>;
      agent?: {
        sendMessage?: (message: string) => Promise<void>;
      };
    };
  }
}

function getCsrfToken(): string {
  const meta = document.querySelector('meta[name="x-studio-csrf"]');
  return meta?.getAttribute('content') || '';
}

function parseToolJsonResult<T>(res: { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): T {
  if (res.isError) {
    const firstText = res.content?.find((c) => c.type === 'text')?.text || 'MCP tool call failed';
    throw new Error(firstText);
  }
  if (res.structuredContent && typeof res.structuredContent === 'object') {
    return res.structuredContent as T;
  }
  const text = res.content?.find((c) => c.type === 'text')?.text;
  if (text) {
    return JSON.parse(text) as T;
  }
  throw new Error('Unexpected empty MCP tool response.');
}

async function httpRpc<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const csrf = getCsrfToken();
  if (csrf) {
    headers['X-Studio-CSRF'] = csrf;
  }
  const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : window.fetch.bind(window);
  const res = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const data = (await res.json()) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function createHttpBridge(isSidecar: boolean, assetCache: Map<string, string>): HostBridge {
  return {
    mode: isSidecar ? 'sidecar' : 'http',

    async init(params = {}) {
      let workspaceUri: string | undefined;
      if (window.sidecar?.getWorkspaceUris) {
        try {
          const uris = await window.sidecar.getWorkspaceUris();
          if (Array.isArray(uris) && uris.length > 0) {
            workspaceUri = uris[0];
          }
        } catch {
          // Ignore unavailable sidecar workspace APIs.
        }
      }
      return httpRpc<StoreInitPayload>('/api/init', {
        workspaceUri,
        preferredProject: params.preferredProject,
        preferredSlug: params.preferredSlug,
        preferredPostProject: params.preferredPostProject
      });
    },

    async getSiteTheme() {
      try {
        return await httpRpc<SiteThemePayload>('/api/site-theme', {});
      } catch {
        return { available: false, siteName: '', css: '' };
      }
    },

    async readPost(project, slug) {
      return httpRpc<PostPayload>('/api/read', { project, slug });
    },

    async savePost(project, slug, content) {
      return httpRpc<{ saved: boolean; mtimeMs: number; fullPath: string }>('/api/save', {
        project,
        slug,
        content
      });
    },

    async createPost(project, args) {
      return httpRpc<PostPayload>('/api/create', {
        project,
        title: args.title,
        slug: args.slug,
        status: args.status
      });
    },

    async getMtime(project, slug) {
      return httpRpc<{ mtimeMs: number; focusTarget?: FocusTargetPayload | null }>('/api/mtime', { project, slug });
    },

    async uploadAsset(project, file) {
      const result = await httpRpc<UploadAssetResult>('/api/upload-asset', {
        project,
        filename: file.filename,
        base64Data: file.base64Data,
        mimeType: file.mimeType
      });
      assetCache.set(`${project}/${result.relativeMarkdownPath}`, `data:${file.mimeType};base64,${file.base64Data}`);
      return result;
    },

    resolveAssetUrl(project, rawSrc) {
      if (!rawSrc) return '';
      if (/^(https?:|data:|blob:)/i.test(rawSrc)) return rawSrc;
      const clean = rawSrc.replace(/^\.\//, '');
      const cacheKey = clean.startsWith('/') ? clean : `${project}/${clean}`;
      const cached = assetCache.get(cacheKey);
      if (cached) return cached;
      if (clean.startsWith('/')) {
        return `/api/asset?project=${encodeURIComponent(project)}&file=${encodeURIComponent(clean)}`;
      }
      if (clean.startsWith('assets/')) {
        const assetFile = clean.slice('assets/'.length);
        return `/api/asset?project=${encodeURIComponent(project)}&file=${encodeURIComponent(assetFile)}`;
      }
      return rawSrc;
    },

    async loadAssetDataUrl(project, rawSrc) {
      const clean = rawSrc.replace(/^\.\//, '');
      const isLocalAsset = clean.startsWith('assets/') || clean.startsWith('/');
      if (!isLocalAsset) return null;
      const cacheKey = clean.startsWith('/') ? clean : `${project}/${clean}`;
      const existing = assetCache.get(cacheKey);
      if (existing) return existing;
      const filename = clean.startsWith('assets/') ? clean.slice('assets/'.length) : clean;
      const res = await httpRpc<{ dataUrl: string }>('/api/read-asset', { project, filename });
      if (res?.dataUrl) {
        assetCache.set(cacheKey, res.dataUrl);
        return res.dataUrl;
      }
      return null;
    },

    async sendToAgent(text) {
      if (window.sidecar?.agent?.sendMessage) {
        await window.sidecar.agent.sendMessage(text);
        return { delivered: true, mode: 'sidecar' };
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      return { delivered: false, mode: 'clipboard' };
    },

    ...(isSidecar
      ? {
          async popout(project: string, slug: string, sidebars?: boolean) {
            return httpRpc<{ opened: boolean; url: string }>('/api/popout', { project, slug, sidebars });
          }
        }
      : {})
  };
}

function createMcpBridge(assetCache: Map<string, string>): {
  bridge: HostBridge;
  connect: () => Promise<StoreInitPayload | null>;
} {
  const app = new App({ name: 'Markdown Blog Studio', version: '0.1.0' }, {});
  let externalDataHandler: ((payload: StoreInitPayload) => void) | undefined;
  let themeHandler: ((theme: 'light' | 'dark') => void) | undefined;
  let initialResultFromTool: StoreInitPayload | null = null;

  app.ontoolresult = (params) => {
    try {
      const parsed = parseToolJsonResult<StoreInitPayload>(params);
      if (parsed && parsed.currentPost) {
        initialResultFromTool = parsed;
        externalDataHandler?.(parsed);
      }
    } catch {
      // Ignore non-store tool results.
    }
  };

  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme === 'light' || ctx.theme === 'dark') {
      themeHandler?.(ctx.theme);
    }
  };

  const bridge: HostBridge = {
    mode: 'mcp',

    async init(params = {}) {
      if (!params.preferredProject && !params.preferredSlug && initialResultFromTool) {
        const cached = initialResultFromTool;
        initialResultFromTool = null;
        return cached;
      }
      const res = await app.callServerTool({
        name: 'blog_init',
        arguments: {
          project: params.preferredProject,
          slug: params.preferredSlug
        }
      });
      return parseToolJsonResult<StoreInitPayload>(res);
    },

    async getSiteTheme() {
      try {
        const res = await app.callServerTool({
          name: 'blog_get_site_theme',
          arguments: {}
        });
        return parseToolJsonResult<SiteThemePayload>(res);
      } catch {
        return { available: false, siteName: '', css: '' };
      }
    },

    async readPost(project, slug) {
      const res = await app.callServerTool({
        name: 'blog_read_post',
        arguments: { project, slug }
      });
      return parseToolJsonResult<PostPayload>(res);
    },

    async savePost(project, slug, content) {
      const res = await app.callServerTool({
        name: 'blog_save_post',
        arguments: { project, slug, content }
      });
      return parseToolJsonResult<{ saved: boolean; mtimeMs: number; fullPath: string }>(res);
    },

    async createPost(project, args) {
      const res = await app.callServerTool({
        name: 'blog_create_post',
        arguments: {
          project,
          title: args.title,
          slug: args.slug,
          status: args.status
        }
      });
      return parseToolJsonResult<PostPayload>(res);
    },

    async getMtime() {
      return null;
    },

    async uploadAsset(project, file) {
      const res = await app.callServerTool({
        name: 'blog_upload_asset',
        arguments: {
          project,
          filename: file.filename,
          base64Data: file.base64Data,
          mimeType: file.mimeType
        }
      });
      const out = parseToolJsonResult<UploadAssetResult>(res);
      const dataUrl = out.dataUrl || `data:${file.mimeType};base64,${file.base64Data}`;
      assetCache.set(`${project}/${out.relativeMarkdownPath}`, dataUrl);
      return out;
    },

    resolveAssetUrl(project, rawSrc) {
      if (!rawSrc) return '';
      if (/^(https?:|data:|blob:)/i.test(rawSrc)) return rawSrc;
      const clean = rawSrc.replace(/^\.\//, '');
      return assetCache.get(`${project}/${clean}`) || rawSrc;
    },

    async sendToAgent(text) {
      const res = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text }]
      });
      if (res.isError) {
        throw new Error('Host declined to inject message into chat.');
      }
      return { delivered: true, mode: 'mcp' };
    },

    async syncModelContext(summary) {
      try {
        await app.updateModelContext({
          structuredContent: summary,
          content: [
            {
              type: 'text',
              text: `Active blog draft: project=${summary.project}, slug=${summary.slug}, title="${summary.title}", status=${summary.status}, words=${summary.words}`
            }
          ]
        });
      } catch {
        // Ignore if host does not support updateModelContext.
      }
    },

    canToggleFullscreen() {
      const modes = app.getHostContext()?.availableDisplayModes;
      return Array.isArray(modes) && modes.includes('fullscreen');
    },

    async toggleFullscreen() {
      const ctx = app.getHostContext();
      const target = ctx?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
      const result = await app.requestDisplayMode({ mode: target });
      return result.mode;
    },

    onExternalData(cb) {
      externalDataHandler = cb;
    },

    onHostThemeChange(cb) {
      themeHandler = cb;
    }
  };

  async function connect(): Promise<StoreInitPayload | null> {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    const ctx = app.getHostContext();
    if (ctx?.theme === 'light' || ctx?.theme === 'dark') {
      themeHandler?.(ctx.theme);
    }
    return initialResultFromTool;
  }

  return { bridge, connect };
}

function readUrlDeepLinkParams(): {
  preferredProject?: string;
  preferredSlug?: string;
  preferredPostProject?: string;
} {
  try {
    const params = new URLSearchParams(window.location.search);
    const project = params.get('project')?.trim() || undefined;
    const slug = params.get('slug')?.trim() || undefined;
    if (slug && project) {
      // Keep All Articles view when deep-linking a specific post, while focusing that exact post.
      return { preferredSlug: slug, preferredPostProject: project };
    }
    return { preferredProject: project, preferredSlug: slug };
  } catch {
    return {};
  }
}

export async function createHostBridge(): Promise<{
  bridge: HostBridge;
  initialPayload?: StoreInitPayload;
}> {
  const assetCache = new Map<string, string>();
  const isSidecar = Boolean(window.sidecar);
  const deepLinkParams = readUrlDeepLinkParams();

  if (isSidecar || (window.location.protocol.startsWith('http') && window.parent === window)) {
    const bridge = createHttpBridge(isSidecar, assetCache);
    const initialPayload = await bridge.init(deepLinkParams);
    return { bridge, initialPayload };
  }

  // Inside an iframe (either Antigravity Sidecar iframe OR Claude MCP App sandboxed iframe):
  // Probe /api/init only if served from http(s) origin; otherwise connect over MCP PostMessageTransport.
  if (window.location.protocol.startsWith('http') && !window.location.href.startsWith('about:')) {
    try {
      const bridge = createHttpBridge(isSidecar, assetCache);
      const initialPayload = await bridge.init(deepLinkParams);
      return { bridge, initialPayload };
    } catch {
      // Fall through to MCP Apps transport.
    }
  }

  const { bridge, connect } = createMcpBridge(assetCache);
  const initialFromTool = await connect();
  const initialPayload = initialFromTool || (await bridge.init(deepLinkParams));
  return { bridge, initialPayload };
}
