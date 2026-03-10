import { assert } from "./tools.js";
import {
  RPCConfig,
  RPCEndpoint,
  FailedURLInfo,
  RPCCallResult,
  RPCType,
  LoadBalancingStrategy,
  FailureStats,
  RPCDependencies,
} from "./types.js";

/**
 * Enhanced RPC Base class for managing and validating RPC URLs.
 * Handles both HTTP and WebSocket calls, failure tracking, retry logic,
 * load balancing, and exponential backoff.
 */
export class RPCBase {
  /** Time-to-live for RPC validation (in seconds) */
  private ttl: number = 10;
  /** Hex value of Blockchain chain ID */
  private chainId: string = "0x0001";
  /** List of valid HTTP RPC endpoints */
  private validRPCs: RPCEndpoint[] = [];
  /** List of valid WebSocket RPC endpoints */
  private validWSRPCs: RPCEndpoint[] = [];
  /** Tracks failed URLs and their retry count */
  private failedURL = new Map<string, FailedURLInfo>();
  /** Maximum number of retries before dropping an RPC */
  private maxRetry: number = 3;
  /** Flag to enable logging */
  private log: boolean = false;
  /** Time before resetting failed URLs (in milliseconds) */
  private timeToResetFailedURL = 6 * 60 * 60 * 1000;
  /** Absolute path to alternative rpc list json used */
  private pathToRpcJson: string = "";
  /** Load balancing strategy */
  private loadBalancing: LoadBalancingStrategy = "fastest";
  /** Round-robin counters for load balancing */
  private httpRoundRobinIndex: number = 0;
  private wsRoundRobinIndex: number = 0;
  /** Base backoff delay in milliseconds */
  private baseBackoffDelay: number = 2000;
  /** Maximum backoff delay in milliseconds */
  private maxBackoffDelay: number = 300000;
  /** Timeout for RPC validation calls in milliseconds */
  private validationTimeout: number = 5000;
  /** Handle for the periodic refresh timer */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** HTTP Agent (Optional) */
  private agent: any;
  /** True if instance has been destroyed to prevent async leak restarts */
  private isDestroyed: boolean = false;
  /** Centralized AbortController to cleanly abort pending requests upon destroy */
  private abortController: AbortController = new AbortController();

  /** Injected Fetch function */
  private fetchFn: typeof fetch;
  /** Injected WebSocket class */
  private websocketClass: typeof WebSocket;
  /** Provided chain list object */
  private chainList: Record<string, string[]> | null = null;

  /**
   * Promise that resolves when initialization is complete.
   * Used to prevent concurrent initialization.
   */
  private initPromise: Promise<void> | null = null;

  private baseHttpUrls: string[] = [];
  private baseWsUrls: string[] = [];

  /**
   * Constructor initializes RPC class with configuration options.
   * @param config - Configuration options for chainId, ttl, maxRetry, and other settings.
   * @param deps - Injected dependencies
   */
  constructor(config: RPCConfig, deps: RPCDependencies) {
    // Validate input parameters
    this.validateConfig(config);

    this.chainId = config.chainId;
    this.ttl = config.ttl ?? this.ttl;
    this.maxRetry = config.maxRetry ?? this.maxRetry;
    this.log = config.log ?? this.log;
    this.pathToRpcJson = config.pathToRpcJson ?? this.pathToRpcJson;
    this.loadBalancing = config.loadBalancing ?? this.loadBalancing;
    this.baseBackoffDelay = config.baseBackoffDelay ?? this.baseBackoffDelay;
    this.maxBackoffDelay = config.maxBackoffDelay ?? this.maxBackoffDelay;
    this.validationTimeout = config.validationTimeout ?? this.validationTimeout;

    this.fetchFn = deps.fetchFn;
    this.websocketClass = deps.websocketClass;
    this.agent = deps.agent;
    this.chainList = deps.chainList || null;

    try {
      this.init();
      this.initialize();
    } catch (err) {
      if (this.agent && typeof this.agent.destroy === "function") {
        try {
          this.agent.destroy();
        } catch (e) { }
      }
      throw err;
    }
  }

  /**
   * Validates the configuration parameters
   * @param config - The configuration to validate
   */
  private validateConfig(config: RPCConfig): void {
    if (!config.chainId) {
      throw new Error("chainId is required");
    }

    if (!config.chainId.startsWith("0x")) {
      throw new Error("chainId must be in hex format (e.g., '0x0001')");
    }

    if (config.ttl !== undefined && (config.ttl <= 0 || config.ttl > 3600)) {
      throw new Error("ttl must be between 1 and 3600 seconds");
    }

    if (
      config.maxRetry !== undefined &&
      (config.maxRetry < 0 || config.maxRetry > 10)
    ) {
      throw new Error("maxRetry must be between 0 and 10");
    }

    if (
      config.loadBalancing &&
      !["fastest", "round-robin", "random"].includes(config.loadBalancing)
    ) {
      throw new Error(
        "loadBalancing must be 'fastest', 'round-robin', or 'random'",
      );
    }
  }


  /**
   * Drops a given URL from the RPC list by marking it as failed.
   * @param url - The RPC URL to be dropped.
   */
  public drop = (url: string) => {
    this.drop_(url, 1);
  }

  /**
   * Private method to track failed RPC URLs with exponential backoff.
   * @param url - The failed RPC URL.
   * @param count - The number of retries to add (default: 1).
   */
  private drop_ = (url: string, count: number = 1): void => {
    const prevFailures = this.failedURL.get(url) ?? {
      count: 0,
      time: Date.now(),
      nextRetry: Date.now(),
    };

    const newCount = prevFailures.count + count;
    const backoffDelay = Math.min(
      this.baseBackoffDelay * Math.pow(2, newCount - 1),
      this.maxBackoffDelay, // Max backoff
    );

    this.failedURL.set(url, {
      count: newCount,
      time: Date.now(),
      nextRetry: Date.now() + backoffDelay,
    });

    if (this.log) {
      console.warn(
        `RPC ${url} failed ${newCount} times. Next retry in ${backoffDelay}ms`,
      );
    }
  }

  /**
   * Retrieves a valid RPC URL based on type and load balancing strategy.
   * @param type - The type of RPC: "ws" or "https".
   * @returns A valid RPC URL.
   * @throws Error if no valid URLs are found.
   */
  public getRpc = (type: RPCType): string => {
    if (type !== "https" && type !== "ws") {
      throw new Error(`Invalid RPC type: "${type}". Must be "ws" or "https"`);
    }

    const endpoints = type === "https" ? this.validRPCs : this.validWSRPCs;

    if (endpoints.length === 0) {
      throw new Error(`No valid ${type} URLs found`);
    }

    let selectedEndpoint: RPCEndpoint | undefined;

    switch (this.loadBalancing) {
      case "fastest":
        selectedEndpoint = endpoints.find((e) => !this.shouldSkipURL(e.url));
        break;

      case "round-robin":
        if (type === "https") {
          for (let i = 0; i < endpoints.length; i++) {
            const index = (this.httpRoundRobinIndex + i) % endpoints.length;
            if (!this.shouldSkipURL(endpoints[index].url)) {
              selectedEndpoint = endpoints[index];
              this.httpRoundRobinIndex = (index + 1) % endpoints.length;
              break;
            }
          }
        } else {
          for (let i = 0; i < endpoints.length; i++) {
            const index = (this.wsRoundRobinIndex + i) % endpoints.length;
            if (!this.shouldSkipURL(endpoints[index].url)) {
              selectedEndpoint = endpoints[index];
              this.wsRoundRobinIndex = (index + 1) % endpoints.length;
              break;
            }
          }
        }
        break;

      case "random":
        const validEndpoints = endpoints.filter(
          (e) => !this.shouldSkipURL(e.url),
        );
        if (validEndpoints.length > 0) {
          const randomIndex = Math.floor(Math.random() * validEndpoints.length);
          selectedEndpoint = validEndpoints[randomIndex];
        }
        break;

      default:
        selectedEndpoint = endpoints.find((e) => !this.shouldSkipURL(e.url));
    }

    if (!selectedEndpoint) {
      throw new Error(`All ${type} URLs are currently failing or in backoff`);
    }

    return selectedEndpoint.url;
  }

  /**
   * Retrieves a valid RPC URL based on type (HTTP or WebSocket) asynchronously.
   * @param type - The type of RPC: "ws" or "https".
   * @returns A valid RPC URL Promise.
   * @throws Error if no valid URLs are found.
   */
  public async getRpcAsync(type: RPCType): Promise<string> {
    await this.initialize();
    return this.getRpc(type);
  }

  /**
   * Initializes RPC lists from the injected chain list, only at Class initialization.
   * @returns void
   */
  private init(): void {
    if (!this.chainList) {
      throw new Error(`Chain list must be provided to dependencies`);
    }
    const chainList = this.chainList;
    const formattedChainId = this.formatChainId(this.chainId);
    const http = chainList[formattedChainId];
    if (!http) {
      throw new Error(`Chain ID ${this.chainId} not found in RPC list`);
    }
    const ws = chainList[`${formattedChainId}_WS`] || [];
    this.baseHttpUrls = http || [];
    this.baseWsUrls = ws || [];
    this.validRPCs = http.map((h: string) => {
      return { url: h, time: 999999999999 };
    });
    this.validWSRPCs = ws.map((w: string) => {
      return { url: w, time: 999999999999 };
    });

  }

  /**
   * Formats the chainId to match the JSON structure where small hex values are zero-padded
   * @param chainId - The blockchain chain ID.
   * @returns Formatted string key like "x0001" or "xa86a".
   */
  private formatChainId(chainId: string): string {
    let cleanHex = chainId.slice(2).toLowerCase(); // Remove "0x"

    // In our rpcList.min.json, ONLY Ethereum mainnet (0x1) is padded as x0001
    // Other chains like Polygon (0x89) are literally just x89
    if (cleanHex === "1" || cleanHex === "0001") {
      return "x0001";
    }

    return `x${cleanHex}`;
  }

  /**
   * Fetches RPC URLs from the chain list and initializes them.
   */
  private initialize(): Promise<void | null> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async (instance: RPCBase) => {
      if (instance.isDestroyed) {
        instance.initPromise = null;
        return;
      }

      try {
        const allUrls: { url: string; type: RPCType }[] = [
          ...instance.baseHttpUrls.map((url) => ({ url, type: "https" as RPCType })),
          ...instance.baseWsUrls.map((url) => ({ url, type: "ws" as RPCType })),
        ];

        // Throttle: validate in batches to avoid overwhelming the network
        const BATCH_SIZE = 10;

        const results: RPCCallResult[] = [];
        for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
          const batch = allUrls.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.allSettled(
            batch.map(({ url, type }) =>
              instance.run(
                type === "https" ? (u: string, id: number) => instance.httpCall(u, id) : (u: string, id: number) => instance.wsCall(u, id),
                url,
                type,
              ),
            ),
          );
          for (const result of batchResults) {
            if (result.status === "fulfilled") {
              results.push(result.value);
            } else if (instance.log) {
              console.warn("RPC validation failed:", result.reason);
            }
          }
        }

        const newHTTP = results
          .filter((r) => r.type === "https")
          .sort((a, b) => a.time - b.time)
          .map((r) => ({ url: r.url, time: r.time }));

        const newWS = results
          .filter((r) => r.type === "ws")
          .sort((a, b) => a.time - b.time)
          .map((r) => ({ url: r.url, time: r.time }));

        // Only replace the lists if we got at least some successes.
        // This prevents total data loss when network is temporarily down.
        if (newHTTP.length > 0) {
          instance.validRPCs = newHTTP;
        }
        if (newWS.length > 0) {
          instance.validWSRPCs = newWS;
        }

        if (instance.log) {
          console.log(
            `Validated ${newHTTP.length} HTTP and ${newWS.length} WebSocket RPCs`,
          );
        }
      } catch (error) {
        if (instance.log) {
          console.error("Error during RPC initialization:", error);
        }
      } finally {
        // critical: unlock the init promise
        instance.initPromise = null;

        if (instance.isDestroyed) return;

        // Schedule next initialization (clear any previous timer first)
        if (instance.refreshTimer) clearTimeout(instance.refreshTimer);

        const weakThis = new WeakRef(instance);
        instance.refreshTimer = setTimeout(
          function () {
            const ref = weakThis.deref();

            // If the user dropped the variable and the GC deleted it, 
            // 'instance' will be undefined. We just do nothing, and the loop dies!
            if (ref && !ref.isDestroyed) {
              ref.initialize();
            }
          },
          instance.ttl * 1000
        );
        if (
          instance.refreshTimer &&
          typeof instance.refreshTimer === "object" &&
          "unref" in instance.refreshTimer
        ) {
          instance.refreshTimer.unref();
        }
      }
    })(this);
    return this.initPromise;
  }

  /**
   * Gets the count of valid RPCs for a given type.
   * @param type - The type of RPC: "ws" or "https".
   * @returns The number of valid RPCs.
   */
  public getValidRPCCount(type: RPCType): number {
    return type === "https" ? this.validRPCs.length : this.validWSRPCs.length;
  }

  /**
   * Gets all valid RPCs for a given type with their performance metrics.
   * @param type - The type of RPC: "ws" or "https".
   * @returns Array of RPC endpoints with performance data.
   */
  public getAllValidRPCs(type: RPCType): RPCEndpoint[] {
    return type === "https" ? [...this.validRPCs] : [...this.validWSRPCs];
  }

  /**
   * Gets statistics about failed URLs.
   * @returns Object containing failure statistics.
   */
  public getFailureStats(): FailureStats {
    let inBackoff = 0;
    let overMaxRetries = 0;

    this.failedURL.forEach((info) => {
      if (info.count >= this.maxRetry) {
        overMaxRetries++;
      } else if (info.nextRetry && Date.now() < info.nextRetry) {
        inBackoff++;
      }
    });

    return {
      totalFailed: this.failedURL.size,
      inBackoff,
      overMaxRetries,
    };
  }

  /**
   * Manually refresh the RPC list by running validation immediately.
   * @returns Promise that resolves when refresh is complete.
   */
  public async refresh(): Promise<void> {
    await this.initialize();
  }

  /**
   * Destroys the RPC instance, clearing all timers and preventing memory leaks.
   * Should be called when the instance is no longer needed.
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.abortController.abort();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.agent && typeof this.agent.destroy === "function") {
      try {
        this.agent.destroy();
      } catch (e) { }
    }
    this.validRPCs = [];
    this.validWSRPCs = [];
    this.failedURL.clear();
    // Recreate abortController to sever all previous signal event listeners
    // that might be holding onto closures
    this.abortController = new AbortController();
    if (this.log) {
      console.log("RPC instance destroyed");
    }
  }

  /**
   * Clear all failed URL records (useful for testing or manual resets).
   */
  public clearFailedURLs(): void {
    this.failedURL.clear();
    if (this.log) {
      console.log("Cleared all failed URL records");
    }
  }

  private id = 0;
  /**
   * Makes an HTTP call to validate an RPC URL.
   * @param url - The RPC URL.
   * @param id - Unique request identifier.
   * @returns Promise that resolves with the response data.
   */
  private httpCall = async (url: string, id: number): Promise<any> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.validationTimeout,
    );

    const onAbort = () => controller.abort();
    const ac = this.abortController;
    if (ac.signal.aborted) {
      onAbort();
    } else {
      ac.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (this.shouldSkipURL(url)) {
        throw new Error(`URL ${url} is in backoff period`);
      }

      if (!url) {
        throw new Error("Invalid HTTP URL");
      }

      const fetchOptions: any = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id,
        }),
        signal: controller.signal,
      };

      if (this.agent) {
        fetchOptions.dispatcher = this.agent;
      }

      const response = await this.fetchFn(url, fetchOptions);

      assert(response.ok, "Invalid HTTP Response");
      const data: any = await response.json();
      assert(data.id === id, "ID Mismatch");
      return data;
    } catch (error) {
      if (!this.isDestroyed) this.drop_(url);
      if (this.log) console.error(`HTTP request failed - ${url}: ${error}`);
      throw error;
    } finally {
      clearTimeout(timeout);
      ac.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Makes a WebSocket call to validate an RPC URL.
   * @param url - The WebSocket URL.
   * @param id - Unique request identifier.
   * @returns Promise that resolves when the WebSocket call is successful.
   */
  private wsCall = (url: string, id: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      try {
        if (this.shouldSkipURL(url)) {
          reject(new Error(`URL ${url} is in backoff period`));
          return;
        }

        if (!url) {
          reject(new Error("Invalid WebSocket URL"));
          return;
        }

        const ws = new this.websocketClass(url);
        // Bind an initial error handler to catch immediate connection errors
        ws.onerror = () => {};
        
        let isResolved = false;

        const closeWs = () => {
          try {
            ws.onerror = () => {}; // Prevent unhandled error if it errors while closing
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            if (ws.readyState === 1 || ws.readyState === 0) { // OPEN or CONNECTING
               ws.close();
            }
          } catch (e) { }
        };

        const onAbort = () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeout);
            closeWs();
            reject(new Error(`RPC instance destroyed`));
          }
        };

        const ac = this.abortController;

        if (ac.signal.aborted) {
          onAbort();
          return;
        }

        ac.signal.addEventListener("abort", onAbort, { once: true });

        const cleanup = () => {
          clearTimeout(timeout);
          ac.signal.removeEventListener("abort", onAbort);
        };

        // Timeout to prevent hanging connections
        const timeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            cleanup();
            closeWs();
            if (!this.isDestroyed) this.drop_(url);
            reject(new Error(`WebSocket timeout for ${url}`));
          }
        }, this.validationTimeout); // Dynamic timeout

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_blockNumber",
              params: [],
              id,
            }),
          );
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            assert(data.id === id, "WebSocket response ID mismatch");

            if (!isResolved) {
              isResolved = true;
              cleanup();
              closeWs();
              resolve(data);
            }
          } catch (error) {
            if (!isResolved) {
              isResolved = true;
              cleanup();
              closeWs();
              if (!this.isDestroyed) this.drop_(url);
              reject(error);
            }
          }
        };

        ws.onerror = (error) => {
          if (!isResolved) {
            isResolved = true;
            cleanup();
            closeWs();
            if (!this.isDestroyed) this.drop_(url);
            if (this.log) console.error(`WebSocket error for ${url}:`, error);
            reject(new Error(`WebSocket connection failed for ${url}`));
          }
        };

        ws.onclose = (event) => {
          if (!isResolved && event.code !== 1000) {
            // 1000 is normal closure
            isResolved = true;
            cleanup();
            if (!this.isDestroyed) this.drop_(url);
            reject(
              new Error(
                `WebSocket closed unexpectedly for ${url}: ${event.code}`,
              ),
            );
          }
        };
      } catch (error) {
        if (!this.isDestroyed) this.drop_(url);
        if (this.log)
          console.error(`Failed to create WebSocket for ${url}:`, error);
        reject(error);
      }
    });
  }

  /**
   * Checks if a URL should be skipped due to backoff or retry limits.
   * @param url - The URL to check.
   * @returns True if the URL should be skipped.
   */
  private shouldSkipURL(url: string): boolean {
    const failureInfo = this.failedURL.get(url);
    if (!failureInfo) return false;

    // Reset failures if enough time has passed
    if (Date.now() - failureInfo.time > this.timeToResetFailedURL) {
      this.failedURL.delete(url);
      // this.failedURL.set(url, { count: 0, time: Date.now(), nextRetry: Date.now() });
      return false;
    }

    // Check if we've exceeded max retries
    if (failureInfo.count >= this.maxRetry) return true;
    // Check if we're still in backoff period
    if (failureInfo.nextRetry && Date.now() < failureInfo.nextRetry)
      return true;
    return false;
  }

  /**
   * Runs the given function with the specified URL and measures execution time.
   * @param fn - The function to execute.
   * @param url - The RPC URL to test.
   * @param type - The type of RPC call: "ws" or "https".
   * @returns A promise resolving to an object containing execution time, type, and URL.
   */
  private async run(
    fn: Function,
    url: string,
    type: RPCType,
  ): Promise<RPCCallResult> {
    this.id++;
    const id = this.id;
    try {
      const start = performance.now();
      await fn(url, id);
      const stop = performance.now();
      return { time: stop - start, type, url };
    } catch (error) {
      // Error already handled in httpCall/wsCall
      throw error;
    }
  }
}
