# Learnings

## 2026-11-04: First three tools
**Built:** list_services, query_metrics, query_logs
**Learned:**
- An MCP tool is a name, a description, a zod input schema and a handler. The client LLM sees only the first three, so the description is effectively the prompt.
- Guardrails belong in the server. The model can't be trusted to keep ranges small.
**Got stuck / wrong:**
- Assumed cAdvisor metrics would carry my `service` label. They don't; they need a relabel rule.
**Still unclear:**
- How the SDK turns zod into JSON Schema.
**Next:** Vitest for guardrails, fix cAdvisor labels.

## 2026-11-04: Lab stack verified end-to-end, tools smoke-tested live
**Built:** docker-compose lab (demo-app, prometheus, loki, alloy, grafana), then the 3 MCP tools wired into src/index.ts.
**Learned:**
- The `service` label can be infra-derived with zero app code: Alloy's `discovery.docker` + `discovery.relabel` promotes Docker's auto-applied `com.docker.compose.service` label straight to a Loki label. Prometheus gets the same string from its own scrape config's static label. One string (the compose service name) backs both signal paths — no app-level labeling needed.
- `@types/node@26` wasn't picked up automatically by tsc; had to add explicit `"types": ["node"]` to tsconfig or `process` didn't resolve.
- Testing an MCP server doesn't require a real client — spawning `node dist/index.js` and hand-writing JSON-RPC lines over stdin/stdout (initialize → tools/list → tools/call) is enough to verify the full stack live.
**Got stuck / wrong:**
- Unquoted query strings (`localhost:9090/slow?ms=300`) get glob-expanded by zsh and silently fail with "no matches found" — always quote URLs with query params in shell.
- `histogram_quantile` over `rate()` needs a few samples across the step window to stabilize; an empty result right after a traffic burst isn't a config bug, just not enough data points yet.
**Still unclear:**
- Whether `query_logs`'s guardrail (`query.includes('service=')`) is too naive — it'd pass on `other_service=` as a false positive. Worth tightening if this becomes a real surface.
**Next:** investigate_service (deferred until primitives have test coverage), vitest for guardrail edge cases, decide whether to run the MCP server itself in docker-compose or keep it as a local stdio process.
**DOCKERFILE**
- the Dockerfile built is a multi-stage build with 2 FROM stages.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 9090
CMD ["node", "dist/index.js"]

- Stage 1 (build): installs all deps including typescript as devDependency, copies src/, runs tsc to produce dist/. This stage needs the TS compiler, type definitions, etc. — none of which should ship in the final image.

- Stage 2 (final, unnamed): starts fresh from a clean node:20-alpine, installs only production deps (--omit=dev, so no TypeScript), then COPY --from=build /app/dist ./dist pulls just the compiled JS out of stage 1 — nothing else from it.

-  Multi-stage builds let you use a "fat" environment to build the artifact, then throw that environment away and copy only the output into a "slim" runtime image.

**what is a vitest coverage for the guardrails, and why are we using it?**
- 

**project structure**

- dist/ — the compiled JavaScript output of src/, produced by tsc (npm run build). This is what Node actually executes (node dist/index.js) and what claude mcp add points at. It's a build artifact, not source — regenerated every time you build, never hand-edited. Correctly gitignored (confirmed earlier it doesn't show in git status).

- node_modules/ — all installed npm dependencies (@modelcontextprotocol/sdk, zod, express, prom-client, typescript, vitest, etc.) plus their own dependencies, resolved from package.json/package-lock.json. Also gitignored — anyone cloning the repo regenerates it via npm install.

- lab/ — a separate, self-contained thing: the Docker Compose observability stack your MCP server talks to. Its own demo-app/ (a small Express app with failure-simulating endpoints), plus config for prometheus/, alloy/, grafana/. It has its own package.json/tsconfig.json/node_modules inside lab/demo-app/ once built, independent of the root project's. This isn't the MCP server — it's the test environment the MCP server queries (Prometheus on :9091, Loki on :3100) for data to correlate.

So the shape is: src → compiles to → dist (what you run), node_modules is third-party code neither you nor git tracks directly, and lab is the sandboxed "thing being observed" that the server in src/dist reaches out to over HTTP.

## 2026-11-09: Read-only Docker proxy and container metrics with a `service` label
**Built:** docker-socket-proxy in the lab; moved container metrics from standalone cAdvisor to Alloy's embedded `prometheus.exporter.cadvisor`; removed the standalone cAdvisor service and its Prometheus scrape job.
**Learned:**
- docker-socket-proxy enforces read-only at the infrastructure layer: only `CONTAINERS=1` enabled, `POST=0`. GET `/containers/json` returned 200, POST `/containers/demo-app/stop` returned 403. The Docker tools can't mutate anything even if the tool code had a bug.
- Standalone cAdvisor on Docker Desktop for Mac only produced `id="/docker/<hash>"` series, with no `name` and no compose labels, so the relabel rule for `service` had nothing to match. Alloy's embedded exporter, given `docker_host`, resolves names, images and `container_label_com_docker_compose_service`. Same cAdvisor code, but it talks to the Docker API.
- In Alloy an exporter component doesn't push anything. The pipeline is `prometheus.exporter.cadvisor` → `prometheus.scrape` → `prometheus.relabel` → `prometheus.remote_write`. The relabel stage is where the compose label becomes `service`, so the join key is still infra-derived.
- Prometheus only accepts remote write with `--web.enable-remote-write-receiver`. Setting `command:` in compose replaces the image's default flags, so `--config.file` and `--storage.tsdb.path` have to be restated.
- Alloy's `prometheus.scrape` defaults to a 60s interval. Querying 30s after a restart returned nothing and looked like a broken config; it was just no first scrape yet. Alloy's own metrics (`prometheus_remote_storage_samples_total`) and `/api/v0/web/components/<id>` showed where data was stopping.
**Got stuck / wrong:**
- Assumed standalone cAdvisor would work once I added a relabel rule. The labels weren't on the series at all, so no relabel could fix it. Check the raw series labels first.
- `promtool` said the config file didn't exist in the container: a single-file bind mount goes stale when the host file is rewritten (new inode). A container restart fixed it.
- After restarting Alloy, Loki rejected replayed old container logs ("entry too far behind"). Noisy but harmless here.
**Still unclear:**
- Alloy now runs `privileged: true` and mounts the raw Docker socket. Could `discovery.docker` and the exporter go through docker-socket-proxy instead (probably needs more endpoints enabled)?
- Whether `list_services` now reports metrics for all services, not just demo-app. Not yet re-tested.
**Next:** re-test `list_services`, then Docker tools (`container_status`, `container_logs`) against the proxy at 127.0.0.1:2375.
## 2026-11-12: container_status, parsed scoping for logs and metrics, redaction, CI
**Built:** `container_status` (through docker-socket-proxy), `hasServiceScope` for LogQL and `hasPromqlServiceScope` for PromQL, `redactSecrets` / `redactRecord`, `readOnlyHint` on all four tools, a README, and a GitHub Actions workflow (build + test).
**Learned:**
- The earlier "`query.includes('service=')` is too naive" worry was right. `{other_service="x"}` passed it. The fix is to parse the selectors: every `{...}` must contain `service="<non-empty>"` with a plain `=`. Skip strings and comments, and reject anything that can't be parsed (fail closed). A guardrail that fails open is worse than none, because it looks like protection.
- PromQL is harder than LogQL because a bare metric name (`up`) is already a selector with no braces, so a text search for `service=` lets `up or foo{service="a"}` through. The scanner has to reject bare identifiers while skipping function names, `by (...)` label lists, `[5m]` ranges, strings and numbers.
- Build the tool output from an allowlist (field by field) instead of copying the Docker object and deleting what's sensitive. The container's `Env` can't leak if no code path copies it. Tests check that a planted secret in `Env` never appears.
- `Promise.allSettled` over per-container inspections means one failed inspect doesn't hide the others. The result reports `inspectFailed` instead of silently dropping them.
- Raw compose output is noisy for an LLM reader. ~25 mostly-empty container labels per series became 6 once `store_container_labels = false` plus an allowlist was set. Fewer, meaningful fields are cheaper and easier to reason about.
- `readOnlyHint` is only a hint to the client. The real guarantee is the proxy's 403 on writes.
- Docker returns `0001-01-01T00:00:00Z` for "never", so it has to be mapped to `null` or the model reads it as a real date. Live crash and OOM checks gave `exit 3, restartCount 2` and `exit 137, oomKilled true`.
**Got stuck / wrong:**
- Regex redaction went quadratic. `password` repeated 100k times, or repeated PEM headers or JWT prefixes, took seconds because an unbounded quantifier can fail after consuming a long run and then retry from every later start. Bounding each quantifier (`{0,64}`, `{5,2048}`) fixed it. I only found it because I wrote an adversarial speed test. It wasn't a case I'd have thought of by reading the code.
- My first live redaction check proved nothing: demo-app never logs query strings, so there was nothing to redact. The real check needed a throwaway container that actually printed secrets.
- First PromQL scanner rejected `sum by (status) (...)` (it saw `sum` followed by `by` and took it for a metric name), and copied the rest of the query for every word, which is quadratic on long input. Both were caught by tests, the second by the speed test.
- Staged the wrong hunk with a zero-context patch (the proxy block landed at the end of the compose file). The leftover diff showing 11 deletions gave it away. I fixed it by building the index entry explicitly and checking with `docker compose config`.
- Pinned images are committed, but the running loki / prometheus / grafana containers still use the old `:latest` ones because I didn't recreate them (data loss risk).
**Still unclear:**
- Redaction can't catch a secret with no marker ("logged in with hunter2"). Is there a better answer than best-effort, or is documenting the limit the right call?
- The PromQL scanner is not a real parser. Would the Prometheus parser, or a WASM build, be worth the dependency, or does fail-closed cover it?
- Could Alloy use the proxy instead of a privileged container with the raw socket?
**Next:** optional only: `investigate_service` or a triage prompt. Otherwise the project is demo-ready.
