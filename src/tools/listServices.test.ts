import { describe, it, expect, vi, beforeEach } from "vitest";
import * as prometheus from "../clients/prometheus.js";
import * as loki from "../clients/loki.js";
import { listServices } from "./listServices.js";

vi.mock("../clients/prometheus.js", () => ({
  listLabelValues: vi.fn(),
}));
vi.mock("../clients/loki.js", () => ({
  listLabelValues: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(prometheus.listLabelValues).mockReset();
  vi.mocked(loki.listLabelValues).mockReset();
});

describe("listServices", () => {
  it("unions services from both backends and flags which signals each has", async () => {
    vi.mocked(prometheus.listLabelValues).mockResolvedValue(["demo-app"]);
    vi.mocked(loki.listLabelValues).mockResolvedValue(["demo-app", "grafana"]);

    const result = await listServices({});

    expect(result.services).toEqual([
      { name: "demo-app", hasMetrics: true, hasLogs: true },
      { name: "grafana", hasMetrics: false, hasLogs: true },
    ]);
  });

  it("returns an empty list when neither backend has services", async () => {
    vi.mocked(prometheus.listLabelValues).mockResolvedValue([]);
    vi.mocked(loki.listLabelValues).mockResolvedValue([]);

    const result = await listServices({});

    expect(result.services).toEqual([]);
  });
});
