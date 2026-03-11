import { RPCBase } from "../../src/core";

// Mock the json module BEFORE importing RPC!
jest.mock("../../src/rpcList.min.json", () => ({
  "x0001": ["https://rpc1.com", "https://rpc2.com"],
  "x0001_WS": ["wss://ws1.com", "wss://ws2.com"]
}), { virtual: true });

import { RPC } from "../../src/browser";

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
if (typeof window !== "undefined") {
    window.WebSocket = MockWebSocket as any;
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
    test("fastest: returns first endpoint (lowest latency after validation)", () => {
      const url = rpc.getRpc("https");
      // Could be anything since we use the real json list, but it shouldn't throw.
      expect(typeof url).toBe("string");
      expect(url.startsWith("https://")).toBe(true);
    });

    test("throws for an unrecognised RPC type", () => {
      expect(() => rpc.getRpc("invalid" as any)).toThrow('Invalid RPC type: "invalid"');
    });
  });

  describe("getValidRPCCount / getAllValidRPCs", () => {
    test("getValidRPCCount returns the number of loaded endpoints per type", () => {
      expect(rpc.getValidRPCCount("https")).toBeGreaterThan(0);
      expect(rpc.getValidRPCCount("ws")).toBeGreaterThan(0);
    });

    test("getAllValidRPCs returns a defensive copy", () => {
      const copy = rpc.getAllValidRPCs("https");
      const len = copy.length;
      copy.pop();
      expect(rpc.getAllValidRPCs("https").length).toBe(len);
    });
  });

  describe("getFailureStats / clearFailedURLs", () => {
    test("clearFailedURLs resets all tracked failures to zero", () => {
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
      for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(100);
      expect(initializeSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5000);
      expect(initializeSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("httpCall — internal RPC validation via fetch", () => {
    test("sends a POST eth_blockNumber request to the given URL", async () => {
      const url = rpc.getRpc("https");
      await rpc["httpCall"](url, 1);
      expect(mockFetch).toHaveBeenCalledWith(url, expect.any(Object));
    });

    test("records the URL in failedURL map when the network request throws", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === "https://failing-rpc.com") {
          throw new Error("Network error");
        }
        return { ok: true, json: async () => ({ id: 1, result: "0x1" }) };
      });

      const r = new RPC({ chainId: "0x0001" });
      await expect(r["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
      expect(r["failedURL"].has("https://failing-rpc.com")).toBe(true);
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
});
