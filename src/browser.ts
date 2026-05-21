import { RPCConfig, RPCDependencies } from "./types.js";
import rpcList from "./rpcList.min.json" assert { type: "json" };
import { RPCBase } from "./core/rpcBase.js";
import { LazyRpcError } from "./core/error.js";

/**
 * Enhanced Browser RPC class for managing and validating RPC URLs.
 */
export class RPC<THttp = string, TWs = string> extends RPCBase<THttp, TWs> {
  /**
   * Constructor initializes RPC class with Browser specific dependencies.
   * @param config - Configuration options for chainId, ttl, maxRetry, and other settings.
   */
  constructor(config: RPCConfig<THttp, TWs>) {
    const _global = globalThis as { window?: unknown; fetch?: unknown; WebSocket?: unknown };
    if (!_global.window || !_global.fetch || !_global.WebSocket) {
      throw new LazyRpcError("Browser environment not detected. Missing fetch or WebSocket.", "Browser", config.errorPrefix);
    }

    const deps: RPCDependencies = {
      fetchFn: config.fetchFn ?? window.fetch.bind(window),
      websocketClass: window.WebSocket,
      chainList: rpcList
    };

    super(config, deps);
  }
}

export * from "./types.js";
export {
  assertSafePayloadSize,
  measureJsonLikeSize,
  parseSafeJsonMessage,
  readSafeJsonResponse,
  safeParseJson,
  type SafeJsonOptions,
} from "./core/security/safeJson.js";
