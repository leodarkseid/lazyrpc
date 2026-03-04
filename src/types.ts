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
  /** Absolute path to custom RPC list JSON file */
  pathToRpcJson?: string;
  /** Enable logging for debugging (default: false) */
  log?: boolean;
  /** Load balancing strategy (default: "fastest") */
  loadBalancing?: "fastest" | "round-robin" | "random";
  /** Exponential backoff base delay in milliseconds (default: 2000) */
  baseBackoffDelay?: number;
  /** Maximum backoff delay in milliseconds (default: 300000) */
  maxBackoffDelay?: number;
  /** Timeout for RPC validation calls in milliseconds (default: 5000) */
  validationTimeout?: number;
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