// The executor's Kubernetes API client: in-cluster only (service account token and CA), Node built-ins only, and
// only the calls its Role allows (charts/gha-emergency/templates/rbac.yaml): Jobs in its own namespace, and reading
// the pods and logs of those Jobs (and dry runs of Jobs, which need the same permission). It never reads Secrets.
import { readFileSync } from "node:fs";
import { request } from "node:https";

export type K8sJob = {
  metadata: { name: string; labels?: Record<string, string>; creationTimestamp?: string };
  status?: { active?: number; succeeded?: number; failed?: number; startTime?: string; completionTime?: string; conditions?: { type: string; status: string; reason?: string; message?: string }[] };
};
export type K8sPod = {
  metadata: { name: string };
  status?: { phase?: string; containerStatuses?: { name: string; state?: { waiting?: { reason?: string; message?: string }; terminated?: { exitCode: number; reason?: string } } }[] };
};

export interface KubeApi {
  /** dryRun: server-side dry run (admission runs, nothing is stored), for the admission check (admission-check.ts). */
  createJob(job: object, options?: { dryRun?: boolean }): Promise<void>;
  getJob(name: string): Promise<K8sJob | undefined>;
  deleteJob(name: string): Promise<void>;
  listPods(selector: string): Promise<K8sPod[]>;
  podLog(pod: string, container: string): Promise<string>;
  /** Warning events of a pod, oldest first (e.g. FailedMount when the named Secret does not exist). */
  podWarnings(pod: string): Promise<string[]>;
}

export class KubeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

export function createInClusterKube(namespace: string): KubeApi {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("Not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST is not set)");
  const ca = readFileSync(`${SA}/ca.crt`);
  const ns = encodeURIComponent(namespace);

  const call = (method: string, path: string, body?: object, accept = "application/json"): Promise<{ status: number; text: string }> =>
    new Promise((done, fail) => {
      // Projected tokens rotate: read it for every request.
      const token = readFileSync(`${SA}/token`, "utf8").trim();
      const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = request(
        { host, port, method, path, ca, timeout: 15_000, headers: { Authorization: `Bearer ${token}`, Accept: accept, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= 32 * 1024 * 1024) chunks.push(c);
          });
          res.on("end", () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("Kubernetes API request timed out")));
      req.on("error", fail);
      req.end(data);
    });
  const ok = async (method: string, path: string, body?: object, accept?: string) => {
    const r = await call(method, path, body, accept);
    if (r.status < 200 || r.status >= 300) {
      let message = `Kubernetes API ${method} ${path.split("?")[0]} returned ${r.status}`;
      try {
        message += `: ${(JSON.parse(r.text) as { message?: string }).message ?? ""}`;
      } catch {
        // keep the status only
      }
      throw new KubeError(r.status, message);
    }
    return r.text;
  };

  return {
    async createJob(job, options) {
      await ok("POST", `/apis/batch/v1/namespaces/${ns}/jobs${options?.dryRun ? "?dryRun=All" : ""}`, job);
    },
    async getJob(name) {
      try {
        return JSON.parse(await ok("GET", `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(name)}`)) as K8sJob;
      } catch (error) {
        if (error instanceof KubeError && error.status === 404) return undefined;
        throw error;
      }
    },
    async deleteJob(name) {
      try {
        await ok("DELETE", `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(name)}?propagationPolicy=Background`);
      } catch (error) {
        if (!(error instanceof KubeError && error.status === 404)) throw error;
      }
    },
    async listPods(selector) {
      return (JSON.parse(await ok("GET", `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(selector)}`)) as { items: K8sPod[] }).items;
    },
    async podWarnings(pod) {
      const selector = encodeURIComponent(`involvedObject.kind=Pod,involvedObject.name=${pod},type=Warning`);
      const list = JSON.parse(await ok("GET", `/api/v1/namespaces/${ns}/events?fieldSelector=${selector}`)) as { items: { reason?: string; message?: string; lastTimestamp?: string; eventTime?: string }[] };
      return list.items
        .sort((a, b) => String(a.lastTimestamp ?? a.eventTime).localeCompare(String(b.lastTimestamp ?? b.eventTime)))
        .map((e) => [e.reason, e.message].filter(Boolean).join(": "));
    },
    async podLog(pod, container) {
      // The log endpoint answers 406 to "Accept: text/plain"; it returns the log as text for */*.
      return ok("GET", `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod)}/log?container=${encodeURIComponent(container)}&limitBytes=${16 * 1024 * 1024}`, undefined, "*/*");
    },
  };
}
