# incident-mcp

An MCP server (Node.js + TypeScript) that helps triage incidents by correlating Docker, Prometheus and Loki data. Read-only. Built as a learning project and portfolio piece.

## How I want to work (IMPORTANT)
I'm building this to learn how MCP servers work. Do not generate the project for me.
- Explain the approach and the MCP concept involved BEFORE writing code.
- Work in small steps: one file or function at a time. Don't write whole files unless I ask.
- I write the first version of each new tool. You review it and point out what I missed.
- Boilerplate is fine to generate: compose files, configs, test scaffolding, CI, README polish.
- When I make a mistake, explain why instead of silently fixing it.
- Before committing, show me the diff summary and let me write or edit the commit message.
- At the end of a session, suggest what I should add to LEARNINGS.md. I write the entry myself.

## Current status
Built and tested: `list_services`, `query_metrics`, `query_logs`, `container_status` (Vitest, mocked clients).
Next: `container_logs`, then `investigate_service`.

### Known issues
- `query_metrics` has no service-scoping guardrail (only a description example). `query_logs` now parses LogQL selectors via `src/guardrails.ts`.

## Architecture
One MCP server, thin backend clients, higher-level incident tools on top.

- `src/clients/`: plain HTTP/Docker wrappers. No MCP knowledge. Easy to mock in tests.
- `src/tools/`: MCP tool definitions. Zod input schemas, guardrails, output shaping.
- `src/guardrails.ts`: caps on time range (6h) and point count (2000), required `service` label, truncation, secret redaction.
- `src/prompts/` and `src/resources/`: triage prompt and runbooks (later).
- Transport: stdio for local dev; Streamable HTTP later.

## Rules
- READ-ONLY. No tool may modify containers, config or data. Docker access goes through docker-socket-proxy (GET only), never the raw socket.
- Join key across backends is the compose service name, derived from Docker labels in Alloy/Prometheus relabeling, not self-reported by apps.
- Return compact summaries, not raw dumps: dedupe logs into patterns with counts, downsample series. Always say when output was truncated.
- Redact secrets (env vars, tokens, passwords) before returning anything.
- Guardrails live in the server, never rely on the prompt or the client LLM.
- Never commit secrets. Config comes from env vars; `.env.example` is committed, `.env` is not.
- Pin image versions in the lab compose file; no `latest`.

## Stack
Node 20+, TypeScript (strict), `@modelcontextprotocol/sdk`, `zod`, Vitest, Biome (or ESLint + Prettier).
Lab (`lab/`): Prometheus, Loki, Grafana, Grafana Alloy, cAdvisor, docker-socket-proxy, demo app.

## Commands
- Lab up: `docker compose -f lab/docker-compose.yml up -d`
- Build: `npm run build`
- Test (single run): `npm test -- --run`
- Inspect: `npx @modelcontextprotocol/inspector node dist/index.js`
- Register with Claude Code: `claude mcp add incident -- node /absolute/path/dist/index.js`

## Conventions
- Small commits, imperative messages ("Add container_status tool").
- Unit tests mock the clients; integration tests run against the lab stack.
- Tool descriptions are written for an LLM reader: what it returns, its limits, when to use it, and example queries using the `service` label.
- Record known gaps as tests or issues, not silent passes.