import { z } from "zod";
import * as loki from "../clients/loki.js";

const MAX_RANGE_SEC = 6 * 60 * 60;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export const queryLogsInputSchema = z.object({
  query: z.string().min(1).describe("A LogQL query, e.g. {service=\"demo-app\"} | json | status=\"500\""),
  startSec: z.number().int().describe("Range start, Unix seconds"),
  endSec: z.number().int().describe("Range end, Unix seconds"),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe(`Max log lines to return, up to ${MAX_LIMIT}`),
});

export type QueryLogsInput = z.infer<typeof queryLogsInputSchema>;

export async function queryLogs(input: QueryLogsInput) {
  const { query, startSec, endSec, limit } = input;

  if (endSec <= startSec) {
    throw new Error("endSec must be after startSec");
  }
  const rangeSec = endSec - startSec;
  if (rangeSec > MAX_RANGE_SEC) {
    throw new Error(`Range too large: ${rangeSec}s exceeds max of ${MAX_RANGE_SEC}s (6h)`);
  }
  if (!query.includes('service=')) {
    throw new Error('Query must scope to a service label, e.g. {service="demo-app"}');
  }

  const streams = await loki.queryRange({
    query,
    startNs: BigInt(startSec) * 1_000_000_000n,
    endNs: BigInt(endSec) * 1_000_000_000n,
    limit,
  });
  return { streams };
}
