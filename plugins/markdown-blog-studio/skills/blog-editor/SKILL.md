---
name: blog-editor
description: Open and collaborate inside Markdown Blog Studio (Aux Pane UI extension in Antigravity or interactive MCP App in Claude) for drafting and editing Markdown posts in any static-site blog repository.
---

# Markdown Blog Studio

Use this skill when the user wants to draft, edit, or preview Markdown blog articles alongside the conversation.

## First-Time Site Auto-Configuration (`.blog-studio.json`)

When invoked in a blog repository that does **not** yet have a `.blog-studio.json` file at its root:
1. Briefly inspect the workspace to identify:
   - The Markdown content directory (`blog`, `content/posts`, `src/content/blog`, `_posts`, `posts`, etc.).
   - The built/static assets directory (`public`, `static`, `dist`, `_site`, etc.).
   - The site's stylesheets (`cssFiles`) and any Google Fonts (`googleFonts` / `fontMap`).
   - The article wrapper classes (`articleClasses`, `innerClasses`) from the site's post template or a sample built HTML article.
   - Optional sidebar/navigation chrome (`chrome.sourceHtml` + `chrome.columns`) and any minimal `overrideCss` needed to keep layout clean inside the editor.
2. Write `.blog-studio.json` to the workspace root so **Visual Edit** and **Read Preview** replicate the user's real blog theme live.

## Opening the Editor

- **In Antigravity**: Surface the clickable sidecar pill so the user can open the Aux Pane directly:
  - General editor: `[Blog Editor](sidecar://markdown-blog-studio/editor/)`
  - Deep-link to a specific post: `[Open <slug>.md in Blog Editor](sidecar://markdown-blog-studio/editor/?project=<project>&slug=<slug>)` (use `project=_root` for root-level Markdown posts)
  - To switch an *already-open* Blog Editor pane directly to a post, call the `blog_focus_post` MCP tool with `project` (`_root` or folder name) and `slug`.
- **In Claude Desktop / MCP App hosts**: Call the `open_blog_editor` tool (passing `project`, `slug`, or `workspacePath` if known) to launch the interactive 3-view Markdown Blog Studio inline or fullscreen.

## Collaborating on Drafts

- Supports both root-level Markdown posts (`_root`) and nested project/category folders, plus a unified **All Articles** (`_all`) view.
- When you edit a `.md` file on disk, the editor automatically detects the change and refreshes the active draft if there are no unsaved edits.
- When the user clicks **Ask Agent** in the editor, they may include an excerpt from their draft—respond with concise prose improvements or file-backed updates.
