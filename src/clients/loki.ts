import { config } from "../config.js";

const FETCH_TIMEOUT_MS = 10_000;

export interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Loki request failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryRange(params: {
  query: string;
  startNs: bigint;
  endNs: bigint;
  limit: number;
}): Promise<LokiStream[]> {
  const { query, startNs, endNs, limit } = params;
  const url = new URL("/loki/api/v1/query_range", config.lokiUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());
  url.searchParams.set("limit", String(limit));

  const body = await fetchJson(url.toString());
  if (body.status !== "success") {
    throw new Error(`Loki query error: ${JSON.stringify(body)}`);
  }
  return body.data.result as LokiStream[];
}

export async function listLabelValues(label: string): Promise<string[]> {
  const url = new URL(`/loki/api/v1/label/${encodeURIComponent(label)}/values`, config.lokiUrl);
  const body = await fetchJson(url.toString());
  if (body.status !== "success") {
    throw new Error(`Loki label query error: ${JSON.stringify(body)}`);
  }
  return body.data as string[];
}
