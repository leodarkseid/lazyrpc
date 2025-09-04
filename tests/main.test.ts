import { RPC, RPCConfig } from "../src/index";
import * as fs from "fs";

// Mock globals at module level
const mockFetch = jest.fn(async () =>
  Promise.resolve({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }),
  })
);
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

// Mock file system
const mockRpcData = {
  x0001: ["https://rpc1.com", "https://rpc2.com"],
  x0001_WS: ["wss://ws1.com", "wss://ws2.com"],
};

const mockAsyncRpcData = {
  x0001: ["https://mock-http-rpc.com", "https://rpc2.com"],
  x0001_WS: ["wss://mock-ws-rpc.com", "wss://ws2.com"],
};

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  readFileSync: jest.fn(() => JSON.stringify(mockRpcData)),
  promises: {
    readFile: jest.fn(() => Promise.resolve(JSON.stringify(mockAsyncRpcData)))
  },
  existsSync: jest.fn(() => true)
}));

describe("Enhanced RPC Class Tests", () => {
  let rpc: RPC;
  let initializeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    initializeSpy = jest.spyOn(RPC.prototype as any, "intialize");
    rpc = new RPC({ chainId: "0x0001", ttl: 5, maxRetry: 3 });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  describe("Constructor and Validation", () => {
    test("should validate chainId format", () => {
      expect(() => new RPC({ chainId: "invalid" })).toThrow("chainId must be in hex format");
    });

    test("should validate ttl range", () => {
      expect(() => new RPC({ chainId: "0x0001", ttl: -1 })).toThrow("ttl must be between 1 and 3600 seconds");
    });

    test("should validate maxRetry range", () => {
      expect(() => new RPC({ chainId: "0x0001", maxRetry: 15 })).toThrow("maxRetry must be between 0 and 10");
    });

    test("should validate loadBalancing strategy", () => {
      expect(() => new RPC({ chainId: "0x0001", loadBalancing: "invalid" as any })).toThrow("loadBalancing must be 'fastest', 'round-robin', or 'random'");
    });
  });

  describe("Load Balancing", () => {
    test("should use fastest strategy by default", () => {
      const rpc = new RPC({ chainId: "0x0001" });
      expect(rpc.getRpc("https")).toBe("https://mock-http-rpc.com");
    });

    test("should support round-robin load balancing", async () => {
      const rpc = new RPC({ chainId: "0x0001", loadBalancing: "round-robin" });
      await rpc.refresh(); // Ensure initialization is complete
      
      // Mock multiple valid RPCs
      rpc["validRPCs"] = [
        { url: "https://rpc1.com", time: 100 },
        { url: "https://rpc2.com", time: 200 }
      ];

      const first = rpc.getRpc("https");
      const second = rpc.getRpc("https");
      const third = rpc.getRpc("https");

      expect([first, second, third]).toEqual(["https://rpc1.com", "https://rpc2.com", "https://rpc1.com"]);
    });
  });

  describe("Utility Methods", () => {
    test("should get valid RPC count", () => {
      expect(rpc.getValidRPCCount("https")).toBeGreaterThanOrEqual(0);
      expect(rpc.getValidRPCCount("ws")).toBeGreaterThanOrEqual(0);
    });

    test("should get all valid RPCs", () => {
      const httpRPCs = rpc.getAllValidRPCs("https");
      const wsRPCs = rpc.getAllValidRPCs("ws");
      
      expect(Array.isArray(httpRPCs)).toBe(true);
      expect(Array.isArray(wsRPCs)).toBe(true);
    });

    test("should get failure statistics", () => {
      const stats = rpc.getFailureStats();
      expect(stats).toHaveProperty("totalFailed");
      expect(stats).toHaveProperty("inBackoff");
      expect(stats).toHaveProperty("overMaxRetries");
    });

    test("should clear failed URLs", () => {
      rpc.drop("https://failed-rpc.com");
      expect(rpc.getFailureStats().totalFailed).toBeGreaterThan(0);
      
      rpc.clearFailedURLs();
      expect(rpc.getFailureStats().totalFailed).toBe(0);
    });
  });

  describe("Legacy Tests (Updated)", () => {
    test("should initialize with the correct RPC endpoints", () => {
      expect(rpc.getRpc("https")).toBe("https://mock-http-rpc.com");
      expect(rpc.getRpc("ws")).toBe("wss://mock-ws-rpc.com");
    });

    test("should call intialize() periodically", () => {
      expect(initializeSpy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5000);
      expect(initializeSpy).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(5000);
      expect(initializeSpy).toHaveBeenCalledTimes(2);
    });

    test("should make a valid HTTP call", async () => {
      await rpc["httpCall"]("https://mock-http-rpc.com", 1);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://mock-http-rpc.com",
        expect.any(Object)
      );
    });

    test("should update RPC list based on response time", async () => {
      await rpc["intialize"]();
      expect(rpc.getRpc("https")).toBe("https://mock-http-rpc.com");
      expect(rpc.getRpc("ws")).toBe("wss://mock-ws-rpc.com");
    });

    test("should throw an error for invalid type", () => {
      expect(() => rpc.getRpc("invalid" as any)).toThrow();
    });

    test("should mark an RPC as failed when drop is called", () => {
      const rpc = new RPC({ chainId: "0x0001" });
      rpc.drop("https://mock-http-rpc.com");

      expect(rpc["failedURL"].has("https://mock-http-rpc.com")).toBe(true);
    });
  });

  describe("Enhanced Error Handling", () => {
    test("should handle WebSocket timeout", async () => {
      jest.useRealTimers();
      
      // Create a mock WebSocket that never responds
      const TimeoutWebSocket = class {
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        
        send = jest.fn();
        close = jest.fn();

        constructor(url: string) {
          // Never call onopen to simulate hanging connection
        }
      };

      const originalWebSocket = global.WebSocket;
      global.WebSocket = TimeoutWebSocket as any;
      
      const rpc = new RPC({ chainId: "0x0001" });
      
      await expect(rpc["wsCall"]("wss://hanging-ws.com", 1)).rejects.toThrow("WebSocket timeout");
      
      global.WebSocket = originalWebSocket;
      jest.useFakeTimers();
    }, 15000);

    test("should handle HTTP errors properly", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
      
      const rpc = new RPC({ chainId: "0x0001" });
      
      await expect(rpc["httpCall"]("https://failing-rpc.com", 1)).rejects.toThrow("Network error");
      expect(rpc["failedURL"].has("https://failing-rpc.com")).toBe(true);
      
      global.fetch = originalFetch;
    });
  });

  describe("Exponential Backoff", () => {
    test("should implement exponential backoff for failed URLs", () => {
      const rpc = new RPC({ chainId: "0x0001" });
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
  });
});
