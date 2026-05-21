/**
 * Unified URL validation for both base chain-list URLs and custom user-provided RPCs.
 *
 * Design: A single validation function with two modes:
 * - `shouldThrow: true`  → for custom RPCs (fail-fast on developer errors)
 * - `shouldThrow: false` → for base list URLs (silently filter bad data)
 *
 * Same rules applied uniformly: parseable URL, correct protocol for type.
 *
 * @module url.validation
 */

export type UrlType = "http" | "ws";

import { LazyRpcError } from "../error.js";
import type { InternalRpcEndpoint, HttpRpcEndpointOptions } from "../../types.js";

export interface ValidateUrlOptions {
  /** If true, throws on invalid URLs. If false, returns false silently. */
  shouldThrow: boolean;
  /** Label for error messages (e.g., "customRpcs.http"). Defaults to "customRpcs.{type}" */
  label?: string;
}

/**
 * Validates a single RPC URL for correct format and protocol.
 *
 * Rules (applied identically regardless of source):
 * 1. URL must be parseable by the URL constructor
 * 2. HTTP URLs must use http: or https: protocol
 * 3. WS URLs must use ws: or wss: protocol
 *
 * @param url - The URL string to validate
 * @param type - Expected type: "http" for HTTP(S) URLs, "ws" for WebSocket URLs
 * @param opts - Controls throw-vs-filter behavior and error labeling
 * @returns true if valid, false if invalid (only when shouldThrow is false)
 * @throws Error when shouldThrow is true and validation fails
 */
export function validateUrl(
  url: string,
  type: UrlType,
  opts: ValidateUrlOptions,
  errorPrefix = "LazyRpc"
): boolean {
  const label = opts.label ?? `customRpcs.${type}`;


  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    if (opts.shouldThrow) {
      throw new LazyRpcError(
        `Invalid URL in ${label}: "${url}" is not a valid URL`,
        "URL Validation", errorPrefix
      );
    }
    return false;
  }


  if (type === "http" && !["https:", "http:"].includes(parsed.protocol)) {
    if (opts.shouldThrow) {
      throw new LazyRpcError(
        `Invalid protocol in ${label}: "${url}" uses "${parsed.protocol}" — ` +
        `expected "http:" or "https:"`,
        "URL Validation", errorPrefix
      );
    }
    return false;
  }

  if (type === "ws" && !["wss:", "ws:"].includes(parsed.protocol)) {
    if (opts.shouldThrow) {
      throw new LazyRpcError(
        `Invalid protocol in ${label}: "${url}" uses "${parsed.protocol}" — ` +
        `expected "ws:" or "wss:"`,
        "URL Validation", errorPrefix
      );
    }
    return false;
  }

  return true;
}

/**
 * Validates and merges custom RPC URLs into a base URL list.
 *
 * Custom URLs are validated strictly (throws on any invalid URL).
 * The result is deduplicated via Set.
 *
 * @param baseUrls - The existing base URL list
 * @param customUrls - Custom URLs to merge (may be undefined — no-op)
 * @param type - "http" or "ws"
 * @param errorPrefix - Prefix for error reporting
 * @returns Deduplicated merged URL array
 * @throws Error if customUrls is an empty array or contains invalid URLs
 */
export function mergeCustomUrls(
  baseUrls: InternalRpcEndpoint[],
  customUrls: (string | HttpRpcEndpointOptions)[] | undefined,
  type: UrlType,
  errorPrefix = "LazyRpc"
): InternalRpcEndpoint[] {
  if (customUrls === undefined) return baseUrls;

  const scope = "URL Validation";

  if (!Array.isArray(customUrls)) {
    throw new LazyRpcError(
      `customRpcs.${type} must be an array of strings`,
      scope, errorPrefix
    );
  }

  if (customUrls.length === 0) {
    throw new LazyRpcError(
      `customRpcs.${type} array cannot be empty. Omit the key if no custom URLs are needed.`,
      scope, errorPrefix
    );
  }

  for (const urlObj of customUrls) {
    let urlString: string;
    if (typeof urlObj === "string") {
      urlString = urlObj;
    } else if (typeof urlObj.url === "string") {
      urlString = urlObj.url;
    } else {
      throw new LazyRpcError(
        `All items in customRpcs.${type} must be strings or endpoint objects with a url property`,
        scope, errorPrefix
      );
    }


    validateUrl(urlString, type === "http" ? "http" : "ws", { shouldThrow: true, label: `customRpcs.${type}` }, errorPrefix);

  }

  const newUrls = customUrls.map((urlObj): InternalRpcEndpoint => {
    if (typeof urlObj === "string") {
      return { url: urlObj, originalFormat: "string" };
    }
    return { ...urlObj, originalFormat: "object" };
  });

  // Deduplicate by URL, prioritizing objects over strings so custom config isn't lost
  const urlMap = new Map<string, InternalRpcEndpoint>();
  for (const ep of [...baseUrls, ...newUrls]) {
    const existing = urlMap.get(ep.url);
    if (!existing) {
      urlMap.set(ep.url, ep);
    } else if (existing.originalFormat === "string" && ep.originalFormat === "object") {
      // Overwrite if the new one has custom configuration object format
      urlMap.set(ep.url, ep);
    }
  }

  return Array.from(urlMap.values());
}

/**
 * Filters a URL list to only include secure protocols (HTTPS / WSS).
 * Used when enforceHttps is enabled — applied as a post-processing step.
 */
export function filterSecureUrls(urls: InternalRpcEndpoint[], type: UrlType, errorPrefix = "LazyRpc"): InternalRpcEndpoint[] {
  const secureProtocol = type === "http" ? "https:" : "wss:";
  const secureUrls = urls.filter(endpoint => {
    if (!URL.canParse(endpoint.url)) return false;
    const parsed = new URL(endpoint.url);
    if (parsed.protocol === secureProtocol) return true;
    const hostname = parsed.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;

    return false;
  });

  if (secureUrls.length === 0 && urls.length > 0) {
    throw new LazyRpcError(
      `HTTPS enforcement is enabled but no secure URLs were found for ${type}. ` +
      `Provide secure URLs or disable enforceHttps.`,
      "URL Validation", errorPrefix
    );
  }

  return secureUrls;
}


