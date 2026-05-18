/**
 * Self-contained transport class for RPC endpoint validation.
 *
 * Only two public methods: httpCall() and wsCall().
 * Delegates failure tracking to the injected EndpointHealthManager.
 *
 * @module transports
 */

import { assert } from "../../tools.js";
import type { _InternalRpcConfig } from "../config.js";
import type { EndpointHealthManager } from "../health/index.js";

export class RpcTransport {
  private readonly config: _InternalRpcConfig;
  private readonly abortController: AbortController;
  private readonly health: EndpointHealthManager;
  private readonly isDestroyed: () => boolean;

  constructor(
    config: _InternalRpcConfig,
    abortController: AbortController,
    health: EndpointHealthManager,
    isDestroyed: () => boolean,
  ) {
    this.config = config;
    this.abortController = abortController;
    this.health = health;
    this.isDestroyed = isDestroyed;
  }

  // ─── Public: Network Calls ───────────────────────────────────────────────

  public async httpCall(url: string, id: number): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.validationTimeout);

    const onAbort = () => controller.abort();
    const ac = this.abortController;
    if (ac.signal.aborted) {
      onAbort();
    } else {
      ac.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (this.health.shouldSkip(url)) {
        throw new Error(`URL ${url} is in backoff period`);
      }

      if (!url) {
        throw new Error("Invalid HTTP URL");
      }

      const fetchOptions: any = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "eth_blockNumber", params: [], id,
        }),
        signal: controller.signal,
      };

      if (this.config.agent) {
        fetchOptions.dispatcher = this.config.agent;
      }

      const response = await this.config.fetchFn(url, fetchOptions);
      assert(response.ok, "Invalid HTTP Response");
      const data: any = await response.json();
      this.validateJsonRpcResponse(data, id);
      return data;
    } catch (error) {
      if (!this.isDestroyed()) this.health.recordFailure(url);
      this.config.logger.error(`HTTP request failed - ${url}: ${error}`);
      throw error;
    } finally {
      clearTimeout(timeout);
      ac.signal.removeEventListener("abort", onAbort);
    }
  }

  public wsCall(url: string, id: number): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        if (this.health.shouldSkip(url)) {
          reject(new Error(`URL ${url} is in backoff period`));
          return;
        }

        if (!url) {
          reject(new Error("Invalid WebSocket URL"));
          return;
        }

        const ws = new this.config.websocketClass(url);
        ws.onerror = () => { };

        let isResolved = false;

        const closeWs = () => {
          try {
            ws.onerror = () => { };
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            if (ws.readyState === 1 || ws.readyState === 0) ws.close();
          } catch (e) { }
        };

        const onAbort = () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(wsTimeout);
            closeWs();
            reject(new Error(`RPC instance destroyed`));
          }
        };

        const ac = this.abortController;
        if (ac.signal.aborted) { onAbort(); return; }
        ac.signal.addEventListener("abort", onAbort, { once: true });

        const cleanup = () => {
          clearTimeout(wsTimeout);
          ac.signal.removeEventListener("abort", onAbort);
        };

        const wsTimeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            cleanup();
            closeWs();
            if (!this.isDestroyed()) this.health.recordFailure(url);
            reject(new Error(`WebSocket timeout for ${url}`));
          }
        }, this.config.validationTimeout);

        ws.onopen = () => {
          ws.send(JSON.stringify({
            jsonrpc: "2.0", method: "eth_blockNumber", params: [], id,
          }));
        };

        ws.onmessage = (event: any) => {
          try {
            const data = JSON.parse(event.data);
            this.validateJsonRpcResponse(data, id);
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
              if (!this.isDestroyed()) this.health.recordFailure(url);
              reject(error);
            }
          }
        };

        ws.onerror = (error: any) => {
          if (!isResolved) {
            isResolved = true;
            cleanup();
            closeWs();
            if (!this.isDestroyed()) this.health.recordFailure(url);
            this.config.logger.error(`WebSocket error for ${url}:`, error);
            reject(new Error(`WebSocket connection failed for ${url}`));
          }
        };

        ws.onclose = (event: any) => {
          if (!isResolved && event.code !== 1000) {
            isResolved = true;
            cleanup();
            if (!this.isDestroyed()) this.health.recordFailure(url);
            reject(new Error(`WebSocket closed unexpectedly for ${url}: ${event.code}`));
          }
        };
      } catch (error) {
        if (!this.isDestroyed()) this.health.recordFailure(url);
        this.config.logger.error(`Failed to create WebSocket for ${url}:`, error);
        reject(error);
      }
    });
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private validateJsonRpcResponse(data: any, expectedId: number): void {
    assert(data != null && typeof data === "object", "JSON-RPC response is not an object");
    assert(data.jsonrpc === "2.0", "Invalid JSON-RPC version");
    assert(data.id === expectedId, "JSON-RPC response ID mismatch");
    assert(!data.error, `JSON-RPC error: ${data.error?.message ?? JSON.stringify(data.error)}`);
    assert(
      typeof data.result === "string" && /^0x[0-9a-fA-F]+$/.test(data.result),
      "Invalid eth_blockNumber result: expected a hex string",
    );
  }
}
