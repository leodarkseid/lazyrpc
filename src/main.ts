import { assert } from "./tools";
import * as fs from "fs";
import * as path from "path";

/**
 * RPC class for managing and validating RPC URLs.
 * Handles both HTTP and WebSocket calls, failure tracking, and retry logic.
 */
export class RPC {
  /** Time-to-live for RPC validation (in seconds) */
  private ttl: number = 10;
  /** Hex value of Blockchain chain ID */
  private chainId: string = "0x0001";
  /** List of valid HTTP RPC endpoints */
  private validRPCs: { url: string; time: number }[] = [];
  /** List of valid WebSocket RPC endpoints */
  private validWSRPCs: { url: string; time: number }[] = [];
  /** Tracks failed URLs and their retry count */
  private failedURL = new Map<string, { count: number; time: number }>();
  /** Maximum number of retries before dropping an RPC */
  private maxRetry: number = 3;
  /** Flag to enable logging */
  private log: boolean = false;
  /** Time before resetting failed URLs (in milliseconds) */
  private timeToResetFailedURL = 6 * 60 * 60 * 1000;

  /** Absolute path to alternative rpc list json used  */
  private pathToRpcJson: string = "";

  /**
   * Constructor initializes RPC class with configuration options.
   * @param data - Configuration options for chainId, ttl, maxRetry, and log flag.
   */
  constructor(data: {
    chainId: string;
    ttl?: number;
    maxRetry?: number;
    pathToRpcJson?: string;
    log?: boolean;
  }) {
    this.httpCall = this.httpCall.bind(this);
    this.wsCall = this.wsCall.bind(this);
    this.drop_ = this.drop_.bind(this);
    this.drop = this.drop.bind(this);
    this.getRpc = this.getRpc.bind(this);
    this.chainId = data.chainId;
    this.ttl = data.ttl || this.ttl;
    this.maxRetry = data.maxRetry || this.maxRetry;
    this.log = data.log || this.log;
    this.pathToRpcJson = data.pathToRpcJson || this.pathToRpcJson;

    this.init();
    this.intialize();
  }

  /**
   * Reads the RPC list file and retrieves RPCs for the given chain ID.
   * @param chainId - The blockchain chain ID.
   * @returns A promise resolving to an array of RPC URLs.
   */
  private async getChain(chainId: string): Promise<string[]> {
    try {
      const filePath =
        this.pathToRpcJson && fs.existsSync(this.pathToRpcJson)
          ? this.pathToRpcJson
          : path.join(__dirname, "rpcList.min.json");
      let data: string | null = await fs.promises.readFile(filePath, "utf-8");
      let chainList = JSON.parse(data);
      try {
        chainList = JSON.parse(data);
      } catch (error: any) {
        throw new Error(`Invalid JSON format in ${filePath}: ${error.message}`);
      }
      const result = chainList[chainId];
      if (!result) {
        throw new Error(`Chain ID ${chainId} not found in ${filePath}`);
      }
      data = null;
      chainList = null;
      return result || [];
    } catch (error: any) {
      throw new Error(`Error fetching chain RPCs: ${error.message}`);
    }
  }

  /**
   * Drops a given URL from the RPC list by marking it as failed.
   * @param url - The RPC URL to be dropped.
   */
  public drop(url: string) {
    this.drop_(url, this.maxRetry);
  }

  /**
   * Private method to track failed RPC URLs with retry count.
   * @param url - The failed RPC URL.
   * @param count - The number of retries before dropping.
   */
  private drop_(url: string, count?: number) {
    const prevFailures = this.failedURL.get(url) ?? {
      count: 0,
      time: Date.now(),
    };
    this.failedURL.set(url, {
      count: prevFailures.count + (count ?? 1),
      time: Date.now(),
    });
  }

  /**
   * Retrieves a valid RPC URL based on type (HTTP or WebSocket).
   * @param type - The type of RPC: "ws" or "https".
   * @returns A valid RPC URL.
   * @throws Error if no valid URLs are found.
   */
  public getRpc(type: "ws" | "https"): string {
    if (type === "https")
      if (this.validRPCs.length > 0) {
        return this.validRPCs[0].url;
      } else {
        throw new Error("no valid url found");
      }
    if (type === "ws")
      if (this.validWSRPCs.length > 0) {
        return this.validWSRPCs[0].url;
      } else {
        throw new Error("no valid url found");
      }
    throw new Error("Invalid Type");
  }

  /**
   * Retrieves a valid RPC URL based on type (HTTP or WebSocket) asychronously.
   * @param type - The type of RPC: "ws" or "https".
   * @returns A valid RPC URL Promise.
   * @throws Error if no valid URLs are found.
   */
  public async getRpcAsync(type: "ws" | "https"): Promise<string> {
    await this.intialize();
    return this.getRpc(type);
  }

  /**
   * Initializes RPC lists from the local file, only at Class initialization.
   * @returns void
   */
  private init() {
    const filePath =
      this.pathToRpcJson && fs.existsSync(this.pathToRpcJson)
        ? this.pathToRpcJson
        : path.join(__dirname, "rpcList.min.json");
    const chainList = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const http = chainList[this.chainId.slice(1)];
    const ws = chainList[`${this.chainId.slice(1)}_WS`];
    this.validRPCs = http.map((h: string) => {
      return { url: h, time: 999999999999 };
    });
    this.validWSRPCs = ws.map((w: string) => {
      return { url: w, time: 999999999999 };
    });
  }

  /**
   * Fetches RPC URLs from the chain list and initializes them.
   */

  private async intialize() {
    const http = await this.getChain(this.chainId.slice(1));
    const ws = await this.getChain(`${this.chainId.slice(1)}_WS`);
    const all = await Promise.allSettled([
      ...http.map(
        async (h: string) => await this.run(this.httpCall, h, "https")
      ),
      ...ws.map(async (w: string) => await this.run(this.wsCall, w, "ws")),
    ]);

    this.validRPCs = [];
    this.validWSRPCs = [];
    all.map((s) => {
      if (s.status === "fulfilled") {
        if (s.value.type === "ws") {
          this.validWSRPCs.push({ url: s.value.url, time: s.value.time });
        }
        if (s.value.type === "https") {
          this.validRPCs.push({ url: s.value.url, time: s.value.time });
        }
      }
    });
    this.validRPCs = this.validRPCs.sort((a, b) => a.time - b.time);
    this.validWSRPCs = this.validWSRPCs.sort((a, b) => a.time - b.time);
    setTimeout(() => this.intialize(), this.ttl * 1000);
  }

  private id = 0;
  /**
   * Makes an HTTP call to validate an RPC URL.
   * @param url - The RPC URL.
   * @param id - Unique request identifier.
   */
  private async httpCall(url: string, id: number) {
    try {
      if (this.failedURL.has(url)) {
        if (
          Date.now() - this.failedURL.get(url)!.time >
          this.timeToResetFailedURL
        )
          this.failedURL.set(url, { count: 0, time: Date.now() });
        if (this.failedURL.get(url)!.count >= this.maxRetry) {
          return;
        }
      }

      if (!url) {
        throw new Error("invalid http url");
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id,
        }),
      });
      assert(response.ok, "Invalid Http Response");
      const data = await response.json();
      assert(data.id === id, "Id Mismatch");
      return data;
    } catch (error) {
      this.drop_(url);
      if (this.log) console.error(`Http request failed - ${url}`);
    }
  }

  /**
   * Makes a WebSocket call to validate an RPC URL.
   * @param url - The WebSocket URL.
   * @param id - Unique request identifier.
   */
  private wsCall(url: string, id: number) {
    if (this.failedURL.has(url)) {
      if (
        Date.now() - this.failedURL.get(url)!.time >
        this.timeToResetFailedURL
      )
        this.failedURL.set(url, { count: 0, time: Date.now() });
      if (this.failedURL.get(url)!.count >= this.maxRetry) {
        return;
      }
    }
    const ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id,
        })
      );
    };
    ws.onmessage = (event) => {
      assert(JSON.parse(event.data).id === id, "ws response id mismatch");
      ws.close();
    };
    ws.onerror = (err) => {
      this.drop_(url);
      if (this.log) console.error(`failed to make wsCall to  - ${url}`);
    };
  }

  /**
   * Runs the given function with the specified URL and measures execution time.
   * @param fn - The function to execute.
   * @param url - The RPC URL to test.
   * @param type - The type of RPC call: "ws" or "https".
   * @returns A promise resolving to an object containing execution time, type, and URL.
   */
  private async run(
    fn: Function,
    url: string,
    type: "ws" | "https"
  ): Promise<{
    time: number;
    type: "ws" | "https";
    url: string;
  }> {
    this.id++;
    const id = this.id;
    const start = performance.now();
    try {
      await fn(url, id);
    } catch (error) {
      throw error;
    }

    const stop = performance.now();
    return { time: stop - start, type, url };
  }
}
