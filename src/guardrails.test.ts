import { describe, it, expect } from "vitest";
import { extractStreamSelectors, hasServiceScope } from "./guardrails.js";

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
