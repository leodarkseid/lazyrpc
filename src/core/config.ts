/**
 * Internal RPC configuration — the final, frozen, immutable runtime config.
 *
 * Built once during construction from RPCConfig + RPCDependencies.
 * Shared freely across all internal functions without coupling to `this`.
 *
 * @module config
 */

import { RPCConfig, RPCDependencies, LoadBalancingStrategy, CustomRpcs } from "../types.js";
import { validateConfig } from "./validation/config.validation.js";
import {
  formatChainId,
  mergeCustomUrls,
  filterSecureUrls,
} from "./validation/url.validation.js";
import { Logger, defaultLogger, silentLogger } from "./logger.js";

/**
 * The final immutable runtime configuration for the RPC class.
 * Contains all resolved values with defaults applied.
 * Frozen after construction — safe to share across all internal functions.
 */
export interface _InternalRpcConfig {
  readonly chainId: string;
  readonly ttl: number;
  readonly maxRetry: number;
  readonly logger: Logger;
  readonly loadBalancing: LoadBalancingStrategy;
  readonly baseBackoffDelay: number;
  readonly maxBackoffDelay: number;
  readonly validationTimeout: number;
  readonly enforceHttps: boolean;
  readonly timeToResetFailedURL: number;
  readonly fetchFn: typeof fetch;
  readonly websocketClass: typeof WebSocket;
  readonly agent: any;
}

/**
 * Validates RPCConfig, merges defaults, and returns a frozen _InternalRpcConfig.
 *
 * @param config - User-provided configuration
 * @param deps - Injected platform dependencies
 * @returns Frozen internal config object
 * @throws Error if config validation fails
 */
export function buildInternalConfig(
  config: RPCConfig,
  deps: RPCDependencies,
): _InternalRpcConfig {
  validateConfig(config);

  let logger: Logger
  if (config.log && typeof config.log === "object") {
    logger = config.log as Logger
  } else if (config.log === true) {
    logger = defaultLogger
  } else {
    logger = silentLogger
  }

  const internal: _InternalRpcConfig = {
    chainId: config.chainId,
    ttl: config.ttl ?? 10,
    maxRetry: config.maxRetry ?? 3,

    logger: logger,
    loadBalancing: config.loadBalancing ?? "fastest",
    baseBackoffDelay: config.baseBackoffDelay ?? 2000,
    maxBackoffDelay: config.maxBackoffDelay ?? 300000,
    validationTimeout: config.validationTimeout ?? 5000,
    enforceHttps: config.enforceHttps ?? true,
    timeToResetFailedURL: 6 * 60 * 60 * 1000,
    fetchFn: deps.fetchFn,
    websocketClass: deps.websocketClass,
    agent: deps.agent,
  };

  return Object.freeze(internal);
}

/**
 * Result of resolving base URLs from a chain list + custom RPCs.
 */
export interface ResolvedUrls {
  readonly http: string[];
  readonly ws: string[];
}

/**
 * Resolves the full set of base URLs for a given chain from:
 * 1. The chain list JSON (built-in or custom file)
 * 2. User-provided custom RPCs (merged, validated strictly)
 * 3. HTTPS enforcement filter (if enabled)
 *
 * @param chainList - Parsed chain list object
 * @param chainId - The hex chain ID (e.g., "0x0001")
 * @param customRpcs - Optional custom RPCs to merge
 * @param enforceHttps - Whether to filter non-secure URLs
 * @returns Resolved and deduplicated HTTP and WS URL arrays
 * @throws Error if chainList is missing or chainId not found
 */
export function resolveBaseUrls(
  chainList: Record<string, string[]> | null | undefined,
  chainId: string,
  customRpcs?: CustomRpcs,
  enforceHttps: boolean = true,
): ResolvedUrls {
  if (!chainList) {
    throw new Error("Chain list must be provided to dependencies");
  }

  const formattedChainId = formatChainId(chainId);
  const httpRaw = chainList[formattedChainId];

  if (!httpRaw) {
    throw new Error(`Chain ID ${chainId} not found in RPC list`);
  }

  const wsRaw = chainList[`${formattedChainId}_WS`] || [];

  // Deduplicate base lists
  let httpUrls = Array.from(new Set(httpRaw));
  let wsUrls = Array.from(new Set(wsRaw));

  // Merge custom RPCs (validates strictly, throws on bad URLs)
  if (customRpcs && Object.keys(customRpcs).length > 0) {
    httpUrls = mergeCustomUrls(httpUrls, customRpcs.http, "http");
    wsUrls = mergeCustomUrls(wsUrls, customRpcs.ws, "ws");
  }

  // Enforce HTTPS/WSS
  if (enforceHttps) {
    httpUrls = filterSecureUrls(httpUrls, "http");
    wsUrls = filterSecureUrls(wsUrls, "ws");
  }

  return { http: httpUrls, ws: wsUrls };
}
