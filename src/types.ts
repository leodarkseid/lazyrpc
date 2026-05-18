import { Logger } from "./core/logger";

/**
 * Custom RPC URLs to append to the base RPC list.
 * URLs are validated at construction time — malformed URLs or wrong protocols
 * will throw an error. Empty arrays are not permitted; omit the key instead.
 *
 * These URLs are merged into the pool after the base list is loaded
 * (whether from the built-in JSON or a custom file via `pathToRpcJson`),
 * then validated at runtime alongside all other endpoints during the
 * periodic validation cycle.
 *
 * @example
 * ```typescript
 * const rpc = new RPC({
 *   chainId: "0x0001",
 *   customRpcs: {
 *     http: ["https://my-alchemy-endpoint.com/v2/key"],
 *     ws: ["wss://my-alchemy-endpoint.com/v2/key"]
 *   }
 * });
 * ```
 */
export interface CustomRpcs {
  /** HTTP(S) RPC endpoint URLs to add to the pool. Must be non-empty if provided. */
  http?: string[];
  /** WebSocket (WSS/WS) RPC endpoint URLs to add to the pool. Must be non-empty if provided. */
  ws?: string[];
}

/**
 * Configuration options for the RPC class
 */
export interface RPCConfig {
  /** Blockchain chain ID in hex format (e.g., "0x0001") */
  chainId: string;
  /** Time-to-live for RPC validation in seconds (default: 10) */
  ttl?: number;
  /** Maximum number of retries before dropping an RPC (default: 3) */
  maxRetry?: number;
  /** Absolute path to custom RPC list JSON file (Node.js only). Replaces the built-in list entirely. */
  pathToRpcJson?: string;
  /** Enable logging for debugging (default: false) or provide custom Logger */
  log?: boolean | Logger;
  /** Load balancing strategy (default: "fastest") */
  loadBalancing?: "fastest" | "round-robin" | "random";
  /** Exponential backoff base delay in milliseconds (default: 2000) */
  baseBackoffDelay?: number;
  /** Maximum backoff delay in milliseconds (default: 300000) */
  maxBackoffDelay?: number;
  /** Timeout for RPC validation calls in milliseconds (default: 5000) */
  validationTimeout?: number;
  /**
   * Additional RPC URLs to merge into the base endpoint list.
   * Accepts HTTP and WebSocket URLs scoped to the instance's chainId.
   * URLs are strictly validated at construction — invalid URLs throw immediately.
   * Empty arrays are not permitted and will throw; omit the key instead.
   * These extend (not replace) whatever base list is loaded.
   * @see CustomRpcs
   */
  customRpcs?: CustomRpcs;
  /**
   * Enforce HTTPS/WSS protocols for all endpoints.
   * When true, any non-secure endpoints (http://, ws://) will be silently ignored.
   * Default: true
   */
  enforceHttps?: boolean;
  /**
   * Inject a custom HTTP agent (e.g., undici Agent) to control routing behavior.
   * This is used to enforce specific network policies like IPv4-only resolution.
   * Must be provided at construction if strict routing is required.
   */
  agent?: any;
}

/**
 * Dependencies injected into the RPC class
 */
export interface RPCDependencies {
  fetchFn: typeof fetch;
  websocketClass: typeof WebSocket;
  agent?: any; // HTTP Agent for Node.js (undici)
  chainList?: Record<string, string[]>; // Parsed JSON chain list
}

/**
 * RPC endpoint with performance metrics
 */
export interface RPCEndpoint {
  /** The RPC URL */
  url: string;
  /** Response time in milliseconds */
  time: number;
}

/**
 * Failed URL tracking information
 */
export interface FailedURLInfo {
  /** Number of consecutive failures */
  count: number;
  /** Timestamp of last failure */
  time: number;
  /** Next retry time (for exponential backoff) */
  nextRetry?: number;
}

/**
 * RPC call result
 */
export interface RPCCallResult {
  /** Response time in milliseconds */
  time: number;
  /** Type of RPC call */
  type: "ws" | "https";
  /** The RPC URL that was called */
  url: string;
}

/**
 * Load balancing strategies
 */
export type LoadBalancingStrategy = "fastest" | "round-robin" | "random";

/**
 * Failure statistics returned by getFailureStats()
 */
export interface FailureStats {
  /** Total number of URLs that have failed at least once */
  totalFailed: number;
  /** Number of URLs currently in backoff period */
  inBackoff: number;
  /** Number of URLs that have exceeded max retries */
  overMaxRetries: number;
}

/**
 * RPC type for method calls
 */
export type RPCType = "ws" | "https";

/**
 * Lifecycle status of the RPC instance.
 * - `"initializing"` — async validation is in progress, no validated URLs available yet
 * - `"refreshing"` — validated URLs are available, but a re-validation cycle is running
 * - `"ready"` — at least one validated URL is available and no validation is in progress
 * - `"destroyed"` — the instance has been destroyed and is no longer usable
 */
export type RPCStatus = "initializing" | "refreshing" | "ready" | "destroyed";
