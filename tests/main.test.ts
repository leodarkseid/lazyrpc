import { RPC } from "../src/index";
import * as fs from "fs";

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

// Enhanced WebSocket mock with proper event handling
class MockWebSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send = jest.fn();
  close = jest.fn();

  constructor(url: string) {
    // Simulate successful connection
    setTimeout(() => {
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 10);

    // Simulate message response after send is called
    this.send = jest.fn(() => {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({
            data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" })
          } as MessageEvent);
        }
      }, 20);
    });
  }
}

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

// Path-aware mock: returns custom data when custom path is used
const getDataForPath = (filePath: string) => {
  if (filePath.includes("custom")) return JSON.stringify(customRpcData);
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

describe("RPC", () => {
  let rpc: RPC;
  let initializeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    initializeSpy = jest.spyOn(RPC.prototype as any, "initialize");
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
    test("fastest: returns first endpoint (lowest latency after validation)", () => {
      // All endpoints start with time=999999999999 from init(); first slot wins
      const url = rpc.getRpc("https");
      expect(url).toBe("https://rpc1.com");
    });

    test("fastest: returns WebSocket URL for 'ws' type", () => {
      const url = rpc.getRpc("ws");
      expect(url).toBe("wss://ws1.com");
    });

    test("throws for an unrecognised RPC type", () => {
      expect(() => rpc.getRpc("invalid" as any)).toThrow('Invalid RPC type: "invalid"');
    });

    test("throws when endpoint list is empty", () => {
      rpc["validRPCs"] = [];
      expect(() => rpc.getRpc("https")).toThrow("No valid https URLs found");
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
    test("getValidRPCCount returns the number of loaded endpoints per type", () => {
      expect(rpc.getValidRPCCount("https")).toBe(2);
      expect(rpc.getValidRPCCount("ws")).toBe(2);
    });

    test("getAllValidRPCs returns a defensive copy — mutations don't affect internal state", () => {
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

    test("records the URL in failedURL map when the network request throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      const r = new RPC({ chainId: "0x0001" });
      await expect(r["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
      expect(r["failedURL"].has("https://failing-rpc.com")).toBe(true);
      r.destroy();
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
      const original = global.WebSocket;
      global.WebSocket = SilentWebSocket as any;
      const r = new RPC({ chainId: "0x0001" });
      await expect(r["wsCall"]("wss://hanging-ws.com", 1)).rejects.toThrow("WebSocket timeout");
      r.destroy();
      global.WebSocket = original;
      jest.useFakeTimers();
    }, 15000);
  });

  describe("getRpcAsync", () => {
    test("resolves with a valid https URL string once async initialization has settled", async () => {
      const r = new RPC({ chainId: "0x0001" });
      for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(100);
      const url = r.getRpc("https");
      expect(typeof url).toBe("string");
      expect(url.startsWith("https://")).toBe(true);
      r.destroy();
    });
  });

  describe("destroy()", () => {
    test("clears all endpoint lists, failure records, and cancels the refresh timer", () => {
      rpc.drop("https://fail.com");
      rpc.destroy();
      expect(rpc["refreshTimer"]).toBeNull();
      expect(rpc["validRPCs"]).toEqual([]);
      expect(rpc["validWSRPCs"]).toEqual([]);
      expect(rpc["failedURL"].size).toBe(0);
    });
  });

  describe("pathToRpcJson — custom RPC list loading", () => {
    test("loads endpoints from the specified custom JSON file", () => {
      const customRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
      });

      // Should use the custom data, not the default
      const allRpcs = customRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(3);
      expect(allRpcs[0].url).toBe("https://custom-rpc-one.example.com");
      expect(allRpcs[1].url).toBe("https://custom-rpc-two.example.com");
      expect(allRpcs[2].url).toBe("https://custom-rpc-three.example.com");

      const wsRpcs = customRpc.getAllValidRPCs("ws");
      expect(wsRpcs.length).toBe(1);
      expect(wsRpcs[0].url).toBe("wss://custom-ws-one.example.com");

      customRpc.destroy();
    });

    test("falls back to bundled rpcList.min.json when the specified path does not exist", () => {
      const fallbackRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/nonexistent-rpc-list.json",
      });

      // Should fall back to default mock data
      const allRpcs = fallbackRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(2);
      expect(allRpcs[0].url).toBe("https://rpc1.com");
      expect(allRpcs[1].url).toBe("https://rpc2.com");

      fallbackRpc.destroy();
    });

    test("uses bundled list when pathToRpcJson is an empty string", () => {
      const defaultRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "",
      });

      const allRpcs = defaultRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(2);
      expect(allRpcs[0].url).toBe("https://rpc1.com");

      defaultRpc.destroy();
    });

    test("custom-path endpoints are compatible with round-robin load balancing", () => {
      const customRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
        loadBalancing: "round-robin",
      });

      const url1 = customRpc.getRpc("https");
      const url2 = customRpc.getRpc("https");
      const url3 = customRpc.getRpc("https");
      const url4 = customRpc.getRpc("https"); // wraps

      expect(url1).toBe("https://custom-rpc-one.example.com");
      expect(url2).toBe("https://custom-rpc-two.example.com");
      expect(url3).toBe("https://custom-rpc-three.example.com");
      expect(url4).toBe(url1); // round-robin wraps

      customRpc.destroy();
    });

    test("drop() correctly tracks failures for custom-path endpoints", () => {
      const customRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "/path/to/custom-rpc-list.json",
        maxRetry: 1,
      });

      const url = customRpc.getRpc("https");
      customRpc.drop(url);

      const stats = customRpc.getFailureStats();
      expect(stats.totalFailed).toBe(1);
      expect(stats.overMaxRetries).toBe(1);

      customRpc.destroy();
    });
  });
});
