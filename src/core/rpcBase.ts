import {
  RPCConfig,
  RPCEndpoint,
  RPCCallResult,
  RPCType,
  RPCStatus,
  LoadBalancingStrategy,
  FailureStats,
  RPCDependencies,
  InternalRpcEndpoint,
  HttpRpcEndpointOptions
} from "../types.js";

type ConfigPayload = HttpRpcEndpointOptions["headers"];
function cloneConfigPayload(payload: ConfigPayload): ConfigPayload {
  if (!payload) return undefined;
  if (typeof payload === "function") return payload;
  return { ...payload };
}
import { buildInternalConfig, resolveBaseUrls, type _InternalRpcConfig } from "./config.js";
import { EndpointHealthManager } from "./health/index.js";
import { FastestBalancer, RoundRobinBalancer, RandomBalancer, type LoadBalancer } from "./balancing/index.js";
import { RpcTransport } from "./network/transports.js";
import { LazyRpcError } from "./error.js";

/**
 * RPC Base — thin orchestration shell.
 *
 * Wires together four independent modules:
 * - `_InternalRpcConfig` — frozen immutable config
 * - `EndpointHealthManager` — failure tracking and backoff
 * - `LoadBalancer` — endpoint selection strategies
 * - `RpcTransport` — HTTP/WS validation calls
 */
export class RPCBase<THttp = string, TWs = string> {

  readonly #config: _InternalRpcConfig;


  readonly #health: EndpointHealthManager;
  readonly #transport: RpcTransport;
  readonly #httpBalancers: Record<LoadBalancingStrategy, LoadBalancer> = {
    fastest: new FastestBalancer(),
    "round-robin": new RoundRobinBalancer(),
    random: new RandomBalancer(),
  };
  readonly #wsBalancers: Record<LoadBalancingStrategy, LoadBalancer> = {
    fastest: new FastestBalancer(),
    "round-robin": new RoundRobinBalancer(),
    random: new RandomBalancer(),
  };


  #validRPCs: RPCEndpoint[] = [];
  #validWSRPCs: RPCEndpoint[] = [];
  #loadBalancing: LoadBalancingStrategy;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #isDestroyed = false;
  #abortController: AbortController = new AbortController();
  #initPromise: Promise<void> | null = null;
  #destroyPromise: Promise<void> | null = null;
  #baseHttpUrls: InternalRpcEndpoint[] = [];
  #baseWsUrls: InternalRpcEndpoint[] = [];
  #id = 0;

  #exitHandler = (): void => {
    void this.destroy();
  };

  #signalHandler = (signal: string): void => {
    void this.destroy();
    
    if (typeof process !== "undefined" && typeof process.listenerCount === "function" && typeof process.kill === "function") {
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    }
  };

  #getRpcAsyncQueue = new Set<{
    type: RPCType,
    resolve: (url: THttp | TWs) => void,
    reject: (err: Error) => void,
    timer: ReturnType<typeof setTimeout> | null
  }>();



  constructor(config: RPCConfig<THttp, TWs>, deps: RPCDependencies) {
    this.#config = buildInternalConfig(config, deps);
    this.#loadBalancing = this.#config.loadBalancing;
    this.#health = new EndpointHealthManager(this.#config);

    if (typeof process !== "undefined" && typeof process.on === "function") {
      process.on("exit", this.#exitHandler);
      process.on("SIGINT", this.#signalHandler);
      process.on("SIGTERM", this.#signalHandler);
    }

    try {
      const urls = resolveBaseUrls(
        deps.chainList, this.#config.chainId, config.customRpcs, this.#config.enforceHttps,
      );
      this.#baseHttpUrls = urls.http;
      this.#baseWsUrls = urls.ws;

      this.#transport = new RpcTransport(
        this.#config, this.#abortController, this.#health, () => this.#isDestroyed,
      );

      void this.initialize();
    } catch (err) {
      const agent = this.#config.agent as { destroy?: () => void } | null | undefined;
      if (typeof agent?.destroy === "function") {
        try { agent.destroy(); } catch { /* ignore */ }
      }
      throw err;
    }
  }



  public drop = (url: string): void => {
    this.#config.logger.warn(`[${this.#config.errorPrefix}: 'RPC Base'] Manual Intervention: Dropping RPC URL from active pool: ${url}`);
    this.#health.recordFailure(url);
  }

  public getRpc = (type: RPCType): THttp | TWs => {
    this.validateRpcType(type);
    if (this.#isDestroyed) {
      throw new LazyRpcError("RPC instance destroyed", "RPC Base", this.#config.errorPrefix);
    }

    const endpoints = type === "https" ? this.#validRPCs : this.#validWSRPCs;
    if (endpoints.length === 0) {
      const candidates = type === "https" ? this.#baseHttpUrls : this.#baseWsUrls;
      if (candidates.length === 0) {
        throw new LazyRpcError(`No ${type} RPC URLs are configured`, "RPC Base", this.#config.errorPrefix);
      }
      throw new LazyRpcError(`No validated ${type} RPC URLs available yet. Use getRpcAsync("${type}") to wait for validation or getAllCandidateRPCs("${type}") to inspect configured URLs.`, "RPC Base", this.#config.errorPrefix);
    }

    const balancerMap = type === "https" ? this.#httpBalancers : this.#wsBalancers;
    const balancer = balancerMap[this.#loadBalancing];
    const selected = balancer.select(endpoints, (url) => this.#health.shouldSkip(url));

    if (!selected) {
      throw new LazyRpcError(`All validated ${type} RPC URLs are currently failing or in backoff. Check getFailureStats() for failure counts.`, "RPC Base", this.#config.errorPrefix);
    }

    this.#config.logger.debug(`[${this.#config.errorPrefix}: 'RPC Base'] Selected ${type} RPC URL: ${selected.url}`);

    if (selected.originalFormat === "string") {
      return selected.url as unknown as THttp | TWs;
    }

    return {
      url: selected.url,
      ...(selected.headers ? { headers: cloneConfigPayload(selected.headers) } : {}),
      ...(selected.query ? { query: cloneConfigPayload(selected.query) } : {})
    } as unknown as THttp | TWs;
  }

  public async getRpcAsync(type: RPCType, timeout = 10_000): Promise<THttp | TWs> {
    this.validateRpcType(type);
    if (this.#isDestroyed) {
      throw new LazyRpcError("RPC instance destroyed", "RPC Base", this.#config.errorPrefix);
    }

    const endpoints = type === "https" ? this.#validRPCs : this.#validWSRPCs;
    if (endpoints.length > 0) {
      return this.getRpc(type);
    }

    const baseUrls = type === "https" ? this.#baseHttpUrls : this.#baseWsUrls;
    if (baseUrls.length === 0) {
      throw new LazyRpcError(`No ${type} RPC URLs are configured`, "RPC Base", this.#config.errorPrefix);
    }


    if (!this.#initPromise) {
      void this.initialize();
    }

    return new Promise((resolve, reject) => {
      const job = { resolve, reject, type, timer: null as ReturnType<typeof setTimeout> | null };
      job.timer = setTimeout(() => {
        this.#getRpcAsyncQueue.delete(job);
        reject(new LazyRpcError(`Timed out after ${timeout}ms waiting for a validated ${type} RPC URL`, "RPC Base", this.#config.errorPrefix));
      }, timeout);
      this.#getRpcAsyncQueue.add(job);
      this.#config.logger.debug(`[${this.#config.errorPrefix}: 'RPC Base'] Queued getRpcAsync(${type}) request with ${timeout}ms timeout`);
    });
  }

  public status(): RPCStatus {
    if (this.#isDestroyed) return "destroyed";
    const hasValidated = this.#validRPCs.length > 0 || this.#validWSRPCs.length > 0;
    if (hasValidated && this.#initPromise) return "refreshing";
    if (hasValidated) return "ready";
    return "initializing";
  }

  public getValidRPCCount(type: RPCType): number {
    this.validateRpcType(type);
    return type === "https" ? this.#validRPCs.length : this.#validWSRPCs.length;
  }

  public getAllValidRPCs(type: RPCType): RPCEndpoint[] {
    this.validateRpcType(type);

    const list = type === "https" ? this.#validRPCs : this.#validWSRPCs;
    return list.map(ep => ({
      ...ep,
      ...(ep.headers ? { headers: cloneConfigPayload(ep.headers) } : {}),
      ...(ep.query ? { query: cloneConfigPayload(ep.query) } : {})
    }));
  }

  public getAllCandidateRPCs(type: RPCType): (THttp | TWs)[] {
    this.validateRpcType(type);

    const candidates = type === "https" ? this.#baseHttpUrls : this.#baseWsUrls;
    return candidates.map(ep => {
      if (ep.originalFormat === "string") return ep.url as unknown as THttp | TWs;
      return {
        url: ep.url,
        ...(ep.headers ? { headers: cloneConfigPayload(ep.headers) } : {}),
        ...(ep.query ? { query: cloneConfigPayload(ep.query) } : {})
      } as unknown as THttp | TWs;
    });
  }

  public getAllRPCs(type: RPCType): (THttp | TWs)[] {
    return this.getAllCandidateRPCs(type);
  }

  public getFailureStats(): FailureStats {
    return this.#health.getStats();
  }

  public async refresh(): Promise<void> {
    await this.initialize();
  }

  public destroy(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;

    this.#isDestroyed = true;
    this.#abortController.abort();
    if (typeof process !== "undefined" && typeof process.removeListener === "function") {
      process.removeListener("exit", this.#exitHandler);
      process.removeListener("SIGINT", this.#signalHandler);
      process.removeListener("SIGTERM", this.#signalHandler);
    }
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#validRPCs = [];
    this.#validWSRPCs = [];
    this.#baseHttpUrls = [];
    this.#baseWsUrls = [];
    this.#health.reset();


    for (const entry of this.#getRpcAsyncQueue) {
      if (entry.timer) { clearTimeout(entry.timer); }
      entry.reject(new LazyRpcError("RPC instance destroyed", "RPC Base", this.#config.errorPrefix));
    }
    this.#getRpcAsyncQueue.clear();
    this.#config.logger.info(`[${this.#config.errorPrefix}: 'RPC Base'] RPC instance destroyed`);

    this.#destroyPromise = (async (): Promise<void> => {
      try {
        await this.#initPromise;
      } catch { /* ignore */ }

      this.#validRPCs = [];
      this.#validWSRPCs = [];

      const agent = this.#config.agent as { destroy?: () => Promise<void> } | undefined;
      if (agent && typeof agent.destroy === "function") {
        try { await agent.destroy(); } catch { /* ignore */ }
      }
    })();

    return this.#destroyPromise;
  }

  public clearFailedURLs(): void {
    this.#health.reset();
  }





  private initialize(): Promise<void> {
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = this.runValidationCycle();
    return this.#initPromise;
  }

  private async runValidationCycle(): Promise<void> {
    if (this.#isDestroyed) {
      this.#initPromise = null;
      return;
    }

    try {
      const allUrls: { endpoint: InternalRpcEndpoint; type: RPCType }[] = [
        ...this.#baseHttpUrls.map((endpoint) => ({ endpoint, type: "https" as const })),
        ...this.#baseWsUrls.map((endpoint) => ({ endpoint, type: "ws" as const })),
      ];

      const BATCH_SIZE = 10;
      const results: RPCCallResult[] = [];
      this.#config.logger.info(`[${this.#config.errorPrefix}: 'RPC Base'] Starting RPC validation cycle for ${allUrls.length} candidate URLs`);

      for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
        if (this.#abortController.signal.aborted) return;

        const batch = allUrls.slice(i, i + BATCH_SIZE);
        this.#config.logger.debug(`[${this.#config.errorPrefix}: 'RPC Base'] Validating RPC batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.map((entry) => `${entry.type}:${entry.endpoint.url}`).join(", ")}`);
        const batchResults = await Promise.allSettled(
          batch.map(({ endpoint, type }) => this.timedCall(endpoint, type)),
        );



        for (let j = 0; j < batch.length; j++) {
          const req = batch[j];
          const result = batchResults[j];
          if (!req || !result) continue;

          if (result.status === "fulfilled") {
            this.drainQueueFor(result.value);
            results.push(result.value);
          } else {
            const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
            this.#config.logger.warn(`[${this.#config.errorPrefix}: 'RPC Base'] Validation Warning: Endpoint ${req.endpoint.url} failed to pass validation checks. Reason: ${errorMessage}`);
          }
        }
      }

      if (this.#abortController.signal.aborted) return;

      const toEndpoints = (r: RPCCallResult[]): RPCEndpoint[] =>
        r.sort((a, b) => a.time - b.time).map(({ type: _type, ...res }) => res);

      const newHTTP = toEndpoints(results.filter((r) => r.type === "https"));
      const newWS = toEndpoints(results.filter((r) => r.type === "ws"));

      if (newHTTP.length > 0) this.#validRPCs = newHTTP;
      if (newWS.length > 0) this.#validWSRPCs = newWS;

      this.#config.logger.info(`[${this.#config.errorPrefix}: 'RPC Base'] RPC validation cycle complete. Validated ${newHTTP.length} HTTP and ${newWS.length} WebSocket RPCs`);
    } catch (error) {
      this.#config.logger.error(`[${this.#config.errorPrefix}: 'RPC Base'] Validation Cycle Error: Failed to complete initialization due to an unexpected exception. Please check your network and configuration:`, error);
    } finally {
      this.#initPromise = null;
      if (!this.#abortController.signal.aborted) {
        this.scheduleNextRefresh();


        for (const entry of this.#getRpcAsyncQueue) {
          if (entry.timer) { clearTimeout(entry.timer); }
          entry.reject(new LazyRpcError(`Failed to find a validated ${entry.type} RPC URL during this validation cycle`, "RPC Base", this.#config.errorPrefix));
        }
        this.#getRpcAsyncQueue.clear();
      }
    }
  }

  private async timedCall(endpoint: InternalRpcEndpoint, type: RPCType): Promise<RPCCallResult> {
    const id = ++this.#id;
    const start = performance.now();
    this.#config.logger.debug(`[${this.#config.errorPrefix}: 'RPC Base'] Validating ${type} RPC URL ${endpoint.url} with request id ${id}`);
    await (type === "https" ? this.#transport.httpCall(endpoint, id) : this.#transport.wsCall(endpoint, id));
    const time = performance.now() - start;
    this.#config.logger.debug(`[${this.#config.errorPrefix}: 'RPC Base'] Validated ${type} RPC URL ${endpoint.url} in ${time.toFixed(2)}ms`);
    return { ...endpoint, time, type };
  }

  private drainQueueFor(rpc: RPCCallResult): void {
    if (this.#getRpcAsyncQueue.size === 0) return;
    for (const entry of this.#getRpcAsyncQueue) {
      if (entry.type === rpc.type) {
        let result: THttp | TWs;
        if (rpc.originalFormat === "string") {
          result = rpc.url as unknown as THttp | TWs;
        } else {
          result = {
            url: rpc.url,
            ...(rpc.headers ? { headers: rpc.headers } : {}),
            ...(rpc.query ? { query: rpc.query } : {})
          } as unknown as THttp | TWs;
        }
        entry.resolve(result);
        if (entry.timer) { clearTimeout(entry.timer); }
        this.#getRpcAsyncQueue.delete(entry);
      }
    }
  }

  private scheduleNextRefresh(): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);

    const weakThis = new WeakRef(this);
    this.#refreshTimer = setTimeout(function () {
      const ref = weakThis.deref();
      if (ref && !ref.#isDestroyed) void ref.initialize();
    }, this.#config.ttl * 1000);

    const timer = this.#refreshTimer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }


  private validateRpcType(type: RPCType): void {
    const typeStr = type as string
    if (typeStr !== "https" && typeStr !== "ws") {
      throw new LazyRpcError(`Invalid RPC type: "${typeStr}". Must be "ws" or "https"`, "RPC Base", this.#config.errorPrefix);
    }
  }
}
