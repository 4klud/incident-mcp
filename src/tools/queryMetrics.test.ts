import { describe, it, expect, vi, beforeEach } from "vitest";
import * as prometheus from "../clients/prometheus.js";
import { queryMetrics } from "./queryMetrics.js";

vi.mock("../clients/prometheus.js", () => ({
  queryRange: vi.fn(),
}));

const UP = 'up{service="demo-app"}';

beforeEach(() => {
  vi.mocked(prometheus.queryRange).mockReset();
  vi.mocked(prometheus.queryRange).mockResolvedValue([]);
});

describe("queryMetrics guardrails", () => {
  it("rejects endSec before or equal to startSec", async () => {
    await expect(
      queryMetrics({ query: UP, startSec: 100, endSec: 100, stepSec: 15 })
    ).rejects.toThrow("endSec must be after startSec");
  });

  it("rejects a range larger than 6 hours", async () => {
    const sixHours = 6 * 60 * 60;
    await expect(
      queryMetrics({ query: UP, startSec: 0, endSec: sixHours + 1, stepSec: 15 })
    ).rejects.toThrow(/Range too large/);
  });

  it("allows a range exactly at the 6 hour boundary", async () => {
    const sixHours = 6 * 60 * 60;
    await expect(
      queryMetrics({ query: UP, startSec: 0, endSec: sixHours, stepSec: 60 })
    ).resolves.toEqual({ series: [] });
  });

  it("rejects a step too small for the range (over 2000 points)", async () => {
    await expect(
      queryMetrics({ query: UP, startSec: 0, endSec: 20000, stepSec: 5 })
    ).rejects.toThrow(/exceeding max of 2000/);
  });

  it("allows a range/step combination right at the 2000 point boundary", async () => {
    await expect(
      queryMetrics({ query: UP, startSec: 0, endSec: 10000, stepSec: 5 })
    ).resolves.toEqual({ series: [] });
  });

  it("passes validated params through to the Prometheus client", async () => {
    await queryMetrics({ query: UP, startSec: 0, endSec: 60, stepSec: 15 });
    expect(prometheus.queryRange).toHaveBeenCalledWith({
      query: UP,
      startSec: 0,
      endSec: 60,
      stepSec: 15,
    });
  });
});

describe("queryMetrics service scoping", () => {
  const rejected = [
    "up",
    "sum(rate(http_requests_total[1m]))",
    'up{job="x"}',
    'up{service=~".+"}',
    'up{service=""}',
    'up{service!="a"}',
    'up{service="a"} or up',
    'up{service="a"} + on(job) group_left other_metric',
    "{}",
  ];
  it.each(rejected)("rejects unscoped query: %s", async (query) => {
    await expect(queryMetrics({ query, startSec: 0, endSec: 60, stepSec: 15 })).rejects.toThrow(
      /scoped to a service/
    );
    expect(prometheus.queryRange).not.toHaveBeenCalled();
  });

  it("allows a scoped query and calls Prometheus", async () => {
    const query = 'sum(rate(http_requests_total{service="demo-app"}[1m])) by (status)';
    await queryMetrics({ query, startSec: 0, endSec: 60, stepSec: 15 });
    expect(prometheus.queryRange).toHaveBeenCalledOnce();
  });
});
