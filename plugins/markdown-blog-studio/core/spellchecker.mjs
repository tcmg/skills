import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nspell from 'nspell';

const USER_DICT_DIR = path.join(os.homedir(), '.markdown-blog-studio');
const USER_DICT_PATH = path.join(USER_DICT_DIR, 'dictionary.txt');
const VALID_LANGS = new Set(['en-AU', 'en-GB', 'en-US']);
const MAX_WORDS_PER_BATCH = 800;

const BUILTIN_TECH_WORDS = [
  'Antigravity',
  'Gemini',
  'TypeScript',
  'JavaScript',
  'Markdown',
  'Tiptap',
  'ProseMirror',
  'Vite',
  'Vercel',
  'Firebase',
  'Firestore',
  'GitHub',
  'GitLab',
  'DevRel',
  'localhost',
  'blog',
  'blogging',
  'webview',
  'webviews',
  'sidecar',
  'sidecars',
  'frontmatter',
  'subagent',
  'subagents',
  'codebase',
  'codebases',
  'repo',
  'repos',
  'README',
  'npm',
  'npx',
  'Node.js',
  'Three.js',
  'WebGL',
  'macOS',
  'iOS',
  'iPhone',
  'iPad',
  'Playwright',
  'Chrome',
  'Electron',
  'Astro',
  'Hugo',
  'Jekyll',
  'Eleventy',
  'Supabase',
  'Cloudflare',
  'Anthropic',
  'OpenAI',
  'Claude',
  'ChatGPT',
  'YouTube',
  'Substack',
  'LinkedIn',
  'Kubernetes',
  'Docker',
  'Terraform',
  'PostgreSQL',
  'SQLite',
  'GraphQL',
  'OAuth',
  'Hunspell',
  'monospace',
  'auto-save',
  'autosave',
  'dropdown',
  'dropdowns',
  'popover',
  'popovers',
  'toolbar',
  'toolbars',
  'topbar',
  'sidebar',
  'sidebars',
  'workflow',
  'workflows',
  'vibe',
  'noodling',
  'unlisted',
  'quickstart',
  'changelog',
  'backtick',
  'backticks',
  'keystroke',
  'keystrokes',
  'leaderboard',
  'multiplayer',
  'playtest',
  'playtesting',
  'indie',
  'over-engineered'
];

const spellCache = new Map();
let userWordsLoaded = false;
let userWords = new Set();

async function loadUserWords() {
  if (userWordsLoaded) return userWords;
  userWordsLoaded = true;
  try {
    const raw = await fs.readFile(USER_DICT_PATH, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const clean = line.trim();
      if (clean && /^[A-Za-z][A-Za-z'-]{0,63}$/.test(clean)) {
        userWords.add(clean);
      }
    }
  } catch {
    // No custom user dictionary yet.
  }
  return userWords;
}

async function loadDictionaryModule(lang) {
  if (lang === 'en-AU') {
    const mod = await import('dictionary-en-au');
    return mod.default || mod;
  }
  if (lang === 'en-GB') {
    const mod = await import('dictionary-en-gb');
    return mod.default || mod;
  }
  const mod = await import('dictionary-en-us');
  return mod.default || mod;
}

async function getSpellInstance(lang) {
  const safeLang = VALID_LANGS.has(lang) ? lang : 'en-AU';
  if (spellCache.has(safeLang)) {
    return spellCache.get(safeLang);
  }

  const dict = await loadDictionaryModule(safeLang);
  const spell = nspell(dict);
  for (const w of BUILTIN_TECH_WORDS) {
    spell.add(w);
    spell.add(w.toLowerCase());
  }
  const custom = await loadUserWords();
  for (const w of custom) {
    spell.add(w);
  }
  spellCache.set(safeLang, spell);
  return spell;
}

function shouldSkipWord(word) {
  if (typeof word !== 'string') return true;
  const clean = word.trim();
  if (clean.length < 2 || clean.length > 64) return true;
  if (!/^[A-Za-z][A-Za-z'’-]*[A-Za-z]$/.test(clean)) return true;
  // Skip ALL-CAPS acronyms (API, HTML, MCP, URL, etc.)
  if (clean.length <= 6 && clean === clean.toUpperCase()) return true;
  // Skip camelCase / PascalCase code identifiers (e.g. ProseMirror, myVar)
  if (/[a-z][A-Z]/.test(clean)) return true;
  return false;
}

/**
 * Check a batch of unique words against the requested Hunspell dictionary.
 * Returns a map of misspelled word -> top suggestions (up to 5).
 */
export async function checkWords(lang, words) {
  if (!VALID_LANGS.has(lang) || !Array.isArray(words) || words.length === 0) {
    return { lang: String(lang || 'off'), misspelled: {} };
  }

  const spell = await getSpellInstance(lang);
  const seen = new Set();
  const misspelled = {};

  for (const raw of words.slice(0, MAX_WORDS_PER_BATCH)) {
    if (typeof raw !== 'string') continue;
    const word = raw.trim();
    if (!word || seen.has(word) || shouldSkipWord(word)) continue;
    seen.add(word);

    // Normalize curly apostrophe to ASCII apostrophe for Hunspell lookup.
    const lookup = word.replace(/’/g, "'");
    if (spell.correct(lookup)) continue;
    // Also accept lowercase match for capitalized words at sentence starts (e.g. "Optimise").
    const lower = lookup.toLowerCase();
    if (lookup[0] !== lower[0] && spell.correct(lower)) continue;
    // Also accept possessive "'s" if base word is valid.
    if (lower.endsWith("'s") && lower.length > 3 && spell.correct(lookup.slice(0, -2))) continue;

    const suggestions = spell.suggest(lookup).slice(0, 5);
    misspelled[word] = suggestions;
  }

  return { lang, misspelled };
}

/**
 * Add a custom word to ~/.markdown-blog-studio/dictionary.txt and all loaded dictionaries.
 */
export async function addWordToUserDictionary(word) {
  if (typeof word !== 'string') {
    throw new Error('Word must be a string.');
  }
  const clean = word.trim().replace(/’/g, "'");
  if (!/^[A-Za-z][A-Za-z'-]{0,63}$/.test(clean)) {
    throw new Error('Invalid dictionary word.');
  }

  await loadUserWords();
  if (!userWords.has(clean)) {
    userWords.add(clean);
    await fs.mkdir(USER_DICT_DIR, { recursive: true });
    await fs.appendFile(USER_DICT_PATH, `${clean}\n`, 'utf8');
  }
  for (const spell of spellCache.values()) {
    spell.add(clean);
  }
  return { added: true, word: clean };
}
