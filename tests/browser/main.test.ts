

// Mock the json module BEFORE importing RPC!
jest.mock("../../src/rpcList.min.json", () => ({
  "x0001": ["https://rpc1.com", "https://rpc2.com"],
  "x0001_WS": ["wss://ws1.com", "wss://ws2.com"]
}), { virtual: true });

import { RPC } from "../../src/browser";
import { RPCBase } from "../../src/core/rpcBase";

// ---------------------------------------------------------------------------
// window.fetch mock
// ---------------------------------------------------------------------------
const mockFetch = jest.fn(async (_url: string, options?: any) => {
  let id = 1;
  try {
    if (options?.body) id = JSON.parse(options.body).id;
  } catch { }
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0x10" }) };
});

global.fetch = mockFetch as any;
if (typeof window !== "undefined") {
    window.fetch = mockFetch as any;
}

// ---------------------------------------------------------------------------
// window.WebSocket mock
// ---------------------------------------------------------------------------
class MockWebSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send = jest.fn();
  close = jest.fn();
  readyState = 1;

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

global.WebSocket = MockWebSocket as any;
if (typeof window !== "undefined") {
    window.WebSocket = MockWebSocket as any;
}

/** Drains the async initialization loop so validRPCs gets populated */
async function drainInit() {
  for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(100);
}

describe("Browser RPC", () => {
  let rpc: RPC;
  let initializeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    initializeSpy = jest.spyOn(RPCBase.prototype as any, "initialize");
    rpc = new RPC({ chainId: "0x0001", ttl: 5, maxRetry: 3 });
  });

  afterEach(() => {
    rpc.destroy();
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  describe("Config validation", () => {
    test("throws when chainId is missing", () => {
      expect(() => new RPC({ chainId: "" })).toThrow("chainId is required");
    });

    test("throws when ttl is <= 0", () => {
      expect(() => new RPC({ chainId: "0x0001", ttl: -1 })).toThrow("ttl must be between 1 and 3600 seconds");
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

    test("throws for an unrecognised RPC type", () => {
      expect(() => rpc.getRpc("invalid" as any)).toThrow('Invalid RPC type: "invalid"');
    });
  });

  describe("getValidRPCCount / getAllValidRPCs", () => {
    test("getValidRPCCount returns base URL count before initialization completes", () => {
      expect(rpc.getValidRPCCount("https")).toBeGreaterThan(0);
      expect(rpc.getValidRPCCount("ws")).toBeGreaterThan(0);
    });

    test("getValidRPCCount returns endpoint count after initialization", async () => {
      await drainInit();
      expect(rpc.getValidRPCCount("https")).toBeGreaterThan(0);
      expect(rpc.getValidRPCCount("ws")).toBeGreaterThan(0);
    });

    test("getAllValidRPCs returns a defensive copy", async () => {
      await drainInit();
      const copy = rpc.getAllValidRPCs("https");
      const len = copy.length;
      copy.pop();
      expect(rpc.getAllValidRPCs("https").length).toBe(len);
    });
  });

  describe("getFailureStats / clearFailedURLs", () => {
    test("clearFailedURLs resets all tracked failures to zero", async () => {
      await drainInit();
      const url = rpc.getRpc("https");
      rpc.drop(url);
      expect(rpc.getFailureStats().totalFailed).toBeGreaterThan(0);
      rpc.clearFailedURLs();
      expect(rpc.getFailureStats().totalFailed).toBe(0);
    });
  });

  describe("Periodic re-validation (TTL)", () => {
    test("initialize() is called exactly once during construction", () => {
      expect(initializeSpy).toHaveBeenCalledTimes(1);
    });

    test("initialize() is called again after ttl seconds elapse", async () => {
      await drainInit();
      expect(initializeSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5000);
      expect(initializeSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("httpCall — internal RPC validation via fetch", () => {
    test("sends a POST eth_blockNumber request to the given URL", async () => {
      await drainInit();
      const url = rpc.getRpc("https");
      await rpc["httpCall"](url, 1);
      expect(mockFetch).toHaveBeenCalledWith(url, expect.any(Object));
    });

    test("records the URL in failedURL map when the network request throws", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === "https://failing-rpc.com") {
          throw new Error("Network error");
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1" }) };
      });

      const r = new RPC({ chainId: "0x0001" });
      await expect(r["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
      expect(r["failedURL"].has("https://failing-rpc.com")).toBe(true);
      r.destroy();
      // Restore healthy mock for subsequent tests
      mockFetch.mockImplementation(async (_url: string, options?: any) => {
        let id = 1;
        try { if (options?.body) id = JSON.parse(options.body).id; } catch { }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0x10" }) };
      });
    });
  });

  describe("getRpcAsync", () => {
    test("resolves with a valid URL once initialization validates one", async () => {
      const r = new RPC({ chainId: "0x0001" });
      const promise = r.getRpcAsync("https");
      await drainInit();
      const url = await promise;
      expect(url.startsWith("https://")).toBe(true);
      r.destroy();
    });

    test("returns immediately when validated RPCs already exist", async () => {
      await drainInit();
      const url = await rpc.getRpcAsync("https");
      expect(url.startsWith("https://")).toBe(true);
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

    test("returns 'refreshing' during re-validation with existing RPCs", async () => {
      await drainInit();
      rpc.refresh();
      expect(rpc.status()).toBe("refreshing");
      await drainInit();
      expect(rpc.status()).toBe("ready");
    });

    test("returns 'destroyed' after destroy()", () => {
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

  describe("customRpcs — merge and validation (browser)", () => {
    test("merges custom HTTP URLs into the built-in list", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["https://my-browser-node.com"] },
      });
      await drainInit();
      const allRpcs = r.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(3); // 2 built-in + 1 custom
      expect(allRpcs.map((e) => e.url)).toContain("https://my-browser-node.com");
      r.destroy();
    });

    test("deduplicates when custom URLs overlap with built-in list", async () => {
      const r = new RPC({
        chainId: "0x0001",
        customRpcs: {
          http: ["https://rpc1.com", "https://new-node.com"],
        },
      });
      await drainInit();
      const allRpcs = r.getAllValidRPCs("https");
      expect(allRpcs.length).toBe(3); // rpc1 deduped, rpc2, new-node
      r.destroy();
    });

    test("throws on malformed URL", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["not-a-url"] },
      })).toThrow("Invalid URL in customRpcs.http");
    });

    test("throws when http array contains a WebSocket URL", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { http: ["wss://wrong-protocol.com"] },
      })).toThrow("Invalid protocol in customRpcs.http");
    });

    test("throws on empty http array", () => {
      expect(() => new RPC({
        chainId: "0x0001",
        customRpcs: { http: [] },
      })).toThrow("customRpcs.http must be a non-empty array");
    });
  });
});

afterAll(async () => {
    jest.useRealTimers();
});
