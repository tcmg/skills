# Markdown Blog Studio

Minimalist, site-aware Markdown blog editor built with a shared Node core + single-file UI bundle so the exact same editorial experience runs natively inside **Antigravity's Auxiliary Side Pane**, **Claude Desktop / Claude Code (MCP Apps)**, and **popped-out Google Chrome**.

Point it at any Markdown-based static site generator (Hugo, Astro, Eleventy, Jekyll, custom Node SSGs, etc.) and let your agent generate a `.blog-studio.json` site profile so **Visual Edit** and **Read Preview** replicate your real blog's CSS, typography, and optional sidebars live.

## Features

- **3 Synchronized Views with Cursor & Focus Preservation**
  - **Visual Edit (`⌘1`)**: Tiptap v3 WYSIWYG editor styled to match your live blog 1:1, with `⌘B` / `⌘I` / `⌘E` / `⌘K` shortcuts, floating selection bubble toolbar, and empty-line `+` block insertion menu.
  - **Raw Markdown (`⌘2`)**: Dark-mode monospace editor (`JetBrains Mono`) including lossless YAML frontmatter, `Tab`/`Shift+Tab` indentation, and exact word-wrapped scroll sync.
  - **Read Preview (`⌘3`)**: Sanitized (`DOMPurify` + `DOMParser`) read-only preview matching Visual Edit pixel-for-pixel.
- **Live Site Theme + Toggleable Sidebars**: Reads your real CSS files via `.blog-studio.json` (scoped safely with CSS `@scope`), with a **Sidebars** toggle to preview your full site chrome and click-to-open articles from your live nav.
- **Distraction-Free Hover HUD**: Management controls stay tucked behind a minimal top-edge pill and glide down on hover (or `⌘.`), with an optional **Pin** toggle and **Pop out ↗** to Google Chrome.
- **All Articles & Root + Nested Folders**: Automatically indexes root-level `*.md` essays (`Standalone`) alongside nested subfolders (`All Articles`), with magic-byte validated image drag-and-drop.

## Configuring for Your Blog (`.blog-studio.json`)

When you run `/blog-editor` in a Markdown blog repo, your agent can inspect your templates/CSS and generate `.blog-studio.json` automatically:

```json
{
  "siteName": "my-blog",
  "contentDir": "content/posts",
  "staticDir": "public",
  "cssFiles": ["public/css/style.css"],
  "googleFonts": ["Inter:wght@400;600;700"],
  "palette": {
    "contentBg": "#ffffff",
    "contentSelector": ".post-content",
    "navBg": "#0f172a",
    "accentBg": "#334155"
  },
  "articleClasses": ["post-content"],
  "innerClasses": ["prose"],
  "chrome": {
    "sourceHtml": "public/index.html",
    "columns": [
      { "className": "site-sidebar", "wrapperClasses": ["site-sidebar"], "ariaLabel": "Sidebar" }
    ]
  },
  "overrideCss": ""
}
```

Without `.blog-studio.json`, Markdown Blog Studio auto-detects common SSG folders (`blog/`, `content/posts/`, `content/blog/`, `src/content/blog/`, `_posts/`, `posts/`) and opens in clean Light/Dark mode. You can also override the content root with `BLOG_ROOT=/path/to/posts`.

## Development & Verification

```bash
npm install
npm run build   # Builds single-file dist/editor.html
npm test        # Runs unit, security, HTTP, and MCP App end-to-end tests
npm start       # Launches standalone local server on http://127.0.0.1:3489
```

## Install in Antigravity

```bash
npm run build
npm run install:plugin
```

Then enable **Markdown Blog Studio** in Customizations and run `/blog-editor` (or click `[Blog Editor](sidecar://markdown-blog-studio/editor/)`).

## Connect to Claude Desktop / Claude Code

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "markdown-blog-studio": {
      "command": "node",
      "args": ["/path/to/markdown-blog-studio/mcp/server.mjs"]
    }
  }
}
```

Or register in Claude Code:

```bash
claude mcp add markdown-blog-studio -- node /path/to/markdown-blog-studio/mcp/server.mjs
```
