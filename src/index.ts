import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { queryMetrics, queryMetricsInputSchema } from "./tools/queryMetrics.js";
import { queryLogs, queryLogsInputSchema } from "./tools/queryLogs.js";
import { listServices, listServicesInputSchema } from "./tools/listServices.js";
import { containerStatus, containerStatusInputSchema } from "./tools/containerStatus.js";

const server = new McpServer({
  name: "incident-mcp",
  version: "1.0.0",
});

server.registerTool(
  "list_services",
  {
    description: "List known service names visible in Prometheus and/or Loki, with which signal types each has.",
    inputSchema: listServicesInputSchema.shape,
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const result = await listServices(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  "query_metrics",
  {
    description: "Run a PromQL range query against the metrics backend. Bounded to a 6h max range and 2000 points per series.",
    inputSchema: queryMetricsInputSchema.shape,
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const result = await queryMetrics(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  "query_logs",
  {
    description: "Run a LogQL query against the logs backend. Must scope to a service label. Bounded to a 6h max range and 500 lines. Secrets in returned lines and labels are redacted on a best-effort basis.",
    inputSchema: queryLogsInputSchema.shape,
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const result = await queryLogs(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  "container_status",
  {
    description:
      "Show the current state of a service's Docker containers: state (running/exited/restarting), health, restart count, OOM-killed flag, exit code, and start/finish times. " +
      "Use this first when a service looks down, is erroring, or may be crash-looping, to tell a restart or OOM kill from an application bug. " +
      "Includes stopped containers. Read-only: returns at most 10 containers per service (reports truncated: true if more) and never returns environment variables. " +
      "Returns found: false if no container matches; call list_services for valid names. " +
      'Example: service="demo-app".',
    inputSchema: containerStatusInputSchema.shape,
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const result = await containerStatus(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting incident-mcp server:", err);
  process.exit(1);
});
