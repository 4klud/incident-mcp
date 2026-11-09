import { config } from "../config.js";

const FETCH_TIMEOUT_MS = 10_000;
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;

export interface DockerContainerSummary {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
}

// Deliberately a narrow shape: Config.Env (which may hold secrets) is never
// copied out of the raw inspect response.
export interface DockerContainerInspect {
  id: string;
  name: string;
  image: string;
  restartCount: number;
  state: {
    status: string;
    running: boolean;
    restarting: boolean;
    oomKilled: boolean;
    dead: boolean;
    exitCode: number;
    error: string;
    startedAt: string;
    finishedAt: string;
    health: string | null;
  };
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Docker request failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Lists ALL containers (running or not) for a compose service. Exited,
// restarting and dead containers are exactly what incident triage needs.
export async function listContainers(service: string): Promise<DockerContainerSummary[]> {
  const url = new URL("/containers/json", config.dockerUrl);
  url.searchParams.set("all", "true");
  url.searchParams.set("filters", JSON.stringify({ label: [`${COMPOSE_SERVICE_LABEL}=${service}`] }));

  const body = await fetchJson(url.toString());
  return (body as any[]).map((c) => ({
    id: c.Id,
    names: c.Names,
    image: c.Image,
    state: c.State,
    status: c.Status,
  }));
}

export async function inspectContainer(id: string): Promise<DockerContainerInspect> {
  if (!CONTAINER_ID_PATTERN.test(id)) {
    throw new Error("Invalid container id");
  }
  const url = new URL(`/containers/${id}/json`, config.dockerUrl);

  const c = await fetchJson(url.toString());
  return {
    id: c.Id,
    name: c.Name,
    image: c.Config?.Image,
    restartCount: c.RestartCount,
    state: {
      status: c.State?.Status,
      running: c.State?.Running,
      restarting: c.State?.Restarting,
      oomKilled: c.State?.OOMKilled,
      dead: c.State?.Dead,
      exitCode: c.State?.ExitCode,
      error: c.State?.Error,
      startedAt: c.State?.StartedAt,
      finishedAt: c.State?.FinishedAt,
      health: c.State?.Health?.Status ?? null,
    },
  };
}
