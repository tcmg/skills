import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'markdown-blog-studio';
const PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);

async function main() {
  const distPath = path.join(REPO_ROOT, 'dist', 'editor.html');
  try {
    await fs.access(distPath);
  } catch {
    throw new Error('dist/editor.html not found. Run `npm run build` before installing the plugin.');
  }

  await fs.mkdir(path.join(PLUGIN_DIR, 'assets'), { recursive: true });
  await fs.mkdir(path.join(PLUGIN_DIR, 'skills', 'blog-editor'), { recursive: true });
  await fs.mkdir(path.join(PLUGIN_DIR, 'sidecars', 'editor'), { recursive: true });

  await fs.copyFile(path.join(REPO_ROOT, 'plugin.json'), path.join(PLUGIN_DIR, 'plugin.json'));
  await fs.copyFile(path.join(REPO_ROOT, 'assets', 'logo.svg'), path.join(PLUGIN_DIR, 'assets', 'logo.svg'));
  await fs.copyFile(
    path.join(REPO_ROOT, 'skills', 'blog-editor', 'SKILL.md'),
    path.join(PLUGIN_DIR, 'skills', 'blog-editor', 'SKILL.md')
  );

  const mcpConfig = {
    mcpServers: {
      'markdown-blog-studio-mcp': {
        command: 'node',
        args: [path.join(REPO_ROOT, 'mcp', 'server.mjs')]
      }
    }
  };
  await fs.writeFile(path.join(PLUGIN_DIR, 'mcp_config.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');

  const sidecarConfig = {
    command: 'node',
    args: [path.join(REPO_ROOT, 'sidecar', 'main.mjs')],
    restart_policy: 'always',
    display_name: 'Markdown Blog Studio',
    description:
      'Minimalist Medium-style, Markdown-source, and Read-Preview blog editor scoped to your active project.',
    has_web_ui: true,
    ui_config: {
      views: [
        {
          path: '/',
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
          title: 'Blog Editor'
        }
      ]
    }
  };
  await fs.writeFile(
    path.join(PLUGIN_DIR, 'sidecars', 'editor', 'sidecar.json'),
    `${JSON.stringify(sidecarConfig, null, 2)}\n`,
    'utf8'
  );

  console.log(`Installed Antigravity plugin to: ${PLUGIN_DIR}`);
  console.log('\nRestart Antigravity so the new plugin directory is discovered.');
  console.log('\nFor Claude Desktop, add this to ~/Library/Application Support/Claude/claude_desktop_config.json:\n');
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          'markdown-blog-studio': {
            command: 'node',
            args: [path.join(REPO_ROOT, 'mcp', 'server.mjs')]
          }
        }
      },
      null,
      2
    )
  );
  console.log('\nFor Claude Code CLI:\n');
  console.log(`claude mcp add markdown-blog-studio -- node ${path.join(REPO_ROOT, 'mcp', 'server.mjs')}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
