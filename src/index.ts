import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { queryMetrics, queryMetricsInputSchema } from "./tools/queryMetrics.js";
import { queryLogs, queryLogsInputSchema } from "./tools/queryLogs.js";
import { listServices, listServicesInputSchema } from "./tools/listServices.js";

const server = new McpServer({
  name: "incident-mcp",
  version: "1.0.0",
});

server.registerTool(
  "list_services",
  {
    description: "List known service names visible in Prometheus and/or Loki, with which signal types each has.",
    inputSchema: listServicesInputSchema.shape,
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
  },
  async (input) => {
    const result = await queryMetrics(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  "query_logs",
  {
    description: "Run a LogQL query against the logs backend. Must scope to a service label. Bounded to a 6h max range and 500 lines.",
    inputSchema: queryLogsInputSchema.shape,
  },
  async (input) => {
    const result = await queryLogs(input);
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
