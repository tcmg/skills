import { Editor, Extension, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computeStats, extractFrontmatterExtras, parseDocument, serializeDocument } from '../core/frontmatter.mjs';
import {
  createHostBridge,
  type HostBridge,
  type PostPayload,
  type PostSummary,
  type SiteThemePayload,
  type StoreInitPayload
} from './bridge';
import { el, svgIcon } from './dom';
import {
  closeAllCustomSelects,
  createCustomSelect,
  hasOpenCustomSelectIn,
  type DropdownTone
} from './dropdown';
import {
  DEFAULT_SPELL_LANGUAGE,
  SPELL_LANGUAGE_OPTIONS,
  extractWordBeforeCaret,
  isRawMarkdownProtectedPos,
  isWordBoundaryChar,
  lookupAutoCorrect,
  type SpellLanguage
} from './spellcheck';

function statusTone(status: string): DropdownTone {
  if (status === 'published') return 'positive';
  if (status === 'review') return 'warning';
  if (status === 'draft') return 'accent';
  if (status === 'idea') return 'info';
  return 'muted';
}

type ViewMode = 'visual' | 'raw' | 'preview';
type ThemeMode = 'blog' | 'light' | 'dark' | 'auto';
type RawWidthMode = 'standard' | 'wide' | 'full';

const ROOT_PROJECT = '_root';
const ALL_PROJECTS = '_all';
const THEME_STORAGE_KEY = 'markdown-blog-studio-theme-v2';
const SITE_CHROME_STORAGE_KEY = 'markdown-blog-studio-site-chrome';
const RAW_FONT_SIZE_STORAGE_KEY = 'markdown-blog-studio-raw-font-size';
const RAW_WIDTH_STORAGE_KEY = 'markdown-blog-studio-raw-width';
const PIN_STATS_STORAGE_KEY = 'markdown-blog-studio-pin-stats';
const SPELL_LANG_STORAGE_KEY = 'markdown-blog-studio-spell-lang';
const DEFAULT_RAW_FONT_SIZE = 14;
const MIN_RAW_FONT_SIZE = 12;
const MAX_RAW_FONT_SIZE = 26;
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function splitLeadingH1(body: string): { hasLeadingH1: boolean; headingText: string; restBody: string } {
  const normalized = String(body || '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^\s*#\s+([^\n]+)(?:\n+|$)/);
  if (!match) {
    return { hasLeadingH1: false, headingText: '', restBody: normalized };
  }
  return {
    hasLeadingH1: true,
    headingText: match[1].trim(),
    restBody: normalized.slice(match[0].length)
  };
}

function readStoredSiteChrome(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const paramVal = params.get('sidebars');
    if (paramVal === '1' || paramVal === 'true') {
      saveStoredSiteChrome(true);
      return true;
    }
    if (paramVal === '0' || paramVal === 'false') {
      saveStoredSiteChrome(false);
      return false;
    }
    return window.localStorage.getItem(SITE_CHROME_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveStoredSiteChrome(enabled: boolean): void {
  try {
    window.localStorage.setItem(SITE_CHROME_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
}

function isLocalAssetSrc(rawSrc: string): boolean {
  const clean = String(rawSrc || '').replace(/^\.\//, '');
  return clean.startsWith('assets/') || (clean.startsWith('/') && !clean.startsWith('//'));
}

function formatBlogDisplayDate(isoDate: string): string {
  if (!isoDate) return '';
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return isoDate;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()}`;
}

function readStoredTheme(): ThemeMode | null {
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (val === 'blog' || val === 'light' || val === 'dark' || val === 'auto') return val;
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
  return null;
}

function saveStoredTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
}

function readStoredRawFontSize(): number {
  try {
    const raw = window.localStorage.getItem(RAW_FONT_SIZE_STORAGE_KEY);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.min(MAX_RAW_FONT_SIZE, Math.max(MIN_RAW_FONT_SIZE, Math.round(parsed)));
      }
    }
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
  return DEFAULT_RAW_FONT_SIZE;
}

function saveStoredRawFontSize(size: number): void {
  try {
    window.localStorage.setItem(RAW_FONT_SIZE_STORAGE_KEY, String(size));
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
}

function readStoredRawWidth(): RawWidthMode {
  try {
    const val = window.localStorage.getItem(RAW_WIDTH_STORAGE_KEY);
    if (val === 'standard' || val === 'wide' || val === 'full') return val;
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
  return 'standard';
}

function saveStoredRawWidth(mode: RawWidthMode): void {
  try {
    window.localStorage.setItem(RAW_WIDTH_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
}

function readStoredPinStats(): boolean {
  try {
    return window.localStorage.getItem(PIN_STATS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveStoredPinStats(pinned: boolean): void {
  try {
    window.localStorage.setItem(PIN_STATS_STORAGE_KEY, pinned ? '1' : '0');
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
}

function readStoredSpellLanguage(): SpellLanguage {
  try {
    const val = window.localStorage.getItem(SPELL_LANG_STORAGE_KEY);
    if (val === 'en-AU' || val === 'en-GB' || val === 'en-US' || val === 'off') {
      return val;
    }
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
  return DEFAULT_SPELL_LANGUAGE;
}

function saveStoredSpellLanguage(lang: SpellLanguage): void {
  try {
    window.localStorage.setItem(SPELL_LANG_STORAGE_KEY, lang);
  } catch {
    // Ignore storage errors inside sandboxed iframes.
  }
}

function formatSmartPath(fullPath: string, maxChars = 36): string {
  const clean = String(fullPath || '').trim();
  if (clean.length <= maxChars) return clean;

  const sep = clean.includes('\\') && !clean.includes('/') ? '\\' : '/';
  const ellipsis = '…';
  const budget = maxChars - ellipsis.length;

  // Favor the end of the path (filename / slug + parent folder) while keeping a recognizable start.
  const lastSepIdx = clean.lastIndexOf(sep);
  const filenamePart = lastSepIdx >= 0 ? clean.slice(lastSepIdx) : clean;
  const minHead = Math.min(12, Math.floor(budget * 0.35));

  let tailBudget = Math.max(Math.floor(budget * 0.62), Math.min(filenamePart.length, budget - minHead));
  tailBudget = Math.min(tailBudget, budget - 6);

  let tail = clean.slice(clean.length - tailBudget);
  // Snap tail to a path separator near the cut if it keeps the tail readable.
  const nextSepInTail = tail.indexOf(sep);
  if (nextSepInTail > 0 && nextSepInTail <= 6 && tail.length - nextSepInTail >= Math.min(filenamePart.length, 14)) {
    tail = tail.slice(nextSepInTail);
  }

  const headBudget = Math.max(6, budget - tail.length);
  const head = clean.slice(0, headBudget).replace(/[\/\\]+$/, '');
  return `${head}${ellipsis}${tail}`;
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, 'https://example.invalid');
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read dropped file.'));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wrapTextareaSelection(
  textarea: HTMLTextAreaElement,
  prefix: string,
  suffix: string,
  placeholderText: string
): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end) || placeholderText;
  const replacement = `${prefix}${selected}${suffix}`;
  textarea.value = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  textarea.selectionStart = start + prefix.length;
  textarea.selectionEnd = start + prefix.length + selected.length;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function bootstrap(): Promise<void> {
  const appRoot = document.getElementById('app');
  if (!appRoot) return;

  const storedTheme = readStoredTheme();

  const state = {
    viewMode: 'visual' as ViewMode,
    themeMode: (storedTheme || 'light') as ThemeMode,
    hasUserThemePref: storedTheme !== null,
    showSiteChrome: readStoredSiteChrome(),
    rawFontSize: readStoredRawFontSize(),
    rawWidth: readStoredRawWidth(),
    pinStats: readStoredPinStats(),
    spellLang: readStoredSpellLanguage(),
    siteTheme: { available: false, siteName: '', css: '' } as SiteThemePayload,
    hostTheme: null as 'light' | 'dark' | null,
    blogRoot: '',
    selectedFilter: ALL_PROJECTS,
    activeProject: '',
    projects: [] as string[],
    posts: [] as PostSummary[],
    activeSlug: '',
    fullPath: '',
    lastMtimeMs: 0,
    lastHandledFocusAt: Date.now(),
    bodyHadLeadingH1: false,
    rawMarkdown: '',
    lastSavedMarkdown: '',
    dirty: false,
    saving: false,
    isSyncingEditor: false,
    linkEditOpen: false,
    plusMenuOpen: false,
    saveTimer: null as number | null,
    toastTimer: null as number | null,
    pendingUpload: null as { filename: string; base64Data: string; mimeType: string; bytes: number } | null
  };

  let bridge: HostBridge;
  let editor: Editor | null = null;

  // --- UI Element References ---
  const projectSelect = createCustomSelect({
    ariaLabel: 'Project',
    maxWidth: '210px',
    menuMinWidth: 220,
    searchable: true,
    searchThreshold: 6,
    searchPlaceholder: 'Filter projects…',
    onOpenChange: (open) => {
      if (open) cancelTopbarClose();
    },
    onChange: async (value) => {
      try {
        if (state.dirty) await persistNow();
        const payload = await bridge.init({ preferredProject: value });
        await applyInitPayload(payload);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to switch project.');
        renderSelectors();
      }
    }
  });

  const postSelect = createCustomSelect({
    ariaLabel: 'Markdown file',
    maxWidth: '240px',
    menuMinWidth: 290,
    searchable: true,
    searchThreshold: 6,
    searchPlaceholder: 'Filter articles…',
    onOpenChange: (open) => {
      if (open) cancelTopbarClose();
    },
    onChange: async (val) => {
      try {
        if (state.dirty) await persistNow();
        const sepIdx = val.indexOf('::');
        const targetProject = sepIdx >= 0 ? val.slice(0, sepIdx) : state.activeProject;
        const targetSlug = sepIdx >= 0 ? val.slice(sepIdx + 2) : val;
        const post = await bridge.readPost(targetProject, targetSlug);
        await applyLoadedPost(post);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to open article.');
        renderSelectors();
      }
    }
  });

  const newDraftBtn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' }, '+ New Draft') as HTMLButtonElement;
  const addImageBtn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' }, '+ Image') as HTMLButtonElement;
  const askAgentBtn = el(
    'button',
    { type: 'button', className: 'btn btn-primary btn-sm' },
    svgIcon(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'], 14),
    'Ask Agent'
  ) as HTMLButtonElement;
  const expandBtn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', hidden: true }, 'Expand') as HTMLButtonElement;

  const saveDot = el('span', { className: 'badge-dot' });
  const saveLabel = el('span', { textContent: 'Saved' });
  const saveBadge = el('span', { className: 'badge badge-positive', role: 'status' }, saveDot, saveLabel);
  const statsChipText = el('span', { className: 'stats-chip-text', textContent: '0 words · 0 min read' });
  const pinStatsBtn = el(
    'button',
    {
      type: 'button',
      className: 'stats-pin-btn',
      'aria-pressed': String(state.pinStats),
      'aria-label': 'Pin word count and read time to top-right corner',
      title: 'Pin word count & read time to top-right corner'
    },
    svgIcon(['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'], 12)
  ) as HTMLButtonElement;
  const statsChip = el('div', { className: 'stats-chip tabular-nums' }, statsChipText, pinStatsBtn);

  const floatingStatsText = el('span', { className: 'floating-stats-text tabular-nums', textContent: '0 words · 0 min read' });
  const floatingStatsUnpinBtn = el(
    'button',
    {
      type: 'button',
      className: 'floating-stats-unpin',
      'aria-label': 'Unpin word count and read time',
      title: 'Unpin word count & read time'
    },
    svgIcon(['M18 6 6 18', 'm6 6 12 12'], 12)
  ) as HTMLButtonElement;
  const floatingStatsBox = el(
    'div',
    {
      className: 'floating-stats-box',
      role: 'status',
      'aria-live': 'polite',
      hidden: !state.pinStats
    },
    floatingStatsText,
    floatingStatsUnpinBtn
  );

  const themeButtons: HTMLButtonElement[] = (['blog', 'light', 'dark', 'auto'] as ThemeMode[]).map((mode) =>
    el(
      'button',
      {
        type: 'button',
        className: 'theme-btn',
        'data-theme-value': mode,
        role: 'radio',
        'aria-checked': String(state.themeMode === mode),
        hidden: mode === 'blog',
        title:
          mode === 'blog'
            ? 'Match your personal blog CSS theme'
            : mode === 'auto'
              ? 'Match system/host theme'
              : `${mode[0].toUpperCase()}${mode.slice(1)} mode`
      },
      mode === 'blog' ? 'Blog' : mode[0].toUpperCase() + mode.slice(1)
    ) as HTMLButtonElement
  );
  const blogThemeBtn = themeButtons[0];

  const themeSwitcher = el(
    'div',
    { className: 'theme-switcher', role: 'radiogroup', 'aria-label': 'Color theme' },
    ...themeButtons
  );

  const tabConfigs: Array<{ mode: ViewMode; label: string; shortcut: string }> = [
    { mode: 'visual', label: 'Visual Edit', shortcut: '⌘1' },
    { mode: 'raw', label: 'Raw Markdown', shortcut: '⌘2' },
    { mode: 'preview', label: 'Read Preview', shortcut: '⌘3' }
  ];

  const tabButtons = new Map<ViewMode, HTMLButtonElement>();
  const tabList = el(
    'div',
    { className: 'tab-list', role: 'tablist', 'aria-label': 'Editor view mode' },
    ...tabConfigs.map(({ mode, label, shortcut }) => {
      const btn = el(
        'button',
        {
          type: 'button',
          className: 'tab-item',
          role: 'tab',
          'aria-selected': String(state.viewMode === mode),
          'data-view-mode': mode
        },
        label,
        el('span', { className: 'kbd-hint', textContent: shortcut })
      ) as HTMLButtonElement;
      tabButtons.set(mode, btn);
      return btn;
    })
  );

  const statusSelect = createCustomSelect({
    ariaLabel: 'Draft status',
    variant: 'compact',
    menuMinWidth: 150,
    onOpenChange: (open) => {
      if (open) cancelTopbarClose();
    },
    onChange: (val) => {
      updateRawMarkdownFromMetaPatch({ status: val });
    }
  });
  statusSelect.setOptions(
    ['idea', 'draft', 'unlisted', 'review', 'published'].map((s) => ({
      value: s,
      label: s,
      dotTone: statusTone(s)
    })),
    'idea'
  );

  const dateInput = el('input', {
    type: 'date',
    className: 'input-control meta-date',
    'aria-label': 'Article date'
  }) as HTMLInputElement;

  const spellLangSelect = createCustomSelect({
    ariaLabel: 'Spelling language',
    variant: 'compact',
    menuMinWidth: 205,
    onOpenChange: (open) => {
      if (open) cancelTopbarClose();
    },
    onChange: (val) => {
      if (val === 'en-AU' || val === 'en-GB' || val === 'en-US' || val === 'off') {
        applySpellLanguage(val);
      }
    }
  });
  spellLangSelect.setOptions(
    SPELL_LANGUAGE_OPTIONS.map((opt) => ({
      value: opt.value,
      label: opt.label,
      triggerLabel: opt.triggerLabel,
      subtitle: opt.subtitle,
      dotTone: opt.value === 'off' ? 'muted' : 'info'
    })),
    state.spellLang
  );

  const pathCodeEl = el('code', { className: 'kv-value', textContent: 'Loading…' });
  const copyPathBtn = el(
    'button',
    { type: 'button', className: 'copy-btn', 'aria-label': 'Copy file path' },
    'Copy'
  ) as HTMLButtonElement;

  const titleInput = el('textarea', {
    rows: '1',
    className: 'article-title-input',
    placeholder: 'Article title…',
    'aria-label': 'Article title'
  }) as HTMLTextAreaElement;
  const titleWrap = el('div', { className: 'article-title-wrap' }, titleInput);

  function autoResizeTitleInput(): void {
    titleInput.style.height = 'auto';
    titleInput.style.height = `${Math.max(44, titleInput.scrollHeight)}px`;
  }

  // Medium Floating Selection Bubble Toolbar
  const bubbleMenuEl = el('div', {
    className: 'medium-bubble-menu',
    role: 'toolbar',
    'aria-label': 'Formatting toolbar',
    hidden: true
  });
  const bubbleStandardGroup = el('div', { className: 'bubble-btn-group' });
  const bubbleLinkGroup = el('div', { className: 'bubble-link-row', hidden: true });
  const bubbleLinkInput = el('input', {
    type: 'url',
    className: 'input-control bubble-link-input',
    placeholder: 'https://…',
    'aria-label': 'Link URL'
  }) as HTMLInputElement;

  bubbleMenuEl.append(bubbleStandardGroup, bubbleLinkGroup);

  // Medium Empty-Line + Gutter Menu
  const plusTriggerBtn = el(
    'button',
    {
      type: 'button',
      className: 'plus-trigger',
      'aria-expanded': 'false',
      'aria-label': 'Insert block',
      title: 'Insert block'
    },
    '+'
  ) as HTMLButtonElement;
  const plusPaletteEl = el('div', { className: 'plus-palette', hidden: true });
  const plusMenuEl = el('div', { className: 'medium-plus-menu blog-studio-ui-exempt', hidden: true }, plusTriggerBtn, plusPaletteEl);

  const tiptapHostEl = el('div', { className: 'tiptap-host' });
  const visualBlogMetaTopEl = el('div', { className: 'visual-blog-meta-top', hidden: true });
  const visualBlogFooterEl = el('div', { className: 'visual-blog-footer', hidden: true });
  const visualPane = el(
    'div',
    { className: 'editor-stage' },
    plusMenuEl,
    visualBlogMetaTopEl,
    tiptapHostEl,
    visualBlogFooterEl
  );

  const rawTextarea = el('textarea', {
    className: 'raw-markdown-textarea',
    spellcheck: 'false',
    placeholder: '---\ndate: 2026-11-18\ntitle: Draft\nstatus: idea\n---\n\n# Start writing…',
    'aria-label': 'Raw Markdown source'
  }) as HTMLTextAreaElement;
  rawTextarea.style.fontSize = `${state.rawFontSize}px`;

  const rawFontDecBtn = el(
    'button',
    {
      type: 'button',
      className: 'raw-font-btn',
      'aria-label': 'Decrease Markdown font size',
      title: 'Decrease Markdown font size'
    },
    'A−'
  ) as HTMLButtonElement;
  const rawFontResetBtn = el(
    'button',
    {
      type: 'button',
      className: 'raw-font-readout tabular-nums',
      'aria-label': 'Reset Markdown font size to default',
      title: 'Click to reset to default (14px)'
    },
    `${state.rawFontSize}px`
  ) as HTMLButtonElement;
  const rawFontIncBtn = el(
    'button',
    {
      type: 'button',
      className: 'raw-font-btn',
      'aria-label': 'Increase Markdown font size',
      title: 'Increase Markdown font size'
    },
    'A+'
  ) as HTMLButtonElement;

  const rawWidthConfigs: Array<{ mode: RawWidthMode; label: string; title: string }> = [
    { mode: 'standard', label: 'Standard', title: 'Standard reading column width' },
    { mode: 'wide', label: '75%', title: '75% window width' },
    { mode: 'full', label: 'Full', title: 'Full window width' }
  ];
  const rawWidthButtons = new Map<RawWidthMode, HTMLButtonElement>();
  const rawWidthControls = el(
    'div',
    { className: 'raw-width-controls', role: 'radiogroup', 'aria-label': 'Markdown editor width' },
    ...rawWidthConfigs.map(({ mode, label, title }) => {
      const btn = el(
        'button',
        {
          type: 'button',
          className: 'raw-width-btn',
          role: 'radio',
          'aria-checked': String(state.rawWidth === mode),
          title
        },
        label
      ) as HTMLButtonElement;
      rawWidthButtons.set(mode, btn);
      return btn;
    })
  );

  const rawFontControls = el(
    'div',
    { className: 'raw-font-controls', role: 'group', 'aria-label': 'Markdown font size' },
    rawFontDecBtn,
    rawFontResetBtn,
    rawFontIncBtn
  );

  const rawToolbarRight = el('div', { className: 'raw-bar-controls' }, rawWidthControls, rawFontControls);

  const rawPane = el(
    'div',
    { className: 'raw-markdown-wrap', hidden: true },
    el(
      'div',
      { className: 'raw-markdown-bar' },
      el('div', {
        className: 'raw-markdown-hint',
        textContent: 'Monospace source mode — includes YAML frontmatter. Shortcuts: ⌘B bold, ⌘I italic, ⌘E code, ⌘K link, Tab indent.'
      }),
      rawToolbarRight
    ),
    rawTextarea
  );

  const previewMetaBadge = el('span', { className: 'badge badge-info', textContent: 'idea' });
  const previewMetaDate = el('span', { className: 'tabular-nums' });
  const previewMetaRead = el('span', { className: 'tabular-nums' });
  const previewMetaRow = el('div', { className: 'preview-meta-row' }, previewMetaBadge, previewMetaDate, previewMetaRead);
  const previewHeroTitle = el('h1', { className: 'preview-hero-title' });
  const previewHeader = el('div', { className: 'preview-header' }, previewMetaRow, previewHeroTitle);
  const previewBodyEl = el('article', { className: 'read-preview' });
  const previewPane = el('div', { hidden: true }, previewHeader, previewBodyEl);

  const sheetInnerEl = el('div', { className: 'sheet-inner' }, titleWrap, visualPane, previewPane);
  const editorSheetEl = el('div', { className: 'editor-sheet' }, sheetInnerEl, rawPane);
  const spellPopoverEl = el('div', {
    className: 'spell-popover',
    role: 'menu',
    'aria-label': 'Spelling suggestions',
    hidden: true
  });
  const toastEl = el('div', { className: 'studio-toast', role: 'status', hidden: true });

  // --- Modals (New Draft, Image Upload Dropzone, Ask Agent) ---
  const newDraftTitleInput = el('input', {
    type: 'text',
    className: 'input-control',
    placeholder: 'e.g. Building a Two-Way MCP App'
  }) as HTMLInputElement;
  const newDraftSlugInput = el('input', {
    type: 'text',
    className: 'input-control',
    placeholder: 'Optional kebab-case slug (auto-generated if blank)'
  }) as HTMLInputElement;
  const newDraftStatusSelect = createCustomSelect({
    ariaLabel: 'Initial Status',
    variant: 'full',
    menuMinWidth: 180
  });
  newDraftStatusSelect.setOptions(
    ['idea', 'draft', 'unlisted', 'review'].map((s) => ({
      value: s,
      label: s,
      dotTone: statusTone(s)
    })),
    'idea'
  );
  const newDraftSubtitleEl = el('p', {
    className: 'modal-subtitle',
    textContent: 'Scaffolds a new Markdown post with YAML frontmatter inside the active project.'
  });
  const newDraftCreateBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Create Draft') as HTMLButtonElement;
  const newDraftCancelBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Cancel') as HTMLButtonElement;
  const newDraftModal = el(
    'div',
    { className: 'modal-backdrop', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Create new draft' },
    el(
      'div',
      { className: 'modal-card' },
      el('h2', { className: 'modal-title', textContent: 'New Markdown Draft' }),
      newDraftSubtitleEl,
      el('label', { className: 'form-field' }, el('span', { className: 'form-label', textContent: 'Title' }), newDraftTitleInput),
      el('label', { className: 'form-field' }, el('span', { className: 'form-label', textContent: 'Slug (optional)' }), newDraftSlugInput),
      el('div', { className: 'form-field' }, el('span', { className: 'form-label', textContent: 'Initial Status' }), newDraftStatusSelect.el),
      el('div', { className: 'modal-actions' }, newDraftCancelBtn, newDraftCreateBtn)
    )
  );

  // Image Upload Modal with Mandatory Drag-and-Drop Zone
  const fileInput = el('input', {
    type: 'file',
    className: 'sr-only',
    accept: 'image/png,image/jpeg,image/webp,image/gif'
  }) as HTMLInputElement;
  const dropzoneEl = el(
    'div',
    {
      className: 'file-dropzone',
      tabindex: '0',
      role: 'button',
      'aria-label': 'Upload image by clicking or dragging and dropping'
    },
    fileInput,
    el('div', { className: 'dropzone-icon' }, svgIcon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'], 18)),
    el('p', { className: 'dropzone-title' }, 'Drag and drop an image here, or ', el('span', { className: 'dropzone-link', textContent: 'browse' })),
    el('p', { className: 'dropzone-hint', textContent: 'Supports PNG, JPEG, WebP, or GIF up to 10 MB' })
  );
  const uploadResultRow = el('div', { className: 'dropzone-result', hidden: true });
  const uploadAltInput = el('input', {
    type: 'text',
    className: 'input-control',
    placeholder: 'Optional alt text describing the screenshot…'
  }) as HTMLInputElement;
  const uploadInsertBtn = el('button', { type: 'button', className: 'btn btn-primary', disabled: true }, 'Insert Image') as HTMLButtonElement;
  const uploadCancelBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Cancel') as HTMLButtonElement;
  const imageModal = el(
    'div',
    { className: 'modal-backdrop', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Upload image' },
    el(
      'div',
      { className: 'modal-card' },
      el('h2', { className: 'modal-title', textContent: 'Insert Image Asset' }),
      el('p', { className: 'modal-subtitle', textContent: 'Images are validated by binary header and saved locally under assets/.' }),
      dropzoneEl,
      uploadResultRow,
      el('label', { className: 'form-field' }, el('span', { className: 'form-label', textContent: 'Alt Text' }), uploadAltInput),
      el('div', { className: 'modal-actions' }, uploadCancelBtn, uploadInsertBtn)
    )
  );

  // Ask Agent Modal
  const agentQuoteBox = el('div', { className: 'quote-snippet', hidden: true });
  const agentInstructionInput = el('textarea', {
    className: 'textarea-control',
    placeholder: 'What should the agent do with this draft or selection?'
  }) as HTMLTextAreaElement;
  const agentPresetBtns = [
    { label: 'Tighten prose', prompt: 'Tighten this section for clarity and builder-first brevity without losing technical detail.' },
    { label: 'Add code walkthrough', prompt: 'Suggest a concise code example from the active workspace that strengthens this section.' },
    { label: 'Review structure', prompt: 'Review the flow and hook of this draft and suggest specific edits.' }
  ].map((preset) => {
    const btn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' }, preset.label) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      agentInstructionInput.value = preset.prompt;
      agentInstructionInput.focus();
    });
    return btn;
  });
  const agentSendBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Send to Agent') as HTMLButtonElement;
  const agentCancelBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Cancel') as HTMLButtonElement;
  const agentModal = el(
    'div',
    { className: 'modal-backdrop', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ask agent' },
    el(
      'div',
      { className: 'modal-card' },
      el('h2', { className: 'modal-title', textContent: 'Collaborate with Agent' }),
      el('p', { className: 'modal-subtitle', textContent: 'Sends your active file reference and instruction directly into the conversation.' }),
      agentQuoteBox,
      el('div', { className: 'btn-row' }, ...agentPresetBtns),
      el('label', { className: 'form-field' }, el('span', { className: 'form-label', textContent: 'Instruction' }), agentInstructionInput),
      el('div', { className: 'modal-actions' }, agentCancelBtn, agentSendBtn)
    )
  );

  // Assemble Minimalist Hover Slide-Down Top Dock & Page Shell
  const handleStatusDot = el('span', { className: 'handle-dot is-saved', 'aria-hidden': 'true' });
  const handleFileEl = el('span', { className: 'handle-file', textContent: 'Loading…' });
  const handleModeEl = el('span', { className: 'handle-mode', textContent: 'Visual' });
  const handleChevronEl = el('span', { className: 'handle-chevron', textContent: '▾', 'aria-hidden': 'true' });
  const topbarHandleBtn = el(
    'button',
    {
      type: 'button',
      className: 'topbar-handle-pill',
      'aria-expanded': 'false',
      'aria-label': 'Toggle blog management bar (⌘.)',
      title: 'Hover or click to open blog controls (⌘.)'
    },
    handleStatusDot,
    handleFileEl,
    el('span', { className: 'handle-sep', textContent: '·', 'aria-hidden': 'true' }),
    handleModeEl,
    handleChevronEl
  ) as HTMLButtonElement;

  const siteChromeBtn = el(
    'button',
    {
      type: 'button',
      className: 'btn btn-secondary btn-sm pin-btn',
      hidden: true,
      'aria-pressed': String(state.showSiteChrome),
      title: 'Show or hide your blog sidebars (left & middle columns)'
    },
    state.showSiteChrome ? 'Sidebars: On' : 'Sidebars'
  ) as HTMLButtonElement;

  const popoutBtn = el(
    'button',
    {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      hidden: true,
      title: 'Pop out current article in Google Chrome'
    },
    'Pop out ↗'
  ) as HTMLButtonElement;

  const pinTopbarBtn = el(
    'button',
    {
      type: 'button',
      className: 'btn btn-secondary btn-sm pin-btn',
      'aria-pressed': 'false',
      title: 'Pin management bar open'
    },
    'Pin'
  ) as HTMLButtonElement;

  const topHeader = el(
    'header',
    { className: 'studio-topbar' },
    el(
      'div',
      { className: 'topbar-inner' },
      el(
        'div',
        { className: 'topbar-row' },
        el(
          'div',
          { className: 'topbar-left' },
          projectSelect.el,
          postSelect.el,
          newDraftBtn,
          addImageBtn,
          askAgentBtn,
          expandBtn
        ),
        el('div', { className: 'topbar-right' }, saveBadge, statsChip, themeSwitcher, siteChromeBtn, popoutBtn, pinTopbarBtn)
      ),
      el(
        'div',
        { className: 'topbar-row topbar-row-secondary' },
        tabList,
        el(
          'div',
          { className: 'meta-strip' },
          el(
            'div',
            { className: 'meta-controls' },
            el('div', { className: 'meta-field' }, el('span', { className: 'meta-field-label', textContent: 'Status' }), statusSelect.el),
            el('label', { className: 'meta-field' }, el('span', { className: 'meta-field-label', textContent: 'Date' }), dateInput),
            el('div', { className: 'meta-field' }, el('span', { className: 'meta-field-label', textContent: 'Spell' }), spellLangSelect.el)
          ),
          el('div', { className: 'path-copy-group' }, pathCodeEl, copyPathBtn)
        )
      )
    )
  );

  const topbarHoverZone = el('div', { className: 'topbar-hover-zone' }, topbarHandleBtn);
  const topbarDock = el('div', { className: 'topbar-dock' }, topbarHoverZone, topHeader);
  const siteChromeEls: HTMLElement[] = [];
  const studioWorkspaceEl = el('main', { className: 'studio-workspace' }, editorSheetEl);

  const shell = el(
    'div',
    { className: 'studio-shell' },
    topbarDock,
    floatingStatsBox,
    studioWorkspaceEl,
    bubbleMenuEl,
    spellPopoverEl,
    newDraftModal,
    imageModal,
    agentModal,
    toastEl
  );
  appRoot.replaceChildren(shell);

  // --- Hover Slide-Down Management Bar Logic ---
  let topbarPinned = false;
  let topbarOpen = false;
  let topbarCloseTimer: number | null = null;

  function setTopbarOpen(open: boolean): void {
    topbarOpen = open;
    topbarDock.classList.toggle('is-open', open || topbarPinned);
    topbarHandleBtn.setAttribute('aria-expanded', String(open || topbarPinned));
    if (!open && !topbarPinned) {
      closeAllCustomSelects(topHeader);
    }
  }

  function setTopbarPinned(pinned: boolean): void {
    topbarPinned = pinned;
    topbarDock.classList.toggle('is-pinned', pinned);
    shell.classList.toggle('has-pinned-topbar', pinned);
    pinTopbarBtn.setAttribute('aria-pressed', String(pinned));
    pinTopbarBtn.classList.toggle('is-pinned', pinned);
    pinTopbarBtn.textContent = pinned ? 'Pinned' : 'Pin';
    setTopbarOpen(pinned || topbarOpen);
  }

  function scheduleTopbarClose(): void {
    if (topbarPinned) return;
    if (topbarCloseTimer) window.clearTimeout(topbarCloseTimer);
    topbarCloseTimer = window.setTimeout(() => {
      if (topbarPinned) return;
      if (hasOpenCustomSelectIn(topHeader)) return;
      const active = document.activeElement;
      if (active && topHeader.contains(active) && active.tagName === 'INPUT') {
        return;
      }
      setTopbarOpen(false);
    }, 260);
  }

  function cancelTopbarClose(): void {
    if (topbarCloseTimer) {
      window.clearTimeout(topbarCloseTimer);
      topbarCloseTimer = null;
    }
  }

  topbarDock.addEventListener('pointerenter', () => {
    cancelTopbarClose();
    setTopbarOpen(true);
  });

  topbarDock.addEventListener('pointerleave', () => {
    scheduleTopbarClose();
  });

  topbarDock.addEventListener('focusin', () => {
    cancelTopbarClose();
    setTopbarOpen(true);
  });

  topbarDock.addEventListener('focusout', (e) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !topbarDock.contains(next)) {
      scheduleTopbarClose();
    }
  });

  topbarHandleBtn.addEventListener('click', () => {
    cancelTopbarClose();
    if (topbarPinned) {
      setTopbarPinned(false);
      setTopbarOpen(false);
    } else {
      setTopbarOpen(!topbarOpen);
    }
  });

  pinTopbarBtn.addEventListener('click', () => {
    setTopbarPinned(!topbarPinned);
  });

  function applyPinStats(pinned: boolean): void {
    state.pinStats = pinned;
    saveStoredPinStats(pinned);
    pinStatsBtn.setAttribute('aria-pressed', String(pinned));
    pinStatsBtn.classList.toggle('is-pinned', pinned);
    pinStatsBtn.title = pinned ? 'Unpin word count & read time' : 'Pin word count & read time to top-right corner';
    floatingStatsBox.hidden = !pinned;
  }

  applyPinStats(state.pinStats);

  pinStatsBtn.addEventListener('click', () => {
    applyPinStats(!state.pinStats);
  });

  floatingStatsUnpinBtn.addEventListener('click', () => {
    applyPinStats(false);
  });

  function applyRawFontSize(nextSize: number): void {
    const clamped = Math.min(MAX_RAW_FONT_SIZE, Math.max(MIN_RAW_FONT_SIZE, Math.round(nextSize)));
    state.rawFontSize = clamped;
    saveStoredRawFontSize(clamped);
    rawTextarea.style.fontSize = `${clamped}px`;
    rawFontResetBtn.textContent = `${clamped}px`;
    rawFontDecBtn.disabled = clamped <= MIN_RAW_FONT_SIZE;
    rawFontIncBtn.disabled = clamped >= MAX_RAW_FONT_SIZE;
    if (state.viewMode === 'raw') {
      autoResizeRawTextarea();
    }
  }

  applyRawFontSize(state.rawFontSize);

  rawFontDecBtn.addEventListener('click', () => {
    applyRawFontSize(state.rawFontSize - 1);
  });

  rawFontIncBtn.addEventListener('click', () => {
    applyRawFontSize(state.rawFontSize + 1);
  });

  rawFontResetBtn.addEventListener('click', () => {
    applyRawFontSize(DEFAULT_RAW_FONT_SIZE);
  });

  function applyRawWidth(mode: RawWidthMode): void {
    state.rawWidth = mode;
    saveStoredRawWidth(mode);
    shell.setAttribute('data-raw-width', mode);
    for (const [m, btn] of rawWidthButtons.entries()) {
      btn.setAttribute('aria-checked', String(m === mode));
    }
    if (state.viewMode === 'raw') {
      autoResizeRawTextarea();
    }
  }

  applyRawWidth(state.rawWidth);

  for (const [mode, btn] of rawWidthButtons.entries()) {
    btn.addEventListener('click', () => {
      applyRawWidth(mode);
    });
  }

  function applySpellAttributesToDom(): void {
    const enabled = state.spellLang !== 'off';
    const targets: Array<HTMLElement | null | undefined> = [titleInput, rawTextarea, editor?.view?.dom];
    for (const target of targets) {
      if (!target) continue;
      target.setAttribute('spellcheck', enabled ? 'true' : 'false');
      if (enabled) {
        target.setAttribute('lang', state.spellLang);
      } else {
        target.removeAttribute('lang');
      }
    }
  }

  function applySpellLanguage(lang: SpellLanguage): void {
    state.spellLang = lang;
    saveStoredSpellLanguage(lang);
    spellLangSelect.setValue(lang);
    applySpellAttributesToDom();
    hideSpellPopover();
    spellMisspelledMap.clear();
    refreshSpellDecorations();
    scheduleSpellCheck(true);
  }

  // --- Real Dictionary Spellcheck (Visual Edit Squiggles + Click-to-Fix Popover) ---
  const spellDecoKey = new PluginKey<DecorationSet>('spellDecorations');
  const spellMisspelledMap = new Map<string, string[]>();
  const spellIgnoredWords = new Set<string>();
  let spellCheckTimer: number | null = null;
  let spellCheckSeq = 0;

  function hideSpellPopover(): void {
    spellPopoverEl.hidden = true;
    spellPopoverEl.replaceChildren();
  }

  function extractDocWordRanges(doc: NonNullable<typeof editor>['state']['doc']): Array<{ word: string; from: number; to: number }> {
    const out: Array<{ word: string; from: number; to: number }> = [];
    const wordRegex = /\b[A-Za-z][A-Za-z'’-]*[A-Za-z]\b/g;

    doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') return false;
      if (!node.isText || !node.text) return true;
      if (node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) {
        return true;
      }

      const text = node.text;
      wordRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = wordRegex.exec(text)) !== null) {
        const word = match[0];
        const idx = match.index;
        if (idx > 0 && /[\/\\_@#:$`.0-9]/.test(text[idx - 1])) continue;
        out.push({ word, from: pos + idx, to: pos + idx + word.length });
      }
      return true;
    });
    return out;
  }

  function buildSpellDecorations(doc: NonNullable<typeof editor>['state']['doc']): DecorationSet {
    if (state.spellLang === 'off' || spellMisspelledMap.size === 0) {
      return DecorationSet.empty;
    }
    const ranges = extractDocWordRanges(doc);
    const decos: Decoration[] = [];
    for (const r of ranges) {
      if (spellIgnoredWords.has(r.word.toLowerCase())) continue;
      if (!spellMisspelledMap.has(r.word)) continue;
      decos.push(
        Decoration.inline(r.from, r.to, {
          class: 'spell-error',
          'data-spell-word': r.word,
          'data-spell-from': String(r.from),
          'data-spell-to': String(r.to)
        })
      );
    }
    return DecorationSet.create(doc, decos);
  }

  function refreshSpellDecorations(): void {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(spellDecoKey, true));
  }

  function scheduleSpellCheck(immediate = false): void {
    if (spellCheckTimer) {
      window.clearTimeout(spellCheckTimer);
      spellCheckTimer = null;
    }
    if (state.spellLang === 'off') {
      spellMisspelledMap.clear();
      refreshSpellDecorations();
      return;
    }
    const run = async () => {
      if (!editor || !bridge?.spellcheck || state.spellLang === 'off') return;
      const reqSeq = ++spellCheckSeq;
      const lang = state.spellLang;
      const ranges = extractDocWordRanges(editor.state.doc);
      const uniqueWords = Array.from(
        new Set(ranges.map((r) => r.word).filter((w) => !spellIgnoredWords.has(w.toLowerCase())))
      );
      if (uniqueWords.length === 0) {
        spellMisspelledMap.clear();
        refreshSpellDecorations();
        return;
      }
      try {
        const res = await bridge.spellcheck(lang, uniqueWords);
        if (reqSeq !== spellCheckSeq || state.spellLang !== lang) return;
        spellMisspelledMap.clear();
        for (const [w, suggestions] of Object.entries(res?.misspelled || {})) {
          if (!spellIgnoredWords.has(w.toLowerCase())) {
            spellMisspelledMap.set(w, suggestions);
          }
        }
        refreshSpellDecorations();
      } catch {
        // Non-fatal if backend spellcheck endpoint is unavailable (e.g. old sidecar before reload).
      }
    };

    if (immediate) {
      void run();
    } else {
      spellCheckTimer = window.setTimeout(() => {
        void run();
      }, 360);
    }
  }

  function openSpellPopoverForSpan(spanEl: HTMLElement): void {
    if (!editor) return;
    const word = spanEl.getAttribute('data-spell-word') || '';
    const from = Number(spanEl.getAttribute('data-spell-from'));
    const to = Number(spanEl.getAttribute('data-spell-to'));
    if (!word || !Number.isFinite(from) || !Number.isFinite(to)) return;

    const suggestions = spellMisspelledMap.get(word) || [];
    const items: HTMLElement[] = [];

    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        const btn = el('button', { type: 'button', className: 'spell-popover-item is-suggestion', role: 'menuitem' }, suggestion) as HTMLButtonElement;
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
          editor?.chain().focus().insertContentAt({ from, to }, suggestion).run();
          hideSpellPopover();
          scheduleSpellCheck(true);
        });
        items.push(btn);
      }
    } else {
      items.push(el('div', { className: 'spell-popover-empty', textContent: 'No suggestions' }));
    }

    items.push(el('div', { className: 'spell-popover-sep' }));

    const addDictBtn = el('button', { type: 'button', className: 'spell-popover-item', role: 'menuitem' }, `Add “${word}” to dictionary`) as HTMLButtonElement;
    addDictBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addDictBtn.addEventListener('click', async () => {
      hideSpellPopover();
      spellIgnoredWords.add(word.toLowerCase());
      spellMisspelledMap.delete(word);
      refreshSpellDecorations();
      try {
        await bridge.addSpellWord?.(word);
        showToast(`Added “${word}” to dictionary.`);
      } catch {
        showToast(`Ignored “${word}” for this session.`);
      }
    });
    items.push(addDictBtn);

    const ignoreBtn = el('button', { type: 'button', className: 'spell-popover-item', role: 'menuitem' }, 'Ignore for session') as HTMLButtonElement;
    ignoreBtn.addEventListener('mousedown', (e) => e.preventDefault());
    ignoreBtn.addEventListener('click', () => {
      hideSpellPopover();
      spellIgnoredWords.add(word.toLowerCase());
      spellMisspelledMap.delete(word);
      refreshSpellDecorations();
    });
    items.push(ignoreBtn);

    spellPopoverEl.replaceChildren(...items);
    spellPopoverEl.hidden = false;

    const rect = spanEl.getBoundingClientRect();
    const popWidth = spellPopoverEl.offsetWidth || 200;
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - popWidth - 12);
    const top = rect.bottom + 6;
    spellPopoverEl.style.left = `${Math.round(left)}px`;
    spellPopoverEl.style.top = `${Math.round(top)}px`;
  }

  tiptapHostEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const spellSpan = target?.closest<HTMLElement>('.spell-error');
    if (spellSpan) {
      e.stopPropagation();
      openSpellPopoverForSpan(spellSpan);
    } else if (!spellPopoverEl.hidden) {
      hideSpellPopover();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (spellPopoverEl.hidden) return;
    const target = e.target as Node | null;
    if (target && !spellPopoverEl.contains(target) && !(target instanceof HTMLElement && target.closest('.spell-error'))) {
      hideSpellPopover();
    }
  });

  applySpellAttributesToDom();

  // --- Theme Handling ---
  const systemDarkMq = window.matchMedia('(prefers-color-scheme: dark)');
  let siteThemeStyleEl: HTMLStyleElement | null = null;

  function isBlogSiteThemeActive(): boolean {
    return state.themeMode === 'blog' && state.siteTheme.available;
  }

  function syncVisualTitleVisibility(): void {
    if (state.viewMode !== 'visual') {
      titleWrap.hidden = true;
      return;
    }
    // In Blog theme, titleWrap always renders the editable H1 above tags/embed/body
    // (mirroring the exact live blog DOM order: H1 -> .article-tags -> .video-embed -> body).
    if (isBlogSiteThemeActive()) {
      titleWrap.hidden = false;
      window.requestAnimationFrame(autoResizeTitleInput);
      return;
    }
    const parsed = parseDocument(state.rawMarkdown);
    const { hasLeadingH1 } = splitLeadingH1(parsed.body);
    titleWrap.hidden = hasLeadingH1;
  }

  function syncEditorContentFromRaw(): void {
    if (!editor) return;
    const parsed = parseDocument(state.rawMarkdown);
    const split = splitLeadingH1(parsed.body);
    state.bodyHadLeadingH1 = split.hasLeadingH1;
    const contentForTiptap =
      isBlogSiteThemeActive() && split.hasLeadingH1 ? split.restBody : parsed.body;
    state.isSyncingEditor = true;
    editor.commands.setContent(contentForTiptap, { contentType: 'markdown' });
    state.isSyncingEditor = false;
  }

  function buildBlogMetaNodes(parsed: ReturnType<typeof parseDocument>): {
    topNodes: Node[];
    footerNode: Node | null;
  } {
    const extras = extractFrontmatterExtras(parsed);
    const topNodes: Node[] = [];
    if (extras.tags.length > 0) {
      topNodes.push(
        el(
          'div',
          { className: 'article-tags' },
          ...extras.tags.map((tag) => el('span', { className: 'article-tag', textContent: tag }))
        )
      );
    }
    if (extras.youtubeId) {
      topNodes.push(
        el(
          'div',
          { className: 'video-embed video-embed-preview' },
          el(
            'a',
            {
              className: 'video-embed-link',
              href: `https://www.youtube.com/watch?v=${extras.youtubeId}`,
              target: '_blank',
              rel: 'noopener noreferrer'
            },
            el('span', { className: 'video-embed-badge', textContent: '▶ YouTube Embed' }),
            el('span', { className: 'video-embed-id', textContent: `youtube.com/watch?v=${extras.youtubeId}` })
          )
        )
      );
    }

    let footerNode: Node | null = null;
    if (parsed.meta.date) {
      const displayDate = formatBlogDisplayDate(parsed.meta.date);
      footerNode = el(
        'p',
        { className: 'blog-date' },
        'Article published on: ',
        el('time', { datetime: parsed.meta.date, textContent: displayDate })
      );
    }
    return { topNodes, footerNode };
  }

  function syncVisualBlogChrome(): void {
    const siteMode = isBlogSiteThemeActive();
    if (!siteMode || state.viewMode !== 'visual') {
      visualBlogMetaTopEl.hidden = true;
      visualBlogFooterEl.hidden = true;
      return;
    }
    const parsed = parseDocument(state.rawMarkdown);
    const { topNodes, footerNode } = buildBlogMetaNodes(parsed);

    if (topNodes.length > 0) {
      visualBlogMetaTopEl.replaceChildren(...topNodes);
      visualBlogMetaTopEl.hidden = false;
    } else {
      visualBlogMetaTopEl.replaceChildren();
      visualBlogMetaTopEl.hidden = true;
    }

    if (footerNode) {
      visualBlogFooterEl.replaceChildren(footerNode);
      visualBlogFooterEl.hidden = false;
    } else {
      visualBlogFooterEl.replaceChildren();
      visualBlogFooterEl.hidden = true;
    }
  }

  function hydrateSiteChromeColumn(container: HTMLElement, rawHtml: string): void {
    const sanitized = DOMPurify.sanitize(String(rawHtml || ''), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed']
    });
    const doc = new DOMParser().parseFromString(sanitized, 'text/html');
    for (const img of doc.body.querySelectorAll('img')) {
      const rawSrc = img.getAttribute('src') || '';
      const resolved = bridge.resolveAssetUrl(ROOT_PROJECT, rawSrc);
      if (resolved) {
        img.setAttribute('src', resolved);
        if (bridge.mode === 'sidecar' && bridge.loadAssetDataUrl && isLocalAssetSrc(rawSrc)) {
          void bridge.loadAssetDataUrl(ROOT_PROJECT, rawSrc).then((dataUrl) => {
            if (dataUrl) img.setAttribute('src', dataUrl);
          });
        }
      } else {
        img.removeAttribute('src');
      }
    }
    for (const anchor of doc.body.querySelectorAll('a')) {
      const href = anchor.getAttribute('href') || '';
      if (!isSafeLinkHref(href)) {
        anchor.removeAttribute('href');
        continue;
      }
      const blogMatch = href.match(/^\/blog\/(?:([a-zA-Z0-9._-]+)\/)?([a-zA-Z0-9._-]+)\.html$/);
      if (blogMatch) {
        const targetProject = blogMatch[1] || ROOT_PROJECT;
        const targetSlug = blogMatch[2];
        anchor.setAttribute('data-blog-project', targetProject);
        anchor.setAttribute('data-blog-slug', targetSlug);
        anchor.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            if (state.dirty) await persistNow();
            const post = await bridge.readPost(targetProject, targetSlug);
            await applyLoadedPost(post);
            showToast(`Opened ${post.filename}`);
          } catch {
            showToast(`Could not open ${targetSlug}.md`);
          }
        });
      } else if (/^https?:/i.test(href)) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      } else {
        anchor.addEventListener('click', (e) => e.preventDefault());
      }
    }
    container.replaceChildren(...Array.from(doc.body.childNodes));
  }

  let appliedArticleClasses: string[] = [];
  let appliedInnerClasses: string[] = [];
  let siteFontLinkEl: HTMLLinkElement | null = null;

  function hasSiteChromeAvailable(): boolean {
    return Boolean(state.siteTheme.available && (state.siteTheme.chrome?.columns?.length || 0) > 0);
  }

  function syncSiteThemeOnSheet(): void {
    const isRaw = state.viewMode === 'raw';
    const applyOnSheet = isBlogSiteThemeActive() && !isRaw;
    const showChrome = applyOnSheet && hasSiteChromeAvailable() && state.showSiteChrome;
    shell.classList.toggle('is-raw-mode', isRaw);
    studioWorkspaceEl.classList.toggle('blog-site-theme-root', applyOnSheet);
    studioWorkspaceEl.classList.toggle('has-site-chrome', showChrome);

    // Physically attach/detach site chrome columns so site CSS media queries can never force
    // hidden sidebars or their box-shadows onto the canvas when Sidebars are OFF.
    for (const colEl of siteChromeEls) {
      if (showChrome) {
        colEl.hidden = false;
        if (!colEl.parentNode) {
          studioWorkspaceEl.insertBefore(colEl, editorSheetEl);
        }
      } else if (colEl.parentNode) {
        colEl.remove();
      }
    }

    siteChromeBtn.hidden = !applyOnSheet || !hasSiteChromeAvailable();
    siteChromeBtn.setAttribute('aria-pressed', String(state.showSiteChrome));
    siteChromeBtn.classList.toggle('is-pinned', state.showSiteChrome);
    siteChromeBtn.textContent = state.showSiteChrome ? 'Sidebars: On' : 'Sidebars';

    editorSheetEl.classList.toggle('is-site-theme', applyOnSheet);
    for (const cls of appliedArticleClasses) {
      editorSheetEl.classList.remove(cls);
    }
    for (const cls of appliedInnerClasses) {
      sheetInnerEl.classList.remove(cls);
    }
    appliedArticleClasses = [];
    appliedInnerClasses = [];
    if (applyOnSheet) {
      for (const cls of state.siteTheme.articleClasses || []) {
        editorSheetEl.classList.add(cls);
        appliedArticleClasses.push(cls);
      }
      for (const cls of state.siteTheme.innerClasses || []) {
        sheetInnerEl.classList.add(cls);
        appliedInnerClasses.push(cls);
      }
    }
    syncVisualTitleVisibility();
    syncVisualBlogChrome();
  }

  siteChromeBtn.addEventListener('click', () => {
    state.showSiteChrome = !state.showSiteChrome;
    saveStoredSiteChrome(state.showSiteChrome);
    syncSiteThemeOnSheet();
  });

  function installSiteTheme(payload: SiteThemePayload): void {
    state.siteTheme = payload;
    for (const colEl of siteChromeEls) {
      colEl.remove();
    }
    siteChromeEls.length = 0;

    if (!payload.available || !payload.css) {
      blogThemeBtn.hidden = true;
      siteChromeBtn.hidden = true;
      if (state.themeMode === 'blog') {
        applyTheme('light', false);
      }
      return;
    }

    if (payload.googleFonts && payload.googleFonts.length > 0) {
      const familyQuery = payload.googleFonts.map((f) => `family=${f}`).join('&');
      const href = `https://fonts.googleapis.com/css2?${familyQuery}&display=swap`;
      if (!siteFontLinkEl) {
        siteFontLinkEl = document.createElement('link');
        siteFontLinkEl.rel = 'stylesheet';
        siteFontLinkEl.id = 'blog-site-theme-fonts';
        document.head.appendChild(siteFontLinkEl);
      }
      if (siteFontLinkEl.href !== href) {
        siteFontLinkEl.href = href;
      }
    }

    if (!siteThemeStyleEl) {
      siteThemeStyleEl = document.createElement('style');
      siteThemeStyleEl.id = 'blog-site-theme-style';
      document.head.appendChild(siteThemeStyleEl);
    }
    siteThemeStyleEl.textContent = payload.css;

    for (const col of payload.chrome?.columns || []) {
      const colEl = el('aside', {
        className: [...col.wrapperClasses, 'site-chrome-col'].join(' '),
        hidden: true,
        'aria-label': col.ariaLabel || col.className
      });
      hydrateSiteChromeColumn(colEl, col.html);
      siteChromeEls.push(colEl);
    }

    blogThemeBtn.hidden = false;
    blogThemeBtn.title = payload.siteName
      ? `Replicate live ${payload.siteName} blog theme`
      : 'Replicate personal blog theme';

    if (!state.hasUserThemePref || state.themeMode === 'blog') {
      applyTheme('blog', false);
    } else {
      syncSiteThemeOnSheet();
    }
  }

  function applyTheme(mode: ThemeMode, persist = true): void {
    const effectiveMode: ThemeMode = mode === 'blog' && !state.siteTheme.available ? 'light' : mode;
    state.themeMode = effectiveMode;
    if (persist) {
      state.hasUserThemePref = true;
      saveStoredTheme(effectiveMode);
    }
    const resolved =
      effectiveMode === 'blog'
        ? 'blog'
        : effectiveMode === 'auto'
          ? state.hostTheme || (systemDarkMq.matches ? 'dark' : 'light')
          : effectiveMode;
    document.documentElement.setAttribute('data-theme', resolved);
    for (const btn of themeButtons) {
      btn.setAttribute('aria-checked', String(btn.getAttribute('data-theme-value') === effectiveMode));
    }
    syncSiteThemeOnSheet();
    if (state.viewMode === 'visual' && editor && state.rawMarkdown) {
      syncEditorContentFromRaw();
    }
    if (state.viewMode === 'preview' && state.rawMarkdown) {
      void renderReadPreview();
    }
  }

  for (const btn of themeButtons) {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-theme-value') as ThemeMode;
      applyTheme(next, true);
    });
  }
  systemDarkMq.addEventListener('change', () => {
    if (state.themeMode === 'auto') applyTheme('auto', false);
  });
  applyTheme(state.themeMode, false);

  // --- Feedback Helpers ---
  function showToast(message: string): void {
    toastEl.textContent = message;
    toastEl.hidden = false;
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 2800);
  }

  function updateSaveBadge(status: 'saved' | 'saving' | 'dirty' | 'error', labelText?: string): void {
    saveBadge.className = 'badge';
    handleStatusDot.className = 'handle-dot';
    if (status === 'saved') {
      saveBadge.classList.add('badge-positive');
      handleStatusDot.classList.add('is-saved');
      saveLabel.textContent = labelText || 'Saved';
    } else if (status === 'saving' || status === 'dirty') {
      saveBadge.classList.add('badge-warning');
      handleStatusDot.classList.add('is-dirty');
      saveLabel.textContent = labelText || (status === 'saving' ? 'Saving…' : 'Unsaved');
    } else {
      saveBadge.classList.add('badge-danger');
      handleStatusDot.classList.add('is-error');
      saveLabel.textContent = labelText || 'Save error';
    }
  }

  function updateStatsAndMetaUI(): void {
    const parsed = parseDocument(state.rawMarkdown);
    const stats = computeStats(parsed.body);
    const statsLabel = `${stats.words} words · ${stats.readingMinutes} min read`;
    statsChipText.textContent = statsLabel;
    floatingStatsText.textContent = statsLabel;

    if (document.activeElement !== titleInput) {
      titleInput.value = parsed.meta.title || '';
      autoResizeTitleInput();
    }
    if (!statusSelect.isOpen()) {
      statusSelect.setValue(parsed.meta.status || 'idea');
    }
    if (document.activeElement !== dateInput) {
      dateInput.value = parsed.meta.date || '';
    }

    const rawDisplayPath = state.fullPath || `${state.activeProject}/${state.activeSlug}.md`;
    pathCodeEl.textContent = formatSmartPath(rawDisplayPath);
    pathCodeEl.title = rawDisplayPath;
    copyPathBtn.setAttribute('data-copy-value', rawDisplayPath);
    handleFileEl.textContent = state.activeSlug ? `${state.activeSlug}.md` : 'Blog Studio';
    syncVisualTitleVisibility();
    syncVisualBlogChrome();
  }

  async function persistNow(): Promise<void> {
    if (!state.activeProject || !state.activeSlug || state.saving) return;
    if (state.saveTimer) {
      window.clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    state.saving = true;
    updateSaveBadge('saving');
    try {
      const res = await bridge.savePost(state.activeProject, state.activeSlug, state.rawMarkdown, {
        baseContent: state.lastSavedMarkdown,
        expectedMtimeMs: state.lastMtimeMs
      });
      state.dirty = false;
      state.lastMtimeMs = res.mtimeMs;
      if (res.fullPath) {
        state.fullPath = res.fullPath;
        pathCodeEl.textContent = formatSmartPath(res.fullPath);
        pathCodeEl.title = res.fullPath;
        copyPathBtn.setAttribute('data-copy-value', res.fullPath);
      }
      if (res.merged && typeof res.content === 'string') {
        const anchor = captureViewFocusAnchor(state.viewMode);
        state.rawMarkdown = res.content;
        state.lastSavedMarkdown = res.content;
        if (editor) {
          syncEditorContentFromRaw();
          scheduleSpellCheck(true);
        }
        rawTextarea.value = state.rawMarkdown;
        if (state.viewMode === 'raw') autoResizeRawTextarea();
        if (state.viewMode === 'preview') await renderReadPreview();
        updateStatsAndMetaUI();
        window.requestAnimationFrame(() => {
          restoreViewFocusAnchor(state.viewMode, anchor);
        });
        showToast('Merged external edit from disk.');
      } else {
        state.lastSavedMarkdown = state.rawMarkdown;
      }
      updateSaveBadge('saved');
      const parsed = parseDocument(state.rawMarkdown);
      const stats = computeStats(parsed.body);
      if (bridge.syncModelContext) {
        await bridge.syncModelContext({
          project: state.activeProject,
          slug: state.activeSlug,
          title: parsed.meta.title || state.activeSlug,
          status: parsed.meta.status || 'idea',
          words: stats.words
        });
      }
    } catch (err) {
      updateSaveBadge('error', 'Save failed');
      showToast(err instanceof Error ? err.message : 'Failed to save draft.');
    } finally {
      state.saving = false;
    }
  }

  function scheduleAutoSave(): void {
    state.dirty = true;
    updateSaveBadge('dirty');
    if (state.saveTimer) window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
      void persistNow();
    }, 450);
  }

  function updateRawMarkdownFromMetaPatch(patch: Partial<{ title: string; status: string; date: string }>): void {
    const parsed = parseDocument(state.rawMarkdown);
    let nextBody = parsed.body;
    if (patch.title !== undefined && state.bodyHadLeadingH1) {
      const split = splitLeadingH1(parsed.body);
      if (split.hasLeadingH1) {
        const cleanTitle = patch.title.trim() || 'Untitled Draft';
        nextBody = split.restBody ? `# ${cleanTitle}\n\n${split.restBody}` : `# ${cleanTitle}\n`;
      }
    }
    const nextDoc = {
      hasFrontmatter: true,
      statusKey: parsed.statusKey,
      meta: {
        ...parsed.meta,
        ...patch
      },
      extraLines: parsed.extraLines,
      body: nextBody
    };
    state.rawMarkdown = serializeDocument(nextDoc);
    if (state.viewMode === 'raw') {
      rawTextarea.value = state.rawMarkdown;
    } else if (state.viewMode === 'preview') {
      void renderReadPreview();
    }
    updateStatsAndMetaUI();
    scheduleAutoSave();
  }

  async function renderReadPreview(): Promise<void> {
    const parsed = parseDocument(state.rawMarkdown);
    const stats = computeStats(parsed.body);
    const status = parsed.meta.status || 'idea';
    const siteMode = isBlogSiteThemeActive();

    previewMetaRow.hidden = siteMode;
    previewMetaBadge.className = 'badge';
    if (status === 'published') previewMetaBadge.classList.add('badge-positive');
    else if (status === 'review' || status === 'unlisted') previewMetaBadge.classList.add('badge-warning');
    else previewMetaBadge.classList.add('badge-info');
    previewMetaBadge.textContent = status;
    previewMetaDate.textContent = parsed.meta.date || '';
    previewMetaRead.textContent = `${stats.words} words · ${stats.readingMinutes} min read`;

    const renderedHtml = await marked.parse(parsed.body, { gfm: true, breaks: false });
    const sanitizedHtml = DOMPurify.sanitize(String(renderedHtml), {
      USE_PROFILES: { html: true }
    });

    const parsedDoc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
    for (const img of parsedDoc.body.querySelectorAll('img')) {
      const rawSrc = img.getAttribute('src') || '';
      const resolved = bridge.resolveAssetUrl(state.activeProject, rawSrc);
      if (resolved) {
        img.setAttribute('src', resolved);
        if (bridge.mode === 'sidecar' && bridge.loadAssetDataUrl && isLocalAssetSrc(rawSrc)) {
          void bridge.loadAssetDataUrl(state.activeProject, rawSrc).then((dataUrl) => {
            if (dataUrl) img.setAttribute('src', dataUrl);
          });
        }
      } else {
        img.removeAttribute('src');
      }
    }
    for (const anchor of parsedDoc.body.querySelectorAll('a')) {
      const href = anchor.getAttribute('href') || '';
      if (!isSafeLinkHref(href)) {
        anchor.removeAttribute('href');
      } else {
        anchor.setAttribute('rel', 'noopener noreferrer');
        if (/^https?:/i.test(href)) {
          anchor.setAttribute('target', '_blank');
        }
      }
    }

    const firstChild = parsedDoc.body.firstElementChild;
    const bodyStartsWithSameHeading =
      firstChild?.tagName === 'H1' &&
      parsed.meta.title &&
      firstChild.textContent?.trim().toLowerCase() === parsed.meta.title.trim().toLowerCase();

    if (parsed.meta.title && !bodyStartsWithSameHeading) {
      previewHeroTitle.textContent = parsed.meta.title;
      previewHeroTitle.hidden = false;
    } else {
      previewHeroTitle.textContent = '';
      previewHeroTitle.hidden = true;
    }

    previewHeader.hidden = previewMetaRow.hidden && previewHeroTitle.hidden;

    const nodes: Node[] = Array.from(parsedDoc.body.childNodes);

    // Replicate tomgreenaway.com blog chrome in Blog Theme Read Preview:
    // article tags & YouTube preview below H1, and `.blog-date` footer at the bottom.
    if (siteMode) {
      const { topNodes, footerNode } = buildBlogMetaNodes(parsed);

      if (topNodes.length > 0) {
        const h1Idx = nodes.findIndex(
          (n) => n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'H1'
        );
        if (h1Idx >= 0) {
          nodes.splice(h1Idx + 1, 0, ...topNodes);
        } else {
          nodes.unshift(...topNodes);
        }
      }

      if (footerNode) {
        nodes.push(footerNode);
      }
    }

    previewBodyEl.replaceChildren(...nodes);
  }

  function autoResizeRawTextarea(keepCaretComfortable = false): void {
    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    const prevPaneHeight = rawPane.offsetHeight;

    // Prevent the document from collapsing while measuring scrollHeight (which otherwise clamps window.scrollY
    // and forces the browser to pin the caret at the bottom edge of the viewport on every keystroke).
    if (prevPaneHeight > 0) {
      rawPane.style.minHeight = `${prevPaneHeight}px`;
    }
    rawTextarea.style.height = 'auto';
    const bottomPadding = Math.max(160, Math.round(window.innerHeight * 0.3));
    const nextHeight = Math.max(520, rawTextarea.scrollHeight + bottomPadding);
    rawTextarea.style.height = `${nextHeight}px`;
    rawPane.style.minHeight = '';

    if (window.scrollX !== prevScrollX || window.scrollY !== prevScrollY) {
      window.scrollTo({ left: prevScrollX, top: prevScrollY, behavior: 'instant' as ScrollBehavior });
    }

    if (keepCaretComfortable && document.activeElement === rawTextarea && state.viewMode === 'raw') {
      const caret = rawTextarea.selectionEnd ?? rawTextarea.selectionStart ?? 0;
      const caretOffsetTop = measureTextareaCaretOffsetTop(rawTextarea, caret);
      const caretViewportY = rawTextarea.getBoundingClientRect().top + caretOffsetTop;
      const linePx = parseFloat(window.getComputedStyle(rawTextarea).lineHeight) || state.rawFontSize * 1.72;
      const bottomMargin = Math.max(96, Math.round(linePx * 3));
      const topMargin = 64;

      if (caretViewportY + linePx > window.innerHeight - bottomMargin) {
        const delta = caretViewportY + linePx - (window.innerHeight - bottomMargin);
        window.scrollTo({ left: prevScrollX, top: Math.max(0, window.scrollY + delta), behavior: 'instant' as ScrollBehavior });
      } else if (caretViewportY < topMargin) {
        const delta = caretViewportY - topMargin;
        window.scrollTo({ left: prevScrollX, top: Math.max(0, window.scrollY + delta), behavior: 'instant' as ScrollBehavior });
      }
    }
  }

  // --- Medium Floating Bubble Menu & Gutter + Menu Logic ---
  function hideBubbleMenu(): void {
    state.linkEditOpen = false;
    bubbleMenuEl.hidden = true;
  }

  function openBubbleLinkEditor(): void {
    if (!editor) return;
    state.linkEditOpen = true;
    bubbleStandardGroup.hidden = true;
    bubbleLinkGroup.hidden = false;
    bubbleLinkInput.value = String(editor.getAttributes('link').href || '');
    bubbleMenuEl.hidden = false;
    window.setTimeout(() => {
      bubbleLinkInput.focus();
      bubbleLinkInput.select();
    }, 0);
  }

  function closeBubbleLinkEditor(): void {
    state.linkEditOpen = false;
    bubbleStandardGroup.hidden = false;
    bubbleLinkGroup.hidden = true;
    updateMediumOverlays();
  }

  function updateMediumOverlays(): void {
    if (!editor || state.viewMode !== 'visual') {
      hideBubbleMenu();
      plusMenuEl.hidden = true;
      return;
    }

    const { selection } = editor.state;

    // 1. Floating Selection Bubble Menu
    if (!selection.empty && (editor.isFocused || state.linkEditOpen)) {
      const selectedText = editor.state.doc.textBetween(selection.from, selection.to, ' ').trim();
      if (selectedText.length > 0 || state.linkEditOpen) {
        const startCoords = editor.view.coordsAtPos(selection.from);
        const endCoords = editor.view.coordsAtPos(selection.to);
        bubbleStandardGroup.hidden = state.linkEditOpen;
        bubbleLinkGroup.hidden = !state.linkEditOpen;
        bubbleMenuEl.hidden = false;

        const halfW = Math.min((bubbleMenuEl.offsetWidth || 320) / 2, window.innerWidth / 2 - 8);
        const centerX = Math.max(
          halfW + 8,
          Math.min(window.innerWidth - halfW - 8, (startCoords.left + endCoords.right) / 2)
        );
        const topY = Math.max(62, Math.min(startCoords.top, endCoords.top) - 10);

        bubbleMenuEl.style.left = `${centerX}px`;
        bubbleMenuEl.style.top = `${topY}px`;

        for (const btn of bubbleStandardGroup.querySelectorAll<HTMLButtonElement>('[data-mark-check]')) {
          const check = btn.getAttribute('data-mark-check');
          if (check === 'h2') btn.classList.toggle('is-active', editor.isActive('heading', { level: 2 }));
          else if (check === 'h3') btn.classList.toggle('is-active', editor.isActive('heading', { level: 3 }));
          else if (check) btn.classList.toggle('is-active', editor.isActive(check));
        }
      } else {
        hideBubbleMenu();
      }
    } else if (!state.linkEditOpen) {
      hideBubbleMenu();
    }

    // 2. Empty-Line + Gutter Menu
    const { $from } = selection;
    const isEmptyParagraph =
      editor.isFocused &&
      selection.empty &&
      $from.parent.type.name === 'paragraph' &&
      $from.parent.content.size === 0;

    if (isEmptyParagraph) {
      const coords = editor.view.coordsAtPos(selection.from);
      const stageRect = visualPane.getBoundingClientRect();
      const triggerSize = 26;
      const gap = 10;
      const cursorRelLeft = coords.left - stageRect.left;
      const lineMidY = (coords.top + coords.bottom) / 2;

      // Keep the blinking text cursor 100% unobstructed: sit cleanly to the left of the caret
      // whenever there's room in the gutter, or tuck neatly to its right on ultra-narrow panes.
      const leftPos =
        coords.left >= triggerSize + gap + 4
          ? cursorRelLeft - triggerSize - gap
          : cursorRelLeft + 14;

      plusMenuEl.style.top = `${Math.max(0, lineMidY - stageRect.top - triggerSize / 2)}px`;
      plusMenuEl.style.left = `${Math.round(leftPos)}px`;
      plusMenuEl.hidden = false;
    } else {
      state.plusMenuOpen = false;
      plusPaletteEl.hidden = true;
      plusTriggerBtn.setAttribute('aria-expanded', 'false');
      plusMenuEl.hidden = true;
    }
  }

  function buildMediumBubbleToolbar(): void {
    const items: Array<{
      label: string;
      title: string;
      check?: string;
      onClick: () => void;
    }> = [
      { label: 'B', title: 'Bold (⌘B)', check: 'bold', onClick: () => editor?.chain().focus().toggleBold().run() },
      { label: 'I', title: 'Italic (⌘I)', check: 'italic', onClick: () => editor?.chain().focus().toggleItalic().run() },
      { label: 'S', title: 'Strikethrough', check: 'strike', onClick: () => editor?.chain().focus().toggleStrike().run() },
      { label: '</>', title: 'Inline Code (⌘E)', check: 'code', onClick: () => editor?.chain().focus().toggleCode().run() },
      { label: 'H2', title: 'Heading 2', check: 'h2', onClick: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
      { label: 'H3', title: 'Heading 3', check: 'h3', onClick: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
      { label: '“', title: 'Blockquote', check: 'blockquote', onClick: () => editor?.chain().focus().toggleBlockquote().run() },
      { label: 'Link', title: 'Add or edit link (⌘K)', check: 'link', onClick: () => openBubbleLinkEditor() }
    ];

    const buttons = items.map((item) => {
      const btn = el(
        'button',
        {
          type: 'button',
          className: 'bubble-btn',
          title: item.title,
          'data-mark-check': item.check || ''
        },
        item.label
      ) as HTMLButtonElement;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        item.onClick();
        updateMediumOverlays();
      });
      return btn;
    });

    const bubbleAskBtn = el(
      'button',
      { type: 'button', className: 'bubble-btn', title: 'Ask agent about highlighted text' },
      'Ask Agent'
    ) as HTMLButtonElement;
    bubbleAskBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openAskAgentModal();
    });

    bubbleStandardGroup.replaceChildren(...buttons, el('span', { className: 'bubble-sep' }), bubbleAskBtn);

    const applyLinkBtn = el('button', { type: 'button', className: 'btn btn-primary btn-sm' }, 'Apply') as HTMLButtonElement;
    const unlinkBtn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' }, 'Unlink') as HTMLButtonElement;
    const cancelLinkBtn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' }, 'Cancel') as HTMLButtonElement;

    function applyLinkFromInput(): void {
      if (!editor) return;
      const href = bubbleLinkInput.value.trim();
      if (!href) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
      } else if (isSafeLinkHref(href)) {
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      } else {
        showToast('Only http://, https://, mailto:, or relative URLs are permitted.');
        return;
      }
      closeBubbleLinkEditor();
      editor.commands.focus();
    }

    applyLinkBtn.addEventListener('click', applyLinkFromInput);
    unlinkBtn.addEventListener('click', () => {
      editor?.chain().focus().extendMarkRange('link').unsetLink().run();
      closeBubbleLinkEditor();
      editor?.commands.focus();
    });
    cancelLinkBtn.addEventListener('click', () => {
      closeBubbleLinkEditor();
      editor?.commands.focus();
    });
    bubbleLinkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyLinkFromInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeBubbleLinkEditor();
        editor?.commands.focus();
      }
    });

    bubbleLinkGroup.replaceChildren(bubbleLinkInput, applyLinkBtn, unlinkBtn, cancelLinkBtn);
  }

  function buildMediumPlusMenu(): void {
    const blocks: Array<{ label: string; run: () => void }> = [
      { label: 'H2', run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
      { label: 'H3', run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
      { label: 'List', run: () => editor?.chain().focus().toggleBulletList().run() },
      { label: '1. List', run: () => editor?.chain().focus().toggleOrderedList().run() },
      { label: 'Quote', run: () => editor?.chain().focus().toggleBlockquote().run() },
      { label: 'Code', run: () => editor?.chain().focus().toggleCodeBlock().run() },
      { label: 'Divider', run: () => editor?.chain().focus().setHorizontalRule().run() },
      { label: 'Image', run: () => openImageModal() }
    ];

    const paletteButtons = blocks.map((blk) => {
      const btn = el('button', { type: 'button', className: 'bubble-btn' }, blk.label) as HTMLButtonElement;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        state.plusMenuOpen = false;
        plusPaletteEl.hidden = true;
        plusTriggerBtn.setAttribute('aria-expanded', 'false');
        blk.run();
        updateMediumOverlays();
      });
      return btn;
    });

    plusPaletteEl.replaceChildren(...paletteButtons);

    plusTriggerBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      state.plusMenuOpen = !state.plusMenuOpen;
      plusPaletteEl.hidden = !state.plusMenuOpen;
      plusTriggerBtn.setAttribute('aria-expanded', String(state.plusMenuOpen));
    });
  }

  // --- Initialize Tiptap v3 Editor ---
  function initTiptapEditor(): void {
    const MarkdownImage = Image.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          src: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-raw-src') || element.getAttribute('src')
          }
        };
      },
      renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, string> }) {
        const rawSrc = HTMLAttributes.src || '';
        const resolved = bridge.resolveAssetUrl(state.activeProject, rawSrc);
        if (bridge.mode === 'sidecar' && bridge.loadAssetDataUrl && isLocalAssetSrc(rawSrc)) {
          void bridge.loadAssetDataUrl(state.activeProject, rawSrc).then((dataUrl) => {
            if (!dataUrl) return;
            for (const imgEl of tiptapHostEl.querySelectorAll<HTMLImageElement>('img')) {
              if (imgEl.getAttribute('data-raw-src') === rawSrc) {
                imgEl.setAttribute('src', dataUrl);
              }
            }
          });
        }
        return [
          'img',
          mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
            src: resolved,
            'data-raw-src': rawSrc
          })
        ];
      }
    });

    const MediumLinkShortcut = Extension.create({
      name: 'mediumLinkShortcut',
      addKeyboardShortcuts() {
        return {
          'Mod-k': () => {
            openBubbleLinkEditor();
            return true;
          }
        };
      }
    });

    const AutoCorrectExtension = Extension.create({
      name: 'spellAutoCorrect',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: spellDecoKey,
            state: {
              init: (_, { doc }) => buildSpellDecorations(doc),
              apply: (tr, oldSet, _, newState) => {
                if (tr.getMeta(spellDecoKey) || tr.docChanged) {
                  return buildSpellDecorations(newState.doc);
                }
                return oldSet;
              }
            },
            props: {
              decorations(editorState) {
                return spellDecoKey.getState(editorState);
              },
              handleTextInput(view, from, to, text) {
                if (state.spellLang === 'off' || from !== to || text.length !== 1 || !isWordBoundaryChar(text)) {
                  return false;
                }
                const $from = view.state.doc.resolve(from);
                if ($from.parent.type.name === 'codeBlock') return false;
                const marks = $from.marks();
                if (marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return false;

                const blockTextBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
                const found = extractWordBeforeCaret(blockTextBefore, blockTextBefore.length);
                if (!found) return false;

                const replacement = lookupAutoCorrect(found.word, state.spellLang);
                if (!replacement) return false;

                const replaceFrom = from - found.word.length;
                const tr = view.state.tr.insertText(`${replacement}${text}`, replaceFrom, to);
                view.dispatch(tr);
                return true;
              },
              handleKeyDown(view, event) {
                if (state.spellLang === 'off' || event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) {
                  return false;
                }
                const { from, to, empty } = view.state.selection;
                if (!empty) return false;
                const $from = view.state.doc.resolve(from);
                if ($from.parent.type.name === 'codeBlock') return false;
                const marks = $from.marks();
                if (marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return false;

                const blockTextBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
                const found = extractWordBeforeCaret(blockTextBefore, blockTextBefore.length);
                if (!found) return false;

                const replacement = lookupAutoCorrect(found.word, state.spellLang);
                if (!replacement) return false;

                const replaceFrom = from - found.word.length;
                view.dispatch(view.state.tr.insertText(replacement, replaceFrom, to));
                return false;
              }
            }
          })
        ];
      }
    });

    editor = new Editor({
      element: tiptapHostEl,
      extensions: [
        StarterKit.configure({
          link: {
            openOnClick: false,
            autolink: true,
            linkOnPaste: true,
            HTMLAttributes: {
              rel: 'noopener noreferrer'
            }
          }
        }),
        Markdown.configure({
          markedOptions: {
            gfm: true,
            breaks: false
          },
          indentation: {
            style: 'space',
            size: 2
          }
        }),
        MarkdownImage.configure({
          inline: false,
          allowBase64: true
        }),
        Placeholder.configure({
          placeholder: 'Tell your story, or click + on an empty line…'
        }),
        Typography,
        MediumLinkShortcut,
        AutoCorrectExtension
      ],
      content: '',
      onUpdate: () => {
        if (state.isSyncingEditor || !editor) return;
        const parsed = parseDocument(state.rawMarkdown);
        let bodyMarkdown = editor.getMarkdown();
        if (isBlogSiteThemeActive() && state.bodyHadLeadingH1) {
          const heading = titleInput.value.trim() || parsed.meta.title || 'Untitled Draft';
          const trimmed = bodyMarkdown.replace(/^\n+/, '');
          bodyMarkdown = trimmed ? `# ${heading}\n\n${trimmed}` : `# ${heading}\n`;
        }
        state.rawMarkdown = serializeDocument({
          hasFrontmatter: parsed.hasFrontmatter,
          statusKey: parsed.statusKey,
          meta: parsed.meta,
          extraLines: parsed.extraLines,
          body: bodyMarkdown
        });
        updateStatsAndMetaUI();
        scheduleAutoSave();
        scheduleSpellCheck(false);
      },
      onSelectionUpdate: () => updateMediumOverlays(),
      onFocus: () => updateMediumOverlays(),
      onBlur: () => {
        window.setTimeout(() => {
          if (!state.linkEditOpen && !bubbleMenuEl.contains(document.activeElement)) {
            updateMediumOverlays();
          }
        }, 80);
      }
    });
  }

  // --- Cross-View Cursor & Focus Synchronization ---
  interface ViewFocusAnchor {
    snippet: string;
    charInBlock: number;
    scrollRatio: number;
    viewportOffsetY: number;
  }

  function normalizeAnchorText(text: string): string {
    return String(text || '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/, '')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getScrollRatio(): number {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    return Math.min(1, Math.max(0, window.scrollY / maxScroll));
  }

  function findFirstVisibleBlock(container: HTMLElement): { el: HTMLElement; text: string; top: number } | null {
    const blocks = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, li, blockquote, pre');
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (rect.height === 0) continue;
      if (rect.bottom > 44 && rect.top < window.innerHeight) {
        const text = normalizeAnchorText(block.textContent || '');
        if (text.length > 0) {
          return { el: block, text, top: rect.top };
        }
      }
    }
    return null;
  }

  function measureTextareaCaretOffsetTop(textarea: HTMLTextAreaElement, charIndex: number): number {
    const cs = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    mirror.style.position = 'fixed';
    mirror.style.top = '-99999px';
    mirror.style.left = '-99999px';
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.boxSizing = cs.boxSizing;
    mirror.style.width = `${textarea.clientWidth || textarea.getBoundingClientRect().width}px`;
    mirror.style.fontFamily = cs.fontFamily;
    mirror.style.fontSize = cs.fontSize;
    mirror.style.fontWeight = cs.fontWeight;
    mirror.style.fontStyle = cs.fontStyle;
    mirror.style.lineHeight = cs.lineHeight;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.tabSize = cs.tabSize;
    mirror.style.paddingTop = cs.paddingTop;
    mirror.style.paddingRight = cs.paddingRight;
    mirror.style.paddingBottom = cs.paddingBottom;
    mirror.style.paddingLeft = cs.paddingLeft;
    mirror.style.borderWidth = '0';

    const clamped = Math.max(0, Math.min(charIndex, textarea.value.length));
    mirror.textContent = textarea.value.slice(0, clamped);
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const offsetTop = marker.offsetTop;
    document.body.removeChild(mirror);
    return offsetTop;
  }

  function captureViewFocusAnchor(fromMode: ViewMode): ViewFocusAnchor {
    const scrollRatio = getScrollRatio();
    const defaultOffsetY = Math.min(140, Math.round(window.innerHeight * 0.22));

    if (fromMode === 'visual' && editor) {
      const { selection } = editor.state;
      const $from = selection.$from;
      const parentText = $from.parent.textContent || '';
      const normalizedParent = normalizeAnchorText(parentText);
      if (normalizedParent.length > 0) {
        try {
          const coords = editor.view.coordsAtPos(selection.from);
          const inViewport = coords.top >= 0 && coords.top <= window.innerHeight;
          if (inViewport || editor.isFocused) {
            return {
              snippet: normalizedParent.slice(0, 96),
              charInBlock: $from.parentOffset,
              scrollRatio,
              viewportOffsetY: inViewport ? Math.max(48, Math.min(window.innerHeight - 80, coords.top)) : defaultOffsetY
            };
          }
        } catch {
          // Fall through to visible block detection.
        }
      }
      const visible = findFirstVisibleBlock(tiptapHostEl);
      if (visible) {
        return {
          snippet: visible.text.slice(0, 96),
          charInBlock: 0,
          scrollRatio,
          viewportOffsetY: Math.max(48, Math.min(window.innerHeight - 80, visible.top))
        };
      }
    }

    if (fromMode === 'raw') {
      const val = rawTextarea.value || '';
      const caret = rawTextarea.selectionStart ?? 0;
      const lines = val.split('\n');
      let pos = 0;
      let caretLineIdx = 0;
      let charInLine = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const len = lines[i].length;
        if (caret <= pos + len) {
          caretLineIdx = i;
          charInLine = caret - pos;
          break;
        }
        pos += len + 1;
      }

      // Measure exact rendered Y of the caret (accounting for word-wrapped Markdown paragraphs)
      const textareaTop = rawTextarea.getBoundingClientRect().top;
      const caretOffsetTop = measureTextareaCaretOffsetTop(rawTextarea, caret);
      const caretScreenY = textareaTop + caretOffsetTop;
      const viewportOffsetY =
        caretScreenY >= 40 && caretScreenY <= window.innerHeight - 40 ? caretScreenY : defaultOffsetY;

      // Find nearest non-empty content line (skipping frontmatter delimiters)
      let bestSnippet = '';
      for (let delta = 0; delta <= 6 && !bestSnippet; delta += 1) {
        const candidates = delta === 0 ? [caretLineIdx] : [caretLineIdx + delta, caretLineIdx - delta];
        for (const idx of candidates) {
          if (idx < 0 || idx >= lines.length) continue;
          const line = lines[idx].trim();
          if (!line || line === '---' || line.startsWith('```')) continue;
          const norm = normalizeAnchorText(line);
          if (norm.length > 0) {
            bestSnippet = norm.slice(0, 96);
            if (delta !== 0) charInLine = 0;
            break;
          }
        }
      }

      if (bestSnippet) {
        return {
          snippet: bestSnippet,
          charInBlock: Math.max(0, charInLine),
          scrollRatio,
          viewportOffsetY
        };
      }
    }

    if (fromMode === 'preview') {
      const domSel = window.getSelection();
      if (domSel && domSel.anchorNode && previewBodyEl.contains(domSel.anchorNode)) {
        const anchorEl =
          domSel.anchorNode.nodeType === Node.ELEMENT_NODE
            ? (domSel.anchorNode as HTMLElement)
            : domSel.anchorNode.parentElement;
        const blockEl = anchorEl?.closest<HTMLElement>('h1, h2, h3, h4, p, li, blockquote, pre');
        if (blockEl) {
          const text = normalizeAnchorText(blockEl.textContent || '');
          if (text.length > 0) {
            const rect = blockEl.getBoundingClientRect();
            return {
              snippet: text.slice(0, 96),
              charInBlock: domSel.anchorOffset || 0,
              scrollRatio,
              viewportOffsetY: Math.max(48, Math.min(window.innerHeight - 80, rect.top))
            };
          }
        }
      }
      const visible = findFirstVisibleBlock(previewBodyEl);
      if (visible) {
        return {
          snippet: visible.text.slice(0, 96),
          charInBlock: 0,
          scrollRatio,
          viewportOffsetY: Math.max(48, Math.min(window.innerHeight - 80, visible.top))
        };
      }
    }

    return { snippet: '', charInBlock: 0, scrollRatio, viewportOffsetY: defaultOffsetY };
  }

  function scoreAnchorMatch(candidateNorm: string, targetSnippet: string): number {
    if (!candidateNorm || !targetSnippet) return 0;
    if (candidateNorm === targetSnippet) return 100;
    if (candidateNorm.includes(targetSnippet) || targetSnippet.includes(candidateNorm)) {
      return 85;
    }
    const shortTarget = targetSnippet.slice(0, 36);
    if (shortTarget.length >= 6 && candidateNorm.includes(shortTarget)) {
      return 70;
    }
    const shortCand = candidateNorm.slice(0, 36);
    if (shortCand.length >= 6 && targetSnippet.includes(shortCand)) {
      return 60;
    }
    return 0;
  }

  function restoreViewFocusAnchor(targetMode: ViewMode, anchor: ViewFocusAnchor): void {
    const applyFallbackScroll = () => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.round(anchor.scrollRatio * maxScroll), behavior: 'instant' as ScrollBehavior });
    };

    if (targetMode === 'visual' && editor) {
      let bestPos = -1;
      let bestNodeSize = 0;
      let bestScore = 0;

      if (anchor.snippet) {
        editor.state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          const norm = normalizeAnchorText(node.textContent || '');
          const score = scoreAnchorMatch(norm, anchor.snippet);
          if (score > bestScore) {
            bestScore = score;
            bestPos = pos;
            bestNodeSize = node.nodeSize;
            if (score === 100) return false;
          }
          return true;
        });
      }

      if (bestPos >= 0) {
        const innerOffset = Math.min(Math.max(0, anchor.charInBlock), Math.max(0, bestNodeSize - 2));
        const targetPos = Math.min(bestPos + 1 + innerOffset, bestPos + bestNodeSize - 1);
        editor.chain().focus(targetPos, { scrollIntoView: false }).run();
        try {
          const coords = editor.view.coordsAtPos(targetPos);
          const targetScrollY = Math.max(0, window.scrollY + coords.top - anchor.viewportOffsetY);
          window.scrollTo({ top: targetScrollY, behavior: 'instant' as ScrollBehavior });
        } catch {
          applyFallbackScroll();
        }
        updateMediumOverlays();
        return;
      }

      applyFallbackScroll();
      editor.commands.focus(undefined, { scrollIntoView: false });
      return;
    }

    if (targetMode === 'raw') {
      const val = rawTextarea.value || '';
      const lines = val.split('\n');
      let inFrontmatter = lines[0]?.trim() === '---';
      let bestLineIdx = -1;
      let bestScore = 0;

      if (anchor.snippet) {
        for (let i = 0; i < lines.length; i += 1) {
          const trimmed = lines[i].trim();
          if (i > 0 && inFrontmatter) {
            if (trimmed === '---') inFrontmatter = false;
            continue;
          }
          if (!trimmed || trimmed === '---' || trimmed.startsWith('```')) continue;
          const norm = normalizeAnchorText(trimmed);
          const score = scoreAnchorMatch(norm, anchor.snippet);
          if (score > bestScore) {
            bestScore = score;
            bestLineIdx = i;
            if (score === 100) break;
          }
        }
      }

      if (bestLineIdx >= 0) {
        let charPos = 0;
        for (let i = 0; i < bestLineIdx; i += 1) {
          charPos += lines[i].length + 1;
        }
        const lineOffset = Math.min(Math.max(0, anchor.charInBlock), lines[bestLineIdx].length);
        const targetCaret = charPos + lineOffset;
        const caretOffsetTop = measureTextareaCaretOffsetTop(rawTextarea, targetCaret);
        const textareaDocTop = rawTextarea.getBoundingClientRect().top + window.scrollY;
        const targetScrollY = Math.max(0, textareaDocTop + caretOffsetTop - anchor.viewportOffsetY);

        rawTextarea.focus({ preventScroll: true });
        rawTextarea.setSelectionRange(targetCaret, targetCaret);
        window.scrollTo({ top: targetScrollY, behavior: 'instant' as ScrollBehavior });
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: targetScrollY, behavior: 'instant' as ScrollBehavior });
        });
        return;
      }

      rawTextarea.focus({ preventScroll: true });
      applyFallbackScroll();
      return;
    }

    if (targetMode === 'preview') {
      if (anchor.snippet) {
        const blocks = previewBodyEl.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, li, blockquote, pre');
        let bestEl: HTMLElement | null = null;
        let bestScore = 0;
        for (const block of blocks) {
          const norm = normalizeAnchorText(block.textContent || '');
          const score = scoreAnchorMatch(norm, anchor.snippet);
          if (score > bestScore) {
            bestScore = score;
            bestEl = block;
            if (score === 100) break;
          }
        }
        if (bestEl) {
          const rect = bestEl.getBoundingClientRect();
          const targetScrollY = Math.max(0, window.scrollY + rect.top - anchor.viewportOffsetY);
          window.scrollTo({ top: targetScrollY, behavior: 'instant' as ScrollBehavior });
          return;
        }
      }
      applyFallbackScroll();
    }
  }

  // --- View Mode Switching (Lossless Sync) ---
  async function setViewMode(nextMode: ViewMode): Promise<void> {
    if (state.viewMode === nextMode) return;
    const prevMode = state.viewMode;
    const focusAnchor = captureViewFocusAnchor(prevMode);
    state.viewMode = nextMode;

    for (const [mode, btn] of tabButtons.entries()) {
      btn.setAttribute('aria-selected', String(mode === nextMode));
    }

    titleWrap.hidden = nextMode !== 'visual';
    visualPane.hidden = nextMode !== 'visual';
    rawPane.hidden = nextMode !== 'raw';
    previewPane.hidden = nextMode !== 'preview';
    handleModeEl.textContent = nextMode === 'visual' ? 'Visual' : nextMode === 'raw' ? 'Markdown' : 'Preview';
    syncSiteThemeOnSheet();

    if (nextMode === 'visual' && editor) {
      syncEditorContentFromRaw();
      updateStatsAndMetaUI();
      updateMediumOverlays();
      scheduleSpellCheck(true);
    } else if (nextMode === 'raw') {
      hideBubbleMenu();
      plusMenuEl.hidden = true;
      rawTextarea.value = state.rawMarkdown;
      autoResizeRawTextarea();
    } else if (nextMode === 'preview') {
      hideBubbleMenu();
      plusMenuEl.hidden = true;
      await renderReadPreview();
    }

    window.requestAnimationFrame(() => {
      restoreViewFocusAnchor(nextMode, focusAnchor);
    });
  }

  for (const [mode, btn] of tabButtons.entries()) {
    btn.addEventListener('click', () => {
      void setViewMode(mode);
    });
  }

  // --- Hydrate Project & Post State ---
  function formatProjectOptionLabel(projectId: string): string {
    if (projectId === ALL_PROJECTS) {
      return state.selectedFilter === ALL_PROJECTS
        ? `All Articles (${state.posts.length})`
        : 'All Articles';
    }
    if (projectId === ROOT_PROJECT) {
      return 'Standalone (blog/)';
    }
    return projectId;
  }

  function renderSelectors(): void {
    projectSelect.setOptions(
      state.projects.map((p) => ({
        value: p,
        label: formatProjectOptionLabel(p)
      })),
      state.selectedFilter
    );
    const activePostKey = `${state.activeProject}::${state.activeSlug}`;
    postSelect.setOptions(
      state.posts.map((post) => {
        const subParts: string[] = [];
        if (state.selectedFilter === ALL_PROJECTS) {
          subParts.push(post.project === ROOT_PROJECT ? 'blog/' : post.project);
        }
        if (post.date) {
          subParts.push(post.date);
        }
        return {
          value: `${post.project}::${post.slug}`,
          label: post.filename,
          triggerLabel: post.filename,
          subtitle: subParts.length > 0 ? subParts.join(' · ') : undefined,
          badge: post.status || undefined,
          badgeTone: post.status ? statusTone(post.status) : undefined,
          dotTone: statusTone(post.status || 'idea')
        };
      }),
      activePostKey
    );
  }

  async function applyLoadedPost(post: PostPayload): Promise<void> {
    state.activeProject = post.project;
    state.activeSlug = post.slug;
    state.fullPath = post.fullPath;
    state.lastMtimeMs = post.mtimeMs;
    state.rawMarkdown = post.content;
    state.lastSavedMarkdown = post.content;
    state.dirty = false;
    updateSaveBadge('saved');

    if (editor) {
      syncEditorContentFromRaw();
      scheduleSpellCheck(true);
    }
    rawTextarea.value = state.rawMarkdown;
    if (state.viewMode === 'raw') autoResizeRawTextarea();
    if (state.viewMode === 'preview') await renderReadPreview();

    updateStatsAndMetaUI();
    renderSelectors();
  }

  async function applyInitPayload(payload: StoreInitPayload): Promise<void> {
    state.blogRoot = payload.blogRoot;
    state.selectedFilter = payload.activeProject;
    state.activeProject = payload.currentPost.project;
    state.projects = payload.projects;
    state.posts = payload.posts;
    await applyLoadedPost(payload.currentPost);
  }

  // --- Event Listeners for Controls ---
  titleInput.addEventListener('input', () => {
    const cleaned = titleInput.value.replace(/\r?\n/g, ' ');
    if (cleaned !== titleInput.value) titleInput.value = cleaned;
    autoResizeTitleInput();
    updateRawMarkdownFromMetaPatch({ title: cleaned });
  });

  function tryAutoCorrectTextarea(
    inputEl: HTMLTextAreaElement,
    event: KeyboardEvent,
    checkMarkdownProtected: boolean
  ): void {
    if (state.spellLang === 'off' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
      return;
    }
    const isBoundaryKey = event.key === 'Enter' || (event.key.length === 1 && isWordBoundaryChar(event.key));
    if (!isBoundaryKey) return;

    const start = inputEl.selectionStart;
    const end = inputEl.selectionEnd;
    if (start !== end || start < 2) return;

    const val = inputEl.value;
    if (checkMarkdownProtected && isRawMarkdownProtectedPos(val, start)) {
      return;
    }

    const found = extractWordBeforeCaret(val, start);
    if (!found) return;

    const replacement = lookupAutoCorrect(found.word, state.spellLang);
    if (!replacement) return;

    inputEl.setSelectionRange(found.start, found.end);
    inputEl.setRangeText(replacement, found.start, found.end, 'end');
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  titleInput.addEventListener('keydown', (e) => {
    tryAutoCorrectTextarea(titleInput, e, false);
    if (e.key === 'Enter') {
      e.preventDefault();
      editor?.commands.focus('start');
    }
  });

  dateInput.addEventListener('change', () => {
    updateRawMarkdownFromMetaPatch({ date: dateInput.value });
  });

  rawTextarea.addEventListener('input', () => {
    state.rawMarkdown = rawTextarea.value;
    autoResizeRawTextarea(true);
    updateStatsAndMetaUI();
    scheduleAutoSave();
  });

  rawTextarea.addEventListener('keydown', (e) => {
    tryAutoCorrectTextarea(rawTextarea, e, true);
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = rawTextarea.selectionStart;
      const end = rawTextarea.selectionEnd;
      const val = rawTextarea.value;
      if (e.shiftKey) {
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        if (val.slice(lineStart, lineStart + 2) === '  ') {
          rawTextarea.value = `${val.slice(0, lineStart)}${val.slice(lineStart + 2)}`;
          rawTextarea.selectionStart = Math.max(lineStart, start - 2);
          rawTextarea.selectionEnd = Math.max(lineStart, end - 2);
          rawTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else {
        rawTextarea.value = `${val.slice(0, start)}  ${val.slice(end)}`;
        rawTextarea.selectionStart = rawTextarea.selectionEnd = start + 2;
        rawTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        wrapTextareaSelection(rawTextarea, '**', '**', 'bold text');
      } else if (k === 'i') {
        e.preventDefault();
        wrapTextareaSelection(rawTextarea, '*', '*', 'italic text');
      } else if (k === 'e') {
        e.preventDefault();
        wrapTextareaSelection(rawTextarea, '`', '`', 'code');
      } else if (k === 'k') {
        e.preventDefault();
        wrapTextareaSelection(rawTextarea, '[', '](https://)', 'link text');
      }
    }
  });

  copyPathBtn.addEventListener('click', async () => {
    const val = copyPathBtn.getAttribute('data-copy-value') || '';
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      copyPathBtn.textContent = 'Copied';
      copyPathBtn.classList.add('is-copied');
      window.setTimeout(() => {
        copyPathBtn.textContent = 'Copy';
        copyPathBtn.classList.remove('is-copied');
      }, 1500);
    } catch {
      showToast('Clipboard permission unavailable in this frame.');
    }
  });

  // --- New Draft Modal ---
  newDraftBtn.addEventListener('click', () => {
    newDraftTitleInput.value = '';
    newDraftSlugInput.value = '';
    newDraftStatusSelect.setValue('idea');
    const destLabel =
      state.selectedFilter === ALL_PROJECTS || state.selectedFilter === ROOT_PROJECT
        ? 'blog/ (standalone article)'
        : `blog/${state.selectedFilter}/`;
    newDraftSubtitleEl.textContent = `Scaffolds a new Markdown post with YAML frontmatter inside ${destLabel}.`;
    newDraftModal.hidden = false;
    newDraftTitleInput.focus();
  });

  newDraftCancelBtn.addEventListener('click', () => {
    closeAllCustomSelects(newDraftModal);
    newDraftModal.hidden = true;
  });

  newDraftCreateBtn.addEventListener('click', async () => {
    const title = newDraftTitleInput.value.trim();
    if (!title) {
      showToast('Please enter a draft title.');
      return;
    }
    try {
      if (state.dirty) await persistNow();
      const targetProject =
        state.selectedFilter === ALL_PROJECTS ? ROOT_PROJECT : state.selectedFilter;
      const created = await bridge.createPost(targetProject, {
        title,
        slug: newDraftSlugInput.value.trim() || undefined,
        status: newDraftStatusSelect.getValue()
      });
      const refreshed = await bridge.init({
        preferredProject: state.selectedFilter,
        preferredSlug: created.slug,
        preferredPostProject: created.project
      });
      await applyInitPayload(refreshed);
      newDraftModal.hidden = true;
      showToast(`Created ${created.filename}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create draft.');
    }
  });

  // --- Image Drag-and-Drop Modal + Direct Canvas Drop ---
  async function stageImageFile(file: File): Promise<void> {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowed.has(file.type)) {
      showToast('Unsupported file type. Use PNG, JPEG, WebP, or GIF.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast('Image exceeds 10 MB limit.');
      return;
    }
    const base64Data = await readFileAsBase64(file);
    state.pendingUpload = {
      filename: file.name,
      base64Data,
      mimeType: file.type,
      bytes: file.size
    };
    uploadResultRow.replaceChildren(
      el('span', { textContent: `${file.name} (${formatBytes(file.size)})` }),
      el('span', { className: 'badge badge-positive', textContent: 'Ready' })
    );
    uploadResultRow.hidden = false;
    uploadInsertBtn.disabled = false;
  }

  function openImageModal(): void {
    state.pendingUpload = null;
    fileInput.value = '';
    uploadAltInput.value = '';
    uploadResultRow.hidden = true;
    uploadInsertBtn.disabled = true;
    imageModal.hidden = false;
  }

  async function uploadAndInsertAsset(
    upload: { filename: string; base64Data: string; mimeType: string },
    altText: string
  ): Promise<void> {
    const uploaded = await bridge.uploadAsset(state.activeProject, upload);
    const alt = altText.trim() || uploaded.filename.replace(/\.[^.]+$/, '');
    if (state.viewMode === 'visual' && editor) {
      editor.chain().focus().setImage({ src: uploaded.relativeMarkdownPath, alt }).run();
    } else if (state.viewMode === 'raw') {
      wrapTextareaSelection(rawTextarea, `![${alt}](${uploaded.relativeMarkdownPath})`, '', '');
    } else {
      const parsed = parseDocument(state.rawMarkdown);
      state.rawMarkdown = serializeDocument({
        hasFrontmatter: parsed.hasFrontmatter,
        statusKey: parsed.statusKey,
        meta: parsed.meta,
        extraLines: parsed.extraLines,
        body: `${parsed.body.trimEnd()}\n\n![${alt}](${uploaded.relativeMarkdownPath})\n`
      });
      await renderReadPreview();
      scheduleAutoSave();
    }
    showToast(`Saved ${uploaded.relativeMarkdownPath}`);
  }

  addImageBtn.addEventListener('click', openImageModal);
  uploadCancelBtn.addEventListener('click', () => {
    imageModal.hidden = true;
  });

  uploadInsertBtn.addEventListener('click', async () => {
    if (!state.pendingUpload) return;
    uploadInsertBtn.disabled = true;
    try {
      await uploadAndInsertAsset(state.pendingUpload, uploadAltInput.value);
      imageModal.hidden = true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to upload image.');
      uploadInsertBtn.disabled = false;
    }
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneEl.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneEl.classList.remove('is-dragover');
    });
  });
  dropzoneEl.addEventListener('drop', (e) => {
    const dragEvt = e as DragEvent;
    const files = Array.from(dragEvt.dataTransfer?.files || []);
    if (files[0]) void stageImageFile(files[0]);
  });
  dropzoneEl.addEventListener('click', () => fileInput.click());
  dropzoneEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void stageImageFile(file);
  });

  // Allow dragging images straight onto the main writing sheet
  ['dragenter', 'dragover'].forEach((evt) => {
    editorSheetEl.addEventListener(evt, (e) => {
      const dragEvt = e as DragEvent;
      if (dragEvt.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        editorSheetEl.classList.add('is-dragover');
      }
    });
  });
  editorSheetEl.addEventListener('dragleave', () => editorSheetEl.classList.remove('is-dragover'));
  editorSheetEl.addEventListener('drop', (e) => {
    const dragEvt = e as DragEvent;
    editorSheetEl.classList.remove('is-dragover');
    const file = Array.from(dragEvt.dataTransfer?.files || [])[0];
    if (!file || !file.type.startsWith('image/')) return;
    e.preventDefault();
    void readFileAsBase64(file)
      .then((base64Data) =>
        uploadAndInsertAsset(
          { filename: file.name, base64Data, mimeType: file.type },
          file.name.replace(/\.[^.]+$/, '')
        )
      )
      .catch((err) => showToast(err instanceof Error ? err.message : 'Image drop failed.'));
  });

  // --- Ask Agent Modal ---
  let capturedSelectionQuote = '';

  function openAskAgentModal(): void {
    capturedSelectionQuote = '';
    if (state.viewMode === 'visual' && editor && !editor.state.selection.empty) {
      capturedSelectionQuote = editor.state.doc
        .textBetween(editor.state.selection.from, editor.state.selection.to, ' ')
        .trim();
    } else if (state.viewMode === 'raw') {
      const sel = rawTextarea.value.slice(rawTextarea.selectionStart, rawTextarea.selectionEnd).trim();
      capturedSelectionQuote = sel;
    }

    if (capturedSelectionQuote) {
      agentQuoteBox.textContent = capturedSelectionQuote;
      agentQuoteBox.hidden = false;
    } else {
      agentQuoteBox.hidden = true;
    }
    agentInstructionInput.value = '';
    agentModal.hidden = false;
    agentInstructionInput.focus();
  }

  askAgentBtn.addEventListener('click', openAskAgentModal);
  agentCancelBtn.addEventListener('click', () => {
    agentModal.hidden = true;
  });

  agentSendBtn.addEventListener('click', async () => {
    const instruction = agentInstructionInput.value.trim();
    if (!instruction) {
      showToast('Enter an instruction for the agent.');
      return;
    }
    await persistNow();
    const header = `Working on blog draft \`${state.fullPath || `${state.activeProject}/${state.activeSlug}.md`}\`:`;
    const quotePart = capturedSelectionQuote ? `\n\nSelected excerpt:\n> ${capturedSelectionQuote}\n` : '';
    const message = `${header}${quotePart}\n${instruction}`;
    try {
      const res = await bridge.sendToAgent(message);
      agentModal.hidden = true;
      showToast(res.delivered ? 'Sent to agent conversation.' : 'Copied prompt to clipboard.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to message agent.');
    }
  });

  // --- Global Keyboard Shortcuts ---
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (closeAllCustomSelects()) return;
      hideSpellPopover();
      newDraftModal.hidden = true;
      imageModal.hidden = true;
      agentModal.hidden = true;
      if (state.linkEditOpen) closeBubbleLinkEditor();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === '1') {
      e.preventDefault();
      void setViewMode('visual');
    } else if (e.key === '2') {
      e.preventDefault();
      void setViewMode('raw');
    } else if (e.key === '3') {
      e.preventDefault();
      void setViewMode('preview');
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      void persistNow();
    } else if (e.key === '.') {
      e.preventDefault();
      setTopbarOpen(!topbarOpen);
    }
  });

  window.addEventListener('scroll', () => {
    if (state.viewMode === 'visual' && !bubbleMenuEl.hidden) {
      updateMediumOverlays();
    }
  });

  window.addEventListener('resize', () => {
    if (state.viewMode === 'visual' && !titleWrap.hidden) {
      autoResizeTitleInput();
    }
  });
  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      if (state.viewMode === 'visual' && !titleWrap.hidden) {
        autoResizeTitleInput();
      }
    });
  }

  // --- Connect Host Bridge & Hydrate Initial Document ---
  const initConnection = await createHostBridge();
  bridge = initConnection.bridge;

  if (bridge.canToggleFullscreen?.()) {
    expandBtn.hidden = false;
    expandBtn.addEventListener('click', async () => {
      const mode = await bridge.toggleFullscreen?.();
      expandBtn.textContent = mode === 'fullscreen' ? 'Inline' : 'Expand';
    });
  }

  if (bridge.mode === 'sidecar' && bridge.popout) {
    popoutBtn.hidden = false;
    popoutBtn.addEventListener('click', async () => {
      try {
        if (state.dirty) await persistNow();
        await bridge.popout?.(state.activeProject, state.activeSlug, state.showSiteChrome);
        showToast('Opened in Google Chrome.');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to pop out to Chrome.');
      }
    });
  }

  bridge.onHostThemeChange?.((hostTheme) => {
    state.hostTheme = hostTheme;
    if (state.themeMode === 'auto') applyTheme('auto');
  });

  bridge.onExternalData?.((payload) => {
    if (!state.dirty) {
      void applyInitPayload(payload);
    }
  });

  buildMediumBubbleToolbar();
  buildMediumPlusMenu();
  initTiptapEditor();
  applySpellAttributesToDom();

  if (initConnection.initialPayload) {
    await applyInitPayload(initConnection.initialPayload);
  } else {
    const initial = await bridge.init();
    await applyInitPayload(initial);
  }

  // Load personal blog's real CSS theme & fonts dynamically if present next to blogRoot
  void bridge.getSiteTheme().then((themePayload) => {
    installSiteTheme(themePayload);
  });

  // External file change & agent focus-target polling for sidecar / standalone HTTP mode
  if (bridge.mode !== 'mcp') {
    window.setInterval(async () => {
      if (state.dirty || state.saving || !state.activeProject || !state.activeSlug) return;
      try {
        const res = await bridge.getMtime(state.activeProject, state.activeSlug);
        if (res?.focusTarget && res.focusTarget.requestedAt > state.lastHandledFocusAt) {
          state.lastHandledFocusAt = res.focusTarget.requestedAt;
          if (
            res.focusTarget.project !== state.activeProject ||
            res.focusTarget.slug !== state.activeSlug
          ) {
            const refreshed = await bridge.init({
              preferredProject: state.selectedFilter,
              preferredSlug: res.focusTarget.slug,
              preferredPostProject: res.focusTarget.project
            });
            await applyInitPayload(refreshed);
            showToast(`Opened ${res.focusTarget.slug}.md`);
            return;
          }
        }
        if (res && res.mtimeMs > state.lastMtimeMs + 10) {
          const fresh = await bridge.readPost(state.activeProject, state.activeSlug);
          await applyLoadedPost(fresh);
          showToast('Synced external edit from disk.');
        }
      } catch {
        // Ignore transient poll errors.
      }
    }, 2000);
  }
}

void bootstrap();
