/**
 * Self-contained transport class for RPC endpoint validation.
 *
 * Only two public methods: httpCall() and wsCall().
 * Delegates failure tracking to the injected EndpointHealthManager.
 *
 * @module transports
 */


import type { _InternalRpcConfig } from "../config.js";
import type { EndpointHealthManager } from "../health/index.js";
import type { SafeJsonOptions } from "../security/safeJson.js";
import type { InternalRpcEndpoint } from "../../types.js";
import { executeHttpRpcCall, executeWsRpcCall } from "./requests.js";
import { LazyRpcError } from "../error.js";

export class RpcTransport {
  readonly #config: _InternalRpcConfig;
  readonly #abortController: AbortController;
  readonly #health: EndpointHealthManager;
  readonly #isDestroyed: () => boolean;

  constructor(
    config: _InternalRpcConfig,
    abortController: AbortController,
    health: EndpointHealthManager,
    isDestroyed: () => boolean,
  ) {
    this.#config = config;
    this.#abortController = abortController;
    this.#health = health;
    this.#isDestroyed = isDestroyed;
  }



  public async httpCall(endpoint: InternalRpcEndpoint, id: number): Promise<unknown> {
    const url = endpoint.url;
    if (this.#health.shouldSkip(url)) {
      throw new LazyRpcError(`HTTP RPC URL ${url} is in backoff period and was skipped`, "Transport", this.#config.errorPrefix);
    }

    if (!url) {
      throw new LazyRpcError("Invalid HTTP URL", "Transport", this.#config.errorPrefix);
    }

    const ac = this.#abortController;
    if (ac.signal.aborted) {
      throw new LazyRpcError(`RPC instance destroyed`, "Transport", this.#config.errorPrefix);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, this.#config.validationTimeout);

    const onAbort = (): void => { controller.abort(); };
    ac.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const data = await executeHttpRpcCall({
        endpoint,
        id,
        fetchFn: this.#config.fetchFn,
        agent: this.#config.agent,
        signal: controller.signal,
        safeJsonOptions: this.safeJsonOptions(),
        errorPrefix: this.#config.errorPrefix,
        logger: this.#config.logger,
      });
      return data;
    } catch (error) {
      if (!this.#isDestroyed()) this.#health.recordFailure(url);
      this.#config.logger.error(`[${this.#config.errorPrefix}: 'Transport'] HTTP RPC validation failed for ${url}:`, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      ac.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  public async wsCall(endpoint: InternalRpcEndpoint, id: number): Promise<unknown> {
    const url = endpoint.url;
    if (this.#health.shouldSkip(url)) {
      throw new LazyRpcError(`WebSocket RPC URL ${url} is in backoff period and was skipped`, "Transport", this.#config.errorPrefix);
    }

    if (!url) {
      throw new LazyRpcError("Invalid WebSocket URL", "Transport", this.#config.errorPrefix);
    }

    if (this.#abortController.signal.aborted) {
      throw new LazyRpcError(`RPC instance destroyed`, "Transport", this.#config.errorPrefix);
    }

    try {
      const data = await executeWsRpcCall({
        endpoint,
        id,
        websocketClass: this.#config.websocketClass,
        signal: this.#abortController.signal,
        timeoutMs: this.#config.validationTimeout,
        safeJsonOptions: this.safeJsonOptions(),
        errorPrefix: this.#config.errorPrefix,
        logger: this.#config.logger,
      });
      return data;
    } catch (error) {
      if (!this.#isDestroyed()) this.#health.recordFailure(url);
      throw error;
    }
  }

  private safeJsonOptions(): SafeJsonOptions {
    return {
      maxBytes: this.#config.maxPayloadBytes,
      maxDepth: this.#config.maxPayloadDepth,
      maxKeys: this.#config.maxPayloadKeys,
      maxArrayLength: this.#config.maxPayloadArrayLength,
      maxStringBytes: this.#config.maxPayloadStringBytes,
      requireJsonContentType: this.#config.requireJsonContentType,
      errorPrefix: this.#config.errorPrefix,
    };
  }
}
