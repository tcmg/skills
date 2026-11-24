export interface AgentDiffSummary {
  addedCount: number;
  removedCount: number;
  beforeExcerpt: string;
  afterExcerpt: string;
}

/**
 * Compute a concise, human-readable before/after excerpt of what changed
 * between `beforeMarkdown` and `afterMarkdown` after an Ask Agent edit.
 */
export function summarizeAgentDiff(
  beforeMarkdown: string,
  afterMarkdown: string,
  fallbackQuote = ''
): AgentDiffSummary {
  const beforeLines = String(beforeMarkdown || '').replace(/\r\n/g, '\n').split('\n');
  const afterLines = String(afterMarkdown || '').replace(/\r\n/g, '\n').split('\n');

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedSlice = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedSlice = afterLines.slice(prefix, afterLines.length - suffix);

  const removedNonEmpty = removedSlice.filter((l) => l.trim().length > 0);
  const addedNonEmpty = addedSlice.filter((l) => l.trim().length > 0);

  const rawBefore = removedNonEmpty.join('\n').trim() || fallbackQuote.trim();
  const rawAfter = addedNonEmpty.join('\n').trim();

  const clip = (text: string, maxLen = 420): string => {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1).trimEnd()}…`;
  };

  return {
    addedCount: addedNonEmpty.length,
    removedCount: removedNonEmpty.length,
    beforeExcerpt: clip(rawBefore),
    afterExcerpt: clip(rawAfter)
  };
}
