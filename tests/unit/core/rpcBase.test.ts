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
    json: async () => ({
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

  test("populates sentinel endpoints synchronously and reports initializing status", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(rpc.status()).toBe("initializing");
    expect(rpc.getValidRPCCount("https")).toBe(2);
    expect(rpc.getValidRPCCount("ws")).toBe(2);
    expect(rpc.getAllValidRPCs("https")).toEqual([
      { url: "https://rpc-1.example", time: 999_999_999 },
      { url: "https://rpc-2.example", time: 999_999_999 },
    ]);

    void rpc.destroy();
  });

  test("getRpc validates the requested type and returns selectable URLs", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

    expect(rpc.getRpc("https")).toBe("https://rpc-1.example");
    expect(rpc.getRpc("ws")).toBe("wss://ws-1.example");
    expect(() => rpc.getRpc("ftp" as any)).toThrow('Invalid RPC type: "ftp"');

    void rpc.destroy();
  });

  test("round-robin selection is independent for HTTP and WebSocket pools", () => {
    const rpc = new RPCBase({
      chainId: "0x1",
      enforceHttps: false,
      loadBalancing: "round-robin",
    }, makeDeps());

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

  test("drop, clearFailedURLs, and getFailureStats delegate to health tracking", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false }, makeDeps());

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

  test("throws when all endpoints of a type are failing", () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false, maxRetry: 1 }, makeDeps());

    rpc.drop("https://rpc-1.example");
    rpc.drop("https://rpc-2.example");

    expect(() => rpc.getRpc("https")).toThrow("All https URLs are currently failing or in backoff");

    rpc.destroy();
  });

  test("validation refresh replaces sentinel endpoints with measured endpoints", async () => {
    const rpc = new RPCBase({ chainId: "0x1", enforceHttps: false, ttl: 60 }, makeDeps());

    await drainValidation();

    expect(rpc.status()).toBe("ready");
    expect(rpc.getAllValidRPCs("https").every((endpoint) => endpoint.time < 999_999_999)).toBe(true);
    expect(rpc.getAllValidRPCs("ws").every((endpoint) => endpoint.time < 999_999_999)).toBe(true);

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

    await expect(rpc.getRpcAsync("ws")).rejects.toThrow("No ws URLs available to validate");

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
});
