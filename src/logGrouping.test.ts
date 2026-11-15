import { describe, it, expect } from "vitest";
import { normalizeLine } from "./logGrouping.js";

// Sample line shaped like the demo app's JSON logs.
const sample = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/error","status":500,"duration_ms":312}';

describe("normalizeLine collapses lines that differ only in variable parts", () => {
  it("same line with a different timestamp", () => {
    const lineA = sample;
    const lineB = '{"time":"2026-11-15T23:59:59.999Z","level":"error","route":"/error","status":500,"duration_ms":312}';

    expect(normalizeLine(lineA)).toBe(normalizeLine(lineB));
  });

  it("same line with a different duration_ms", () => {
    const lineA = sample;
    const lineB = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/error","status":500,"duration_ms":1450}';

    expect(normalizeLine(lineA)).toBe(normalizeLine(lineB));
  });

  it("same line with a different UUID or hex ID", () => {
    const uuidLineA = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/users/550e8400-e29b-41d4-a716-446655440000","trace_id":"a1b2c3d4e5f60718"}';
    const uuidLineB = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/users/123e4567-e89b-12d3-a456-426614174000","trace_id":"9988776655443322"}';

    expect(normalizeLine(uuidLineA)).toBe(normalizeLine(uuidLineB));
  });

  it("same line with different camelCase and snake_case dynamic keys", () => {
    const lineA = '{"level":"error","traceId":"abc","request-id":"r1","ts":1,"elapsedMs":12}';
    const lineB = '{"level":"error","traceId":"def","request-id":"r2","ts":2,"elapsedMs":900}';

    expect(normalizeLine(lineA)).toBe(normalizeLine(lineB));
  });

  it("does not mask keys that merely contain a dynamic word (e.g. runtime)", () => {
    const lineA = '{"level":"error","runtime":"node18"}';
    const lineB = '{"level":"error","runtime":"node20"}';

    expect(normalizeLine(lineA)).not.toBe(normalizeLine(lineB));
  });

  it("same line with a different UUIDv7 (version and variant digits are not 1-5 / 8-b)", () => {
    const lineA = '{"level":"error","route":"/users/018f3c2a-7b1e-7c3a-9d4e-0123456789ab"}';
    const lineB = '{"level":"error","route":"/users/018f3c2b-1111-7c3a-ed4e-aaaaaaaaaaaa"}';

    expect(normalizeLine(lineA)).toBe(normalizeLine(lineB));
  });
});

describe("normalizeLine masks targeted number shapes in text", () => {
  it("plain-text lines with different durations and IPs collapse", () => {
    const lineA = "GET /users took 312ms from 10.0.0.5:51234";
    const lineB = "GET /users took 1450 ms from 192.168.1.9:40000";

    expect(normalizeLine(lineA)).toBe(normalizeLine(lineB));
  });

  it("durations inside a JSON string value collapse", () => {
    const lineA = '{"level":"error","msg":"timeout after 312ms"}';
    const lineB = '{"level":"error","msg":"timeout after 1450ms"}';

    expect(normalizeLine(lineA)).toBe(normalizeLine(lineB));
  });

  it("different status codes in plain text stay separate", () => {
    expect(normalizeLine("GET /users returned 500")).not.toBe(normalizeLine("GET /users returned 200"));
  });

  // Known gap, pinned on purpose: bare ids are not masked, so these do not collapse.
  it("KNOWN GAP: bare numeric ids in text are not masked", () => {
    expect(normalizeLine("lost connection 42")).not.toBe(normalizeLine("lost connection 97"));
  });
});

describe("normalizeLine keeps genuinely different lines apart", () => {
  it("different status code (500 vs 200)", () => {
    const lineB = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/error","status":200,"duration_ms":312}';

    expect(normalizeLine(sample)).not.toBe(normalizeLine(lineB));
  });

  it("different route", () => {
    const lineB = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/slow","status":500,"duration_ms":312}';

    expect(normalizeLine(sample)).not.toBe(normalizeLine(lineB));
  });

  it("different level", () => {
    const lineB = '{"time":"2026-11-15T10:02:11Z","level":"info","route":"/error","status":500,"duration_ms":312}';

    expect(normalizeLine(sample)).not.toBe(normalizeLine(lineB));
  });

  it("different message text", () => {
    const lineA = '{"level":"error","msg":"database connection refused"}';
    const lineB = '{"level":"error","msg":"upstream timeout"}';

    expect(normalizeLine(lineA)).not.toBe(normalizeLine(lineB));
  });

  it("different plain-text messages", () => {
    expect(normalizeLine("disk full on /var")).not.toBe(normalizeLine("out of memory in worker"));
  });

  it("an extra field makes lines different", () => {
    const lineB = '{"time":"2026-11-15T10:02:11Z","level":"error","route":"/error","status":500,"duration_ms":312,"user":"x"}';

    expect(normalizeLine(sample)).not.toBe(normalizeLine(lineB));
  });
});

describe("normalizeLine stays fast on hostile input", () => {
  // Each input repeats a pattern's trigger so that an unbounded quantifier would
  // backtrack once per repetition (quadratic). ~200 KB lines must stay well under a second.
  it.each([
    ["plain text", "a".repeat(200_000)],
    ["one long digit run", "1".repeat(200_000)],
    ["one long hex run", "ab".repeat(100_000)],
    ["repeated timestamp prefix", "2026-11-15T10:02:".repeat(12_000)],
    ["repeated UUID prefix", "550e8400-e29b-41d4-".repeat(10_000)],
    ["repeated IPv4 prefix", "10.0.0.".repeat(28_000)],
    ["repeated number and space", "123456789012 ".repeat(15_000)],
    ["repeated duration prefix", "123456789012.123456 ".repeat(10_000)],
    ["long whitespace runs", ("a" + " ".repeat(100)).repeat(1_900)],
    ["huge JSON string value", '{"msg":"' + "a1 ".repeat(66_000) + '"}'],
    ["huge JSON string of repeated hex", '{"msg":"' + "deadbeef".repeat(25_000) + '"}'],
    ["many JSON keys", "{" + Array.from({ length: 15_000 }, (_, i) => `"k${i}":${i}`).join(",") + "}"],
    ["deeply nested JSON array", '{"a":' + "[".repeat(100_000) + "]".repeat(100_000) + "}"],
    ["malformed JSON that falls back to text", '{"msg":"' + "2026-11-15T10:02:11Z ".repeat(9_000)],
  ])("stays fast on %s", (_label, input) => {
    const start = performance.now();
    normalizeLine(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("normalizeLine is idempotent", () => {
  it.each([
    ["demo-app JSON line", sample],
    ["JSON with camelCase keys", '{"level":"error","traceId":"abc","ts":1,"elapsedMs":12}'],
    ["JSON with nested objects and arrays", '{"a":{"time":"x","b":[{"id":"1"},{"z":"2026-11-15T10:02:11Z"}]}}'],
    ["JSON with a UUID and IP in a string", '{"msg":"user 550e8400-e29b-41d4-a716-446655440000 from 10.0.0.5:8080 took 312ms"}'],
    ["plain text with timestamp, IP and duration", "2026-11-15 10:02:11 GET /users from 10.0.0.5 took 312ms"],
    ["plain text with duration_ms=", "route=/slow duration_ms=312 status=500"],
    ["malformed JSON (falls back to text)", '{"level":"error","msg":'],
    ["extra whitespace", "  GET   /users \t took  312ms  "],
    ["empty string", ""],
  ])("%s", (_name, input) => {
    const once = normalizeLine(input);

    expect(normalizeLine(once)).toBe(once);
  });
});
