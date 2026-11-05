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