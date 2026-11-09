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
