import { z } from "zod";
import * as docker from "../clients/docker.js";
import type { DockerContainerInspect } from "../clients/docker.js";
import { redactSecrets } from "../guardrails.js";

const MAX_CONTAINERS = 10;
// Docker reports this timestamp for "never happened" (e.g. finishedAt of a running container).
const DOCKER_ZERO_TIME_PREFIX = "0001-01-01";

export const containerStatusInputSchema = z.object({
  service: z
    .string()
    .max(63)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Must be a compose service name, e.g. demo-app")
    .describe('Compose service name, e.g. "demo-app". Use list_services to find valid names.'),
});

export type ContainerStatusInput = z.infer<typeof containerStatusInputSchema>;

function nullIfNever(timestamp: string | undefined): string | null {
  if (!timestamp || timestamp.startsWith(DOCKER_ZERO_TIME_PREFIX)) {
    return null;
  }
  return timestamp;
}

// Allowlist: only these fields ever leave the tool.
function shapeContainer(c: DockerContainerInspect) {
  return {
    name: c.name.replace(/^\//, ""),
    image: c.image,
    state: c.state.status,
    health: c.state.health,
    restartCount: c.restartCount,
    oomKilled: c.state.oomKilled,
    exitCode: c.state.exitCode,
    // Free text from the Docker daemon: the only non-enumerated string in the output.
    error: c.state.error ? redactSecrets(c.state.error) : null,
    startedAt: nullIfNever(c.state.startedAt),
    finishedAt: nullIfNever(c.state.finishedAt),
  };
}

export async function containerStatus(input: ContainerStatusInput) {
  const { service } = input;

  let listed: docker.DockerContainerSummary[];
  try {
    listed = await docker.listContainers(service);
  } catch (err) {
    throw new Error(
      `Could not reach the Docker proxy: ${err instanceof Error ? err.message : String(err)}. Is the lab running?`,
    );
  }

  if (listed.length === 0) {
    return {
      service,
      found: false,
      hint: `No containers found for service "${service}". Call list_services to see valid service names.`,
      containers: [],
      truncated: false,
      inspectFailed: 0,
    };
  }

  const selected = listed.slice(0, MAX_CONTAINERS);
  // allSettled: a container can vanish between list and inspect during an incident.
  const results = await Promise.allSettled(selected.map((c) => docker.inspectContainer(c.id)));

  const containers = [];
  let inspectFailed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      containers.push(shapeContainer(r.value));
    } else {
      inspectFailed++;
    }
  }

  return {
    service,
    found: true,
    containers,
    totalContainers: listed.length,
    truncated: listed.length > MAX_CONTAINERS,
    inspectFailed,
  };
}
