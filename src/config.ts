export const config = {
  prometheusUrl: process.env.PROMETHEUS_URL ?? "http://localhost:9091",
  lokiUrl: process.env.LOKI_URL ?? "http://localhost:3100",
};
