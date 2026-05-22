/**
 * Internal RPC configuration — the final, frozen, immutable runtime config.
 *
 * Built once during construction from RPCConfig + RPCDependencies.
 * Shared freely across all internal functions without coupling to `this`.
 *
 * @module config
 */

import { RPCConfig, RPCDependencies, LoadBalancingStrategy, CustomRpcs, InternalRpcEndpoint, HttpRpcEndpointOptions } from "../types.js";
import { validateConfig } from "./validation/config.validation.js";
import {
  mergeCustomUrls,
  filterSecureUrls,
} from "./validation/url.validation.js";
import { Logger, defaultLogger, silentLogger } from "./logger.js";
import { LazyRpcError } from "./error.js";

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
  readonly agent: unknown;
  readonly maxPayloadBytes: number;
  readonly maxPayloadDepth: number;
  readonly maxPayloadKeys: number;
  readonly maxPayloadArrayLength: number;
  readonly maxPayloadStringBytes: number;
  readonly requireJsonContentType: boolean;
  readonly errorPrefix: string;
}

/**
 * Validates RPCConfig, merges defaults, and returns a frozen _InternalRpcConfig.
 *
 * @param config - User-provided configuration
 * @param deps - Injected platform dependencies
 * @returns Frozen internal config object
 * @throws Error if config validation fails
 */
function parseChainId(input: string | number): string {
  let cleanHex: string;

  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0) {
      throw new LazyRpcError("chainId number must be a positive integer", "Config Builder");
    }
    cleanHex = input.toString(16);
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
      cleanHex = trimmed.slice(2).toLowerCase();
    } else if (/^\d+$/.test(trimmed)) {
      if (trimmed.length > 1 && trimmed.startsWith("0")) {
        cleanHex = trimmed.toLowerCase();
      } else {
        cleanHex = parseInt(trimmed, 10).toString(16);
      }
    } else if (/^[0-9a-fA-F]+$/i.test(trimmed)) {
      cleanHex = trimmed.toLowerCase();
    } else {
      throw new LazyRpcError("chainId must be in hex format", "Config Builder");
    }
  } else {
    throw new LazyRpcError("chainId must be a string or number", "Config Builder");
  }

  if (cleanHex === "1" || cleanHex === "0001") {
    return "x0001";
  }

  return `x${cleanHex}`;
}

export function buildInternalConfig<THttp = string, TWs = string>(
  config: RPCConfig<THttp, TWs>,
  deps: RPCDependencies,
): _InternalRpcConfig {
  validateConfig(config);

  const parsedChainId = parseChainId(config.chainId);

  let logger: Logger
  if (config.log && typeof config.log === "object") {
    logger = config.log
  } else if (config.log === true) {
    logger = defaultLogger
  } else {
    logger = silentLogger
  }

  const internal: _InternalRpcConfig = {
    chainId: parsedChainId,
    ttl: config.ttl ?? 1200,
    maxRetry: config.maxRetry ?? 3,

    logger: logger,
    loadBalancing: config.loadBalancing ?? "fastest",
    baseBackoffDelay: config.baseBackoffDelay ?? 30000,
    maxBackoffDelay: config.maxBackoffDelay ?? 300000,
    validationTimeout: config.validationTimeout ?? 5000,
    enforceHttps: config.enforceHttps ?? true,
    timeToResetFailedURL: config.timeToResetFailedURL ?? 6 * 60 * 60 * 1000,
    fetchFn: deps.fetchFn,
    websocketClass: deps.websocketClass,
    agent: config.agent !== undefined ? config.agent : deps.agent,
    maxPayloadBytes: config.maxPayloadBytes ?? 2048,
    maxPayloadDepth: config.maxPayloadDepth ?? 3,
    maxPayloadKeys: config.maxPayloadKeys ?? 10,
    maxPayloadArrayLength: config.maxPayloadArrayLength ?? 10,
    maxPayloadStringBytes: config.maxPayloadStringBytes ?? 100,
    requireJsonContentType: config.requireJsonContentType ?? true,
    errorPrefix: config.errorPrefix ?? "LazyRpc",
  };

  return Object.freeze(internal);
}

/**
 * Result of resolving base URLs from a chain list + custom RPCs.
 */
export interface ResolvedUrls {
  readonly http: InternalRpcEndpoint[];
  readonly ws: InternalRpcEndpoint[];
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
export function resolveBaseUrls<THttp = string, TWs = string>(
  chainList: Record<string, string[]> | null | undefined,
  chainId: string,
  customRpcs?: CustomRpcs<THttp, TWs>,
  enforceHttps = true,
  errorPrefix = "LazyRpc"
): ResolvedUrls {
  if (!chainList) {
    throw new LazyRpcError("Chain list must be provided to dependencies", "Config Builder", errorPrefix);
  }

  let normalizedId = chainId;
  if (chainId.startsWith("0x") || chainId.startsWith("0X")) {
    const cleanHex = chainId.slice(2).toLowerCase();
    normalizedId = (cleanHex === "1" || cleanHex === "0001") ? "x0001" : `x${cleanHex}`;
  }

  const httpRaw = chainList[normalizedId];

  if (!httpRaw) {
    let displayId = normalizedId.replace(/^x/, "0x");
    if (displayId === "0x0001") displayId = "0x1";
    throw new LazyRpcError(`Chain ID ${displayId} not found in RPC list`, "Config Builder", errorPrefix);
  }

  const wsRaw = chainList[`${normalizedId}_WS`] ?? [];


  let httpUrls: InternalRpcEndpoint[] = Array.from(new Set(httpRaw)).map(url => ({ url, originalFormat: "string" }));
  let wsUrls: InternalRpcEndpoint[] = Array.from(new Set(wsRaw)).map(url => ({ url, originalFormat: "string" }));

  if (customRpcs && Object.keys(customRpcs).length > 0) {
    httpUrls = mergeCustomUrls(httpUrls, customRpcs.http as (string | HttpRpcEndpointOptions)[] | undefined, "http");
    wsUrls = mergeCustomUrls(wsUrls, customRpcs.ws as (string | HttpRpcEndpointOptions)[] | undefined, "ws");
  }

  if (enforceHttps) {
    httpUrls = filterSecureUrls(httpUrls, "http");
    wsUrls = filterSecureUrls(wsUrls, "ws");
  }

  return { http: httpUrls, ws: wsUrls };
}
