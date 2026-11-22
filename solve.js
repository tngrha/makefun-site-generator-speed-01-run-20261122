// SPDX-License-Identifier: MIT
//
// A fast drop-in for makefun-site 1.0.0 (site-generator-speed-01): run(input) returns the
// same output tree (path -> text) as the reference build, byte for byte, on every input.
//
// Written from the makefun-site README spec (front matter, Markdown subset, template
// dialect, slug rule, report). The reference code is the authority where the README and
// the code differ, so every observable behaviour of the reference is reproduced here:
// refusal reasons and their order, template parse errors, inline Markdown edge cases,
// link resolution and broken-link reporting, collection/tag ordering and the report.
//
// Speed comes from structure, not from changing semantics:
//   - HTML escaping runs over whole plain-text ranges at once (the reference escapes
//     one character at a time inside its inline renderer);
//   - Markdown blocks are lexed and rendered in a single pass over the lines, with no
//     intermediate token objects, and inline markup is rendered over [lo, hi) ranges of
//     the original string instead of recursively sliced substrings;
//   - templates compile to flat node arrays rendered into a parts array joined once;
//   - slugify has an ASCII fast path and results are memoised per case (tag names and
//     headings repeat), link resolution is memoised per case, word counts are a manual
//     scan instead of a global regex match.
// Nothing is cached between cases: every memo table is created inside run().

// ------------------------------------------------------------------ small helpers

/** Code-unit order comparison (never the locale's). */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class). */
function isWsCode(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 160) return false;
  return (
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
    c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** Whether `s` holds any JavaScript whitespace character. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/** Push `s[a..b)` HTML-escaped onto `out` (only & < > " ' are escaped). */
function escRange(s, a, b, out) {
  let start = a;
  let i = a;
  while (i < b) {
    let best = b;
    let ent = null;
    let p = s.indexOf('&', i);
    if (p !== -1 && p < best) { best = p; ent = '&amp;'; }
    p = s.indexOf('<', i);
    if (p !== -1 && p < best) { best = p; ent = '&lt;'; }
    p = s.indexOf('>', i);
    if (p !== -1 && p < best) { best = p; ent = '&gt;'; }
    p = s.indexOf('"', i);
    if (p !== -1 && p < best) { best = p; ent = '&quot;'; }
    p = s.indexOf("'", i);
    if (p !== -1 && p < best) { best = p; ent = '&#39;'; }
    if (ent === null) break;
    if (start < best) out.push(s.slice(start, best));
    out.push(ent);
    i = best + 1;
    start = i;
  }
  if (start < b) out.push(s.slice(start, b));
}

/** Push the whole string `s` HTML-escaped onto `out`. */
function escStr(s, out) {
  escRange(s, 0, s.length, out);
}

/** One character HTML-escaped. */
function escChar(ch) {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
}

/** `text` with every \r\n and lone \r made \n. */
function normalizeEol(text) {
  let idx = text.indexOf('\r');
  if (idx === -1) return text;
  const parts = [];
  let start = 0;
  while (idx !== -1) {
    parts.push(text.slice(start, idx), '\n');
    start = idx + 1;
    if (text.charCodeAt(start) === 10) start++;
    idx = text.indexOf('\r', start);
  }
  parts.push(text.slice(start));
  return parts.join('');
}

/** The directory part of a "/"-separated path ("" at the root). */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `s` with every trailing "/" dropped. */
function stripTrailingSlashes(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 47) e--;
  return e === s.length ? s : s.slice(0, e);
}

// ------------------------------------------------------------------ slugs and dates

const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD with combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64 characters
 * (a "-" left at the cut dropped), "untitled" when nothing is left. Pure-ASCII text
 * skips normalisation (ASCII is stable under NFKD and holds no marks).
 */
function slugifyRaw(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(MARK_RE, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
    if (out.length >= 64) break;
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A validated YYYY-MM-DD date in words: "2026-11-09" -> "9 November 2026". */
function longDateOf(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return d + ' ' + MONTHS[m - 1] + ' ' + date.slice(0, 4);
}

/** The number of words in `text`: its runs of non-whitespace characters. */
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `raw` is a real YYYY-MM-DD day from 1970-01-01 to 2099-12-31. */
function validDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a template name: a-z, 0-9 and -, at least one character. */
function isTemplateName(s) {
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug value: a-z and 0-9 with single - between, at most 64 characters. */
function isSlugValue(s) {
  if (s === '' || s.length > 64) return false;
  let prevDash = true; // a leading - is refused by starting "after a dash"
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** Whether a tag name holds none of " [ ]. */
function isTagName(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return validDate(raw)
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || !isTagName(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. The closing line is found before any line
 * is validated, so an unclosed block reports that first.
 */
function parseFrontMatter(text) {
  const n = text.length;
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  const ranges = []; // [start, end) of each front-matter line
  let bodyStart = -1;
  let pos = nl + 1;
  while (pos <= n) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? n : eol;
    if (
      end - pos === 3 &&
      text.charCodeAt(pos) === 45 &&
      text.charCodeAt(pos + 1) === 45 &&
      text.charCodeAt(pos + 2) === 45
    ) {
      bodyStart = eol === -1 ? n : eol + 1;
      break;
    }
    ranges.push(pos, end);
    if (eol === -1) break;
    pos = eol + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let r = 0; r < ranges.length; r += 2) {
    const a = ranges[r];
    const b = ranges[r + 1];
    let blank = true;
    for (let i = a; i < b; i++) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank) continue;
    if (text.charCodeAt(a) === 35) continue; // comment line
    let i = a;
    while (i < b) {
      const c = text.charCodeAt(i);
      if ((c >= 97 && c <= 122) || c === 95) i++;
      else break;
    }
    if (i === a || i >= b || text.charCodeAt(i) !== 58) {
      return { error: `line ${r / 2 + 2} is not "key: value"` };
    }
    const key = text.slice(a, i);
    let rawStart;
    if (i + 1 === b) rawStart = b;
    else if (text.charCodeAt(i + 1) === 32) rawStart = i + 2;
    else return { error: `line ${r / 2 + 2} is not "key: value"` };
    let rawEnd = b;
    while (rawEnd > rawStart) {
      const c = text.charCodeAt(rawEnd - 1);
      if (c === 32 || c === 9) rawEnd--;
      else break;
    }
    const raw = text.slice(rawStart, rawEnd);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if (v.error !== undefined) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ Markdown

/** Whether a line is blank: spaces and tabs only. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-opening line's language ("" for none), or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether a line closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d < 1 || d > 6) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let a = d;
  while (a < line.length) {
    const cc = line.charCodeAt(a);
    if (cc === 32 || cc === 9) a++;
    else break;
  }
  let b = line.length;
  while (b > a) {
    const cc = line.charCodeAt(b - 1);
    if (cc === 32 || cc === 9) b--;
    else break;
  }
  if (b === a) return null;
  return { depth: d, text: line.slice(a, b) };
}

/** Whether a line is a thematic break: --- or ***, then spaces or tabs only. */
function isHrLine(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item line's rest (after "- " or "* "), or null. */
function bulletRest(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line's { num, rest }, or null (1-9 digits, ". ", rest). */
function orderedOf(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d < 1 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: Number(line.slice(0, d)), rest: line.slice(d + 2) };
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinuedLine(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

/** A line with spaces and tabs dropped at either end. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  // Dispatched on the first character: each ending kind has its own.
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHrLine(line);
  if (c === 32 || c === 9 || line.length === 0) return isBlankLine(line);
  return false;
}

/** The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 ||
    c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

/** The first index from `from` (within [0, hi)) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const last = hi - what.length;
  // Fast path: the first occurrence, when no backslash before it can form an escape
  // pair covering it, is the answer.
  const first = s.indexOf(what, from);
  if (first === -1 || first > last) return -1;
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs > first) return first;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one not beside another *), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let pos = from;
  let handScan = false;
  while (pos < hi) {
    const star = s.indexOf('*', pos);
    if (star === -1 || star >= hi) return -1;
    const bs = s.indexOf('\\', pos);
    if (bs !== -1 && bs < star) {
      handScan = true; // an escape pair may cover it: scan by hand below
      break;
    }
    if (star + 1 < hi && s.charCodeAt(star + 1) === 42) {
      pos = star + 2; // a ** pair is skipped whole
      continue;
    }
    return star;
  }
  if (!handScan) return -1;
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** The first index from `from` (within [0, hi)) holding an inline-special character (\\ ` * [), or hi. */
function nextSpecial(s, from, hi) {
  let best = hi;
  let p = s.indexOf('\\', from);
  if (p !== -1 && p < best) best = p;
  p = s.indexOf('`', from);
  if (p !== -1 && p < best) best = p;
  p = s.indexOf('*', from);
  if (p !== -1 && p < best) best = p;
  p = s.indexOf('[', from);
  if (p !== -1 && p < best) best = p;
  return best;
}

/**
 * `s[lo..hi)` rendered inline, appended to `out`; `link(target)` is a link's href.
 * Plain runs are escaped in bulk when a construct interrupts them.
 */
function renderInline(s, lo, hi, link, out) {
  let i = lo;
  let plain = lo;
  while (i < hi) {
    i = nextSpecial(s, i, hi);
    if (i >= hi) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash: an escape only before an escapable character
      if (i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
        escRange(s, plain, i, out);
        out.push(escChar(s[i + 1]));
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      // backtick: a code span to the next backtick, at least one character between
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < hi) {
        escRange(s, plain, i, out);
        out.push('<code>');
        escRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        // ** strong, closed by the next unescaped **
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          escRange(s, plain, i, out);
          out.push('<strong>');
          renderInline(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else {
          escRange(s, plain, i, out);
          out.push('**');
          i += 2;
          plain = i;
        }
      } else {
        // single * emphasis, closed by the next single *
        const j = findSingleStar(s, i + 1, hi);
        if (j > i + 1) {
          escRange(s, plain, i, out);
          out.push('<em>');
          renderInline(s, i + 1, j, link, out);
          out.push('</em>');
          i = j + 1;
          plain = i;
        } else i++;
      }
      continue;
    }
    if (c === 91) {
      // [text](target): first unescaped ], ( at once, next ) closes a non-empty,
      // whitespace-free target
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
        const p = s.indexOf(')', k + 2);
        if (p !== -1 && p < hi) m = p;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          escRange(s, plain, i, out);
          out.push('<a href="');
          escStr(link(target), out);
          out.push('">');
          renderInline(s, i + 1, k, link, out);
          out.push('</a>');
          i = m + 1;
          plain = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  escRange(s, plain, hi, out);
}

/**
 * `body` rendered in one pass: its HTML (each block followed by "\n"), its table of
 * contents (every level 2 and 3 heading), its excerpt (the first paragraph's inline
 * HTML, or "") and its word count (runs of non-whitespace; counted per line, which
 * sums to the body's count since a run cannot cross a newline). `slugOf` is the
 * per-case memoised slugify.
 */
function renderBody(body, link, slugOf) {
  const lines = body.split('\n');
  const n = lines.length;
  let words = 0;
  for (let q = 0; q < n; q++) words += countWords(lines[q]);
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
      // A non-blank line opening on a space or tab can only be paragraph text.
    }
    const lang = c0 === 96 ? fenceLang(line) : null;
    if (lang !== null) {
      out.push(lang === '' ? '<pre><code>' : '<pre><code class="language-' + lang + '">');
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        escStr(lines[i], out);
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const h = c0 === 35 ? headingOf(line) : null;
    if (h !== null) {
      const id = uniqueSlug(slugOf(h.text), ids);
      const parts = [];
      renderInline(h.text, 0, h.text.length, link, parts);
      const html = parts.join('');
      out.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>\n');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHrLine(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // blockquote: consecutive > lines, > and one space dropped, trimmed, empties dropped
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') parts.push(l);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const joined = parts.length === 1 ? parts[0] : parts.join('\n');
        renderInline(joined, 0, joined.length, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? bulletRest(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrd) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.rest)]);
            i++;
            continue;
          }
        } else {
          const m = bulletRest(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinuedLine(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      out.push(isOrd && ordered.num !== 1 ? '<ol start="' + ordered.num + '">\n' : '<' + tag + '>\n');
      for (const parts of items) {
        out.push('<li>');
        const joined = parts.length === 1 ? parts[0] : parts.join('\n');
        renderInline(joined, 0, joined.length, link, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
      continue;
    }
    // paragraph: this line and the lines after it up to a blank, fence, heading or break
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const joined = parts.length === 1 ? parts[0] : parts.join('\n');
    out.push('<p>');
    if (excerpt === null) {
      const ep = [];
      renderInline(joined, 0, joined.length, link, ep);
      excerpt = ep.join('');
      out.push(excerpt);
    } else {
      renderInline(joined, 0, joined.length, link, out);
    }
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ------------------------------------------------------------------ templates
//
// A template compiles to an array of nodes, each a small array:
//   [0, text]                       literal text
//   [1, path]                       {{ path }}   (escaped)
//   [2, path]                       {{{ path }}} (raw)
//   [3, path, not, then, else]      {% if %} (else is null when absent)
//   [4, name, path, body]           {% for name in path %}
//   [5, name]                       {% include "name" %}
// A path is its segments, split at the dots. Tokenising runs to completion before the
// tree is built, so a token-level error (an unclosed {{, a bad path in a {{ }}) is
// reported ahead of any tree-level error, exactly as in the reference.

/** A template that does not parse; its message is the report line. */
class TplError extends Error {}

function tplFail(name, reason) {
  throw new TplError(`template "${name}": ${reason}`);
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

/** The segments of path `text`, or null when it is not a path. */
function pathSegments(text) {
  if (text === '') return null;
  const segs = text.split('.');
  for (const seg of segs) {
    if (seg === '' || !isNameStart(seg.charCodeAt(0))) return null;
    for (let i = 1; i < seg.length; i++) if (!isNameChar(seg.charCodeAt(i))) return null;
  }
  return segs;
}

/** The path `text` names, or a TplError. */
function pathOf(name, text) {
  const segs = pathSegments(text);
  if (segs === null) tplFail(name, `${JSON.stringify(text)} is not a path`);
  return segs;
}

/** Whether `s[a..b)` is spaces and tabs only. */
function isBlankRange(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Drop `k` characters from the end of the accumulated text parts. */
function trimPartsEnd(parts, k) {
  while (k > 0 && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last.length <= k) {
      k -= last.length;
      parts.pop();
    } else {
      parts[parts.length - 1] = last.slice(0, last.length - k);
      k = 0;
    }
  }
}

/** `src`'s tokens: [0, text], [1, path], [2, path], [3, tag]; a standalone tag's line is taken with it. */
function tokenizeTpl(name, src) {
  const tokens = [];
  const textParts = [];
  const len = src.length;
  let i = 0;
  const flushText = () => {
    if (textParts.length > 0) {
      const text = textParts.join('');
      if (text !== '') tokens.push([0, text]);
      textParts.length = 0;
    }
  };
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      textParts.push(src.slice(i));
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      textParts.push(src.slice(i, open + 1));
      i = open + 1;
      continue;
    }
    if (open > i) textParts.push(src.slice(i, open));
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) tplFail(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      flushText();
      tokens.push([raw ? 2 : 1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) tplFail(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isBlankRange(src, lineStart, open) && isBlankRange(src, end, lineEnd);
    if (standalone) trimPartsEnd(textParts, open - lineStart);
    flushText();
    tokens.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  flushText();
  return tokens;
}

/** A {% %} tag's classification, or null when it is none of the dialect's tags. */
function classifyTag(tag) {
  if (tag === 'else') return { type: 'else' };
  if (tag === 'endfor') return { type: 'endfor' };
  if (tag === 'endif') return { type: 'endif' };
  if (tag.startsWith('for ')) {
    let i = 4;
    if (!isNameStart(tag.charCodeAt(i))) return null;
    i++;
    while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
    const varName = tag.slice(4, i);
    if (!tag.startsWith(' in ', i)) return null;
    const pathText = tag.slice(i + 4);
    if (pathText === '' || hasWs(pathText)) return null;
    return { type: 'for', name: varName, pathText };
  }
  if (tag.startsWith('if ')) {
    const rest = tag.slice(3);
    if (rest.startsWith('not ')) {
      const p = rest.slice(4);
      if (p !== '' && !hasWs(p)) return { type: 'if', not: true, pathText: p };
    }
    if (rest !== '' && !hasWs(rest)) return { type: 'if', not: false, pathText: rest };
    return null;
  }
  if (tag.startsWith('include "') && tag.endsWith('"') && tag.length >= 11) {
    const mid = tag.slice(9, -1);
    if (mid !== '' && isTemplateName(mid)) return { type: 'include', name: mid };
    return null;
  }
  return null;
}

/** `src` parsed into its node array (a TplError when it does not parse). */
function parseTpl(name, src) {
  const tokens = tokenizeTpl(name, src);
  const rootFrame = { kind: 'root', node: null, cur: [] };
  const stack = [rootFrame];
  for (const tok of tokens) {
    const frame = stack[stack.length - 1];
    if (tok[0] === 0) {
      frame.cur.push([0, tok[1]]);
      continue;
    }
    if (tok[0] === 1 || tok[0] === 2) {
      frame.cur.push([tok[0], tok[1]]);
      continue;
    }
    const tag = tok[1];
    const cls = classifyTag(tag);
    if (cls === null) tplFail(name, `{% ${tag} %} is not a tag`);
    if (cls.type === 'for') {
      const node = [4, cls.name, pathOf(name, cls.pathText), []];
      frame.cur.push(node);
      stack.push({ kind: 'for', node, cur: node[3] });
    } else if (cls.type === 'if') {
      const node = [3, pathOf(name, cls.pathText), cls.not, [], null];
      frame.cur.push(node);
      stack.push({ kind: 'if', node, cur: node[3] });
    } else if (cls.type === 'else') {
      if (frame.kind !== 'if' || frame.node[4] !== null) tplFail(name, 'an else outside an if');
      frame.node[4] = [];
      frame.cur = frame.node[4];
    } else if (cls.type === 'endfor') {
      if (frame.kind !== 'for') tplFail(name, 'an endfor with no open for');
      stack.pop();
    } else if (cls.type === 'endif') {
      if (frame.kind !== 'if') tplFail(name, 'an endif with no open if');
      stack.pop();
    } else {
      frame.cur.push([5, cls.name]);
    }
  }
  if (stack.length > 1) tplFail(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return rootFrame.cur;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valueText(v) {
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = new Array(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = valueText(v[i]);
    return parts.join(', ');
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function valueTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Names `nodes` reference that are not bound inside them (for bodies bind their name and loop). */
function directFree(nodes, bound, out) {
  for (const node of nodes) {
    const k = node[0];
    if (k === 1 || k === 2) {
      if (!bound.has(node[1][0])) out.add(node[1][0]);
    } else if (k === 3) {
      if (!bound.has(node[1][0])) out.add(node[1][0]);
      directFree(node[3], bound, out);
      if (node[4] !== null) directFree(node[4], bound, out);
    } else if (k === 4) {
      if (!bound.has(node[2][0])) out.add(node[2][0]);
      const inner = new Set(bound);
      inner.add(node[1]);
      inner.add('loop');
      directFree(node[3], inner, out);
    }
  }
}

/** Every template name included anywhere in `nodes`. */
function includeNames(nodes, out) {
  for (const node of nodes) {
    const k = node[0];
    if (k === 5) out.push(node[1]);
    else if (k === 3) {
      includeNames(node[3], out);
      if (node[4] !== null) includeNames(node[4], out);
    } else if (k === 4) includeNames(node[3], out);
  }
  return out;
}

/**
 * The names of templates whose rendering depends only on the case-constant values
 * (site, tags, recent): every name they reference free — transitively through
 * includes, by fixpoint over include cycles — is one of those three. Such a
 * template renders the same string at the same include depth on every page of a
 * case, unless a loop between the page root and the include site binds one of the
 * three names (checked again at render time).
 */
function constantTemplates(templates) {
  const free = new Map();
  for (const [name, nodes] of templates) {
    const set = new Set();
    directFree(nodes, new Set(), set);
    free.set(name, set);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      const set = free.get(name);
      for (const inc of includeNames(nodes, [])) {
        const sub = free.get(inc);
        if (sub !== undefined) {
          for (const f of sub) {
            if (!set.has(f)) {
              set.add(f);
              changed = true;
            }
          }
        }
      }
    }
  }
  const out = new Set();
  for (const [name, set] of free) {
    let ok = true;
    for (const f of set) {
      if (f !== 'site' && f !== 'tags' && f !== 'recent') {
        ok = false;
        break;
      }
    }
    if (ok) out.add(name);
  }
  return out;
}

/** Whether a loop scope between `scope` and the root binds site, tags or recent. */
function shadowedConstants(scope) {
  for (let s = scope; s.parent !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, 'site') || Object.hasOwn(s.vars, 'tags') || Object.hasOwn(s.vars, 'recent')) return true;
  }
  return false;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. Includes nest at
 * most 8 deep. `ctx` holds the parsed templates, the constant-template set and the
 * per-case memo of their renders (keyed by name and include depth).
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    const kind = node[0];
    if (kind === 0) {
      out.push(node[1]);
    } else if (kind === 1) {
      const v = valueText(lookupPath(scope, node[1]));
      if (v !== '') escStr(v, out);
    } else if (kind === 2) {
      const v = valueText(lookupPath(scope, node[1]));
      if (v !== '') out.push(v);
    } else if (kind === 3) {
      const t = valueTruthy(lookupPath(scope, node[1]));
      const branch = t !== node[2] ? node[3] : node[4];
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (kind === 4) {
      const xs = lookupPath(scope, node[2]);
      if (Array.isArray(xs)) {
        const len = xs.length;
        // One scope reused across iterations: rendering is depth-first and templates
        // only read the current bindings, so mutating them between iterations is safe.
        const loopInfo = { index: 0, first: false, last: false, length: len };
        const vars = {};
        const child = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[node[1]] = xs[k];
          loopInfo.index = k + 1;
          loopInfo.first = k === 0;
          loopInfo.last = k === len - 1;
          vars.loop = loopInfo;
          renderNodes(node[3], child, ctx, depth, out);
        }
      }
    } else {
      const t = ctx.templates.get(node[1]);
      if (t !== undefined && depth < 8) {
        if (ctx.constant.has(node[1]) && !shadowedConstants(scope)) {
          const key = node[1] + '@' + depth;
          let cached = ctx.memo.get(key);
          if (cached === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            cached = tmp.join('');
            ctx.memo.set(key, cached);
          }
          if (cached !== '') out.push(cached);
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ the build

/** The top-level directories the generator writes itself, reserved at the root. */
const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` opens on a scheme: a letter, then letters/digits/+.- up to ":". */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) {
      return false;
    }
  }
  return false;
}

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target's href from directory `dir`, and whether it names nothing built. */
function computeHref(target, dir, ctx) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
    return { href: target, broken: false };
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const src = ctx.bySource.get(path);
    if (src !== undefined) return { href: src.url + frag, broken: false };
    if (ctx.staticPaths.has(path)) return { href: ctx.base + '/' + path + frag, broken: false };
  }
  return { href: target, broken: true };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  const date = s.data.date;
  return {
    title: s.data.title,
    url: s.url,
    date: date ?? '',
    date_long: date === undefined ? '' : longDateOf(date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  const date = s.data.date;
  return {
    title: s.data.title,
    url: s.url,
    date: date ?? '',
    date_long: date === undefined ? '' : longDateOf(date),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const c = s.card;
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. The answer for one case's input. */
export function run(input) {
  const report = [];
  const broken = new Set();
  const base = stripTrailingSlashes(input.site.base_url);

  // Templates, parsed in code-unit order of name; one that does not parse is reported
  // and left out.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmpStr)) {
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplError) report.push(err.message);
      else throw err;
    }
  }

  // Per-case slug memo (tag names and headings repeat across sources).
  const slugCache = new Map();
  const slugOf = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // Sources in code-unit order of path; .md files are sources with \n line ends,
  // anything else is static.
  const files = input.files.slice().sort((x, y) => cmpStr(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: normalizeEol(f.content) });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in order: refused front matter, the
  // generator's own directories, a post with no date, an unparsed layout, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slug unique in its directory, in source order; posts/, tags/ and page/
  // are taken at the root from the start.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : []);
      takenByDir.set(dir, taken);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), taken);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against the built pages and static files.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const linkCtx = { base, bySource, staticPaths, broken, linkCache: new Map() };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const key = dir + '\0' + target;
      let entry = linkCtx.linkCache.get(key);
      if (entry === undefined) {
        entry = computeHref(target, dir, linkCtx);
        linkCtx.linkCache.set(key, entry);
      }
      if (entry.broken) broken.add(`broken-link ${s.path} -> ${target}`);
      return entry.href;
    };
    const md = renderBody(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, named as first met walking the posts in collection order,
  // ordered by post count then slug. A page's tags link to the posts' tag of the same
  // slug, or to "" where no post has it.
  const bySlug = new Map();
  const ownTagsOf = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagsOf(p)) {
      const sl = slugOf(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: base + '/tags/' + sl + '/', posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagsOf(s).map((name) => {
      const sl = slugOf(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // Cards, once per kept source.
  for (const s of kept) s.card = cardOf(s);

  // Layouts: every page, the index pages, each tag page and the tags index. A page
  // whose template is missing is not written (a source's own layout always parses).
  const output = {};
  const siteVars = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const tplCtx = { templates, constant: constantTemplates(templates), memo: new Map() };
  const renderPage = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site: siteVars, tags: allTags, recent, ...vars }, parent: null }, tplCtx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = renderPage(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  if (templates.has('index')) {
    for (let k = 1; k <= pageCount; k++) {
      const html = renderPage('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
        pager: {
          number: k,
          total: pageCount,
          url: indexUrl(k),
          newer_url: k === 1 ? '' : indexUrl(k - 1),
          older_url: k === pageCount ? '' : indexUrl(k + 1),
        },
      });
      if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
    }
  }
  for (const t of tags) {
    const html = renderPage('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderPage('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  // Static files at their own paths, unless a built page has the path.
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link sorted, then the counts.
  const lines = report.concat([...broken]).sort(cmpStr);
  let pageTotal = 0;
  for (const s of kept) if (!s.post) pageTotal++;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
