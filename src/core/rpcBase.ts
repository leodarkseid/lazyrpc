import {
  RPCConfig,
  RPCEndpoint,
  RPCCallResult,
  RPCType,
  RPCStatus,
  LoadBalancingStrategy,
  FailureStats,
  RPCDependencies,
} from "../types.js";
import { buildInternalConfig, resolveBaseUrls, type _InternalRpcConfig } from "./config.js";
import { EndpointHealthManager } from "./health/index.js";
import { FastestBalancer, RoundRobinBalancer, RandomBalancer, type LoadBalancer } from "./balancing/index.js";
import { RpcTransport } from "./network/transports.js";

/**
 * RPC Base — thin orchestration shell.
 *
 * Wires together four independent modules:
 * - `_InternalRpcConfig` — frozen immutable config
 * - `EndpointHealthManager` — failure tracking and backoff
 * - `LoadBalancer` — endpoint selection strategies
 * - `RpcTransport` — HTTP/WS validation calls
 */
export class RPCBase {
  // ─── Immutable Config ──────────────────────────────────────────────────
  readonly #config: _InternalRpcConfig;

  // ─── Composable Modules ────────────────────────────────────────────────
  private readonly health: EndpointHealthManager;
  private readonly transport: RpcTransport;
  private readonly httpBalancers: Record<LoadBalancingStrategy, LoadBalancer> = {
    fastest: new FastestBalancer(),
    "round-robin": new RoundRobinBalancer(),
    random: new RandomBalancer(),
  };
  private readonly wsBalancers: Record<LoadBalancingStrategy, LoadBalancer> = {
    fastest: new FastestBalancer(),
    "round-robin": new RoundRobinBalancer(),
    random: new RandomBalancer(),
  };

  // ─── Mutable State ─────────────────────────────────────────────────────
  private validRPCs: RPCEndpoint[] = [];
  private validWSRPCs: RPCEndpoint[] = [];
  private loadBalancing: LoadBalancingStrategy;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed: boolean = false;
  private abortController: AbortController = new AbortController();
  private initPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private baseHttpUrls: string[] = [];
  private baseWsUrls: string[] = [];
  private id = 0;

  private getRpcAsyncQueue = new Set<{
    type: RPCType,
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    timer: ReturnType<typeof setTimeout> | null
  }>();

  // ─── Backward-compat getters (tests access via bracket notation) ───────
  private get failedURL() { return this.health.entries; }
  private get maxRetry(): number { return this.#config.maxRetry; }
  private get log(): boolean { return !!this.#config.logger; }
  private get agent(): any { return this.#config.agent; }
  private get timeToResetFailedURL(): number { return this.#config.timeToResetFailedURL; }

  constructor(config: RPCConfig, deps: RPCDependencies) {
    this.#config = buildInternalConfig(config, deps);
    this.loadBalancing = this.#config.loadBalancing;
    this.health = new EndpointHealthManager(this.#config);

    try {
      const urls = resolveBaseUrls(
        deps.chainList, config.chainId, config.customRpcs, this.#config.enforceHttps,
      );
      this.baseHttpUrls = urls.http;
      this.baseWsUrls = urls.ws;

      // Populate validRPCs synchronously with a sentinel time so they can be used immediately
      this.validRPCs = this.baseHttpUrls.map(url => ({ url, time: 999_999_999 }));
      this.validWSRPCs = this.baseWsUrls.map(url => ({ url, time: 999_999_999 }));

      this.transport = new RpcTransport(
        this.#config, this.abortController, this.health, () => this.isDestroyed,
      );

      this.initialize();
    } catch (err) {
      if (this.#config.agent && typeof this.#config.agent.destroy === "function") {
        try { this.#config.agent.destroy(); } catch (e) { }
      }
      throw err;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  public drop = (url: string) => {
    this.health.recordFailure(url);
  }

  public getRpc = (type: RPCType): string => {
    if (type !== "https" && type !== "ws") {
      throw new Error(`Invalid RPC type: "${type}". Must be "ws" or "https"`);
    }

    const endpoints = type === "https" ? this.validRPCs : this.validWSRPCs;
    if (endpoints.length === 0) {
      throw new Error(`No valid ${type} URLs found`);
    }

    const balancerMap = type === "https" ? this.httpBalancers : this.wsBalancers;
    const balancer = balancerMap[this.loadBalancing] ?? balancerMap["fastest"];
    const selected = balancer.select(endpoints, (url) => this.health.shouldSkip(url));

    if (!selected) {
      throw new Error(`All ${type} URLs are currently failing or in backoff`);
    }

    return selected.url;
  }

  public async getRpcAsync(type: RPCType, timeout: number = 10_000): Promise<string> {
    const endpoints = type === "https" ? this.validRPCs : this.validWSRPCs;
    const hasValidatedEndpoints = endpoints.length > 0 && endpoints[0].time < 999_999_999;

    if (hasValidatedEndpoints) {
      return this.getRpc(type);
    }

    const baseUrls = type === "https" ? this.baseHttpUrls : this.baseWsUrls;
    if (baseUrls.length === 0) {
      throw new Error(`No ${type} URLs available to validate`);
    }

    // Trigger validation if we're not currently running it
    if (!this.initPromise) {
      this.initialize();
    }

    return new Promise((resolve, reject) => {
      const job = { resolve, reject, type, timer: null as any };
      job.timer = setTimeout(() => {
        this.getRpcAsyncQueue.delete(job);
        reject(new Error(`Timeout of ${timeout}ms exceeded for ${type} RPC`));
      }, timeout);
      this.getRpcAsyncQueue.add(job);
    });
  }

  public status(): RPCStatus {
    if (this.isDestroyed) return "destroyed";
    const hasValidated = 
      (this.validRPCs.length > 0 && this.validRPCs[0].time < 999_999_999) || 
      (this.validWSRPCs.length > 0 && this.validWSRPCs[0].time < 999_999_999);
    if (hasValidated && this.initPromise) return "refreshing";
    if (hasValidated) return "ready";
    return "initializing";
  }

  public getValidRPCCount(type: RPCType): number {
    return type === "https" ? this.validRPCs.length : this.validWSRPCs.length;
  }

  public getAllValidRPCs(type: RPCType): RPCEndpoint[] {
    return type === "https" ? [...this.validRPCs] : [...this.validWSRPCs];
  }

  public getFailureStats(): FailureStats {
    return this.health.getStats();
  }

  public async refresh(): Promise<void> {
    await this.initialize();
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this.isDestroyed = true;
    this.abortController.abort();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.validRPCs = [];
    this.validWSRPCs = [];
    this.health.reset();
    // this.abortController = new AbortController();

    for (const entry of this.getRpcAsyncQueue) {
      clearTimeout(entry.timer!);
      entry.reject(new Error("RPC instance destroyed"));
    }
    this.getRpcAsyncQueue.clear();
    this.#config.logger.info("RPC instance destroyed");

    this.destroyPromise = (async () => {
      try {
        await this.initPromise;
      } catch (e) { }

      this.validRPCs = [];
      this.validWSRPCs = [];

      if (this.#config.agent && typeof this.#config.agent.destroy === "function") {
        try { await this.#config.agent.destroy(); } catch (e) { }
      }
    })();

    return this.destroyPromise;
  }

  public clearFailedURLs(): void {
    this.health.reset();
  }

  // ─── Backward-compat delegates (tests call these via bracket notation) ─

  private drop_ = (url: string, count: number = 1) => this.health.recordFailure(url, count);
  private shouldSkipURL(url: string): boolean { return this.health.shouldSkip(url); }
  private httpCall = async (url: string, id: number): Promise<any> => this.transport.httpCall(url, id);
  private wsCall = (url: string, id: number): Promise<any> => this.transport.wsCall(url, id);

  // ─── Private: Validation Loop ──────────────────────────────────────────

  private initialize(): Promise<void | null> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.runValidationCycle();
    return this.initPromise;
  }

  private async runValidationCycle(): Promise<void> {
    if (this.isDestroyed) {
      this.initPromise = null;
      return;
    }

    try {
      const allUrls: { url: string; type: RPCType }[] = [
        ...this.baseHttpUrls.map((url) => ({ url, type: "https" as RPCType })),
        ...this.baseWsUrls.map((url) => ({ url, type: "ws" as RPCType })),
      ];

      const BATCH_SIZE = 10;
      const results: RPCCallResult[] = [];

      for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
        if (this.isDestroyed) return;

        const batch = allUrls.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(({ url, type }) => this.timedCall(url, type)),
        );

        if (this.isDestroyed) return;

        for (const result of batchResults) {
          if (result.status === "fulfilled") {
            this.drainQueueFor(result.value);
            results.push(result.value);
          }else { this.#config.logger.warn("RPC validation failed:", result.reason);}
        }
      }

      if (this.isDestroyed) return;

      const toEndpoints = (r: RPCCallResult[]) =>
        r.sort((a, b) => a.time - b.time).map((r) => ({ url: r.url, time: r.time }));

      const newHTTP = toEndpoints(results.filter((r) => r.type === "https"));
      const newWS = toEndpoints(results.filter((r) => r.type === "ws"));

      if (newHTTP.length > 0) this.validRPCs = newHTTP;
      if (newWS.length > 0) this.validWSRPCs = newWS;

      this.#config.logger.info(`Validated ${newHTTP.length} HTTP and ${newWS.length} WebSocket RPCs`);
    } catch (error) {
      this.#config.logger.error("Error during RPC initialization:", error);
    } finally {
      this.initPromise = null;
      if (this.isDestroyed) return;

      this.scheduleNextRefresh();

      // Reject remaining queue entries (no valid URL arrived for them)
      for (const entry of this.getRpcAsyncQueue) {
        clearTimeout(entry.timer!);
        entry.reject(new Error("Failed To Find A Valid RPC"));
      }
      this.getRpcAsyncQueue.clear();
    }
  }

  private async timedCall(url: string, type: RPCType): Promise<RPCCallResult> {
    const id = ++this.id;
    const start = performance.now();
    await (type === "https" ? this.transport.httpCall(url, id) : this.transport.wsCall(url, id));
    return { time: performance.now() - start, type, url };
  }

  private drainQueueFor(rpc: RPCCallResult): void {
    if (this.getRpcAsyncQueue.size === 0) return;
    for (const entry of this.getRpcAsyncQueue) {
      if (entry.type === rpc.type) {
        entry.resolve(rpc.url);
        clearTimeout(entry.timer!);
        this.getRpcAsyncQueue.delete(entry);
      }
    }
  }

  private scheduleNextRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const weakThis = new WeakRef(this);
    this.refreshTimer = setTimeout(function () {
      const ref = weakThis.deref();
      if (ref && !ref.isDestroyed) ref.initialize();
    }, this.#config.ttl * 1000);

    if (
      this.refreshTimer &&
      typeof this.refreshTimer === "object" &&
      "unref" in this.refreshTimer
    ) {
      this.refreshTimer.unref();
    }
  }

  // Keep old name for backward compat (tests spy on "initialize")
  private _resolveGetAsyncQueue(rpc: RPCCallResult): void {
    this.drainQueueFor(rpc);
  }
}
