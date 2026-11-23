/**
 * Lossless YAML frontmatter + Markdown serialization and reading statistics.
 * Shared across Node backend and browser UI bundle.
 */

const KNOWN_STATUSES = new Set(['idea', 'draft', 'unlisted', 'review', 'published']);
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function formatYamlScalar(value) {
  const str = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  if (str === '') return '""';
  const needsQuotes =
    /^[\s"'#&*!|>%@`{}\[\],?-]/.test(str) ||
    /[:#]/.test(str) ||
    /\s$/.test(str) ||
    /^(true|false|null|yes|no|on|off)$/i.test(str);
  if (needsQuotes) {
    return JSON.stringify(str);
  }
  return str;
}

/**
 * Parse a Markdown file with optional leading YAML frontmatter.
 */
export function parseDocument(rawMarkdown = '') {
  const normalized = String(rawMarkdown ?? '').replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n\n?|$)/);

  const meta = {
    date: todayIsoDate(),
    title: '',
    status: 'idea'
  };
  /** @type {Array<{ key: string, rawLine: string }>} */
  const extraLines = [];

  if (!fmMatch) {
    // Try inferring title from first H1 if present, without forcing frontmatter.
    const h1Match = normalized.match(/^#\s+(.+)$/m);
    if (h1Match) {
      meta.title = h1Match[1].trim();
    }
    return {
      hasFrontmatter: false,
      meta,
      extraLines,
      body: normalized
    };
  }

  const rawHeader = fmMatch[1];
  const body = normalized.slice(fmMatch[0].length);
  const lines = rawHeader.split('\n');

  let hasExplicitStatus = false;
  let statusKey = 'status';

  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      if (line.trim().length > 0) {
        extraLines.push({ key: '', rawLine: line });
      }
      continue;
    }
    const key = kv[1];
    const value = unquoteYamlScalar(kv[2]);
    if (key === 'date') {
      meta.date = value || todayIsoDate();
    } else if (key === 'title') {
      meta.title = value;
    } else if (key === 'status') {
      hasExplicitStatus = true;
      statusKey = 'status';
      meta.status = KNOWN_STATUSES.has(value) ? value : value || 'idea';
    } else if (key === 'state' && !hasExplicitStatus) {
      statusKey = 'state';
      meta.status = KNOWN_STATUSES.has(value) ? value : value || 'idea';
    } else {
      extraLines.push({ key, rawLine: line });
    }
  }

  return {
    hasFrontmatter: true,
    statusKey,
    meta,
    extraLines,
    body
  };
}

/**
 * Extract optional blog-specific metadata (tags, youtubeId) from parsed extraLines.
 */
export function extractFrontmatterExtras(parsed) {
  const tags = [];
  let youtubeId = '';
  const extras = Array.isArray(parsed?.extraLines) ? parsed.extraLines : [];
  for (const entry of extras) {
    if (!entry || typeof entry.rawLine !== 'string') continue;
    const kv = entry.rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rawVal = kv[2].trim();
    if (key === 'tags') {
      const cleaned = rawVal.replace(/^\s*\[|\]\s*$/g, '');
      for (const piece of cleaned.split(',')) {
        const tag = unquoteYamlScalar(piece).trim();
        if (tag) tags.push(tag);
      }
    } else if (key === 'youtubeId') {
      const candidate = unquoteYamlScalar(rawVal).trim();
      if (YOUTUBE_ID_RE.test(candidate)) {
        youtubeId = candidate;
      }
    }
  }
  return { tags, youtubeId };
}

/**
 * Serialize parsed frontmatter + Markdown body back to a clean Markdown file.
 * @param {{ hasFrontmatter?: boolean, statusKey?: string, meta?: { date?: string, title?: string, status?: string }, extraLines?: Array<{ key: string, rawLine: string }>, body?: string }} doc
 */
export function serializeDocument({ hasFrontmatter = true, statusKey = 'status', meta = {}, extraLines = [], body = '' }) {
  const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  if (!hasFrontmatter) {
    return normalizedBody;
  }

  const resolvedStatusKey = statusKey === 'state' ? 'state' : 'status';
  const lines = [
    '---',
    `date: ${formatYamlScalar(meta.date || todayIsoDate())}`,
    `title: ${formatYamlScalar(meta.title || 'Untitled Draft')}`,
    `${resolvedStatusKey}: ${formatYamlScalar(meta.status || 'idea')}`
  ];

  for (const extra of extraLines) {
    if (extra && typeof extra.rawLine === 'string' && extra.rawLine.trim().length > 0) {
      lines.push(extra.rawLine);
    }
  }

  lines.push('---');
  if (normalizedBody.length === 0) {
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n\n${normalizedBody}`;
}

/**
 * Compute word, character, and reading-time statistics from Markdown body prose.
 */
export function computeStats(body = '') {
  const plain = String(body ?? '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/, '').replace(/```$/, ''))
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = plain.length === 0 ? 0 : plain.split(' ').filter(Boolean).length;
  const chars = String(body ?? '').length;
  const readingMinutes = words === 0 ? 0 : Math.max(1, Math.round(words / 200));

  return {
    words,
    chars,
    readingMinutes
  };
}
