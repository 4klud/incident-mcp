import { z } from "zod";
import * as prometheus from "../clients/prometheus.js";
import * as loki from "../clients/loki.js";

export const listServicesInputSchema = z.object({});

export type ListServicesInput = z.infer<typeof listServicesInputSchema>;

export async function listServices(_input: ListServicesInput) {
  const [metricsServices, logServices] = await Promise.all([
    prometheus.listLabelValues("service"),
    loki.listLabelValues("service"),
  ]);

  const allServices = Array.from(new Set([...metricsServices, ...logServices])).sort();

  return {
    services: allServices.map((name) => ({
      name,
      hasMetrics: metricsServices.includes(name),
      hasLogs: logServices.includes(name),
    })),
  };
}
