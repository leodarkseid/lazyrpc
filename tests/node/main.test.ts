import { RPCBase } from "../../src/core/rpcBase";
import { RPC } from "../../src/index";

// ---------------------------------------------------------------------------
// undici fetch mock — intercepts all internal HTTP validation calls
// ---------------------------------------------------------------------------
const mockFetch = jest.fn(async (_url: string, options?: any) => {
  let id = 1;
  try {
    if (options?.body) id = JSON.parse(options.body).id;
  } catch { }
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0x10" }) };
});

jest.mock("undici", () => {
  return {
    fetch: (url: any, options: any) => mockFetch(url, options),
    Agent: class {
      opts: any;
      constructor(opts: any) { this.opts = opts; }
    }
  };
});

jest.mock("ws", () => {
  class MockWebSocket {
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    send = jest.fn();
    close = jest.fn();

    constructor(url: string) {
      setTimeout(() => {
        if (this.onopen) this.onopen(new Event('open'));
      }, 10);

      this.send = jest.fn((payload: string) => {
        let id = 1;
        try { id = JSON.parse(payload).id; } catch {}
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage({
              data: JSON.stringify({ jsonrpc: "2.0", id, result: "0x10" })
            } as MessageEvent);
          }
        }, 20);
      });
    }
  }
  return { WebSocket: MockWebSocket };
});

const { WebSocket: MockWebSocket } = require("ws");
global.WebSocket = MockWebSocket as any;
// Mock file system — use the SAME data for both sync and async reads
// so init() and initialize() produce consistent results.
const mockRpcData = {
  x0001: ["https://rpc1.com", "https://rpc2.com"],
  x0001_WS: ["wss://ws1.com", "wss://ws2.com"],
};

// Custom RPC data for pathToRpcJson tests
const customRpcData = {
  x0001: ["https://custom-rpc-one.example.com", "https://custom-rpc-two.example.com", "https://custom-rpc-three.example.com"],
  x0001_WS: ["wss://custom-ws-one.example.com"],
};

const duplicateRpcData = {
  x0001: ["https://rpc1.com", "https://rpc1.com", "https://rpc2.com"],
  x0001_WS: ["wss://ws1.com", "wss://ws1.com"],
};

// Path-aware mock: returns custom data when custom path is used
const getDataForPath = (filePath: string) => {
  if (filePath.includes("custom")) return JSON.stringify(customRpcData);
  if (filePath.includes("duplicate")) return JSON.stringify(duplicateRpcData);
  if (filePath.includes("invalid")) throw new SyntaxError("Unexpected token");
  return JSON.stringify(mockRpcData);
};

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  readFileSync: jest.fn((filePath: string) => getDataForPath(filePath)),
  promises: {
    readFile: jest.fn((filePath: string) => Promise.resolve(getDataForPath(filePath)))
  },
  existsSync: jest.fn((filePath: string) => {
    if (filePath.includes("nonexistent")) return false;
    return true;
  })
}));

/** Drains the async initialization loop so validRPCs gets populated */
async function drainInit() {
  for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(100);
}

describe("RPC", () => {
  let rpc: RPC;
  let initializeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    initializeSpy = jest.spyOn(RPCBase.prototype as any, "initialize");
    rpc = new RPC({ chainId: "0x0001", ttl: 5, maxRetry: 3 });
  });

  afterEach(() => {
    // Clean up the instance to prevent timer leaks (the root cause of Jest hanging)
    rpc.destroy();
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  describe("Config validation", () => {
    test("throws when chainId is missing", () => {
      expect(() => new RPC({ chainId: "" })).toThrow("chainId is required");
    });

    test("throws when chainId is not hex (missing 0x prefix)", () => {
      expect(() => new RPC({ chainId: "invalid" })).toThrow("chainId must be in hex format");
    });

    test("throws when ttl is <= 0", () => {
      expect(() => new RPC({ chainId: "0x0001", ttl: -1 })).toThrow("ttl must be between 1 and 3600 seconds");
    });

    test("throws when ttl exceeds 3600 seconds", () => {
      expect(() => new RPC({ chainId: "0x0001", ttl: 9999 })).toThrow("ttl must be between 1 and 3600 seconds");
    });

    test("throws when maxRetry exceeds 10", () => {
      expect(() => new RPC({ chainId: "0x0001", maxRetry: 15 })).toThrow("maxRetry must be between 0 and 10");
    });

    test("accepts maxRetry of 0 (no retries)", () => {
      const r = new RPC({ chainId: "0x0001", maxRetry: 0 });
      expect(r["maxRetry"]).toBe(0);
      r.destroy();
    });

    test("throws for an unrecognised loadBalancing strategy", () => {
      expect(() => new RPC({ chainId: "0x0001", loadBalancing: "invalid" as any })).toThrow("loadBalancing must be 'fastest', 'round-robin', or 'random'");
    });


  });

  describe("getRpc — load balancing strategies", () => {
    test("returns unvalidated URL before initialization completes", () => {
      const url = rpc.getRpc("https");
      expect(typeof url).toBe("string");
      expect(url.startsWith("https://")).toBe(true);
    });

    test("fastest: returns a valid URL after initialization", async () => {
      await drainInit();
      const url = rpc.getRpc("https");
      expect(typeof url).toBe("string");
      expect(url.startsWith("https://")).toBe(true);
    });

    test("fastest: returns WebSocket URL for 'ws' type after initialization", async () => {
      await drainInit();
      const url = rpc.getRpc("ws");
      expect(url.startsWith("wss://")).toBe(true);
    });

    test("throws for an unrecognised RPC type", () => {
      expect(() => rpc.getRpc("invalid" as any)).toThrow('Invalid RPC type: "invalid"');
    });

    test("round-robin: cycles across all endpoints and wraps back to start", () => {
      const rr = new RPC({ chainId: "0x0001", loadBalancing: "round-robin" });
      rr["validRPCs"] = [
        { url: "https://rpc1.com", time: 100 },
        { url: "https://rpc2.com", time: 200 },
      ];
      expect([rr.getRpc("https"), rr.getRpc("https"), rr.getRpc("https")])
        .toEqual(["https://rpc1.com", "https://rpc2.com", "https://rpc1.com"]);
      rr.destroy();
    });

    test("round-robin: cycles WebSocket endpoints independently of HTTP counter", () => {
      const rr = new RPC({ chainId: "0x0001", loadBalancing: "round-robin" });
      rr["validWSRPCs"] = [
        { url: "wss://ws1.com", time: 100 },
        { url: "wss://ws2.com", time: 200 },
      ];
      expect([rr.getRpc("ws"), rr.getRpc("ws")]).toEqual(["wss://ws1.com", "wss://ws2.com"]);
      rr.destroy();
    });

    test("random: always returns a URL that exists in the valid set", () => {
      const rr = new RPC({ chainId: "0x0001", loadBalancing: "random" });
      rr["validRPCs"] = [
        { url: "https://rpc1.com", time: 100 },
        { url: "https://rpc2.com", time: 200 },
      ];
      const url = rr.getRpc("https");
      expect(["https://rpc1.com", "https://rpc2.com"]).toContain(url);
      rr.destroy();
    });
  });

  describe("getValidRPCCount / getAllValidRPCs", () => {
    test("getValidRPCCount returns base URL count before initialization completes", () => {
      expect(rpc.getValidRPCCount("https")).toBeGreaterThan(0);
      expect(rpc.getValidRPCCount("ws")).toBeGreaterThan(0);
    });

    test("getValidRPCCount returns endpoint count after initialization", async () => {
      await drainInit();
      expect(rpc.getValidRPCCount("https")).toBe(2);
      expect(rpc.getValidRPCCount("ws")).toBe(2);
    });

    test("getAllValidRPCs returns a defensive copy — mutations don't affect internal state", async () => {
      await drainInit();
      const copy = rpc.getAllValidRPCs("https");
      expect(copy.length).toBe(2);
      copy.pop();
      expect(rpc.getAllValidRPCs("https").length).toBe(2);
    });
  });

  describe("getFailureStats / clearFailedURLs", () => {
    test("getFailureStats returns zeroes when no failures have occurred", () => {
      rpc.clearFailedURLs();
      expect(rpc.getFailureStats()).toEqual({ totalFailed: 0, inBackoff: 0, overMaxRetries: 0 });
    });

    test("clearFailedURLs resets all tracked failures to zero", () => {
      rpc.drop("https://failed-rpc.com");
      expect(rpc.getFailureStats().totalFailed).toBeGreaterThan(0);
      rpc.clearFailedURLs();
      expect(rpc.getFailureStats().totalFailed).toBe(0);
    });
  });

  describe("drop() — failure tracking and exponential backoff", () => {
    test("records the URL in failedURL map with count = 1 on first drop", () => {
      rpc.drop("https://failing.com");
      expect(rpc["failedURL"].has("https://failing.com")).toBe(true);
      expect(rpc["failedURL"].get("https://failing.com")!.count).toBe(1);
    });

    test("increments failure count by 1 on each successive drop call", () => {
      rpc.drop("https://failing.com");
      rpc.drop("https://failing.com");
      rpc.drop("https://failing.com");
      expect(rpc["failedURL"].get("https://failing.com")!.count).toBe(3);
    });

    test("exponential backoff: nextRetry grows with each failure (2nd delay > 1st delay)", () => {
      const url = "https://failed-rpc.com";
      rpc["drop_"](url);
      const firstBackoff = rpc["failedURL"].get(url)!.nextRetry! - Date.now();
      rpc["drop_"](url);
      const secondBackoff = rpc["failedURL"].get(url)!.nextRetry! - Date.now();
      expect(secondBackoff).toBeGreaterThan(firstBackoff);
    });

    test("getFailureStats correctly classifies: overMaxRetries vs inBackoff", () => {
      rpc.clearFailedURLs();
      // Drive url1 to maxRetry (3)
      rpc["drop_"]("https://maxed-out.com");
      rpc["drop_"]("https://maxed-out.com");
      rpc["drop_"]("https://maxed-out.com");
      // url2 has 1 failure — still in backoff window
      rpc["drop_"]("https://in-backoff.com");
      const stats = rpc.getFailureStats();
      expect(stats.totalFailed).toBe(2);
      expect(stats.overMaxRetries).toBe(1);
      expect(stats.inBackoff).toBe(1);
    });
  });

  describe("shouldSkipURL", () => {
    test("returns false for URLs with no recorded failures", () => {
      expect(rpc["shouldSkipURL"]("https://unknown.com")).toBe(false);
    });

    test("returns true when a URL has reached maxRetry", () => {
      const url = "https://dead.com";
      rpc["drop_"](url); rpc["drop_"](url); rpc["drop_"](url); // count == 3 == maxRetry
      expect(rpc["shouldSkipURL"](url)).toBe(true);
    });

    test("returns true while nextRetry is still in the future (backoff window)", () => {
      const url = "https://backoff.com";
      rpc["drop_"](url);
      expect(rpc["shouldSkipURL"](url)).toBe(true);
    });

    test("returns false once the 6-hour failure reset window has elapsed", () => {
      const url = "https://old-failure.com";
      rpc["drop_"](url); rpc["drop_"](url); rpc["drop_"](url);
      // Backdate the failure timestamp to simulate 7 hours ago
      const entry = rpc["failedURL"].get(url)!;
      entry.time = Date.now() - 7 * 60 * 60 * 1000;
      rpc["failedURL"].set(url, entry);
      expect(rpc["shouldSkipURL"](url)).toBe(false);
    });
  });

  describe("Periodic re-validation (TTL)", () => {
    test("initialize() is called exactly once during construction", () => {
      expect(initializeSpy).toHaveBeenCalledTimes(1);
    });

    test("initialize() is called again after ttl seconds elapse", async () => {
      // Drain microtasks from the initial async initialize()
      for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(100);
      expect(initializeSpy).toHaveBeenCalledTimes(1);
      // Advance past ttl=5s — the next scheduled refresh fires
      await jest.advanceTimersByTimeAsync(5000);
      expect(initializeSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("httpCall — internal RPC validation via undici", () => {
    test("sends a POST eth_blockNumber request to the given URL", async () => {
      await rpc["httpCall"]("https://rpc1.com", 1);
      expect(mockFetch).toHaveBeenCalledWith("https://rpc1.com", expect.any(Object));
    });

    // test("records the URL in failedURL map when the network request throws", async () => {
    //   mockFetch.mockRejectedValueOnce(new Error("Network error"));
    //   const r = new RPC({ chainId: "0x0001" });
    //   await expect(r["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
    //   expect(r["failedURL"].has("https://failing-rpc.com")).toBe(true);
    //   r.destroy();
    // });
    test("records the URL in failedURL map when the network request throws", async () => {
      // Use mockImplementation to intercept all fetches conditionally
      mockFetch.mockImplementation(async (url: string) => {
        if (url === "https://failing-rpc.com") {
          throw new Error("Network error");
        }
        // Return a fake healthy response for the background initialize() loop
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1" }),
        };
      });

      const r = new RPC({ chainId: "0x0001" });

      await expect(r["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
      expect(r["failedURL"].has("https://failing-rpc.com")).toBe(true);

      r.destroy();
      mockFetch.mockImplementation(async (_url: string, options?: any) => {
        let id = 1;
        try { if (options?.body) id = JSON.parse(options.body).id; } catch { }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0x10" }) };
      });
    });

    test("rejects immediately (no network call) when the URL is already in backoff", async () => {
      rpc["failedURL"].set("https://rpc1.com", { count: 10, time: Date.now(), nextRetry: Date.now() + 60000 });
      await expect(rpc["httpCall"]("https://rpc1.com", 1)).rejects.toThrow("in backoff period");
    });
  });

  describe("wsCall — internal WebSocket RPC validation", () => {
    test("rejects with a timeout error when the WebSocket never responds within validationTimeout", async () => {
      jest.useRealTimers();
      // A WebSocket that opens connections but never sends a message
      const SilentWebSocket = class {
        onopen: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        onclose: ((e: CloseEvent) => void) | null = null;
        send = jest.fn();
        close = jest.fn();
        constructor(_url: string) { }
      };
      const r = new RPCBase({ chainId: "0x0001" }, {
        fetchFn: fetch,
        websocketClass: SilentWebSocket as any,
        chainList: { "x0001": ["https://rpc.com"], "x0001_WS": ["wss://hanging-ws.com"] },
        agent: undefined
      });
      await expect(r["wsCall"]("wss://hanging-ws.com", 1)).rejects.toThrow("WebSocket timeout");
      r.destroy();
      jest.useFakeTimers();
    }, 15000);
  });

  describe("getRpcAsync", () => {
    test("resolves with a valid URL once initialization validates one", async () => {
      const r = new RPC({ chainId: "0x0001" });
      const promise = r.getRpcAsync("https");
      await drainInit();
      const url = await promise;
      expect(typeof url).toBe("string");
      expect(url.startsWith("https://")).toBe(true);
      r.destroy();
    });

    test("returns immediately when validated RPCs already exist", async () => {
      await drainInit();
      const url = await rpc.getRpcAsync("https");
      expect(url.startsWith("https://")).toBe(true);
    });

    test("rejects with timeout error when no URL validates in time", async () => {
      // Create an instance whose fetch always fails — no URL will ever validate
      const failFetch = jest.fn(async () => { throw new Error("fail"); });
      const r = new RPCBase({ chainId: "0x0001" }, {
        fetchFn: failFetch as any,
        websocketClass: MockWebSocket as any,
        chainList: mockRpcData,
        agent: undefined
      });
      const promise = r.getRpcAsync("https", 500);
      // Catch immediately to prevent unhandled rejection warning
      const result = promise.catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(600);
      const err:any = await result;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("Failed To Find A Valid RPC");
      r.destroy();
    });

    test("multiple concurrent callers all resolve", async () => {
      const r = new RPC({ chainId: "0x0001" });
      const p1 = r.getRpcAsync("https");
      const p2 = r.getRpcAsync("https");
      const p3 = r.getRpcAsync("ws");
      await drainInit();
      const [u1, u2, u3] = await Promise.all([p1, p2, p3]);
      expect(u1.startsWith("https://")).toBe(true);
      expect(u2.startsWith("https://")).toBe(true);
      expect(u3.startsWith("wss://")).toBe(true);
      r.destroy();
    });

    test("rejects all queued callers when destroyed", async () => {
      const r = new RPC({ chainId: "0x0001" });
      const p1 = r.getRpcAsync("https");
      const p2 = r.getRpcAsync("ws");
      r.destroy();
      await expect(p1).rejects.toThrow("RPC instance destroyed");
      await expect(p2).rejects.toThrow("RPC instance destroyed");
    });
  });

  describe("status()", () => {
    test("returns 'initializing' immediately after construction", () => {
      expect(rpc.status()).toBe("initializing");
    });

    test("returns 'ready' after initialization completes", async () => {
      await drainInit();
      expect(rpc.status()).toBe("ready");
    });

    test("returns 'refreshing' when validated RPCs exist but re-validation is running", async () => {
      await drainInit();
      expect(rpc.status()).toBe("ready");
      // Trigger a refresh — initPromise becomes non-null again
      rpc.refresh();
      expect(rpc.status()).toBe("refreshing");
      await drainInit();
      expect(rpc.status()).toBe("ready");
    });

    test("returns 'destroyed' after destroy() is called", () => {
      rpc.destroy();
      expect(rpc.status()).toBe("destroyed");
    });
  });

  describe("destroy()", () => {
    test("clears all endpoint lists, failure records, queue, and cancels the refresh timer", () => {
      rpc.drop("https://fail.com");
      rpc.destroy();
      expect(rpc["refreshTimer"]).toBeNull();
      expect(rpc["validRPCs"]).toEqual([]);
      expect(rpc["validWSRPCs"]).toEqual([]);
      expect(rpc["failedURL"].size).toBe(0);
      expect(rpc["getRpcAsyncQueue"].size).toBe(0);
    });
  });

  describe("pathToRpcJson — custom RPC list loading", () => {
    test("loads endpoints from the specified custom JSON file", async () => {
      const customRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
      });
      await drainInit();

      const allRpcs = customRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(3);
      expect(allRpcs.map(e => e.url)).toContain("https://custom-rpc-one.example.com");
      expect(allRpcs.map(e => e.url)).toContain("https://custom-rpc-two.example.com");
      expect(allRpcs.map(e => e.url)).toContain("https://custom-rpc-three.example.com");

      const wsRpcs = customRpc.getAllValidRPCs("ws");
      expect(wsRpcs.length).toBe(1);
      expect(wsRpcs[0].url).toBe("wss://custom-ws-one.example.com");

      customRpc.destroy();
    });

    test("falls back to bundled rpcList.min.json when the specified path does not exist", async () => {
      const fallbackRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/nonexistent-rpc-list.json",
      });
      await drainInit();

      const allRpcs = fallbackRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(2);

      fallbackRpc.destroy();
    });

    test("uses bundled list when pathToRpcJson is an empty string", async () => {
      const defaultRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "",
      });
      await drainInit();

      const allRpcs = defaultRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(2);

      defaultRpc.destroy();
    });

    test("custom-path endpoints are compatible with round-robin load balancing", async () => {
      const customRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
        loadBalancing: "round-robin",
      });
      await drainInit();

      const url1 = customRpc.getRpc("https");
      const url2 = customRpc.getRpc("https");
      const url3 = customRpc.getRpc("https");
      const url4 = customRpc.getRpc("https"); // wraps

      expect(url4).toBe(url1); // round-robin wraps

      customRpc.destroy();
    });

    test("drop() correctly tracks failures for custom-path endpoints", async () => {
      const customRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
        maxRetry: 1,
      });
      await drainInit();

      const url = customRpc.getRpc("https");
      customRpc.drop(url);

      const stats = customRpc.getFailureStats();
      expect(stats.totalFailed).toBe(1);
      expect(stats.overMaxRetries).toBe(1);

      customRpc.destroy();
    });

    test("deduplicates RPC URLs loaded from JSON", async () => {
      const dupRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/duplicate-rpc-list.json",
      });
      await drainInit();

      const allRpcs = dupRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(2);

      const wsRpcs = dupRpc.getAllValidRPCs("ws");
      expect(wsRpcs.length).toBe(1);

      dupRpc.destroy();
    });
  });

  describe("customRpcs — merge and validation", () => {

    // --- Merge behavior ---

    test("merges custom HTTP URLs into the built-in list", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["https://my-private-node.com/rpc"] },
      });
      await drainInit();
      const allRpcs = r.getAllValidRPCs("https");
      // 2 built-in + 1 custom
      expect(allRpcs.length).toBe(3);
      expect(allRpcs.map((e) => e.url)).toContain("https://my-private-node.com/rpc");
      r.destroy();
    });

    test("merges custom WS URLs into the built-in list", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: { ws: ["wss://my-private-ws.com"] },
      });
      await drainInit();
      const wsRpcs = r.getAllValidRPCs("ws");
      // 2 built-in + 1 custom
      expect(wsRpcs.length).toBe(3);
      expect(wsRpcs.map((e) => e.url)).toContain("wss://my-private-ws.com");
      r.destroy();
    });

    test("deduplicates when custom URLs overlap with built-in list", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: {
          http: ["https://rpc1.com", "https://brand-new.com"],
          ws: ["wss://ws1.com"],
        },
      });
      await drainInit();
      const allRpcs = r.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(3); // rpc1, rpc2, brand-new
      const wsRpcs = r.getAllValidRPCs("ws");
      expect(wsRpcs.length).toBe(2); // ws1, ws2 — no duplicate
      r.destroy();
    });

    test("works alongside pathToRpcJson", async () => {
      const r = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
        customRpcs: { http: ["https://extra-node.com"] },
      });
      await drainInit();
      const allRpcs = r.getAllValidRPCs("https");
      // 3 from custom file + 1 from customRpcs
      expect(allRpcs.length).toBe(4);
      expect(allRpcs.map((e) => e.url)).toContain("https://extra-node.com");
      r.destroy();
    });

    test("custom URLs participate in round-robin load balancing", async () => {
      const r = new RPC({
        chainId: "0x0001",
        loadBalancing: "round-robin",
        customRpcs: { http: ["https://my-node.com"] },
      });
      await drainInit();
      const urls: string[] = [];
      for (let i = 0; i < 4; i++) urls.push(r.getRpc("https"));
      // 3 endpoints cycling, fourth wraps to first
      expect(urls[3]).toBe(urls[0]);
      r.destroy();
    });

    test("custom URLs participate in runtime validation (initialize calls fetch with custom URL)", async () => {
      mockFetch.mockClear();
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["https://my-validated-node.com"] },
      });
      // Drain the async initialization
      for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(100);
      const calledUrls = mockFetch.mock.calls.map((c: any[]) => c[0]);
      expect(calledUrls).toContain("https://my-validated-node.com");
      r.destroy();
    });

    test("no-op when customRpcs is an empty object {}", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: {},
      });
      await drainInit();
      expect(r.getAllValidRPCs("https").length).toBe(2);
      expect(r.getAllValidRPCs("ws").length).toBe(2);
      r.destroy();
    });

    test("only http key provided — only HTTP pool extended, WS unchanged", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["https://http-only.com"] },
      });
      await drainInit();
      expect(r.getAllValidRPCs("https").length).toBe(3);
      expect(r.getAllValidRPCs("ws").length).toBe(2);
      r.destroy();
    });

    test("only ws key provided — only WS pool extended, HTTP unchanged", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: { ws: ["wss://ws-only.com"] },
      });
      await drainInit();
      expect(r.getAllValidRPCs("https").length).toBe(2);
      expect(r.getAllValidRPCs("ws").length).toBe(3);
      r.destroy();
    });

    // --- Strict validation (throw cases) ---

    test("throws on malformed URL in http array", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["not-a-valid-url"] },
      })).toThrow('Invalid URL in customRpcs.http: "not-a-valid-url" is not a valid URL');
    });

    test("throws when http array contains a WebSocket URL", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["wss://wrong-protocol.com"] },
      })).toThrow('Invalid protocol in customRpcs.http');
    });

    test("throws when ws array contains an HTTP URL", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { ws: ["https://wrong-protocol.com"] },
      })).toThrow('Invalid protocol in customRpcs.ws');
    });

    test("throws on empty http array", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { http: [] },
      })).toThrow("customRpcs.http must be a non-empty array");
    });

    test("throws on empty ws array", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { ws: [] },
      })).toThrow("customRpcs.ws must be a non-empty array");
    });
  });
});

afterAll(async () => {
    jest.useRealTimers();
});
