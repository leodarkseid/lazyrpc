import { RPCBase } from "../../../src/core/rpcBase";
import type { RPCDependencies } from "../../../src/types";

class MockWebSocket {
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  readyState = 1;
  close = jest.fn();

  constructor(public url: string) {
    setTimeout(() => this.onopen?.({}), 1);
  }

  send = jest.fn((payload: string) => {
    const id = JSON.parse(payload).id;
    setTimeout(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id, result: "0x10" }),
      });
    }, 1);
  });
}

const makeDeps = (overrides: Partial<RPCDependencies> = {}): RPCDependencies => ({
  fetchFn: jest.fn(async (_url: string, options: any) => ({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({
      jsonrpc: "2.0",
      id: JSON.parse(options.body).id,
      result: "0x10",
    }),
  })) as any,
  websocketClass: MockWebSocket as any,
  chainList: {
    x0001: ["https://rpc-1.example", "https://rpc-2.example"],
    x0001_WS: ["wss://ws-1.example", "wss://ws-2.example"],
  },
  ...overrides,
});

async function drainValidation() {
  for (let i = 0; i < 10; i++) {
    await jest.advanceTimersByTimeAsync(10);
  }
}

describe("core/rpcBase", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("keeps candidates separate from validated endpoints before initialization completes", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(rpc.status()).toBe("initializing");
    expect(rpc.getValidRPCCount("https")).toBe(0);
    expect(rpc.getValidRPCCount("ws")).toBe(0);
    expect(rpc.getAllValidRPCs("https")).toEqual([]);
    expect(rpc.getAllCandidateRPCs("https")).toEqual(["https://rpc-1.example", "https://rpc-2.example"]);
    expect(rpc.getAllRPCs("ws")).toEqual(["wss://ws-1.example", "wss://ws-2.example"]);

    void rpc.destroy();
  });

  test("getRpc validates the requested type and only returns validated URLs", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(() => rpc.getRpc("https")).toThrow("No validated https RPC URLs available yet");
    await drainValidation();
    expect(rpc.getRpc("https")).toBe("https://rpc-1.example");
    expect(rpc.getRpc("ws")).toBe("wss://ws-1.example");
    expect(() => rpc.getRpc("ftp" as any)).toThrow('Invalid RPC type: "ftp"');

    void rpc.destroy();
  });

  test("round-robin selection is independent for HTTP and WebSocket pools", async () => {
    const rpc = new RPCBase({
      chainId: "0x1",
      enforceHttps: false,
      loadBalancing: "round-robin",
    }, makeDeps());

    await drainValidation();

    expect([rpc.getRpc("https"), rpc.getRpc("https"), rpc.getRpc("https")]).toEqual([
      "https://rpc-1.example",
      "https://rpc-2.example",
      "https://rpc-1.example",
    ]);
    expect([rpc.getRpc("ws"), rpc.getRpc("ws")]).toEqual([
      "wss://ws-1.example",
      "wss://ws-2.example",
    ]);

    rpc.destroy();
  });

  test("drop, clearFailedURLs, and getFailureStats delegate to health tracking", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());
    await drainValidation();

    rpc.drop("https://rpc-1.example");
    expect(rpc.getFailureStats()).toEqual({
      totalFailed: 1,
      inBackoff: 1,
      overMaxRetries: 0,
    });
    expect(() => rpc.getRpc("https")).not.toThrow();

    rpc.clearFailedURLs();
    expect(rpc.getFailureStats()).toEqual({
      totalFailed: 0,
      inBackoff: 0,
      overMaxRetries: 0,
    });

    rpc.destroy();
  });

  test("throws when all endpoints of a type are failing", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false, maxRetry: 1 }, makeDeps());
    await drainValidation();

    rpc.drop("https://rpc-1.example");
    rpc.drop("https://rpc-2.example");

    expect(() => rpc.getRpc("https")).toThrow("All validated https RPC URLs are currently failing or in backoff");

    rpc.destroy();
  });

  test("validation refresh replaces sentinel endpoints with measured endpoints", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false, ttl: 60 }, makeDeps());

    await drainValidation();

    expect(rpc.status()).toBe("ready");
    expect(rpc.getAllValidRPCs("https").length).toBe(2);
    expect(rpc.getAllValidRPCs("ws").length).toBe(2);

    rpc.destroy();
  });

  test("hostile payload failures are tracked and excluded from validated selection", async () => {
    const fetchFn = jest.fn(async (url: string, options: any) => {
      const id = JSON.parse(options.body).id;
      if (url === "https://rpc-1.example") {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: "0x10",
            extra: "x".repeat(128),
          }),
        };
      }
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id, result: "0x10" }),
      };
    });
    const rpc = new RPCBase({
      chainId: "0x1",
      enforceHttps: false,
      maxPayloadStringBytes: 16,
    }, makeDeps({
      fetchFn: fetchFn as any,
      chainList: { x0001: ["https://rpc-1.example", "https://rpc-2.example"] },
    }));

    await drainValidation();

    expect(rpc.getAllValidRPCs("https").map((endpoint) => endpoint.url)).toEqual(["https://rpc-2.example"]);
    expect(rpc.getRpc("https")).toBe("https://rpc-2.example");
    expect(rpc.getFailureStats().totalFailed).toBe(1);

    rpc.destroy();
  });

  test("getRpcAsync resolves queued callers as soon as validation finds a matching type", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());
    const httpPromise = rpc.getRpcAsync("https", 1_000);
    const wsPromise = rpc.getRpcAsync("ws", 1_000);

    await drainValidation();

    await expect(httpPromise).resolves.toMatch(/^https:\/\//);
    await expect(wsPromise).resolves.toMatch(/^wss:\/\//);

    rpc.destroy();
  });

  test("getRpcAsync returns immediately once endpoints have already been validated", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());
    await drainValidation();

    await expect(rpc.getRpcAsync("https")).resolves.toMatch(/^https:\/\//);

    rpc.destroy();
  });

  test("getRpcAsync rejects when no base URLs exist for the requested type", async () => {
    const rpc = new RPCBase({
      chainId: "0x1",
      enforceHttps: false,
    }, makeDeps({ chainList: { x0001: ["https://rpc.example"] } }));

    await expect(rpc.getRpcAsync("ws")).rejects.toThrow("No ws RPC URLs are configured");

    rpc.destroy();
  });

  test("refresh triggers another validation cycle", async () => {
    const deps = makeDeps();
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, deps);
    await drainValidation();
    expect(deps.fetchFn).toHaveBeenCalledTimes(2);

    const refresh = rpc.refresh();
    await drainValidation();
    await refresh;

    expect(deps.fetchFn).toHaveBeenCalledTimes(4);

    rpc.destroy();
  });

  test("destroy aborts work, clears state, rejects queued async callers, and destroys the agent", async () => {
    const agent = { destroy: jest.fn() };
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps({ agent }));
    const pending = rpc.getRpcAsync("https", 1_000);
    const pendingAssertion = expect(pending).rejects.toThrow("RPC instance destroyed");

    await rpc.destroy();

    expect(rpc.status()).toBe("destroyed");
    expect(rpc.getValidRPCCount("https")).toBe(0);
    await pendingAssertion;
    expect(agent.destroy).toHaveBeenCalledTimes(1);
  });

  test("constructor destroys the provided agent if URL resolution fails", () => {
    const agent = { destroy: jest.fn() };

    expect(() => new RPCBase({ chainId: "0x404" }, makeDeps({ agent })))
      .toThrow("Chain ID 0x404 not found in RPC list");
    expect(agent.destroy).toHaveBeenCalledTimes(1);
  });

  // ─── getRpcAsync edge cases ───────────────────────────────────────

  test("getRpcAsync times out when validation never produces a matching endpoint", async () => {
    const slowFetch = jest.fn(() => new Promise(() => {})); // never resolves
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps({
      fetchFn: slowFetch as any,
      chainList: { x0001: ["https://slow.example"] },
    }));

    const promise = rpc.getRpcAsync("https", 50);
    // Register assertion early to prevent unhandled rejection
    const assertion = expect(promise).rejects.toThrow("Timed out after 50ms");

    await jest.advanceTimersByTimeAsync(51);
    await assertion;

    // Don't await destroy — the never-resolving fetch would hang the test.
    // destroy() aborts it, but the promise is still pending.
    void rpc.destroy();
  });

  test("getRpcAsync rejects immediately when the instance is already destroyed", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());
    await rpc.destroy();

    await expect(rpc.getRpcAsync("https")).rejects.toThrow("RPC instance destroyed");
  });

  test("getRpcAsync validates the requested type", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    await expect(rpc.getRpcAsync("ftp" as any)).rejects.toThrow('Invalid RPC type: "ftp"');

    await rpc.destroy();
  });

  // ─── status() edge cases ──────────────────────────────────────────

  test("status returns 'refreshing' when validated endpoints exist and a validation cycle is active", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());
    await drainValidation();
    expect(rpc.status()).toBe("ready");

    // Trigger a refresh — initPromise is set but validRPCs still populated
    const refreshPromise = rpc.refresh();
    expect(rpc.status()).toBe("refreshing");

    await drainValidation();
    await refreshPromise;
    expect(rpc.status()).toBe("ready");

    await rpc.destroy();
  });

  // ─── Validation cycle — all fail ──────────────────────────────────

  test("validation cycle where every endpoint fails leaves validRPCs empty and rejects queue", async () => {
    const failingFetch = jest.fn(async () => { throw new Error("network error"); });
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps({
      fetchFn: failingFetch as any,
      websocketClass: class {
        constructor() { throw new Error("ws error"); }
      } as any,
      chainList: { x0001: ["https://bad.example"], x0001_WS: ["wss://bad.example"] },
    }));

    // Queue after construction — the init cycle is already running
    const queued = rpc.getRpcAsync("https", 30_000);
    // Register the assertion early to prevent unhandled rejection
    const assertion = expect(queued).rejects.toThrow("Failed to find a validated https RPC URL");

    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(10);
    }

    await assertion;
    expect(rpc.getValidRPCCount("https")).toBe(0);
    expect(rpc.getValidRPCCount("ws")).toBe(0);

    await rpc.destroy();
  });

  test("validation cycle propagates specific failure reasons upwards to getRpcAsync callers", async () => {
    const customErrorMessage = "Special injected mock error for payload size";
    const failingFetch = jest.fn(async () => { throw new Error(customErrorMessage); });
    
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps({
      fetchFn: failingFetch as any,
      chainList: { x0001: ["https://failing.example"] },
    }));

    const queued = rpc.getRpcAsync("https", 30_000);
    
    const assertion = expect(queued).rejects.toThrow(
      `Failed to find a validated https RPC URL during this validation cycle. Reasons: ${customErrorMessage}`
    );

    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(10);
    }
    
    await assertion;

    await rpc.destroy();
  });

  // ─── Batched validation ───────────────────────────────────────────

  test("validation batches candidates in groups of 10", async () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://rpc-${i}.example`);
    const fetchFn = jest.fn(async (_url: string, options: any) => ({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: JSON.parse(options.body).id,
        result: "0x10",
      }),
    }));

    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps({
      fetchFn: fetchFn as any,
      chainList: { x0001: urls },
    }));

    await drainValidation();

    expect(rpc.getValidRPCCount("https")).toBe(15);
    // fetch was called once per URL
    expect(fetchFn).toHaveBeenCalledTimes(15);

    await rpc.destroy();
  });

  // ─── Partial queue drain ──────────────────────────────────────────

  test("drainQueueFor resolves HTTP callers while WS callers remain pending until cycle ends", async () => {
    // WS will never connect (constructor hangs)
    class HangingWs {
      onopen: any; onmessage: any; onerror: any; onclose: any;
      readyState = 0;
      close = jest.fn();
      send = jest.fn();
      constructor() {}
    }

    const rpc = new RPCBase({
      chainId: "0x1",
      enforceHttps: false,
      validationTimeout: 50,
    }, makeDeps({
      websocketClass: HangingWs as any,
      chainList: {
        x0001: ["https://rpc.example"],
        x0001_WS: ["wss://ws.example"],
      },
    }));

    const httpPromise = rpc.getRpcAsync("https", 30_000);
    const wsPromise = rpc.getRpcAsync("ws", 30_000);
    // Register assertions early to prevent unhandled rejection
    const wsAssertion = expect(wsPromise).rejects.toThrow();

    // Drain validation — HTTP will succeed, WS will timeout after 50ms
    for (let i = 0; i < 30; i++) {
      await jest.advanceTimersByTimeAsync(10);
    }

    // HTTP should resolve quickly via drainQueueFor
    await expect(httpPromise).resolves.toBe("https://rpc.example");
    // WS should be rejected at end of cycle since it never validated
    await wsAssertion;

    await rpc.destroy();
  }, 15_000);

  // ─── Concurrent refresh deduplication ─────────────────────────────

  test("concurrent refresh calls are deduplicated — only one validation cycle runs", async () => {
    const deps = makeDeps();
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, deps);
    await drainValidation();
    const countAfterInit = (deps.fetchFn as jest.Mock).mock.calls.length;

    // Call refresh twice before the first completes
    // The second call goes through initialize() which returns initPromise if set
    // But refresh() wraps it in `async`, so the promises are different objects.
    // What matters: only one set of fetch calls is made.
    const r1 = rpc.refresh();
    const r2 = rpc.refresh();

    await drainValidation();
    await r1;
    await r2;

    // Only one additional validation cycle (2 HTTP URLs)
    const countAfterRefresh = (deps.fetchFn as jest.Mock).mock.calls.length;
    expect(countAfterRefresh - countAfterInit).toBe(2);

    await rpc.destroy();
  });

  // ─── Destroy edge cases ───────────────────────────────────────────

  test("double destroy returns the same promise and only destroys agent once", async () => {
    const agent = { destroy: jest.fn() };
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps({ agent }));

    const d1 = rpc.destroy();
    const d2 = rpc.destroy();

    expect(d1).toBe(d2);

    await d1;
    expect(agent.destroy).toHaveBeenCalledTimes(1);
  });

  test("getRpc throws after destroy", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());
    await drainValidation();
    expect(rpc.getRpc("https")).toBeTruthy();

    await rpc.destroy();

    expect(() => rpc.getRpc("https")).toThrow("RPC instance destroyed");
  });

  test("refresh after destroy resolves without re-validating", async () => {
    const deps = makeDeps();
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, deps);
    await drainValidation();
    const callCount = (deps.fetchFn as jest.Mock).mock.calls.length;

    await rpc.destroy();

    await rpc.refresh();
    // No additional fetch calls
    expect((deps.fetchFn as jest.Mock).mock.calls.length).toBe(callCount);
  });

  // ─── API method edge cases ────────────────────────────────────────

  test("getAllRPCs is an alias for getAllCandidateRPCs", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(rpc.getAllRPCs("https")).toEqual(rpc.getAllCandidateRPCs("https"));
    expect(rpc.getAllRPCs("ws")).toEqual(rpc.getAllCandidateRPCs("ws"));

    rpc.destroy();
  });

  test("getValidRPCCount throws for invalid type", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(() => rpc.getValidRPCCount("ftp" as any)).toThrow('Invalid RPC type: "ftp"');

    rpc.destroy();
  });

  test("getAllValidRPCs throws for invalid type", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(() => rpc.getAllValidRPCs("ftp" as any)).toThrow('Invalid RPC type: "ftp"');

    rpc.destroy();
  });

  test("getAllCandidateRPCs throws for invalid type", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(() => rpc.getAllCandidateRPCs("ftp" as any)).toThrow('Invalid RPC type: "ftp"');

    rpc.destroy();
  });

  // ─── Logger integration ───────────────────────────────────────────

  test("custom logger receives info and debug calls during validation cycle", async () => {
    const customLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const rpc = new RPCBase({
      chainId: "0x1",
      enforceHttps: false,
      log: customLogger,
    }, makeDeps());

    await drainValidation();

    // Logger should have been called with validation-related messages
    expect(customLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Starting RPC validation cycle"),
    );
    expect(customLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("RPC validation cycle complete"),
    );
    expect(customLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Validating"),
    );

    await rpc.destroy();
  });
});
