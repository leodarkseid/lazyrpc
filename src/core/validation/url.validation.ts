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
): boolean {
  const label = opts.label ?? `customRpcs.${type}`;

  // 1. Parse the URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    if (opts.shouldThrow) {
      throw new Error(
        `Invalid URL in ${label}: "${url}" is not a valid URL`,
      );
    }
    return false;
  }

  // 2. Protocol check
  if (type === "http" && !["https:", "http:"].includes(parsed.protocol)) {
    if (opts.shouldThrow) {
      throw new Error(
        `Invalid protocol in ${label}: "${url}" uses "${parsed.protocol}" — ` +
        `expected "http:" or "https:"`,
      );
    }
    return false;
  }

  if (type === "ws" && !["wss:", "ws:"].includes(parsed.protocol)) {
    if (opts.shouldThrow) {
      throw new Error(
        `Invalid protocol in ${label}: "${url}" uses "${parsed.protocol}" — ` +
        `expected "ws:" or "wss:"`,
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
 * @returns Deduplicated merged URL array
 * @throws Error if customUrls is an empty array or contains invalid URLs
 */
export function mergeCustomUrls(
  baseUrls: string[],
  customUrls: string[] | undefined,
  type: UrlType,
): string[] {
  if (customUrls === undefined) return baseUrls;

  const fieldName = type === "http" ? "http" : "ws";
  const humanName = type === "http" ? "HTTP" : "WebSocket";

  if (!Array.isArray(customUrls) || customUrls.length === 0) {
    throw new Error(
      `customRpcs.${fieldName} must be a non-empty array of URL strings. ` +
      `Omit the field entirely if you have no custom ${humanName} endpoints.`,
    );
  }

  for (const url of customUrls) {
    validateUrl(url, type, {
      shouldThrow: true,
      label: `customRpcs.${fieldName}`,
    });
  }

  return Array.from(new Set([...baseUrls, ...customUrls]));
}

/**
 * Filters a URL list to only include secure protocols (HTTPS / WSS).
 * Used when enforceHttps is enabled — applied as a post-processing step.
 */
export function filterSecureUrls(urls: string[], type: UrlType): string[] {
  if (type === "http") {
    return urls.filter(url => {
      if (url.startsWith("https://")) return true;
      try {
        const hostname = new URL(url).hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
      } catch {}
      return false;
    });
  }
  return urls.filter(url => {
    if (url.startsWith("wss://")) return true;
    try {
      const hostname = new URL(url).hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    } catch {}
    return false;
  });
}

/**
 * Formats the chainId to match the JSON structure where small hex values are zero-padded.
 * @param chainId - The blockchain chain ID (e.g., "0x0001", "0x89").
 * @returns Formatted string key like "x0001" or "x89".
 */
export function formatChainId(chainId: string): string {
  let cleanHex = chainId.slice(2).toLowerCase(); // Remove "0x"

  // In our rpcList.min.json, ONLY Ethereum mainnet (0x1) is padded as x0001
  // Other chains like Polygon (0x89) are literally just x89
  if (cleanHex === "1" || cleanHex === "0001") {
    return "x0001";
  }

  return `x${cleanHex}`;
}
