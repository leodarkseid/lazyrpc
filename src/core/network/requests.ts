import { LazyRpcError } from "../error.js";
import { parseSafeJsonMessage, readSafeJsonResponse, type SafeJsonOptions } from "../security/safeJson.js";
import { assert } from "../../tools.js";

import type { InternalRpcEndpoint } from "../../types.js";

export interface HttpRpcRequestOptions {
  endpoint: InternalRpcEndpoint;
  id: number;
  fetchFn: typeof fetch;
  agent?: unknown;
  signal?: AbortSignal;
  safeJsonOptions: SafeJsonOptions;
  errorPrefix?: string;
  logger?: { debug: (msg: string) => void; error: (msg: string, err?: unknown) => void };
}

/**
 * Validates that the parsed data conforms to the expected JSON-RPC 2.0 response format.
 */
export function validateJsonRpcResponse(data: unknown, expectedId: number): void {
  assert(data !== null && data !== undefined && typeof data === "object" && !Array.isArray(data), "JSON-RPC response is not an object");
  const d = data as { jsonrpc?: unknown; id?: unknown; error?: { message?: string } | null; result?: unknown };
  assert(d.jsonrpc === "2.0", `Invalid JSON-RPC version: expected "2.0", received ${JSON.stringify(d.jsonrpc)}`);
  assert(d.id === expectedId, `JSON-RPC response ID mismatch: expected ${expectedId}, received ${JSON.stringify(d.id)}`);
  assert(!d.error, `JSON-RPC error: ${d.error?.message ?? JSON.stringify(d.error)}`);
  assert(
    typeof d.result === "string" && /^0x[0-9a-fA-F]+$/.test(d.result),
    `Invalid eth_blockNumber result: expected a hex string, received ${JSON.stringify(d.result)}`,
  );
}

/**
 * Executes a stateless HTTP JSON-RPC POST request and validates the response.
 */
export async function executeHttpRpcCall(options: HttpRpcRequestOptions): Promise<unknown> {
  const { endpoint, id, fetchFn, agent, signal, safeJsonOptions, errorPrefix = "LazyRpc", logger } = options;

  let urlString = endpoint.url;
  
  if (endpoint.query) {
    const q = typeof endpoint.query === "function" ? await endpoint.query() : endpoint.query;
    if (Object.keys(q).length > 0) {
      const urlObj = new URL(urlString);
      for (const [key, value] of Object.entries(q)) {
        urlObj.searchParams.append(key, value);
      }
      urlString = urlObj.toString();
    }
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.headers) {
    const h = typeof endpoint.headers === "function" ? await endpoint.headers() : endpoint.headers;
    Object.assign(headers, h);
  }

  const fetchOptions: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", method: "eth_blockNumber", params: [], id,
    }),
    signal: signal ?? null,
  };

  if (agent) {
    fetchOptions.dispatcher = agent;
  }

  logger?.debug(`[${errorPrefix}: 'Transport'] Sending HTTP RPC validation request to ${urlString} with id ${id}`);
  const response = await fetchFn(urlString, fetchOptions);

  assert(response.ok, `Invalid HTTP response from ${urlString}`);

  const data: unknown = await readSafeJsonResponse(response, safeJsonOptions);
  validateJsonRpcResponse(data, id);

  logger?.debug(`[${errorPrefix}: 'Transport'] HTTP RPC validation succeeded for ${urlString}`);
  return data;
}

export interface WsRpcRequestOptions {
  endpoint: InternalRpcEndpoint;
  id: number;
  websocketClass: typeof WebSocket;
  signal?: AbortSignal;
  timeoutMs: number;
  safeJsonOptions: SafeJsonOptions;
  errorPrefix?: string;
  logger?: { debug: (msg: string) => void; error: (msg: string, err?: unknown) => void };
}

/**
 * Executes a stateless WebSocket JSON-RPC request and validates the response.
 */
export async function executeWsRpcCall(options: WsRpcRequestOptions): Promise<unknown> {
  const { endpoint, id, websocketClass, signal, timeoutMs, safeJsonOptions, errorPrefix = "LazyRpc", logger } = options;

  let urlString = endpoint.url;
  try {
    if (endpoint.query) {
      const q = typeof endpoint.query === "function" ? await endpoint.query() : endpoint.query;
      if (Object.keys(q).length > 0) {
        const urlObj = new URL(urlString);
        for (const [key, value] of Object.entries(q)) {
          urlObj.searchParams.append(key, value);
        }
        urlString = urlObj.toString();
      }
    }

    const protocols: string | string[] | undefined = undefined;
    // WebSockets in browsers don't support custom headers directly via constructor,
    // but they support subprotocols. Node implementations like ws support options.
    // We'll pass headers via the third argument if the websocket class supports it.
    let wsOptions: { headers?: Record<string, string> } | undefined = undefined;
    
    if (endpoint.headers) {
      const h = typeof endpoint.headers === "function" ? await endpoint.headers() : endpoint.headers;
      if (Object.keys(h).length > 0) {
        wsOptions = { headers: h };
      }
    }

    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new LazyRpcError(`RPC instance destroyed`, "Transport", errorPrefix));
        return;
      }

      // @ts-expect-error constructor overload
      const ws = new websocketClass(urlString, protocols, wsOptions);
      ws.onerror = (): void => { /* ignore */ };

      let isResolved = false;

      const closeWs = (): void => {
        try {
          ws.onerror = (): void => { /* ignore */ };
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          if (ws.readyState === 1 || ws.readyState === 0) ws.close();
        } catch { /* ignore */ }
      };

      const cleanupAndReject = (error: Error): void => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(wsTimeout);
          if (signal) signal.removeEventListener("abort", onAbort);
          closeWs();
          reject(error);
        }
      };

      const onAbort = (): void => {
        cleanupAndReject(new LazyRpcError(`RPC instance destroyed`, "Transport", errorPrefix));
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const wsTimeout = setTimeout(() => {
        cleanupAndReject(new LazyRpcError(`WebSocket timeout for ${urlString}`, "Transport", errorPrefix));
      }, timeoutMs);

      ws.onopen = (): void => {
        logger?.debug(`[${errorPrefix}: 'Transport'] Sending WebSocket RPC validation request to ${urlString} with id ${id}`);
        ws.send(JSON.stringify({
          jsonrpc: "2.0", method: "eth_blockNumber", params: [], id,
        }));
      };

      ws.onmessage = (event: unknown): void => {
        try {
          const data = parseSafeJsonMessage((event as { data: unknown }).data, safeJsonOptions);
          validateJsonRpcResponse(data, id);
          if (!isResolved) {
            isResolved = true;
            clearTimeout(wsTimeout);
            if (signal) signal.removeEventListener("abort", onAbort);
            closeWs();
            logger?.debug(`[${errorPrefix}: 'Transport'] WebSocket RPC validation succeeded for ${urlString}`);
            resolve(data);
          }
        } catch (error) {
          logger?.error(`[${errorPrefix}: 'Transport'] Failed to validate incoming JSON-RPC response from endpoint ${urlString}. Error details:`, error);
          cleanupAndReject(error instanceof Error ? error : new LazyRpcError(String(error), "Transport", errorPrefix));
        }
      };

      ws.onerror = (error: unknown): void => {
        logger?.error(`[${errorPrefix}: 'Transport'] Unexpected error emitted by endpoint ${urlString} during validation. Error details:`, error);
        cleanupAndReject(new LazyRpcError(`WebSocket connection failed for ${urlString}`, "Transport", errorPrefix));
      };

      ws.onclose = (event: unknown): void => {
        const code = (event as { code?: number }).code;
        if (code !== 1000) {
          cleanupAndReject(new LazyRpcError(`WebSocket closed unexpectedly for ${urlString}: ${code}`, "Transport", errorPrefix));
        } else {
          cleanupAndReject(new LazyRpcError(`WebSocket closed normally before resolving ${urlString}`, "Transport", errorPrefix));
        }
      };
    });
  } catch (error) {
    logger?.error(`[${errorPrefix}: 'Transport'] Failed to prepare WebSocket URL or headers for endpoint ${urlString}. Error details:`, error);
    throw error instanceof Error ? error : new LazyRpcError(String(error), "Transport", errorPrefix);
  }
}
