const UUID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ID_REGEX = /\b[0-9a-f]{12,64}\b/gi;
const ISO_TIMESTAMP_REGEX = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

// Targeted number shapes only. Bare digits are NOT masked, because that would merge
// "status 500" with "status 200". Quantifiers are bounded to avoid regex backtracking.
const IPV4_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const DURATION_REGEX = /\b\d{1,12}(?:\.\d{1,6})?\s?(?:ms|s)\b/g;

// Keys in JSON logs whose values should always be masked, and the placeholder for each.
// Lookup uses canonicalKey(), so write the keys here lowercase with no "_" or "-".
const DYNAMIC_JSON_KEYS = new Map<string, string>([
  ['time', '<TIMESTAMP>'],
  ['timestamp', '<TIMESTAMP>'],
  ['ts', '<TIMESTAMP>'],
  ['duration', '<DURATION>'],
  ['durationms', '<DURATION>'],
  ['latency', '<DURATION>'],
  ['elapsed', '<DURATION>'],
  ['elapsedms', '<DURATION>'],
  ['id', '<ID>'],
  ['requestid', '<ID>'],
  ['traceid', '<ID>'],
  ['spanid', '<ID>'],
]);

// "traceId", "trace_id" and "TRACE-ID" all become "traceid".
function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function maskDynamicStrings(value: string): string {
  return value
    .replace(ISO_TIMESTAMP_REGEX, '<TIMESTAMP>')
    .replace(UUID_REGEX, '<ID>')
    .replace(IPV4_REGEX, '<IP>')
    .replace(DURATION_REGEX, '<DURATION>')
    .replace(HEX_ID_REGEX, '<ID>');
}

function normalizeJsonValue(key: string, value: unknown): unknown {
  const placeholder = DYNAMIC_JSON_KEYS.get(canonicalKey(key));
  if (placeholder !== undefined) {
    return placeholder;
  }

  if (typeof value === 'string') {
    return maskDynamicStrings(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue('', item));
  }

  if (value !== null && typeof value === 'object') {
    const normalizedObj: Record<string, unknown> = {};
    // Sort keys so JSON property order differences don't break equality
    for (const k of Object.keys(value).sort()) {
      normalizedObj[k] = normalizeJsonValue(k, (value as Record<string, unknown>)[k]);
    }
    return normalizedObj;
  }

  return value;
}

export function normalizeLine(line: string): string {
  const trimmed = line.trim();

  // 1. Handle structured JSON log lines
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      const normalized = normalizeJsonValue('', parsed);
      return JSON.stringify(normalized);
    } catch {
      // Fall back to plain-text regex if JSON is malformed
    }
  }

  // 2. Handle plain-text / unstructured log lines
  return maskDynamicStrings(trimmed)
    .replace(/\bduration_ms[=:]\s*\d+(?:\.\d+)?/gi, 'duration_ms=<DURATION>')
    .replace(/\s+/g, ' ');
}
