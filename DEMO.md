# Demo guide

A five-minute walkthrough of incident-mcp, plus how to use the lab's web UIs and a query cheat sheet.

## 1. Setup (once)

```bash
docker compose -f lab/docker-compose.yml up -d
docker compose -f lab/docker-compose.yml ps        # everything should be "Up"
npm install && npm run build
claude mcp add incident -- node /absolute/path/to/incident-mcp/dist/index.js
```

Restart Claude Code and run `/mcp` to check that `incident` is connected.

Open these before presenting:

| What | URL | Use it for |
|---|---|---|
| Grafana | http://localhost:3000 | Provisioned `demo-app` dashboard (http://localhost:3000/d/demo-app) and Explore. Anonymous admin, no login. |
| Prometheus | http://localhost:9091 | Raw metrics and scrape health |
| Alloy | http://localhost:12345 | The pipeline that adds the `service` label |

The demo app (http://localhost:9090) is an API, not a web page. `GET /` returns "Cannot GET /", which is expected. Use its endpoints with `curl`:

| Endpoint | Effect |
|---|---|
| `/ok` | Healthy response |
| `/slow?ms=300` | Responds after a delay |
| `/error?rate=1` | Returns 500s (`rate` is the probability, 1 = always) |
| `/cpu` | Burns CPU |
| `/crash` | Kills the process; Docker restarts the container |
| `/metrics` | Prometheus metrics |

## 2. The demo (about 5 minutes)

1. **Pitch (20 s).** A read-only MCP server that lets an AI assistant investigate an incident from metrics, logs and container state. The safety rules live in the server, not the prompt.
2. **Architecture (30 s).** Show the README diagram: the guardrail box and the GET-only docker-socket-proxy.
3. **Cause an incident (30 s).**
   ```bash
   for i in $(seq 1 20); do curl -s "localhost:9090/error?rate=1" >/dev/null; curl -s "localhost:9090/slow?ms=300" >/dev/null; done
   curl -s localhost:9090/crash
   ```
   Wait about 60 seconds. Alloy scrapes container metrics every 60 s, so a query straight after a restart can be empty.
4. **Let the assistant investigate (2 min).** Ask Claude Code: *"demo-app looks unhealthy. What's going on?"* Expect `list_services`, then `container_status` (`restartCount` is up), then `query_logs` (the 500s) and `query_metrics` (request rate by status). Narrate each call: one question, three data sources, joined on the `service` label.
5. **Break a guardrail on purpose (1 min).** Ask it to run:
   - `query_logs` with `{other_service="x"}`
   - `query_metrics` with `up`
   - `query_metrics` over the last 24 hours

   Each is rejected with a clear error. The server parses the queries, so this doesn't depend on the model behaving. To show the read-only claim:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:2375/containers/json                    # 200
   curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:2375/containers/demo-app/stop   # 403
   ```
6. **Optional, no LLM:** `npx @modelcontextprotocol/inspector node dist/index.js`, then call each tool by hand under Tools.

## 3. Using the UIs

### Prometheus (http://localhost:9091)
- **Status → Targets**: is scraping working? `demo-app` should be UP. First place to look when a query is empty.
- **Query**: type an expression, Execute, then switch between Table and Graph.
- **Status → Configuration**: the loaded scrape config.

Compare what you see here with what `query_metrics` returns. It's the same data.

### Alloy (http://localhost:12345)
- **Components** lists every block from `lab/alloy/config.alloy` with its health.
- **Graph** draws the pipeline: `prometheus.exporter.cadvisor` → `prometheus.scrape` → `prometheus.relabel "service_label"` → `prometheus.remote_write`.
- Click `prometheus.relabel.service_label` to see the rule that turns `container_label_com_docker_compose_service` into `service`. This is the key idea: the join label comes from Docker, so apps can't spoof it.
- Click `discovery.relabel.containers` or `loki.source.docker` for the log side.
- An Unhealthy component here is the first thing to check when metrics or logs stop flowing.

### Grafana (http://localhost:3000)
- Open the **demo-app** dashboard: request rate, error rate, p95 latency and logs.
- **Explore** has the Prometheus and Loki data sources already provisioned.

## 4. Query cheat sheet

The demo app exposes `http_requests_total{route,status}` and `http_request_duration_seconds` (histogram, label `route`). Its logs are JSON with `time`, `level`, `route`, `status` and `duration_ms`. Container metrics come from Alloy's cAdvisor.

Through the MCP tools, every selector must include `service="<name>"` with a plain `=`.

### PromQL

```promql
up{service="demo-app"}
sum(rate(http_requests_total{service="demo-app"}[1m])) by (status)
sum(rate(http_requests_total{service="demo-app"}[1m])) by (route)
sum(rate(http_requests_total{service="demo-app",status=~"5.."}[1m]))
sum(rate(http_requests_total{service="demo-app",status=~"5.."}[1m])) / sum(rate(http_requests_total{service="demo-app"}[1m]))
increase(http_requests_total{service="demo-app",status="500"}[10m])
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="demo-app"}[5m])) by (le))
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="demo-app"}[5m])) by (le, route))
rate(http_request_duration_seconds_sum{service="demo-app"}[5m]) / rate(http_request_duration_seconds_count{service="demo-app"}[5m])
rate(container_cpu_usage_seconds_total{service="demo-app"}[5m])
container_memory_working_set_bytes{service="demo-app"} / 1024 / 1024
rate(container_network_receive_bytes_total{service="demo-app"}[5m])
time() - container_start_time_seconds{service="demo-app"}
```

Notes: container metrics arrive every 60 s, so use a `[5m]` window for `rate()` on them. A `[1m]` window often holds under two samples and returns nothing. (The demo app's own metrics are scraped more often, so `[1m]` is fine for them.) Run `/slow` first or the histogram queries are empty. `/cpu` makes the CPU query climb. The last query is uptime, which resets after `/crash`. Container metric names depend on what Alloy's cAdvisor exports, so check in the Prometheus UI if one is empty.

Not allowed through the MCP server (but fine in the Prometheus UI, which makes a good guardrail demo): `up`, `rate(x[1m])` with no selector, `up{service=~".+"}`.

### LogQL

```logql
{service="demo-app"}
{service="demo-app"} |= "error"
{service="demo-app"} != "/metrics"
{service="demo-app"} |~ "(?i)error|timeout|fatal"
{service="demo-app"} | json
{service="demo-app"} | json | status="500"
{service="demo-app"} | json | status >= 500
{service="demo-app"} | json | duration_ms > 250
{service="demo-app"} | json | level="error" | line_format "{{.route}} {{.status}} {{.duration_ms}}ms"
{service="alloy"} |~ "(?i)error|failed"
{service="loki"} |= "error"
```

Metric-style LogQL (works in Grafana Explore; I haven't confirmed `query_logs` formats these):

```logql
count_over_time({service="demo-app"}[5m])
sum(rate({service="demo-app"} | json | status="500" [1m]))
sum by (status) (count_over_time({service="demo-app"} | json [5m]))
```

## 5. Troubleshooting

- **Empty metrics right after a restart:** wait for the 60 s scrape.
- **`container_status` fails:** check `docker compose -f lab/docker-compose.yml ps docker-socket-proxy`.
- **Claude doesn't see the tools:** run `/mcp`, and rebuild with `npm run build` after code changes.
- **Stale entries in `list_services`:** old containers age out. Harmless.

## 6. Shutting down

```bash
docker compose -f lab/docker-compose.yml down        # stop and remove, keep data volumes
docker compose -f lab/docker-compose.yml down -v     # also delete stored metrics, logs and dashboards
```

`down` does not take `-d`. The MCP server needs no shutdown: Claude Code starts it on demand. To unregister it, run `claude mcp remove incident`.
