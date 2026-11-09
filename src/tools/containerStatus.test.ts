import { describe, it, expect, vi, beforeEach } from "vitest";
import * as docker from "../clients/docker.js";
import type { DockerContainerInspect, DockerContainerSummary } from "../clients/docker.js";
import { containerStatus, containerStatusInputSchema } from "./containerStatus.js";

vi.mock("../clients/docker.js", () => ({
  listContainers: vi.fn(),
  inspectContainer: vi.fn(),
}));

function summary(id: string): DockerContainerSummary {
  return { id, names: [`/${id}`], image: "img", state: "running", status: "Up" };
}

function inspected(id: string, overrides: Partial<DockerContainerInspect["state"]> = {}): DockerContainerInspect {
  return {
    id,
    name: `/${id}`,
    image: "lab-demo-app",
    restartCount: 0,
    state: {
      status: "running",
      running: true,
      restarting: false,
      oomKilled: false,
      dead: false,
      exitCode: 0,
      error: "",
      startedAt: "2026-11-04T23:32:05.538004304Z",
      finishedAt: "0001-01-01T00:00:00Z",
      health: null,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.mocked(docker.listContainers).mockReset();
  vi.mocked(docker.inspectContainer).mockReset();
});

describe("containerStatus output shaping", () => {
  it("returns only the allowlisted fields, with the leading slash stripped from the name", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue([summary("abc")]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(inspected("abc"));

    const result = await containerStatus({ service: "demo-app" });

    expect(result).toEqual({
      service: "demo-app",
      found: true,
      containers: [
        {
          name: "abc",
          image: "lab-demo-app",
          state: "running",
          health: null,
          restartCount: 0,
          oomKilled: false,
          exitCode: 0,
          error: null,
          startedAt: "2026-11-04T23:32:05.538004304Z",
          finishedAt: null,
        },
      ],
      totalContainers: 1,
      truncated: false,
      inspectFailed: 0,
    });
  });

  it("never returns fields outside the allowlist, even if the client leaks them", async () => {
    const leaky = { ...inspected("abc"), Env: ["DB_PASSWORD=hunter2"], Config: { Env: ["TOKEN=secret"] } };
    vi.mocked(docker.listContainers).mockResolvedValue([summary("abc")]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(leaky as DockerContainerInspect);

    const text = JSON.stringify(await containerStatus({ service: "demo-app" }));

    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Env");
  });

  it("turns Docker's zero timestamp into null for both started and finished", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue([summary("abc")]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(
      inspected("abc", { startedAt: "0001-01-01T00:00:00Z", finishedAt: "0001-01-01T00:00:00Z" }),
    );

    const result = await containerStatus({ service: "demo-app" });

    expect(result.containers[0]).toMatchObject({ startedAt: null, finishedAt: null });
  });

  it("reports a crashed container's failure details", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue([summary("abc")]);
    vi.mocked(docker.inspectContainer).mockResolvedValue({
      ...inspected("abc", {
        status: "exited",
        running: false,
        oomKilled: true,
        exitCode: 137,
        error: "OOM",
        finishedAt: "2026-11-09T10:00:00Z",
      }),
      restartCount: 4,
    });

    const result = await containerStatus({ service: "demo-app" });

    expect(result.containers[0]).toMatchObject({
      state: "exited",
      oomKilled: true,
      exitCode: 137,
      error: "OOM",
      restartCount: 4,
      finishedAt: "2026-11-09T10:00:00Z",
    });
  });
});

describe("containerStatus lookup", () => {
  it("passes the service name to the Docker client", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue([summary("abc")]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(inspected("abc"));

    await containerStatus({ service: "demo-app" });

    expect(docker.listContainers).toHaveBeenCalledWith("demo-app");
    expect(docker.inspectContainer).toHaveBeenCalledWith("abc");
  });

  it("returns found: false with a hint for an unknown service, and inspects nothing", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue([]);

    const result = await containerStatus({ service: "nope" });

    expect(result).toMatchObject({ service: "nope", found: false, containers: [], truncated: false, inspectFailed: 0 });
    expect(result).toHaveProperty("hint", expect.stringContaining("list_services"));
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  it("wraps a failure to reach the Docker proxy in a clear error", async () => {
    vi.mocked(docker.listContainers).mockRejectedValue(new Error("fetch failed"));

    await expect(containerStatus({ service: "demo-app" })).rejects.toThrow(
      /Could not reach the Docker proxy: fetch failed/,
    );
  });
});

describe("containerStatus limits", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

  it("inspects at most 10 containers and says it truncated", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue(ids(12).map(summary));
    vi.mocked(docker.inspectContainer).mockImplementation(async (id) => inspected(id));

    const result = await containerStatus({ service: "demo-app" });

    expect(docker.inspectContainer).toHaveBeenCalledTimes(10);
    expect(result.containers).toHaveLength(10);
    expect(result.totalContainers).toBe(12);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation at exactly 10 containers", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue(ids(10).map(summary));
    vi.mocked(docker.inspectContainer).mockImplementation(async (id) => inspected(id));

    const result = await containerStatus({ service: "demo-app" });

    expect(result.containers).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it("keeps the other containers when one inspect fails, and counts the failure", async () => {
    vi.mocked(docker.listContainers).mockResolvedValue(ids(3).map(summary));
    vi.mocked(docker.inspectContainer).mockImplementation(async (id) => {
      if (id === "c1") throw new Error("No such container");
      return inspected(id);
    });

    const result = await containerStatus({ service: "demo-app" });

    expect(result.containers.map((c) => c.name)).toEqual(["c0", "c2"]);
    expect(result.inspectFailed).toBe(1);
  });

  it("returns found: true with no containers when every inspect fails (known gap)", async () => {
    // Arguably misleading: containers exist but none could be read. Recorded, not fixed.
    vi.mocked(docker.listContainers).mockResolvedValue(ids(2).map(summary));
    vi.mocked(docker.inspectContainer).mockRejectedValue(new Error("gone"));

    const result = await containerStatus({ service: "demo-app" });

    expect(result).toMatchObject({ found: true, containers: [], inspectFailed: 2 });
  });
});

describe("containerStatusInputSchema", () => {
  it.each(["demo-app", "loki", "my_service.v2", "a"])("accepts %s", (service) => {
    expect(containerStatusInputSchema.safeParse({ service }).success).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["leading dash", "-demo"],
    ["spaces", "demo app"],
    ["quote and brace", 'a"}'],
    ["path traversal", "../etc"],
    ["over 63 chars", "a".repeat(64)],
  ])("rejects %s", (_label, service) => {
    expect(containerStatusInputSchema.safeParse({ service }).success).toBe(false);
  });

  it("requires service", () => {
    expect(containerStatusInputSchema.safeParse({}).success).toBe(false);
  });
});
