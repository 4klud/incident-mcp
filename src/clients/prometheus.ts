import { config } from "../config.js";

const FETCH_TIMEOUT_MS = 10_000;

export interface PrometheusSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Prometheus request failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryRange(params: {
  query: string;
  startSec: number;
  endSec: number;
  stepSec: number;
}): Promise<PrometheusSeries[]> {
  const { query, startSec, endSec, stepSec } = params;
  const url = new URL("/api/v1/query_range", config.prometheusUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("start", String(startSec));
  url.searchParams.set("end", String(endSec));
  url.searchParams.set("step", String(stepSec));

  const body = await fetchJson(url.toString());
  if (body.status !== "success") {
    throw new Error(`Prometheus query error: ${JSON.stringify(body)}`);
  }
  return body.data.result as PrometheusSeries[];
}

export async function listLabelValues(label: string): Promise<string[]> {
  const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, config.prometheusUrl);
  const body = await fetchJson(url.toString());
  if (body.status !== "success") {
    throw new Error(`Prometheus label query error: ${JSON.stringify(body)}`);
  }
  return body.data as string[];
}
