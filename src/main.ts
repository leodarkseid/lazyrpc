import { assert } from "./tools";
import * as fs from "fs";
import * as path from "path";
import { 
  RPCConfig, 
  RPCEndpoint, 
  FailedURLInfo, 
  RPCCallResult, 
  RPCType,
  LoadBalancingStrategy 
} from "./types";

/**
 * Enhanced RPC class for managing and validating RPC URLs.
 * Handles both HTTP and WebSocket calls, failure tracking, retry logic,
 * load balancing, and exponential backoff.
 */
export class RPC {
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
  private baseBackoffDelay: number = 1000;
  /** Timer for periodic initialization */
  private initializationTimer?: NodeJS.Timeout;

  /**
   * Constructor initializes RPC class with configuration options.
   * @param config - Configuration options for chainId, ttl, maxRetry, and other settings.
   */
  constructor(config: RPCConfig) {
    // Validate input parameters
    this.validateConfig(config);

    this.httpCall = this.httpCall.bind(this);
    this.wsCall = this.wsCall.bind(this);
    this.drop_ = this.drop_.bind(this);
    this.drop = this.drop.bind(this);
    this.getRpc = this.getRpc.bind(this);
    
    this.chainId = config.chainId;
    this.ttl = config.ttl || this.ttl;
    this.maxRetry = config.maxRetry || this.maxRetry;
    this.log = config.log || this.log;
    this.pathToRpcJson = config.pathToRpcJson || this.pathToRpcJson;
    this.loadBalancing = config.loadBalancing || this.loadBalancing;

    this.init();
    this.intialize();
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

    if (config.maxRetry !== undefined && (config.maxRetry < 0 || config.maxRetry > 10)) {
      throw new Error("maxRetry must be between 0 and 10");
    }

    if (config.loadBalancing && !["fastest", "round-robin", "random"].includes(config.loadBalancing)) {
      throw new Error("loadBalancing must be 'fastest', 'round-robin', or 'random'");
    }
  }

  /**
   * Reads the RPC list file and retrieves RPCs for the given chain ID.
   * @param chainId - The blockchain chain ID.
   * @returns A promise resolving to an array of RPC URLs.
   */
  private async getChain(chainId: string): Promise<string[]> {
    try {
      const filePath =
        this.pathToRpcJson && fs.existsSync(this.pathToRpcJson)
          ? this.pathToRpcJson
          : path.join(__dirname, "rpcList.min.json");
      let data: string | null = await fs.promises.readFile(filePath, "utf-8");
      let chainList = JSON.parse(data);
      try {
        chainList = JSON.parse(data);
      } catch (error: any) {
        throw new Error(`Invalid JSON format in ${filePath}: ${error.message}`);
      }
      const result = chainList[chainId];
      if (!result) {
        throw new Error(`Chain ID ${chainId} not found in ${filePath}`);
      }
      data = null;
      chainList = null;
      return result || [];
    } catch (error: any) {
      throw new Error(`Error fetching chain RPCs: ${error.message}`);
    }
  }

  /**
   * Drops a given URL from the RPC list by marking it as failed.
   * @param url - The RPC URL to be dropped.
   */
  public drop(url: string) {
    this.drop_(url, this.maxRetry);
  }

  /**
   * Private method to track failed RPC URLs with exponential backoff.
   * @param url - The failed RPC URL.
   * @param count - The number of retries to add (default: 1).
   */
  private drop_(url: string, count: number = 1): void {
    const prevFailures = this.failedURL.get(url) ?? {
      count: 0,
      time: Date.now(),
      nextRetry: Date.now()
    };
    
    const newCount = prevFailures.count + count;
    const backoffDelay = Math.min(
      this.baseBackoffDelay * Math.pow(2, newCount - 1), 
      60000 // Max 1 minute backoff
    );
    
    this.failedURL.set(url, {
      count: newCount,
      time: Date.now(),
      nextRetry: Date.now() + backoffDelay
    });

    if (this.log) {
      console.warn(`RPC ${url} failed ${newCount} times. Next retry in ${backoffDelay}ms`);
    }
  }

  /**
   * Retrieves a valid RPC URL based on type and load balancing strategy.
   * @param type - The type of RPC: "ws" or "https".
   * @returns A valid RPC URL.
   * @throws Error if no valid URLs are found.
   */
  public getRpc(type: RPCType): string {
    if (type !== "https" && type !== "ws") {
      throw new Error(`Invalid RPC type: ${type}. Must be 'https' or 'ws'.`);
    }
    
    const endpoints = type === "https" ? this.validRPCs : this.validWSRPCs;
    
    if (endpoints.length === 0) {
      throw new Error(`No valid ${type} URLs found`);
    }

    let selectedEndpoint: RPCEndpoint;

    switch (this.loadBalancing) {
      case "fastest":
        selectedEndpoint = endpoints[0]; // Already sorted by response time
        break;
      
      case "round-robin":
        if (type === "https") {
          selectedEndpoint = endpoints[this.httpRoundRobinIndex % endpoints.length];
          this.httpRoundRobinIndex = (this.httpRoundRobinIndex + 1) % endpoints.length;
        } else {
          selectedEndpoint = endpoints[this.wsRoundRobinIndex % endpoints.length];
          this.wsRoundRobinIndex = (this.wsRoundRobinIndex + 1) % endpoints.length;
        }
        break;
      
      case "random":
        const randomIndex = Math.floor(Math.random() * endpoints.length);
        selectedEndpoint = endpoints[randomIndex];
        break;
      
      default:
        selectedEndpoint = endpoints[0];
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
    await this.intialize();
    return this.getRpc(type);
  }

  /**
   * Initializes RPC lists from the local file, only at Class initialization.
   * @returns void
   */
  private init() {
    const filePath =
      this.pathToRpcJson && fs.existsSync(this.pathToRpcJson)
        ? this.pathToRpcJson
        : path.join(__dirname, "rpcList.min.json");
    const chainList = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const http = chainList[this.chainId.slice(1)];
    const ws = chainList[`${this.chainId.slice(1)}_WS`];
    this.validRPCs = http.map((h: string) => {
      return { url: h, time: 999999999999 };
    });
    this.validWSRPCs = ws.map((w: string) => {
      return { url: w, time: 999999999999 };
    });
  }

  /**
   * Fetches RPC URLs from the chain list and initializes them.
   */
  private async intialize(): Promise<void> {
    try {
      const http = await this.getChain(this.chainId.slice(1));
      const ws = await this.getChain(`${this.chainId.slice(1)}_WS`);
      
      const all = await Promise.allSettled([
        ...http.map(
          async (h: string) => await this.run(this.httpCall, h, "https")
        ),
        ...ws.map(async (w: string) => await this.run(this.wsCall, w, "ws")),
      ]);

      this.validRPCs = [];
      this.validWSRPCs = [];
      
      all.forEach((result) => {
        if (result.status === "fulfilled") {
          if (result.value.type === "ws") {
            this.validWSRPCs.push({ url: result.value.url, time: result.value.time });
          } else if (result.value.type === "https") {
            this.validRPCs.push({ url: result.value.url, time: result.value.time });
          }
        } else if (this.log) {
          console.warn("RPC validation failed:", result.reason);
        }
      });
      
      // Sort by response time (fastest first)
      this.validRPCs = this.validRPCs.sort((a, b) => a.time - b.time);
      this.validWSRPCs = this.validWSRPCs.sort((a, b) => a.time - b.time);
      
      if (this.log) {
        console.log(`Validated ${this.validRPCs.length} HTTP and ${this.validWSRPCs.length} WebSocket RPCs`);
      }
    } catch (error) {
      if (this.log) {
        console.error("Error during RPC initialization:", error);
      }
    }
    
    // Schedule next initialization
    if (this.initializationTimer) {
      clearTimeout(this.initializationTimer);
    }
    this.initializationTimer = setTimeout(() => this.intialize(), this.ttl * 1000);
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
  public getFailureStats(): { totalFailed: number; inBackoff: number; overMaxRetries: number } {
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
      overMaxRetries
    };
  }

  /**
   * Manually refresh the RPC list by running validation immediately.
   * @returns Promise that resolves when refresh is complete.
   */
  public async refresh(): Promise<void> {
    await this.intialize();
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

  /**
   * Clean up resources and stop timers (useful for testing).
   */
  public cleanup(): void {
    if (this.initializationTimer) {
      clearTimeout(this.initializationTimer);
      this.initializationTimer = undefined;
    }
  }

  private id = 0;
  /**
   * Makes an HTTP call to validate an RPC URL.
   * @param url - The RPC URL.
   * @param id - Unique request identifier.
   * @returns Promise that resolves with the response data.
   */
  private async httpCall(url: string, id: number): Promise<any> {
    try {
      if (this.shouldSkipURL(url)) {
        throw new Error(`URL ${url} is in backoff period`);
      }

      if (!url) {
        throw new Error("Invalid HTTP URL");
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id,
        }),
      });
      
      assert(response.ok, "Invalid HTTP Response");
      const data = await response.json();
      assert(data.id === id, "ID Mismatch");
      return data;
    } catch (error) {
      this.drop_(url);
      if (this.log) console.error(`HTTP request failed - ${url}: ${error}`);
      throw error;
    }
  }

  /**
   * Makes a WebSocket call to validate an RPC URL.
   * @param url - The WebSocket URL.
   * @param id - Unique request identifier.
   * @returns Promise that resolves when the WebSocket call is successful.
   */
  private wsCall(url: string, id: number): Promise<any> {
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

        const ws = new WebSocket(url);
        let isResolved = false;
        
        // Timeout to prevent hanging connections
        const timeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            ws.close();
            this.drop_(url);
            reject(new Error(`WebSocket timeout for ${url}`));
          }
        }, 10000); // 10 second timeout

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_blockNumber",
              params: [],
              id,
            })
          );
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            assert(data.id === id, "WebSocket response ID mismatch");
            
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeout);
              ws.close();
              resolve(data);
            }
          } catch (error) {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeout);
              ws.close();
              this.drop_(url);
              reject(error);
            }
          }
        };

        ws.onerror = (error) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeout);
            ws.close();
            this.drop_(url);
            if (this.log) console.error(`WebSocket error for ${url}:`, error);
            reject(new Error(`WebSocket connection failed for ${url}`));
          }
        };

        ws.onclose = (event) => {
          if (!isResolved && event.code !== 1000) { // 1000 is normal closure
            isResolved = true;
            clearTimeout(timeout);
            this.drop_(url);
            reject(new Error(`WebSocket closed unexpectedly for ${url}: ${event.code}`));
          }
        };
      } catch (error) {
        this.drop_(url);
        if (this.log) console.error(`Failed to create WebSocket for ${url}:`, error);
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
    if (!failureInfo) {
      return false;
    }

    // Reset failures if enough time has passed
    if (Date.now() - failureInfo.time > this.timeToResetFailedURL) {
      this.failedURL.set(url, { count: 0, time: Date.now(), nextRetry: Date.now() });
      return false;
    }

    // Check if we've exceeded max retries
    if (failureInfo.count >= this.maxRetry) {
      return true;
    }

    // Check if we're still in backoff period
    if (failureInfo.nextRetry && Date.now() < failureInfo.nextRetry) {
      return true;
    }

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
    type: RPCType
  ): Promise<RPCCallResult> {
    this.id++;
    const id = this.id;
    const start = performance.now();
    
    try {
      await fn(url, id);
      const stop = performance.now();
      return { time: stop - start, type, url };
    } catch (error) {
      // Error already handled in httpCall/wsCall
      throw error;
    }
  }
}
