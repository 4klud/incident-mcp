export const config = {
  prometheusUrl: process.env.PROMETHEUS_URL ?? "http://localhost:9091",
  lokiUrl: process.env.LOKI_URL ?? "http://localhost:3100",
  // docker-socket-proxy (GET only), never the raw Docker socket.
  dockerUrl: process.env.DOCKER_PROXY_URL ?? "http://127.0.0.1:2375",
};
