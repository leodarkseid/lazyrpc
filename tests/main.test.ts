import { RPC, RPCConfig } from "../src/index";
import * as fs from "fs";

// Mock globals at module level
const mockFetch = jest.fn(async (_url: string, options?: any) => {
  // Parse the request to return matching id for assertion
  let id = 1;
  try {
    if (options?.body) {
      const body = JSON.parse(options.body);
      id = body.id;
    }
  } catch { }
  return Promise.resolve({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id, result: "0x10" }),
  });
});
global.fetch = mockFetch as any;

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

describe("Enhanced RPC Class Tests", () => {
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

  describe("Constructor and Validation", () => {
    test("should validate chainId is required", () => {
      expect(() => new RPC({ chainId: "" })).toThrow("chainId is required");
    });

    test("should validate chainId format", () => {
      expect(() => new RPC({ chainId: "invalid" })).toThrow("chainId must be in hex format");
    });

    test("should validate ttl range (negative)", () => {
      expect(() => new RPC({ chainId: "0x0001", ttl: -1 })).toThrow("ttl must be between 1 and 3600 seconds");
    });

    test("should validate ttl range (too high)", () => {
      expect(() => new RPC({ chainId: "0x0001", ttl: 9999 })).toThrow("ttl must be between 1 and 3600 seconds");
    });

    test("should validate maxRetry range", () => {
      expect(() => new RPC({ chainId: "0x0001", maxRetry: 15 })).toThrow("maxRetry must be between 0 and 10");
    });

    test("should accept maxRetry of 0", () => {
      const r = new RPC({ chainId: "0x0001", maxRetry: 0 });
      expect(r["maxRetry"]).toBe(0);
      r.destroy();
    });

    test("should validate loadBalancing strategy", () => {
      expect(() => new RPC({ chainId: "0x0001", loadBalancing: "invalid" as any })).toThrow("loadBalancing must be 'fastest', 'round-robin', or 'random'");
    });
  });

  describe("getRpc and Load Balancing", () => {
    test("should use fastest strategy by default (sync init)", () => {
      // After construction, init() has loaded sync data. The first URL is the fastest
      // since all are initialized with time=999999999999.
      const url = rpc.getRpc("https");
      expect(url).toBe("https://rpc1.com");
    });

    test("should return WebSocket URLs for ws type", () => {
      const url = rpc.getRpc("ws");
      expect(url).toBe("wss://ws1.com");
    });

    test("should throw for invalid RPC type", () => {
      expect(() => rpc.getRpc("invalid" as any)).toThrow('Invalid RPC type: "invalid"');
    });

    test("should support round-robin load balancing", () => {
      const rr = new RPC({ chainId: "0x0001", loadBalancing: "round-robin" });

      // Manually set valid RPCs for deterministic test
      rr["validRPCs"] = [
        { url: "https://rpc1.com", time: 100 },
        { url: "https://rpc2.com", time: 200 }
      ];

      const first = rr.getRpc("https");
      const second = rr.getRpc("https");
      const third = rr.getRpc("https");

      expect([first, second, third]).toEqual(["https://rpc1.com", "https://rpc2.com", "https://rpc1.com"]);
      rr.destroy();
    });

    test("should support round-robin for WebSocket", () => {
      const rr = new RPC({ chainId: "0x0001", loadBalancing: "round-robin" });

      rr["validWSRPCs"] = [
        { url: "wss://ws1.com", time: 100 },
        { url: "wss://ws2.com", time: 200 }
      ];

      const first = rr.getRpc("ws");
      const second = rr.getRpc("ws");
      expect([first, second]).toEqual(["wss://ws1.com", "wss://ws2.com"]);
      rr.destroy();
    });

    test("should support random load balancing", () => {
      const rr = new RPC({ chainId: "0x0001", loadBalancing: "random" });
      rr["validRPCs"] = [
        { url: "https://rpc1.com", time: 100 },
        { url: "https://rpc2.com", time: 200 }
      ];

      const url = rr.getRpc("https");
      expect(["https://rpc1.com", "https://rpc2.com"]).toContain(url);
      rr.destroy();
    });

    test("should throw when no valid URLs exist", () => {
      rpc["validRPCs"] = [];
      expect(() => rpc.getRpc("https")).toThrow("No valid https URLs found");
    });
  });

  describe("Utility Methods", () => {
    test("should get valid RPC count", () => {
      expect(rpc.getValidRPCCount("https")).toBe(2);
      expect(rpc.getValidRPCCount("ws")).toBe(2);
    });

    test("should get all valid RPCs as copies", () => {
      const httpRPCs = rpc.getAllValidRPCs("https");
      expect(Array.isArray(httpRPCs)).toBe(true);
      expect(httpRPCs.length).toBe(2);

      // Verify it returns a copy, not the internal array
      httpRPCs.pop();
      expect(rpc.getAllValidRPCs("https").length).toBe(2);
    });

    test("should get failure statistics", () => {
      // Clear any failures from background initialization attempts
      rpc.clearFailedURLs();
      const stats = rpc.getFailureStats();
      expect(stats).toEqual({ totalFailed: 0, inBackoff: 0, overMaxRetries: 0 });
    });

    test("should clear failed URLs", () => {
      rpc.drop("https://failed-rpc.com");
      expect(rpc.getFailureStats().totalFailed).toBeGreaterThan(0);

      rpc.clearFailedURLs();
      expect(rpc.getFailureStats().totalFailed).toBe(0);
    });
  });

  describe("drop() and Failure Tracking", () => {
    test("should mark an RPC as failed when drop is called", () => {
      rpc.drop("https://failing.com");
      expect(rpc["failedURL"].has("https://failing.com")).toBe(true);
      expect(rpc["failedURL"].get("https://failing.com")!.count).toBe(1);
    });

    test("should increment failure count by 1 per drop", () => {
      rpc.drop("https://failing.com");
      expect(rpc["failedURL"].get("https://failing.com")!.count).toBe(1);

      rpc.drop("https://failing.com");
      expect(rpc["failedURL"].get("https://failing.com")!.count).toBe(2);

      rpc.drop("https://failing.com");
      expect(rpc["failedURL"].get("https://failing.com")!.count).toBe(3);
    });

    test("should implement exponential backoff for failed URLs", () => {
      const url = "https://failed-rpc.com";

      // First failure
      rpc["drop_"](url);
      let failureInfo = rpc["failedURL"].get(url)!;
      expect(failureInfo.count).toBe(1);
      expect(failureInfo.nextRetry).toBeGreaterThan(Date.now());

      // Second failure should have longer backoff
      const firstBackoff = failureInfo.nextRetry! - Date.now();
      rpc["drop_"](url);
      failureInfo = rpc["failedURL"].get(url)!;
      const secondBackoff = failureInfo.nextRetry! - Date.now();

      expect(secondBackoff).toBeGreaterThan(firstBackoff);
    });

    test("should report correct failure stats categories", () => {
      // Clear any failures from background initialization
      rpc.clearFailedURLs();

      const url1 = "https://maxed-out.com";
      const url2 = "https://in-backoff.com";

      // Push url1 past maxRetry (3)
      rpc["drop_"](url1);
      rpc["drop_"](url1);
      rpc["drop_"](url1);

      // url2 has 1 failure, still in backoff
      rpc["drop_"](url2);

      const stats = rpc.getFailureStats();
      expect(stats.totalFailed).toBe(2);
      expect(stats.overMaxRetries).toBe(1);
      expect(stats.inBackoff).toBe(1);
    });
  });

  describe("shouldSkipURL", () => {
    test("should not skip unknown URLs", () => {
      expect(rpc["shouldSkipURL"]("https://unknown.com")).toBe(false);
    });

    test("should skip URLs that have exceeded maxRetry", () => {
      const url = "https://dead.com";
      rpc["drop_"](url);
      rpc["drop_"](url);
      rpc["drop_"](url); // count = 3 = maxRetry
      expect(rpc["shouldSkipURL"](url)).toBe(true);
    });

    test("should skip URLs in backoff period", () => {
      const url = "https://backoff.com";
      rpc["drop_"](url); // nextRetry is in the future
      expect(rpc["shouldSkipURL"](url)).toBe(true);
    });

    test("should reset failures after timeToResetFailedURL", () => {
      const url = "https://old-failure.com";
      rpc["drop_"](url);
      rpc["drop_"](url);
      rpc["drop_"](url);

      // Fast-forward past the 6-hour reset window
      const entry = rpc["failedURL"].get(url)!;
      entry.time = Date.now() - (7 * 60 * 60 * 1000); // 7 hours ago
      rpc["failedURL"].set(url, entry);

      expect(rpc["shouldSkipURL"](url)).toBe(false);
    });
  });

  describe("Periodic Initialization", () => {
    test("should call initialize() on construction", () => {
      expect(initializeSpy).toHaveBeenCalledTimes(1);
    });

    test("should schedule periodic initialize() via ttl", async () => {
      // Flush all microtasks and pending promises from the initial initialize()
      // We need multiple cycles because initialize() does async work before scheduling the timer
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(100);
      }
      expect(initializeSpy).toHaveBeenCalledTimes(1);

      // Advance past the TTL (5 seconds) — the timer was set after initialize() resolved
      await jest.advanceTimersByTimeAsync(5000);
      expect(initializeSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("HTTP Call Validation", () => {
    test("should make a valid HTTP call", async () => {
      await rpc["httpCall"]("https://rpc1.com", 1);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://rpc1.com",
        expect.any(Object)
      );
    });

    test("should handle HTTP errors and track failure", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      const r = new RPC({ chainId: "0x0001" });

      await expect(r["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
      expect(r["failedURL"].has("https://failing-rpc.com")).toBe(true);

      r.destroy();
      global.fetch = originalFetch;
    });

    test("should skip URLs in backoff during httpCall", async () => {
      // Force the URL into permanent failure
      rpc["failedURL"].set("https://rpc1.com", {
        count: 10,
        time: Date.now(),
        nextRetry: Date.now() + 60000
      });

      await expect(rpc["httpCall"]("https://rpc1.com", 1)).rejects.toThrow("in backoff period");
    });
  });

  describe("WebSocket Call Validation", () => {
    test("should handle WebSocket timeout", async () => {
      jest.useRealTimers();

      const TimeoutWebSocket = class {
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        send = jest.fn();
        close = jest.fn();
        constructor(url: string) { }
      };

      const originalWebSocket = global.WebSocket;
      global.WebSocket = TimeoutWebSocket as any;

      const r = new RPC({ chainId: "0x0001" });

      await expect(r["wsCall"]("wss://hanging-ws.com", 1)).rejects.toThrow("WebSocket timeout");

      r.destroy();
      global.WebSocket = originalWebSocket;
      jest.useFakeTimers();
    }, 15000);
  });

  describe("getRpcAsync", () => {
    test("should resolve with a valid URL after async initialization", async () => {
      // Use fake timers but advance them to let initialize() complete
      const r = new RPC({ chainId: "0x0001" });

      // Flush the async initialization
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(100);
      }

      const url = r.getRpc("https");
      expect(url).toBeDefined();
      expect(typeof url).toBe("string");

      r.destroy();
    });
  });

  describe("destroy()", () => {
    test("should clear all state", () => {
      rpc.drop("https://fail.com");
      rpc.destroy();

      expect(rpc["refreshTimer"]).toBeNull();
      expect(rpc["validRPCs"]).toEqual([]);
      expect(rpc["validWSRPCs"]).toEqual([]);
      expect(rpc["failedURL"].size).toBe(0);
    });
  });

  describe("pathToRpcJson", () => {
    test("should load RPCs from a custom JSON file path", () => {
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

    test("should fall back to bundled list when pathToRpcJson does not exist", () => {
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

    test("should use default data when pathToRpcJson is empty string", () => {
      const defaultRpc = new RPC({
        chainId: "0x0001",
        pathToRpcJson: "",
      });

      const allRpcs = defaultRpc.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(2);
      expect(allRpcs[0].url).toBe("https://rpc1.com");

      defaultRpc.destroy();
    });

    test("custom path RPCs should work with load balancing", () => {
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

    test("custom path RPCs should work with drop()", () => {
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
