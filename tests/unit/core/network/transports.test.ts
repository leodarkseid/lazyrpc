import { RpcTransport } from "../../../../src/core/network/transports";
import type { _InternalRpcConfig } from "../../../../src/core/config";
import type { EndpointHealthManager } from "../../../../src/core/health";
import type { Logger } from "../../../../src/core/logger";

const logger = (): jest.Mocked<Logger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  readyState = 1;
  send = jest.fn();
  close = jest.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

const makeConfig = (overrides: Partial<_InternalRpcConfig> = {}): _InternalRpcConfig => ({
  chainId: "0x1",
  ttl: 10,
  maxRetry: 3,
  logger: logger(),
  loadBalancing: "fastest",
  baseBackoffDelay: 100,
  maxBackoffDelay: 1_000,
  validationTimeout: 100,
  enforceHttps: false,
  timeToResetFailedURL: 1_000,
  fetchFn: jest.fn(),
  websocketClass: MockWebSocket as any,
  agent: undefined,
  ...overrides,
});

const makeHealth = (overrides: Partial<EndpointHealthManager> = {}) => ({
  shouldSkip: jest.fn(() => false),
  recordFailure: jest.fn(),
  ...overrides,
}) as unknown as jest.Mocked<EndpointHealthManager>;

describe("core/network/transports", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("httpCall", () => {
    test("sends an eth_blockNumber request and returns the JSON-RPC response", async () => {
      const fetchFn = jest.fn(async (_url: string, options: any) => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: JSON.parse(options.body).id,
          result: "0x10",
        }),
      }));
      const config = makeConfig({ fetchFn: fetchFn as any, agent: { dispatcher: true } });
      const health = makeHealth();
      const transport = new RpcTransport(config, new AbortController(), health, () => false);

      await expect(transport.httpCall("https://rpc.example", 42)).resolves.toEqual({
        jsonrpc: "2.0",
        id: 42,
        result: "0x10",
      });
      expect(fetchFn).toHaveBeenCalledWith("https://rpc.example", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        dispatcher: config.agent,
      }));
      expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 42,
      });
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test("rejects skipped URLs before fetching and records the failure", async () => {
      const health = makeHealth({ shouldSkip: jest.fn(() => true) as any });
      const fetchFn = jest.fn();
      const transport = new RpcTransport(makeConfig({ fetchFn: fetchFn as any }), new AbortController(), health, () => false);

      await expect(transport.httpCall("https://rpc.example", 1)).rejects.toThrow("is in backoff period");

      expect(fetchFn).not.toHaveBeenCalled();
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test.each([
      [{ ok: false, json: async () => ({}) }, "Invalid HTTP Response"],
      [{ ok: true, json: async () => null }, "JSON-RPC response is not an object"],
      [{ ok: true, json: async () => ({ jsonrpc: "1.0", id: 1, result: "0x1" }) }, "Invalid JSON-RPC version"],
      [{ ok: true, json: async () => ({ jsonrpc: "2.0", id: 2, result: "0x1" }) }, "JSON-RPC response ID mismatch"],
      [{ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "bad" } }) }, "JSON-RPC error: bad"],
      [{ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "123" }) }, "Invalid eth_blockNumber result"],
    ])("rejects invalid HTTP responses %#", async (response, message) => {
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({ fetchFn: jest.fn(async () => response) as any }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall("https://rpc.example", 1)).rejects.toThrow(message);
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("does not record HTTP failures after destruction", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({ fetchFn: jest.fn(async () => { throw new Error("network"); }) as any }),
        new AbortController(),
        health,
        () => true,
      );

      await expect(transport.httpCall("https://rpc.example", 1)).rejects.toThrow("network");
      expect(health.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe("wsCall", () => {
    test("sends an eth_blockNumber request and resolves a valid response", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall("wss://rpc.example", 7);
      const ws = MockWebSocket.instances[0];

      ws.onopen?.({});
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 7,
      }));
      ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0xabc" }) });

      await expect(promise).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: "0xabc" });
      expect(ws.close).toHaveBeenCalled();
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test("rejects invalid WebSocket messages and records failure", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall("wss://rpc.example", 7);
      const ws = MockWebSocket.instances[0];
      const assertion = expect(promise).rejects.toThrow("JSON-RPC response ID mismatch");

      ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 8, result: "0xabc" }) });

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
    });

    test("rejects WebSocket errors and unexpected closes", async () => {
      const firstHealth = makeHealth();
      const first = new RpcTransport(makeConfig(), new AbortController(), firstHealth, () => false);
      const firstPromise = first.wsCall("wss://rpc.example", 1);
      const firstAssertion = expect(firstPromise).rejects.toThrow("WebSocket connection failed");
      MockWebSocket.instances[0].onerror?.(new Error("boom"));

      await firstAssertion;
      expect(firstHealth.recordFailure).toHaveBeenCalledWith("wss://rpc.example");

      const secondHealth = makeHealth();
      const second = new RpcTransport(makeConfig(), new AbortController(), secondHealth, () => false);
      const secondPromise = second.wsCall("wss://close.example", 1);
      const secondAssertion = expect(secondPromise).rejects.toThrow("WebSocket closed unexpectedly");
      MockWebSocket.instances[1].onclose?.({ code: 1006 });

      await secondAssertion;
      expect(secondHealth.recordFailure).toHaveBeenCalledWith("wss://close.example");
    });

    test("times out unresolved WebSocket validations", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig({ validationTimeout: 50 }), new AbortController(), health, () => false);
      const promise = transport.wsCall("wss://rpc.example", 1);
      const assertion = expect(promise).rejects.toThrow("WebSocket timeout for wss://rpc.example");

      await jest.advanceTimersByTimeAsync(51);

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
      expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    });

    test("rejects invalid or skipped WebSocket URLs without opening a socket", async () => {
      const skippedHealth = makeHealth({ shouldSkip: jest.fn(() => true) as any });
      const skipped = new RpcTransport(makeConfig(), new AbortController(), skippedHealth, () => false);

      await expect(skipped.wsCall("wss://rpc.example", 1)).rejects.toThrow("is in backoff period");

      const invalid = new RpcTransport(makeConfig(), new AbortController(), makeHealth(), () => false);
      await expect(invalid.wsCall("", 1)).rejects.toThrow("Invalid WebSocket URL");
    });
  });
});
