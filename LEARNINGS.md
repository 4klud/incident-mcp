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

## 2026-11-07: Vitest, guardrail tests and project structure

**what is a vitest coverage for the guardrails, and why are we using it?**
- Two different things share the word. **Vitest** is the test runner: `npm test` runs every `*.test.ts` file and reports which assertions pass or fail. **Coverage** is an extra report on top of that, showing which lines and branches of the source ran at least once during the tests. This project uses Vitest. It does not use coverage: `@vitest/coverage-v8` is not installed and CI doesn't measure it.
- Why test the guardrails specifically: they are the safety rules (service scoping, range and size caps, redaction), and nothing else in the stack would notice if one silently stopped working. The model can't be trusted to keep ranges small, so the server has to, and a test is how I prove it still does.
- What the tests check: good queries are accepted, bad ones are rejected (`{other_service="x"}`, `up`, `service=~".+"`), anything unparseable is rejected (fail closed), every redaction rule fires, redaction is idempotent, known gaps are pinned as tests, and hostile inputs finish quickly (the regex backtracking cases).
- Why the clients are mocked: the tests run without the lab and only exercise my own logic, so they are fast and deterministic. The cost is that they can't catch a real Prometheus, Loki or Docker behaving differently. That is why I also did live checks by hand.
- Coverage would only tell me which lines the tests never touch, not whether the assertions are good. A line can run without being checked. It could be added with `@vitest/coverage-v8` and `npx vitest run --coverage`, and it's worth it only if I want a number or a gap report.

**project structure**

- dist/ — the compiled JavaScript output of src/, produced by tsc (npm run build). This is what Node actually executes (node dist/index.js) and what claude mcp add points at. It's a build artifact, not source — regenerated every time you build, never hand-edited. Correctly gitignored (confirmed earlier it doesn't show in git status).

- node_modules/ — all installed npm dependencies (@modelcontextprotocol/sdk, zod, express, prom-client, typescript, vitest, etc.) plus their own dependencies, resolved from package.json/package-lock.json. Also gitignored — anyone cloning the repo regenerates it via npm install.

- lab/ — a separate, self-contained thing: the Docker Compose observability stack your MCP server talks to. Its own demo-app/ (a small Express app with failure-simulating endpoints), plus config for prometheus/, alloy/, grafana/. It has its own package.json/tsconfig.json/node_modules inside lab/demo-app/ once built, independent of the root project's. This isn't the MCP server — it's the test environment the MCP server queries (Prometheus on :9091, Loki on :3100) for data to correlate.

- src/ — the actual MCP server, in TypeScript. `index.ts` registers the four tools and starts the stdio transport. `tools/` holds one file per tool (`listServices`, `queryMetrics`, `queryLogs`, `containerStatus`), each with its zod input schema, guardrails and output shaping. `clients/` are thin HTTP wrappers for Prometheus, Loki and Docker with no MCP knowledge, which is what makes them easy to mock. `guardrails.ts` holds the shared safety code (LogQL and PromQL service scoping, secret redaction). `config.ts` reads the backend URLs from environment variables.

- *.test.ts — Vitest tests, kept next to the code they test. They mock the clients, so they run without the lab. `vitest.config.ts` excludes `dist/` so the compiled copies of the tests don't run twice.

- .github/workflows/ci.yml — the GitHub Actions workflow: `npm ci`, `npm run build`, `npm test` on every push and pull request.

- README.md, DEMO.md, CLAUDE.md, LEARNINGS.md — README is the public overview, DEMO.md is the walkthrough and query cheat sheet, CLAUDE.md holds the working rules for Claude Code, and LEARNINGS.md is this log.

- package.json / package-lock.json / tsconfig.json — dependencies and scripts, the exact locked versions (what `npm ci` installs), and the strict TypeScript settings.

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

## 2026-11-13: Demo prep, follow-ups and loose ends
**Built:** `DEMO.md` (demo script, UI guide, query cheat sheet), README clarifications, and a live check of the demo queries.
**Learned:**
- The demo app is an API with no `/` route, so `GET /` returns "Cannot GET /". That is expected. Its endpoints are `/ok`, `/slow`, `/error`, `/cpu`, `/crash` and `/metrics`.
- Container metrics reach Prometheus through Alloy every 60 s, so `rate(...[1m])` on them often returns nothing (fewer than two samples in the window). `[5m]` works. The demo app's own metrics are scraped more often, so `[1m]` is fine for those.
- The demo app's logs are JSON with `time`, `level`, `route`, `status` and `duration_ms`. An example query I was given used fields that don't exist (`method`, `path`). Check the real fields (click a log line in Grafana) before writing a LogQL filter, and test cheat-sheet queries against the running lab.
- `container_logs` was dropped on purpose. Loki already holds container logs, so a Docker logs tool would duplicate it and add multiplexed-stream parsing. The 2026-11-09 "Next" line is out of date for that reason.
- `container_status` validates its inputs before building a request: the service name against a regex, and container IDs against `^[a-f0-9]{12,64}$`. Nothing unchecked ends up in a URL or a Docker filter.
- `/crash` sends a 200 response and only then throws, so a crash leaves no 500s in the logs and no error-rate spike. The only evidence is in Docker (`restartCount`, a recent `startedAt`), which is why `container_status` matters: a logs-and-metrics-only assistant would say everything looks fine. The container comes back because demo-app has `restart: on-failure`.
- Vitest also ran the compiled `dist/*.test.js` until `vitest.config.ts` excluded `dist/**`. A clean checkout (or CI) catches things a local build folder hides.
- Compose: recreating one service is `up -d --no-deps --force-recreate <svc>`. During a recreate, Compose briefly renames the old container to `<id>_<name>`.
- `package.json` said ISC while `LICENSE` is MIT. Keep the two in sync (the root `package-lock.json` entry too).
- CI is `npm ci`, `npm run build`, `npm test` on Node 22. It does not cover the lab, linting, `npm audit` or Node 20, even though the README says Node 20+. It also doesn't block merges unless branch protection requires it.
- Production gap (honest view): this is a secure prototype, not a production product. Missing: prompt-injection handling for log text, authentication and per-user isolation, audit logging, evals, a threat model and compliance work. Worth a `THREAT_MODEL.md` if I keep going.
**Resolved from earlier entries:**
- `list_services` now reports metrics for all services (re-tested; stale `cadvisor` and `redactdemo` entries aged out). The "not yet re-tested" item on 2026-11-09 is closed.
- The 2026-11-12 "demo-ready" note was written before `DEMO.md` existed.
**Still unclear:**
- How the SDK turns zod schemas into JSON Schema (open since 2026-11-04).
- Whether Vitest coverage is worth wiring into CI. It's explained in the 2026-11-07 entry, but it isn't set up.
- Whether metric-style LogQL (`count_over_time`) works through `query_logs`, which is built for log lines.
**Next:** optional: Node 20 + 22 matrix in CI, `npm audit` in CI, `THREAT_MODEL.md`, a prompt-injection note on log output, audit logging of tool calls.
