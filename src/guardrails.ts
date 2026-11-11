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
