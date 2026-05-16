import { RPCBase } from "./core.js";
import { RPCConfig, RPCDependencies } from "./types.js";
import rpcList from "./rpcList.min.json" assert { type: "json" };

/**
 * Enhanced Browser RPC class for managing and validating RPC URLs.
 */
export class RPC extends RPCBase {
  /**
   * Constructor initializes RPC class with Browser specific dependencies.
   * @param config - Configuration options for chainId, ttl, maxRetry, and other settings.
   */
  constructor(config: RPCConfig) {
    if (typeof window === "undefined" || !window.fetch || !window.WebSocket) {
      throw new Error("Browser environment not detected. Missing fetch or WebSocket.");
    }

    const deps: RPCDependencies = {
      fetchFn: window.fetch.bind(window),
      websocketClass: window.WebSocket,
      chainList: rpcList as Record<string, string[]>
    };

    super(config, deps);
  }
}

export * from "./types.js";
