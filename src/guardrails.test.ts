import { describe, it, expect } from "vitest";
import {
  extractStreamSelectors,
  hasPromqlServiceScope,
  hasServiceScope,
  redactRecord,
  redactSecrets,
} from "./guardrails.js";

describe("hasServiceScope accepts scoped queries", () => {
  it.each([
    ['plain selector', '{service="demo-app"}'],
    ['extra matchers', '{service="demo-app", level="error"}'],
    ['service not first', '{level="error", service="demo-app"}'],
    ['spaces around operator', '{ service = "demo-app" }'],
    ['backtick value', "{service=`demo-app`}"],
    ['with a pipeline', '{service="demo-app"} | json | status="500"'],
    ['with a line filter', '{service="demo-app"} |= "timeout"'],
    ['metric query', 'sum(rate({service="demo-app"} |= "error" [5m]))'],
    ['two scoped selectors', 'sum(rate({service="a"}[5m])) / sum(rate({service="b"}[5m]))'],
    ['braces inside a line filter', '{service="demo-app"} |= "{not a selector}"'],
    ['regex quantifier in a string', '{service="demo-app"} |~ "\\\\d{3}"'],
    ['escaped quote in a value', '{service="demo-app", msg="a\\"}b"}'],
  ])("%s", (_label, query) => {
    expect(hasServiceScope(query)).toBe(true);
  });
});

describe("hasServiceScope rejects unscoped queries", () => {
  it.each([
    ['no selector at all', 'error'],
    ['empty selector', '{}'],
    ['different label', '{job="x"}'],
    ['label that merely ends in service (the known gap)', '{other_service="x"}'],
    ['label that merely starts with service', '{service_name="x"}'],
    ['"service=" only in a line filter', '{job="x"} |= "service="'],
    ['"service=" only in a label value', '{job="service=demo-app"}'],
    ['regex matcher', '{service=~".+"}'],
    ['negative matcher', '{service!="demo-app"}'],
    ['negative regex matcher', '{service!~"demo-app"}'],
    ['empty value', '{service=""}'],
    ['empty backtick value', "{service=``}"],
    ['one scoped, one unscoped selector', 'sum(rate({service="a"}[5m])) + sum(rate({job="b"}[5m]))'],
    ['scoped selector only inside a comment', '{job="x"} # {service="a"}'],
  ])("%s", (_label, query) => {
    expect(hasServiceScope(query)).toBe(false);
  });

  it.each([
    ['unbalanced open brace', '{service="demo-app"'],
    ['stray close brace', '{service="demo-app"}}'],
    ['unterminated string', '{service="demo-app'],
    ['nested braces', '{service="demo-app", {x="y"}}'],
  ])("fails closed on %s", (_label, query) => {
    expect(hasServiceScope(query)).toBe(false);
  });
});

describe("extractStreamSelectors", () => {
  it("returns each selector body", () => {
    expect(extractStreamSelectors('{a="1"} | x or {b="2"}')).toEqual(['a="1"', 'b="2"']);
  });

  it("ignores braces inside strings and comments", () => {
    expect(extractStreamSelectors('{a="1"} |= "{b}" # {c="3"}')).toEqual(['a="1"']);
  });

  it("returns null when the query can't be scanned", () => {
    expect(extractStreamSelectors('{a="1"')).toBeNull();
  });
});

describe("hasPromqlServiceScope accepts scoped queries", () => {
  const accepted = [
    'up{service="demo-app"}',
    'sum(rate(http_requests_total{service="demo-app"}[1m])) by (status)',
    'sum by (status) (rate(http_requests_total{service="demo-app",status=~"5.."}[5m]))',
    'rate(x{service="a"}[5m]) / on(instance) group_left rate(y{service="a"}[5m])',
    'histogram_quantile(0.95, sum(rate(h_bucket{service="a"}[5m])) by (le))',
    'x{service="a"} offset 5m',
    'x{service="a"} > bool 0.5',
    'x{service="a"} # up',
    '{__name__="up", service="a"}',
    'avg_over_time(x{service="a"}[30m:1m])',
  ];
  it.each(accepted)("accepts %s", (q) => expect(hasPromqlServiceScope(q)).toBe(true));
});

describe("hasPromqlServiceScope rejects unscoped or unparseable queries", () => {
  const rejected = [
    "up",
    "",
    "1 + 1",
    'up{job="x"}',
    'up{other_service="a"}',
    'up{service=~"a|b"}',
    'up{service=~".+"}',
    'up{service!="a"}',
    'up{service=""}',
    "up{}",
    'up{service="a"} or up',
    'up{service="a"} or {job="x"}',
    "up{service='a'}", // known gap: single-quoted label values are not accepted (fails closed)
    'sum(rate(a{service="a"}[1m])) / sum(rate(b[1m]))',
    'x{service="a"} + on(job) group_left y',
    'x{service="a"} unless y',
    'sum without (service) (up)',
    'up{service="a"',
    'up{service="a}',
    'up{service="a"}}',
    'label_replace(up, "service", "a", "job", ".*")',
    'up{job="service=\"a\""}',
    '"up{service=\"a\"}"',
    '# up{service="a"}\nup',
  ];
  it.each(rejected)("rejects %s", (q) => expect(hasPromqlServiceScope(q)).toBe(false));
});

describe("hasPromqlServiceScope speed", () => {
  it("scans hostile long queries in linear time", () => {
    const inputs = [
      "a ".repeat(100_000),
      "sum ".repeat(50_000),
      "(".repeat(100_000),
      'x{service="a"} or '.repeat(20_000) + "up",
      "by (".repeat(50_000),
    ];
    const start = performance.now();
    for (const q of inputs) hasPromqlServiceScope(q);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("redactSecrets redacts", () => {
  it.each([
    ["key=value", "login password=hunter2 ok", "login password=[REDACTED] ok"],
    ["key: value", "password: hunter2", "password: [REDACTED]"],
    ["a compound key name", "DB_PASSWORD=hunter2", "DB_PASSWORD=[REDACTED]"],
    ["an uppercase key", "API_KEY=abc123", "API_KEY=[REDACTED]"],
    ["a hyphenated header key", "x-api-key: abc123", "x-api-key: [REDACTED]"],
    ["a JSON value", '{"password":"hunter2","user":"bob"}', '{"password":[REDACTED],"user":"bob"}'],
    ["a quoted value with spaces", 'secret="two words"', "secret=[REDACTED]"],
    ["a quoted value with an escaped quote", 'token="ab\\"cd" rest', "token=[REDACTED] rest"],
    ["a query-string value", "GET /cb?token=abc123&x=1", "GET /cb?token=[REDACTED]&x=1"],
    ["an Authorization Bearer header", "Authorization: Bearer abc.def-123", "Authorization: [REDACTED]"],
    ["an Authorization Basic header", "Authorization: Basic dXNlcjpwYXNz", "Authorization: [REDACTED]"],
    ["a bare Bearer token", "sent Bearer abc.def-123 upstream", "sent Bearer [REDACTED] upstream"],
    ["URL credentials", "connect postgres://admin:s3cret@db:5432/app", "connect postgres://admin:[REDACTED]@db:5432/app"],
    ["an AWS access key", "key AKIAIOSFODNN7EXAMPLE used", "key [REDACTED] used"],
    ["a JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_DEF-123 done", "jwt [REDACTED] done"],
    ["a GitHub token", "pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789", "pushed with [REDACTED]"],
    ["a Slack token", "slack xoxb-1234567890-abcdefghij", "slack [REDACTED]"],
    ["an sk- style API key", "using sk-abcdefghijklmnopqrstuvwxyz123456", "using [REDACTED]"],
    [
      "a whole private key block",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----",
      "[REDACTED PRIVATE KEY]",
    ],
    ["a lone private key header", "-----BEGIN PRIVATE KEY-----", "[REDACTED PRIVATE KEY]"],
  ])("%s", (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts several secrets in one line", () => {
    const out = redactSecrets("password=a token=b postgres://u:p@h/d");
    expect(out).not.toMatch(/=a\b|=b\b|u:p@/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(3);
  });
});

describe("redactSecrets leaves ordinary text alone", () => {
  it.each([
    "GET /health 200 3ms",
    '{"time":"2026-11-09T22:23:08Z","level":"info","route":"/ok","status":200,"duration_ms":2}',
    "passenger=3 author=bob",
    "listening on http://localhost:9090/metrics",
    "",
  ])("%j", (line) => {
    expect(redactSecrets(line)).toBe(line);
  });

  it("over-redacts harmless token counters on purpose (known trade-off)", () => {
    expect(redactSecrets("tokens_used=123")).toBe("tokens_used=[REDACTED]");
  });

  it("does NOT catch a secret with no marker (known gap)", () => {
    expect(redactSecrets("user logged in with hunter2")).toBe("user logged in with hunter2");
  });

  it("does NOT catch the body lines of a multi-line key when they arrive separately (known gap)", () => {
    expect(redactSecrets("MIIBOgIBAAJBAKj34GkxFhD90")).toBe("MIIBOgIBAAJBAKj34GkxFhD90");
  });
});

describe("redactSecrets properties", () => {
  it("is idempotent", () => {
    const once = redactSecrets("password=a Authorization: Bearer xyz postgres://u:p@h/d");
    expect(redactSecrets(once)).toBe(once);
  });

  // Each input repeats a pattern's trigger so that an unbounded quantifier would
  // backtrack once per repetition (quadratic). 200 KB lines must stay well under a second.
  it.each([
    ["plain text", "a".repeat(200_000)],
    ["repeated key word", "password".repeat(25_000)],
    ["repeated key word with separators", "token-".repeat(33_000)],
    ["repeated URL credential start", "://a:".repeat(40_000)],
    ["repeated private key header", "-----BEGIN PRIVATE KEY-----".repeat(7_000)],
    ["repeated JWT prefix", "eyJaaaaa-".repeat(22_000)],
    ["one huge JWT-like word", "eyJ" + "a".repeat(200_000)],
    ["repeated Bearer", "Bearer ".repeat(28_000)],
    ["repeated long whitespace after a key", ("password" + " ".repeat(100)).repeat(1_800)],
  ])("stays fast on %s", (_label, input) => {
    const start = performance.now();
    redactSecrets(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("redactRecord", () => {
  it("hides the value of a sensitive key and scans the other values", () => {
    expect(
      redactRecord({ service: "demo-app", api_token: "abc", url: "postgres://u:p@h/d", note: "ok" }),
    ).toEqual({ service: "demo-app", api_token: "[REDACTED]", url: "postgres://u:[REDACTED]@h/d", note: "ok" });
  });
});
