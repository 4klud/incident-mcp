// Shared server-side guardrails. These must never depend on the client LLM behaving.

// Index just past the closing quote of the string starting at `start`, or -1 if unterminated.
// "..." strings honour backslash escapes; `...` strings are raw.
function skipString(s: string, start: number): number {
  const quote = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (quote === '"' && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === quote) {
      return i + 1;
    }
  }
  return -1;
}

// Index of the "}" closing a selector body that starts at `from`, or -1 if the
// body is unterminated or contains a nested "{" (not valid in a stream selector).
function findSelectorEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "`") {
      const end = skipString(s, i);
      if (end === -1) return -1;
      i = end;
    } else if (ch === "}") {
      return i;
    } else if (ch === "{") {
      return -1;
    } else {
      i++;
    }
  }
  return -1;
}

// Returns the body of every stream selector ({...}) in a LogQL query, ignoring
// braces inside strings and text inside # comments. Returns null if the query
// can't be scanned cleanly (unbalanced braces, unterminated string): fail closed.
export function extractStreamSelectors(query: string): string[] | null {
  const selectors: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"' || ch === "`") {
      const end = skipString(query, i);
      if (end === -1) return null;
      i = end;
    } else if (ch === "#") {
      const newline = query.indexOf("\n", i);
      if (newline === -1) break;
      i = newline + 1;
    } else if (ch === "{") {
      const close = findSelectorEnd(query, i + 1);
      if (close === -1) return null;
      selectors.push(query.slice(i + 1, close));
      i = close + 1;
    } else if (ch === "}") {
      return null;
    } else {
      i++;
    }
  }
  return selectors;
}

function splitOutsideStrings(s: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "`") {
      const end = skipString(s, i);
      if (end === -1) break;
      i = end;
    } else if (ch === separator) {
      parts.push(s.slice(start, i));
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

const MATCHER = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!=|!~|=)\s*("(?:[^"\\]|\\.)*"|`[^`]*`)$/;

// True only for service="<something>": exact label, plain "=" operator, non-empty literal.
// Rejects other_service="x", service=~".+", service!="x" and service="".
function isExactServiceMatcher(matcher: string): boolean {
  const m = MATCHER.exec(matcher.trim());
  if (!m) return false;
  const [, name, operator, value] = m;
  return name === "service" && operator === "=" && value.length > 2;
}

// True if the query has at least one stream selector and EVERY selector is
// scoped to a specific service. A single unscoped selector (e.g. in a
// binary expression) makes the whole query unscoped.
export function hasServiceScope(query: string): boolean {
  const selectors = extractStreamSelectors(query);
  if (!selectors || selectors.length === 0) return false;
  return selectors.every((body) => splitOutsideStrings(body, ",").some(isExactServiceMatcher));
}

// --- PromQL service scoping ---
//
// Harder than LogQL: a bare metric name (`up`) is already a valid selector with no
// braces, so a "contains service=" check would let `up or foo{service="a"}` through.
// Instead we tokenise: every {...} selector must carry service="<name>", and any
// identifier that is not a function, keyword or label list is treated as a bare
// metric name and rejected. Anything we can't scan cleanly is rejected (fail closed).

// Followed by a parenthesised list of label names, which are not metrics.
const PROMQL_LABEL_LIST_KEYWORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right"]);
// Operators and literals that appear as bare words.
const PROMQL_WORD_OPERATORS = new Set(["offset", "bool", "and", "or", "unless", "atan2", "inf", "nan"]);

const PROMQL_IDENT_START = /[A-Za-z_:]/;
const PROMQL_IDENT_PART = /[A-Za-z0-9_:]/;

// PromQL allows "..." and '...' (with escapes) and `...` (raw).
function skipPromString(s: string, start: number): number {
  const quote = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (quote !== "`" && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === quote) return i + 1;
  }
  return -1;
}

function skipSpaces(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

// Index just past the ")" closing a label list that starts at `open`, or -1.
function skipLabelList(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'" || s[i] === "`") {
      const end = skipPromString(s, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (s[i] === ")") {
      return i + 1;
    }
  }
  return -1;
}

const PROMQL_GROUPING = /(?:by|without)\b/iy;

// True if `by` or `without` starts at `from`. Sticky regex: no copy of the rest of the query.
function startsWithGrouping(s: string, from: number): boolean {
  PROMQL_GROUPING.lastIndex = from;
  return PROMQL_GROUPING.test(s);
}

// True if the query has at least one selector, every {...} selector is scoped to a
// specific service, and no metric is selected by bare name.
export function hasPromqlServiceScope(query: string): boolean {
  let selectorCount = 0;
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipPromString(query, i);
      if (end === -1) return false;
      i = end;
    } else if (ch === "#") {
      const newline = query.indexOf("\n", i);
      if (newline === -1) break;
      i = newline + 1;
    } else if (ch === "[") {
      const close = query.indexOf("]", i);
      if (close === -1) return false;
      i = close + 1;
    } else if (ch === "{") {
      const close = findSelectorEnd(query, i + 1);
      if (close === -1) return false;
      const body = query.slice(i + 1, close);
      if (!splitOutsideStrings(body, ",").some(isExactServiceMatcher)) return false;
      selectorCount++;
      i = close + 1;
    } else if (ch === "}") {
      return false;
    } else if (/[0-9]/.test(ch)) {
      // Number or duration (1e3, 0x1F, 5m): skip the whole token.
      while (i < query.length && /[A-Za-z0-9_.]/.test(query[i])) i++;
    } else if (PROMQL_IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < query.length && PROMQL_IDENT_PART.test(query[end])) end++;
      const word = query.slice(i, end).toLowerCase();
      const next = skipSpaces(query, end);
      if (PROMQL_LABEL_LIST_KEYWORDS.has(word)) {
        if (query[next] === "(") {
          const after = skipLabelList(query, next);
          if (after === -1) return false;
          i = after;
        } else {
          i = end;
        }
      } else if (query[next] === "(" || PROMQL_WORD_OPERATORS.has(word) || startsWithGrouping(query, next)) {
        i = end; // function name, operator, or aggregation written as `sum by (...) (...)`
      } else if (query[next] === "{") {
        i = end; // metric name; its selector is checked on the next iteration
      } else {
        return false; // bare metric name: unscoped
      }
    } else {
      i++;
    }
  }
  return selectorCount > 0;
}

// --- Secret redaction (best effort) ---
//
// Applied to free text before it leaves a tool. It errs toward over-redacting
// (e.g. token_count=5 is redacted) because a leak costs more than readability.
// It cannot catch secrets with no marker ("logged in with hunter2"), unusual
// formats, or the body lines of a multi-line private key (redaction is per string).
//
// Every pattern must run in linear time, since log lines can contain attacker-shaped
// text. An unbounded quantifier that can fail after consuming a long run backtracks
// and goes quadratic when the trigger repeats (e.g. "passwordpassword..."), so each
// such quantifier is bounded. The adversarial test in guardrails.test.ts guards this.

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEYWORDS =
  "password|passwd|passphrase|secret|token|api[_-]?key|authorization|credentials?|private[_-]?key|access[_-]?key|session[_-]?id";

const SENSITIVE_KEY = new RegExp(SENSITIVE_KEYWORDS, "i");

const QUOTED_OR_BARE_VALUE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s"'&;,]+`;

// Order matters: Bearer/Basic first so "Authorization: Bearer abc" doesn't
// leave abc behind when the key/value rule consumes only "Bearer".
const REDACTION_RULES: Array<[RegExp, string]> = [
  // PEM private key blocks, then a bare header as fallback
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  // Authorization schemes
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // key=value, key: value, "key":"value" (key may be part of a longer name, e.g. db_password)
  [
    new RegExp(
      `((?:${SENSITIVE_KEYWORDS})[A-Za-z0-9_.-]{0,64}["']?\\s*[:=]\\s*)(?:(?:Bearer|Basic)\\s+)?(?:${QUOTED_OR_BARE_VALUE})`,
      "gi",
    ),
    `$1${REDACTED}`,
  ],
  // Credentials in URLs: scheme://user:pass@host
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${REDACTED}@`],
  // Well-known token shapes (no key name needed)
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{0,2048}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// For label maps (e.g. Loki stream labels): a sensitive key name hides the whole
// value; otherwise the value is scanned like any other text.
export function redactRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(value);
  }
  return out;
}
