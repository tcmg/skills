/**
 * Conflict-free line-level 3-way merge for Markdown auto-save.
 *
 * When an external editor or AI agent updates a file on disk while the user is
 * typing elsewhere in the same draft:
 * - Non-overlapping edits from both sides are merged cleanly.
 * - Identical edits are deduplicated.
 * - True same-line collisions auto-resolve deterministically in favor of `local`
 *   (the user's active typing) so it NEVER emits `<<<<<<<` conflict markers or
 *   requires manual conflict resolution.
 */

function splitLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n');
}

/**
 * Compute LCS-based edit hunks transforming `baseLines` into `targetLines`.
 * Each hunk is `{ start, end, lines }` where `[start, end)` is a slice in `baseLines`
 * replaced by `lines`.
 */
function diffToHunks(baseLines, targetLines) {
  const n = baseLines.length;
  const m = targetLines.length;

  // Trim common prefix and suffix to keep DP small and fast for long articles.
  let prefix = 0;
  while (prefix < n && prefix < m && baseLines[prefix] === targetLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    baseLines[n - 1 - suffix] === targetLines[m - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = baseLines.slice(prefix, n - suffix);
  const b = targetLines.slice(prefix, m - suffix);
  const an = a.length;
  const bm = b.length;

  if (an === 0 && bm === 0) return [];
  if (an === 0 || bm === 0) {
    return [{ start: prefix, end: prefix + an, lines: b }];
  }

  // Guard against extreme pathological files (> 4M DP cells): treat middle span as one hunk.
  if (an * bm > 4_000_000) {
    return [{ start: prefix, end: prefix + an, lines: b }];
  }

  // Standard LCS DP table (flat Int32Array for low memory & speed).
  const cols = bm + 1;
  const dp = new Int32Array((an + 1) * cols);
  for (let i = an - 1; i >= 0; i -= 1) {
    const rowOff = i * cols;
    const nextRowOff = (i + 1) * cols;
    for (let j = bm - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[rowOff + j] = dp[nextRowOff + j + 1] + 1;
      } else {
        const down = dp[nextRowOff + j];
        const right = dp[rowOff + j + 1];
        dp[rowOff + j] = down >= right ? down : right;
      }
    }
  }

  // Walk DP to collect matching anchor pairs.
  const anchors = [];
  let i = 0;
  let j = 0;
  while (i < an && j < bm) {
    if (a[i] === b[j]) {
      anchors.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  anchors.push([an, bm]);

  const hunks = [];
  let curA = 0;
  let curB = 0;
  for (const [matchA, matchB] of anchors) {
    if (curA !== matchA || curB !== matchB) {
      hunks.push({
        start: prefix + curA,
        end: prefix + matchA,
        lines: b.slice(curB, matchB)
      });
    }
    curA = matchA + 1;
    curB = matchB + 1;
  }
  return hunks;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hunksOverlap(a, b) {
  // Two pure insertions at the exact same point overlap; otherwise check interval overlap.
  if (a.start === a.end && b.start === b.end) {
    return a.start === b.start;
  }
  if (a.start === a.end) {
    return a.start >= b.start && a.start <= b.end;
  }
  if (b.start === b.end) {
    return b.start >= a.start && b.start <= a.end;
  }
  return a.start < b.end && b.start < a.end;
}

/**
 * Perform a conflict-free 3-way merge of `base`, `local` (user edits), and `remote` (disk/agent edits).
 * Returns `{ content, merged, remoteChangesApplied }`.
 */
export function threeWayMerge(base, local, remote) {
  const normBase = String(base ?? '').replace(/\r\n/g, '\n');
  const normLocal = String(local ?? '').replace(/\r\n/g, '\n');
  const normRemote = String(remote ?? '').replace(/\r\n/g, '\n');

  if (normRemote === normBase) {
    return { content: normLocal, merged: false, remoteChangesApplied: false };
  }
  if (normLocal === normBase) {
    return { content: normRemote, merged: true, remoteChangesApplied: true };
  }
  if (normLocal === normRemote) {
    return { content: normLocal, merged: false, remoteChangesApplied: false };
  }

  const baseLines = splitLines(normBase);
  const localLines = splitLines(normLocal);
  const remoteLines = splitLines(normRemote);

  const localHunks = diffToHunks(baseLines, localLines);
  const remoteHunks = diffToHunks(baseLines, remoteLines);

  const chosen = [];
  let li = 0;
  let ri = 0;
  let remoteApplied = false;

  while (li < localHunks.length || ri < remoteHunks.length) {
    if (li >= localHunks.length) {
      chosen.push(remoteHunks[ri]);
      remoteApplied = true;
      ri += 1;
      continue;
    }
    if (ri >= remoteHunks.length) {
      chosen.push(localHunks[li]);
      li += 1;
      continue;
    }

    const lh = localHunks[li];
    const rh = remoteHunks[ri];

    if (hunksOverlap(lh, rh)) {
      if (lh.start === rh.start && lh.end === rh.end && arraysEqual(lh.lines, rh.lines)) {
        // Identical edit on both sides.
        chosen.push(lh);
        li += 1;
        ri += 1;
      } else {
        // Same-line collision: keep user's local edit without ever emitting conflict markers,
        // and skip any remote hunks that overlap this local hunk.
        chosen.push(lh);
        li += 1;
        while (ri < remoteHunks.length && hunksOverlap(lh, remoteHunks[ri])) {
          ri += 1;
        }
      }
      continue;
    }

    if (lh.end <= rh.start) {
      chosen.push(lh);
      li += 1;
    } else {
      chosen.push(rh);
      remoteApplied = true;
      ri += 1;
    }
  }

  const out = [];
  let cursor = 0;
  for (const hunk of chosen) {
    if (hunk.start > cursor) {
      out.push(...baseLines.slice(cursor, hunk.start));
    }
    out.push(...hunk.lines);
    cursor = Math.max(cursor, hunk.end);
  }
  if (cursor < baseLines.length) {
    out.push(...baseLines.slice(cursor));
  }

  const mergedContent = out.join('\n');
  return {
    content: mergedContent,
    merged: remoteApplied && mergedContent !== normLocal,
    remoteChangesApplied: remoteApplied
  };
}
