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
export interface CustomRpcs<THttp = string, TWs = string> {
  /** HTTP(S) RPC endpoint URLs to add to the pool. Must be non-empty if provided. */
  http?: THttp[];
  /** WebSocket (WSS/WS) RPC endpoint URLs to add to the pool. Must be non-empty if provided. */
  ws?: TWs[];
}
export interface HttpRpcEndpointOptions {
  /** The base URL of the RPC endpoint */
  url: string;
  /** Custom headers to inject (e.g., Authorization tokens). Supports dynamic async resolution. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Custom query parameters to append. Supports dynamic async resolution. */
  query?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
}

export interface InternalRpcEndpoint {
  url: string;
  headers?: HttpRpcEndpointOptions["headers"];
  query?: HttpRpcEndpointOptions["query"];
  originalFormat: "string" | "object";
}

/**
 * Configuration options for the RPC class
 */
export interface RPCConfig<THttp = string, TWs = string> {
  /** Blockchain chain ID (can be hex string "0x1", numeric string "1", or number 1) */
  chainId: string | number;
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
  /** Time before a failed URL is completely reset in milliseconds (default: 21600000 / 6 hours) */
  timeToResetFailedURL?: number;
  /**
   * Additional RPC URLs to merge into the base endpoint list.
   * Accepts HTTP and WebSocket URLs scoped to the instance's chainId.
   * URLs are strictly validated at construction — invalid URLs throw immediately.
   * Empty arrays are not permitted and will throw; omit the key instead.
   * These extend (not replace) whatever base list is loaded.
   * @see CustomRpcs
   */
  customRpcs?: CustomRpcs<THttp, TWs>;
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
  agent?: unknown;
  /**
   * Bring-your-own fetch adapter (e.g., Axios wrappers, custom network handlers).
   *
   * ⚠️ SECURITY WARNING: lazy-rpc achieves its un-crashable runtime defense by parsing
   * raw, incoming byte streams incrementally. If you override fetchFn using traditional
   * higher-level libraries like Axios or Superagent without stream-passthrough options,
   * you will disable the maxPayloadBytes protection layer and allow full-payload buffering
   * memory exploits. For proxy routing, prefer passing an Undici ProxyAgent into the
   * native agent parameter instead.
   */
  fetchFn?: typeof fetch;
  /** Maximum accepted RPC response/message payload size in bytes (default: 51200 - 50KB). */
  maxPayloadBytes?: number;
  /** Maximum parsed JSON nesting depth accepted from RPC endpoints (default: 5). */
  maxPayloadDepth?: number;
  /** Maximum total object key count accepted from a parsed RPC payload (default: 50). */
  maxPayloadKeys?: number;
  /** Maximum JSON array length accepted from RPC endpoints (default: 50). */
  maxPayloadArrayLength?: number;
  /** Maximum byte size for any single JSON string in an RPC payload (default: 1024). */
  maxPayloadStringBytes?: number;
  /** Require HTTP validation responses to declare an application/json content type (default: true). */
  requireJsonContentType?: boolean;
  /** Configurable error prefix for standardizing error tracking application wide (default: "LazyRpc"). */
  errorPrefix?: string;
}

/**
 * Dependencies injected into the RPC class
 */
export interface RPCDependencies {
  fetchFn: typeof fetch;
  websocketClass: typeof WebSocket;
  agent?: unknown;
  chainList?: Record<string, string[]>;
}

/**
 * RPC endpoint with performance metrics
 */
export interface RPCEndpoint extends InternalRpcEndpoint {
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
export interface RPCCallResult extends InternalRpcEndpoint {
  /** Response time in milliseconds */
  time: number;
  /** Type of RPC call */
  type: "ws" | "https";
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
