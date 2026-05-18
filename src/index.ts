import * as fs from "fs";
import * as path from "path";
import * as dns from "dns";
import { fetch as undiciFetch, Agent } from "undici";
import { WebSocket } from "ws";

import { RPCConfig, RPCDependencies } from "./types.js";
import { RPCBase } from "./core/rpcBase.js";

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
export class RPC extends RPCBase {
  /**
   * Constructor initializes RPC class with Node.js optimized dependencies.
   * @param config - Configuration options for chainId, ttl, maxRetry, and other settings.
   */
  constructor(config: RPCConfig) {
    // Determine path to RPC list
    const rpcListPath =
      config.pathToRpcJson && fs.existsSync(config.pathToRpcJson)
        ? config.pathToRpcJson
        : path.join(__dirname, "rpcList.min.json");

    // Parse chain list
    let chainList: Record<string, string[]> = {};
    try {
      chainList = JSON.parse(fs.readFileSync(rpcListPath, "utf-8"));
    } catch (e) {
      console.error(`Failed to load RPC list from ${rpcListPath}`, e);
      throw e;
    }

    // Configure Agent for IPv4 as per original logic
    const agent = config.agent ?? new Agent({
      connect: { family: 4, lookup: ipv4Lookup } as any,
    });

    const deps: RPCDependencies = {
      fetchFn: undiciFetch as any,
      websocketClass: WebSocket as any,
      agent,
      chainList
    };

    super(config, deps);
  }
}

export * from "./types.js";
