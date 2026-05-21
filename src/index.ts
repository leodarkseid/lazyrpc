import * as fs from "fs";
import * as path from "path";
import * as dns from "dns";
import { fetch as undiciFetch, Agent } from "undici";
import { WebSocket } from "ws";

import { RPCConfig, RPCDependencies } from "./types.js";
import { RPCBase } from "./core/rpcBase.js";
import { LazyRpcError } from "./core/error.js";

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

const ipv4Lookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void => {
  if (hostname === "localhost") {
    callback(null, "127.0.0.1", 4);
    return;
  }

  dns.lookup(hostname, { ...options, family: 4, all: false }, callback);
};

/**
 * Enhanced Node.js RPC class for managing and validating RPC URLs.
 */
export class RPC<THttp = string, TWs = string> extends RPCBase<THttp, TWs> {
  /**
   * Constructor initializes RPC class with Node.js optimized dependencies.
   * @param config - Configuration options for chainId, ttl, maxRetry, and other settings.
   */
  constructor(config: RPCConfig<THttp, TWs>) {

    const rpcListPath =
      config.pathToRpcJson && fs.existsSync(config.pathToRpcJson)
        ? config.pathToRpcJson
        : path.join(__dirname, "rpcList.min.json");


    const chainList: Record<string, string[]> = ((): Record<string, string[]> => {
      try {
        const rawData = fs.readFileSync(rpcListPath, "utf-8");
        return JSON.parse(rawData) as Record<string, string[]>;
      } catch (e) {
        throw new LazyRpcError(`Failed to load RPC list from ${rpcListPath}: ${e instanceof Error ? e.message : String(e)}`, "RPC", config.errorPrefix);
      }
    })()


    const agent = config.agent ?? new Agent({
      connect: { family: 4, lookup: ipv4Lookup },
    });

    const deps: RPCDependencies = {
      fetchFn: config.fetchFn ?? undiciFetch as unknown as typeof fetch,
      websocketClass: WebSocket as unknown as typeof globalThis.WebSocket,
      agent,
      chainList
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
