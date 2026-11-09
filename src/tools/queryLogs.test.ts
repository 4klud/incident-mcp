import { describe, it, expect, vi, beforeEach } from "vitest";
import * as loki from "../clients/loki.js";
import { queryLogs } from "./queryLogs.js";

vi.mock("../clients/loki.js", () => ({
  queryRange: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loki.queryRange).mockReset();
  vi.mocked(loki.queryRange).mockResolvedValue([]);
});

describe("queryLogs guardrails", () => {
  it("rejects endSec before or equal to startSec", async () => {
    await expect(
      queryLogs({ query: '{service="demo-app"}', startSec: 100, endSec: 100, limit: 10 })
    ).rejects.toThrow("endSec must be after startSec");
  });

  it("rejects a range larger than 6 hours", async () => {
    const sixHours = 6 * 60 * 60;
    await expect(
      queryLogs({ query: '{service="demo-app"}', startSec: 0, endSec: sixHours + 1, limit: 10 })
    ).rejects.toThrow(/Range too large/);
  });

  it("allows a range exactly at the 6 hour boundary", async () => {
    const sixHours = 6 * 60 * 60;
    await expect(
      queryLogs({ query: '{service="demo-app"}', startSec: 0, endSec: sixHours, limit: 10 })
    ).resolves.toEqual({ streams: [] });
  });

  it("rejects a query with no service label", async () => {
    await expect(
      queryLogs({ query: '{job="x"}', startSec: 0, endSec: 60, limit: 10 })
    ).rejects.toThrow(/Query must scope to a service label/);
  });

  it("rejects a query whose label merely ends in 'service' (other_service)", async () => {
    await expect(
      queryLogs({ query: '{other_service="x"}', startSec: 0, endSec: 60, limit: 10 })
    ).rejects.toThrow(/Query must scope to a service label/);
  });

  it("rejects a regex service matcher that matches every service", async () => {
    await expect(
      queryLogs({ query: '{service=~".+"}', startSec: 0, endSec: 60, limit: 10 })
    ).rejects.toThrow(/Query must scope to a service label/);
  });

  it("converts seconds to nanoseconds for the Loki client", async () => {
    await queryLogs({ query: '{service="demo-app"}', startSec: 10, endSec: 70, limit: 5 });
    expect(loki.queryRange).toHaveBeenCalledWith({
      query: '{service="demo-app"}',
      startNs: 10_000_000_000n,
      endNs: 70_000_000_000n,
      limit: 5,
    });
  });
});
