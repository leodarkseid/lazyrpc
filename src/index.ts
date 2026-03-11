import * as fs from "fs";
import * as path from "path";
import { fetch as undiciFetch, Agent } from "undici";
import { WebSocket } from "ws";
import { RPCBase } from "./core.js";
import { RPCConfig, RPCDependencies } from "./types.js";

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
    const agent = new Agent({ connect: { family: 4 } });

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