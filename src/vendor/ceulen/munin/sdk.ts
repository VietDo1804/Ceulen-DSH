// ponytail: vendored from @kalera/munin-sdk 1.6.0 (dist/{client,errors,capabilities,maintenance}.js +
// types.d.ts), zero deps, so the bundle keeps its no-runtime-deps rule.
// Local changes vs upstream: capabilities cache is keyed by `${baseUrl}|${apiKey}`
// (upstream cached one global `globalThis.__munin_caps`, which went stale when a
// user switched munin servers per project), fetchCapabilities arms a timeout
// like invoke() (upstream could hang forever on a dead server), and a
// transport failure can fail over to a second endpoint.
// 1.6.0 is the maintenance protocol: during a server write freeze every write
// answers 503 MAINTENANCE_READ_ONLY with Retry-After. This copy retries like
// upstream and then throws MuninMaintenanceError. It runs without upstream's
// local write queue (~/.munin; upstream's own `writeQueue: false` mode): a
// refused write is reported to the caller as not saved instead of being
// replayed later, so nothing here writes outside DSH_HOME. A maintenance
// answer never fails over: the primary is up, and a write sent to the second
// endpoint during the freeze would split the store.
// Upgrade = re-vendor this one file.

export type MuninAction = "store" | "retrieve" | "search" | "list" | "recent" | "share" | "versions" | "rollback" | "encrypt" | "decrypt" | "diff" | "delete" | "acknowledge_setup";

export interface MuninActionEnvelope<TPayload = Record<string, unknown>> {
  action: MuninAction;
  project: string;
  payload: TPayload;
  requestId?: string;
  client?: {
    name: string;
    version: string;
  };
}

export interface MuninCapabilities {
  specVersion: string;
  actions: {
    core: string[];
    optional: string[];
  };
  features: Record<string, {
    supported: boolean;
    reason?: string;
  }>;
  metadata: {
    serverVersion: string;
    timestamp: string;
    [key: string]: unknown;
  };
}

export interface MuninError {
  code: "AUTH_INVALID" | "FEATURE_DISABLED" | "NOT_FOUND" | "RATE_LIMITED" | "VALIDATION_ERROR" | "INTERNAL_ERROR" | "ERR_STALE_PROTOCOL" | "MAINTENANCE_READ_ONLY";
  message: string;
  details?: Record<string, unknown>;
}

export interface MuninResponse<TData = unknown> {
  ok: boolean;
  data?: TData;
  error?: MuninError;
  requestId?: string;
}

export interface MuninClientConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Secondary endpoint, tried once when the primary is unreachable at the
   * transport level (refused, DNS, timeout, 5xx, non-JSON body). Keep its
   * apiKey explicit: a token belongs to one server.
   */
  fallback?: { baseUrl: string; apiKey?: string };
  /** How often and how long a call waits out a maintenance answer before giving up. */
  maintenanceRetry?: Partial<MaintenanceRetryPolicy>;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MaintenanceRetryPolicy {
  retries: number;
  maxWaitMs: number;
}

export class MuninSdkError extends Error {
  code: MuninError["code"] | string;
  details?: Record<string, unknown>;
  constructor(error: MuninError) {
    super(error.message);
    this.name = "MuninSdkError";
    this.code = error.code;
    this.details = error.details;
  }
}

export class MuninTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuninTransportError";
  }
}

/**
 * Munin is in a maintenance window (server MUNIN_READ_ONLY). Not retryable by
 * the caller: the client already retried. `queued` is always false here, as
 * this copy keeps no local write queue: the write was not saved.
 */
export class MuninMaintenanceError extends MuninSdkError {
  queued = false;
  retryAfterMs: number | null;
  retryable = false;
  constructor(info: { action: string; retryAfterMs: number | null }) {
    super({
      code: "MAINTENANCE_READ_ONLY",
      message: "Munin is in maintenance (read-only). The write was not saved. Please try again later.",
      details: { queued: false, reason: "maintenance", ...info },
    });
    this.name = "MuninMaintenanceError";
    this.retryAfterMs = info.retryAfterMs;
  }
}

export const MAINTENANCE_ERROR_CODE = "MAINTENANCE_READ_ONLY";
export const DEFAULT_MAINTENANCE_RETRY: MaintenanceRetryPolicy = { retries: 2, maxWaitMs: 5_000 };

function errorCodeOf(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "";
}

export function isMaintenanceResponse(status: number, body: unknown): boolean {
  return status === 503 && errorCodeOf(body) === MAINTENANCE_ERROR_CODE;
}

/** Retry-After in ms: the header (seconds or an HTTP date) wins over the body's `retryAfter` seconds. */
export function retryAfterMs(header: string | null, body: unknown, now = Date.now()): number | null {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const fromBody = Number((body as { retryAfter?: unknown } | null)?.retryAfter);
  return Number.isFinite(fromBody) && fromBody >= 0 ? fromBody * 1000 : null;
}

/** Exponential from 1 s, at least Retry-After, never above maxWaitMs. */
export function maintenanceDelayMs(attempt: number, retryAfter: number | null, policy: MaintenanceRetryPolicy): number {
  return Math.min(Math.max(1_000 * 2 ** attempt, retryAfter ?? 0), policy.maxWaitMs);
}

export async function fetchCapabilities(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MuninCapabilities> {
  const response = await fetchImpl(`${baseUrl}/api/mcp/capabilities`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    throw new MuninTransportError(`Failed to call capabilities endpoint: ${String(error)}`);
  });
  if (!response.ok) {
    throw new MuninTransportError(`Capabilities request failed with status ${response.status}`);
  }
  const body = (await response.json()) as MuninResponse<MuninCapabilities>;
  if (!body.ok || !body.data) {
    throw new MuninSdkError(body.error ?? {
      code: "INTERNAL_ERROR",
      message: "Capabilities response missing data",
    });
  }
  return body.data;
}

export function isActionSupported(capabilities: MuninCapabilities, action: string): boolean {
  return capabilities.actions.core.includes(action) ||
    capabilities.actions.optional.includes(action);
}

const DEFAULT_TIMEOUT_MS = 15_000;
const CLIENT_VERSION = "1.6.0";

/** How long a failed primary is skipped before one call probes it again. */
const DEGRADED_MS = 60_000;

function isFailoverWorthy(error: unknown): boolean {
  return error instanceof MuninTransportError ||
    (error instanceof MuninSdkError && error.code === "INTERNAL_ERROR");
}

export class MuninClient {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  /** `undefined` = failover off. Built here so it never nests (no fallback chain). */
  fallback: MuninClient | undefined;
  /** While `Date.now() < degradedUntil` the primary is skipped entirely. */
  degradedUntil = 0;
  retryPolicy: MaintenanceRetryPolicy;
  sleep: (ms: number) => Promise<void>;
  constructor(config?: MuninClientConfig) {
    this.baseUrl = (config?.baseUrl || "https://munin.kalera.dev").replace(/\/$/, "");
    this.apiKey = config?.apiKey;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config?.fetchImpl ?? fetch;
    this.retryPolicy = { ...DEFAULT_MAINTENANCE_RETRY, ...(config?.maintenanceRetry ?? {}) };
    this.sleep = config?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const secondary = config?.fallback;
    if (secondary !== undefined) {
      const fallbackUrl = secondary.baseUrl.replace(/\/$/, "");
      if (fallbackUrl !== "" && fallbackUrl !== this.baseUrl) {
        this.fallback = new MuninClient({
          baseUrl: fallbackUrl,
          apiKey: secondary.apiKey,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
          maintenanceRetry: this.retryPolicy,
          sleep: this.sleep,
        });
      }
    }
  }

  async capabilities(forceRefresh = false): Promise<MuninCapabilities> {
    const cacheKey = `${this.baseUrl}|${this.apiKey ?? ""}`;
    if (!forceRefresh && globalThis.__munin_caps?.key === cacheKey) {
      return globalThis.__munin_caps.caps;
    }
    const caps = await fetchCapabilities(this.baseUrl, this.apiKey, this.fetchImpl, this.timeoutMs);
    globalThis.__munin_caps = { key: cacheKey, caps };
    return caps;
  }

  async invoke(projectId: string, action: string, payload: Record<string, unknown> = {}, options?: { ensureCapability?: boolean; requestId?: string }): Promise<unknown> {
    const fallback = this.fallback;
    if (fallback === undefined) return this.invokeOnce(projectId, action, payload, options);
    if (Date.now() < this.degradedUntil) return fallback.invokeOnce(projectId, action, payload, options);
    try {
      return await this.invokeOnce(projectId, action, payload, options);
    } catch (error) {
      if (!isFailoverWorthy(error)) throw error;
      this.degradedUntil = Date.now() + DEGRADED_MS;
      return await fallback.invokeOnce(projectId, action, payload, options);
    }
  }

  private async invokeOnce(projectId: string, action: string, payload: Record<string, unknown> = {}, options?: { ensureCapability?: boolean; requestId?: string }): Promise<unknown> {
    if (options?.ensureCapability) {
      const caps = await this.capabilities();
      if (!isActionSupported(caps, action)) {
        throw new MuninSdkError({
          code: "FEATURE_DISABLED",
          message: `Action '${action}' is not supported by current server capabilities`,
        });
      }
    }
    let reply = await this.sendOnce(projectId, action, payload, options?.requestId);
    for (let attempt = 0; reply.maintenance && attempt < this.retryPolicy.retries; attempt++) {
      await this.sleep(maintenanceDelayMs(attempt, reply.retryAfterMs, this.retryPolicy));
      reply = await this.sendOnce(projectId, action, payload, options?.requestId);
    }
    if (reply.maintenance) throw new MuninMaintenanceError({ action, retryAfterMs: reply.retryAfterMs });
    const { response, body } = reply;
    if (!response.ok || (body.ok === false) || (body.success === false)) {
      let errObj: MuninError | undefined = body.error;
      if (typeof errObj === "string") {
        // The server may return `error` as a bare string code
        // (e.g. "ERR_STALE_PROTOCOL"); use it as both the code and message
        // instead of flattening every string error into INTERNAL_ERROR.
        errObj = { code: errObj as MuninError["code"], message: errObj };
      }
      if (!errObj) {
        errObj = {
          code: "INTERNAL_ERROR",
          message: `Unexpected failure invoking action '${action}'`,
        };
      }
      // A top-level `remediation` (sent alongside the error envelope, e.g. for
      // ERR_STALE_PROTOCOL) is folded into `details` so callers can read it via
      // MuninSdkError.details without losing any existing structured details.
      const remediation = (body as { remediation?: unknown }).remediation;
      if (remediation !== undefined) {
        errObj = {
          ...errObj,
          details: { ...(errObj.details ?? {}), remediation },
        };
      }
      throw new MuninSdkError(errObj);
    }
    return body;
  }

  /** One request. A maintenance answer is returned, not thrown, so the caller can wait and retry. */
  private async sendOnce(projectId: string, action: string, payload: Record<string, unknown>, requestId?: string): Promise<{ response: Response; body: MuninResponse & { success?: boolean }; maintenance: boolean; retryAfterMs: number | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/mcp/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiKey: this.apiKey,
          project: projectId,
          projectId, // Fallback for un-restarted server
          action,
          payload,
          requestId,
          client: {
            name: "@kalera/munin-sdk",
            version: CLIENT_VERSION,
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new MuninTransportError(`Request failed for action '${action}': ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    let body: MuninResponse & { success?: boolean };
    try {
      body = (await response.json()) as MuninResponse & { success?: boolean };
    } catch {
      // A proxy/502 HTML page is not JSON; surface it as transport so failover sees it.
      throw new MuninTransportError(`Action '${action}' returned a non-JSON response (status ${response.status})`);
    }
    const maintenance = isMaintenanceResponse(response.status, body);
    return { response, body, maintenance, retryAfterMs: maintenance ? retryAfterMs(response.headers.get("retry-after"), body) : null };
  }

  async store(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "store", payload, { ensureCapability: true });
  }
  async retrieve(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "retrieve", payload, { ensureCapability: true });
  }
  async search(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "search", payload, { ensureCapability: true });
  }
  async list(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "list", payload, { ensureCapability: true });
  }
  async recent(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "recent", payload, { ensureCapability: true });
  }
  async share(projectId: string, memoryIds: string[], targetProjectIds: string[]): Promise<unknown> {
    return this.invoke(projectId, "share", { memoryIds, targetProjectIds }, { ensureCapability: true });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __munin_caps: { key: string; caps: MuninCapabilities } | undefined;
}
