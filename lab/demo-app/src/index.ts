import express from "express";
import client from "prom-client";

const app = express();
const PORT = 9090;

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["route", "status"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["route"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

function log(level: "info" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, ...fields }));
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.path;
    httpRequestsTotal.inc({ route, status: res.statusCode });
    httpRequestDuration.observe({ route }, durationSec);
    log(res.statusCode >= 500 ? "error" : "info", {
      route,
      status: res.statusCode,
      duration_ms: Math.round(durationSec * 1000),
    });
  });
  next();
});

app.get("/ok", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/slow", (req, res) => {
  const ms = Number(req.query.ms ?? 1000);
  setTimeout(() => res.status(200).json({ ok: true, delayed_ms: ms }), ms);
});

app.get("/error", (req, res) => {
  const rate = Number(req.query.rate ?? 0.5);
  if (Math.random() < rate) {
    res.status(500).json({ error: "simulated failure" });
  } else {
    res.status(200).json({ ok: true });
  }
});

app.get("/cpu", (req, res) => {
  const ms = Number(req.query.ms ?? 500);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-loop to spike CPU
  }
  res.status(200).json({ ok: true, busy_ms: ms });
});

app.get("/crash", (_req, res) => {
  res.status(200).json({ ok: true, note: "crashing after response" });
  setImmediate(() => {
    throw new Error("simulated crash");
  });
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  log("info", { msg: `demo-app listening on ${PORT}` });
});
