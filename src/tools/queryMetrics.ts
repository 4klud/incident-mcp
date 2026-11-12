import { z } from "zod";
import * as prometheus from "../clients/prometheus.js";
import { hasPromqlServiceScope } from "../guardrails.js";

const MAX_RANGE_SEC = 6 * 60 * 60;
const MIN_STEP_SEC = 5;
const MAX_POINTS = 2000;

export const queryMetricsInputSchema = z.object({
  query: z.string().min(1).describe("A PromQL query; every metric selector must include service=\"<name>\", e.g. sum(rate(http_requests_total{service=\"demo-app\"}[1m])) by (route)"),
  startSec: z.number().int().describe("Range start, Unix seconds"),
  endSec: z.number().int().describe("Range end, Unix seconds"),
  stepSec: z.number().int().min(MIN_STEP_SEC).default(15).describe("Resolution step in seconds, minimum 5"),
});

export type QueryMetricsInput = z.infer<typeof queryMetricsInputSchema>;

export async function queryMetrics(input: QueryMetricsInput) {
  const { query, startSec, endSec, stepSec } = input;

  if (!hasPromqlServiceScope(query)) {
    throw new Error(
      'Query must be scoped to a service: every metric selector needs a service="<name>" matcher, e.g. up{service="demo-app"}. Bare metric names and service=~"..." are not allowed. Call list_services for valid names.'
    );
  }
  if (endSec <= startSec) {
    throw new Error("endSec must be after startSec");
  }
  const rangeSec = endSec - startSec;
  if (rangeSec > MAX_RANGE_SEC) {
    throw new Error(`Range too large: ${rangeSec}s exceeds max of ${MAX_RANGE_SEC}s (6h)`);
  }
  const estimatedPoints = Math.ceil(rangeSec / stepSec);
  if (estimatedPoints > MAX_POINTS) {
    throw new Error(
      `Query would return ~${estimatedPoints} points per series, exceeding max of ${MAX_POINTS}. Increase stepSec or shrink the range.`
    );
  }

  const series = await prometheus.queryRange({ query, startSec, endSec, stepSec });
  return { series };
}
