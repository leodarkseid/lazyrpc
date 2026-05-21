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
  static activeInstances: Set<MockWebSocket> = new Set();

  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  readyState = 1;
  send = jest.fn();
  close = jest.fn(function(this: MockWebSocket) {
    MockWebSocket.activeInstances.delete(this);
  });

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    MockWebSocket.activeInstances.add(this);
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
  maxPayloadBytes: 1024 * 1024,
  maxPayloadDepth: 32,
  maxPayloadKeys: 1_000,
  maxPayloadArrayLength: 1_000,
  maxPayloadStringBytes: 256 * 1024,
  requireJsonContentType: true,
  errorPrefix: "LazyRpc",
  ...overrides,
});

const jsonResponse = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(payload),
  ...overrides,
});

const jsonTextResponse = (text: string, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => text,
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
    MockWebSocket.activeInstances = new Set();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("httpCall", () => {
    test("sends an eth_blockNumber request and returns the JSON-RPC response", async () => {
      const fetchFn = jest.fn(async (_url: string, options: any) => ({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(options.body).id,
          result: "0x10",
        }),
      }));
      const config = makeConfig({ fetchFn: fetchFn as any, agent: { dispatcher: true } });
      const health = makeHealth();
      const transport = new RpcTransport(config, new AbortController(), health, () => false);

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 42)).resolves.toEqual({
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

    test("rejects skipped URLs before fetching without recording an additional failure", async () => {
      const health = makeHealth({ shouldSkip: jest.fn(() => true) as any });
      const fetchFn = jest.fn();
      const transport = new RpcTransport(makeConfig({ fetchFn: fetchFn as any }), new AbortController(), health, () => false);

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("is in backoff period");

      expect(fetchFn).not.toHaveBeenCalled();
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test.each([
      [{ ok: false, headers: new Headers(), text: async () => "{}" }, "Invalid HTTP response"],
      [jsonResponse(null), "JSON-RPC response is not an object"],
      [jsonResponse([]), "JSON-RPC response is not an object"],
      [jsonTextResponse("true"), "JSON-RPC response is not an object"],
      [jsonTextResponse("123"), "JSON-RPC response is not an object"],
      [jsonResponse({ jsonrpc: "1.0", id: 1, result: "0x1" }), "Invalid JSON-RPC version"],
      [jsonResponse({ jsonrpc: "2.0", id: 2, result: "0x1" }), "JSON-RPC response ID mismatch"],
      [jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "bad" } }), "JSON-RPC error: bad"],
      [jsonResponse({ jsonrpc: "2.0", id: 1, result: "123" }), "Invalid eth_blockNumber result"],
    ])("rejects invalid HTTP responses %#", async (response, message) => {
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({ fetchFn: jest.fn(async () => response) as any }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow(message);
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("accepts HTTP payloads that are exactly at the configured byte limit", async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" });
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          maxPayloadBytes: body.length,
          fetchFn: jest.fn(async () => jsonTextResponse(body)) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "0xabc",
      });
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test("rejects HTTP content-length overflow before reading the body", async () => {
      const text = jest.fn(async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" }));
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          maxPayloadBytes: 10,
          fetchFn: jest.fn(async () => ({
            ok: true,
            headers: new Headers({
              "content-type": "application/json",
              "content-length": "100",
            }),
            text,
          })) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("maximum size");
      expect(text).not.toHaveBeenCalled();
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("rejects HTTP stream overflow during transport validation", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"jsonrpc\":\"2.0\","));
          controller.enqueue(new TextEncoder().encode("\"id\":1,\"result\":\"0xabc\"}"));
          controller.close();
        },
      });
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          maxPayloadBytes: 20,
          fetchFn: jest.fn(async () => new Response(stream, {
            headers: { "content-type": "application/json" },
          })) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("maximum size");
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("rejects JSON-RPC-like HTTP payloads with oversized extra fields", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          maxPayloadStringBytes: 8,
          fetchFn: jest.fn(async () => jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: "0xabc",
            ignoredButHuge: "x".repeat(9),
          })) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("JSON string exceeds");
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

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("network");
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test("rejects HTTP payloads that exceed the configured byte limit", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          maxPayloadBytes: 32,
          fetchFn: jest.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xabc" })) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("maximum size");
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("rejects HTTP responses with a non-JSON content type", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          fetchFn: jest.fn(async () => jsonResponse(
            { jsonrpc: "2.0", id: 1, result: "0xabc" },
            { headers: new Headers({ "content-type": "text/plain" }) },
          )) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("Invalid JSON content type");
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("logs detailed HTTP validation failures", async () => {
      const log = logger();
      const health = makeHealth();
      const transport = new RpcTransport(
        makeConfig({
          logger: log,
          fetchFn: jest.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 2, result: "0xabc" })) as any,
        }),
        new AbortController(),
        health,
        () => false,
      );

      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("JSON-RPC response ID mismatch");
      expect(log.error).toHaveBeenCalledWith(
        "[LazyRpc: 'Transport'] HTTP RPC validation failed for https://rpc.example:",
        expect.any(Error),
      );
    });
  });

  describe("wsCall", () => {
    test("sends an eth_blockNumber request and resolves a valid response", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
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
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
      const ws = MockWebSocket.instances[0];
      const assertion = expect(promise).rejects.toThrow("JSON-RPC response ID mismatch");

      ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 8, result: "0xabc" }) });

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
    });

    test("rejects oversized WebSocket messages before JSON-RPC validation", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig({ maxPayloadBytes: 24 }), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
      const ws = MockWebSocket.instances[0];
      const assertion = expect(promise).rejects.toThrow("maximum size");

      ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0xabc" }) });

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
    });

    test("accepts WebSocket binary messages from ArrayBuffer and Buffer", async () => {
      const firstHealth = makeHealth();
      const first = new RpcTransport(makeConfig(), new AbortController(), firstHealth, () => false);
      const firstPromise = first.wsCall({ url: "wss://array-buffer.example", originalFormat: "string" as const }, 7);
      const firstWs = MockWebSocket.instances[0];
      const firstBody = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0xabc" }));
      firstWs.onmessage?.({ data: firstBody.buffer });
      await expect(firstPromise).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: "0xabc" });

      const secondHealth = makeHealth();
      const second = new RpcTransport(makeConfig(), new AbortController(), secondHealth, () => false);
      const secondPromise = second.wsCall({ url: "wss://buffer.example", originalFormat: "string" as const }, 8);
      const secondWs = MockWebSocket.instances[1];
      secondWs.onmessage?.({ data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 8, result: "0xdef" })) });
      await expect(secondPromise).resolves.toEqual({ jsonrpc: "2.0", id: 8, result: "0xdef" });
    });

    test("rejects malformed UTF-8 WebSocket binary messages", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
      const ws = MockWebSocket.instances[0];
      const assertion = expect(promise).rejects.toThrow();

      ws.onmessage?.({ data: new Uint8Array([0xff]) });

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
    });

    test("rejects WebSocket JSON with forbidden prototype-pollution keys", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
      const ws = MockWebSocket.instances[0];
      const assertion = expect(promise).rejects.toThrow("forbidden key");

      ws.onmessage?.({ data: "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"0xabc\",\"__proto__\":{}}" });

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
    });

    test("rejects WebSocket errors and unexpected closes", async () => {
      const firstHealth = makeHealth();
      const first = new RpcTransport(makeConfig(), new AbortController(), firstHealth, () => false);
      const firstPromise = first.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 1);
      const firstAssertion = expect(firstPromise).rejects.toThrow("WebSocket connection failed");
      MockWebSocket.instances[0].onerror?.(new Error("boom"));

      await firstAssertion;
      expect(firstHealth.recordFailure).toHaveBeenCalledWith("wss://rpc.example");

      const secondHealth = makeHealth();
      const second = new RpcTransport(makeConfig(), new AbortController(), secondHealth, () => false);
      const secondPromise = second.wsCall({ url: "wss://close.example", originalFormat: "string" as const }, 1);
      const secondAssertion = expect(secondPromise).rejects.toThrow("WebSocket closed unexpectedly");
      MockWebSocket.instances[1].onclose?.({ code: 1006 });

      await secondAssertion;
      expect(secondHealth.recordFailure).toHaveBeenCalledWith("wss://close.example");
    });

    test("times out unresolved WebSocket validations", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig({ validationTimeout: 50 }), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 1);
      const assertion = expect(promise).rejects.toThrow("WebSocket timeout for wss://rpc.example");

      await jest.advanceTimersByTimeAsync(51);

      await assertion;
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
      expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    });

    test("rejects invalid or skipped WebSocket URLs without opening a socket", async () => {
      const skippedHealth = makeHealth({ shouldSkip: jest.fn(() => true) as any });
      const skipped = new RpcTransport(makeConfig(), new AbortController(), skippedHealth, () => false);

      await expect(skipped.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("is in backoff period");

      const invalid = new RpcTransport(makeConfig(), new AbortController(), makeHealth(), () => false);
      await expect(invalid.wsCall({ url: "", originalFormat: "string" as const }, 1)).rejects.toThrow("Invalid WebSocket URL");
    });

    test("wsCall normal close (code 1000) after resolution does not trigger rejection", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
      const ws = MockWebSocket.instances[0];

      ws.onopen?.({});
      ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0xabc" }) });

      await expect(promise).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: "0xabc" });

      // Simulate normal close after resolution — should not reject
      ws.onclose?.({ code: 1000 });
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test("wsCall is rejected when parent AbortController aborts mid-connection", async () => {
      const health = makeHealth();
      const ac = new AbortController();
      const transport = new RpcTransport(makeConfig(), ac, health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 1);
      const assertion = expect(promise).rejects.toThrow("RPC instance destroyed");

      // Abort before any messages arrive
      ac.abort();

      await assertion;
      expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    });

    test("rejects immediately when aborted before instantiation without allocating connection", async () => {
      const health = makeHealth();
      const ac = new AbortController();
      ac.abort(); // Abort beforehand
      
      const beforeCount = MockWebSocket.instances.length;
      const transport = new RpcTransport(makeConfig(), ac, health, () => false);
      
      await expect(transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("RPC instance destroyed");
      
      // Ensure it never called `new WebSocket()`
      expect(MockWebSocket.instances.length).toBe(beforeCount);
    });

    test("wsCall normal close (code 1000) BEFORE resolution rejects and records failure", async () => {
      const health = makeHealth();
      const transport = new RpcTransport(makeConfig(), new AbortController(), health, () => false);
      const promise = transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, 7);
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];

      // Simulate a clean close from the server *before* it replies to our RPC request
      ws.onclose?.({ code: 1000 });
      
      await expect(promise).rejects.toThrow("WebSocket closed normally before resolving wss://rpc.example");
      expect(health.recordFailure).toHaveBeenCalledWith("wss://rpc.example");
    });
  });

  describe("httpCall — additional edge cases", () => {
    test("rejects empty HTTP URL without recording a failure", async () => {
      const health = makeHealth();
      const fetchFn = jest.fn();
      const transport = new RpcTransport(makeConfig({ fetchFn: fetchFn as any }), new AbortController(), health, () => false);

      await expect(transport.httpCall({ url: "", originalFormat: "string" as const }, 1)).rejects.toThrow("Invalid HTTP URL");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    test("httpCall is rejected when parent AbortController aborts mid-request", async () => {
      const ac = new AbortController();
      const health = makeHealth();
      // fetchFn that hangs until abort
      const fetchFn = jest.fn((_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
      );
      const transport = new RpcTransport(makeConfig({ fetchFn: fetchFn as any }), ac, health, () => false);
      const promise = transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1);

      ac.abort();

      await expect(promise).rejects.toThrow("aborted");
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
    });

    test("times out unresolved HTTP validations", async () => {
      jest.useFakeTimers();
      const health = makeHealth();
      const ac = new AbortController();
      // fetchFn that hangs indefinitely
      const fetchFn = jest.fn((_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("Timeout aborted")));
        }),
      );
      const transport = new RpcTransport(makeConfig({ fetchFn: fetchFn as any, validationTimeout: 5000 }), ac, health, () => false);
      const promise = transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1);

      // Advance timers by the exact timeout duration
      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow("Timeout aborted");
      expect(health.recordFailure).toHaveBeenCalledWith("https://rpc.example");
      jest.useRealTimers();
    });

    test("rejects immediately when aborted before instantiation without allocating timers or calling fetchFn", async () => {
      const ac = new AbortController();
      const health = makeHealth();
      const fetchFn = jest.fn();
      
      ac.abort(); // Abort beforehand
      
      const transport = new RpcTransport(makeConfig({ fetchFn: fetchFn as any }), ac, health, () => false);
      await expect(transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, 1)).rejects.toThrow("RPC instance destroyed");
      
      expect(fetchFn).not.toHaveBeenCalled();
      expect(health.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe("Mathematical Memory Isolation Proof", () => {
    test("Guarantees reference count drops to zero post-destroy", async () => {
      const ac = new AbortController();
      let listenerCount = 0;

      // Spy on the signal's event listeners to track allocations accurately
      const originalAdd = ac.signal.addEventListener.bind(ac.signal);
      const originalRemove = ac.signal.removeEventListener.bind(ac.signal);

      jest.spyOn(ac.signal, "addEventListener").mockImplementation((type: any, listener: any, options: any) => {
        if (type === "abort") listenerCount++;
        return originalAdd(type, listener, options);
      });

      jest.spyOn(ac.signal, "removeEventListener").mockImplementation((type: any, listener: any, options: any) => {
        if (type === "abort") listenerCount--;
        return originalRemove(type, listener, options);
      });

      const config = makeConfig({ websocketClass: MockWebSocket as any, validationTimeout: 5000 });
      const health = makeHealth();
      const transport = new RpcTransport(config, ac, health, () => false);

      // 1. Fire off multiple concurrent requests to simulate hot allocations
      const requests = Array.from({ length: 50 }, (_, i) => 
        transport.wsCall({ url: "wss://rpc.example", originalFormat: "string" as const }, i).catch(() => { /* sink errors */ })
      );

      // 2. Validate instances and listeners were allocated
      expect(MockWebSocket.activeInstances.size).toBe(50);
      expect(listenerCount).toBe(50);

      // 3. Mid-flight, simulate an immediate system crash / instance destruction
      ac.abort();
      await Promise.all(requests);

      // 4. STATICAL PROOF A: Explicit Handle Count Verification
      // Every single socket must be explicitly removed from the registry tree
      expect(MockWebSocket.activeInstances.size).toBe(0);

      // 5. STATICAL PROOF B: Event Listener Leak Check
      // If listeners are still attached to the AbortSignal, the listener count will be > 0
      expect(listenerCount).toBe(0);
    });

    test("Guarantees HTTP active requests and listeners drop to zero post-destroy", async () => {
      const ac = new AbortController();
      let listenerCount = 0;
      let activeFetches = 0;

      const originalAdd = ac.signal.addEventListener.bind(ac.signal);
      const originalRemove = ac.signal.removeEventListener.bind(ac.signal);

      jest.spyOn(ac.signal, "addEventListener").mockImplementation((type: any, listener: any, options: any) => {
        if (type === "abort") listenerCount++;
        return originalAdd(type, listener, options);
      });

      jest.spyOn(ac.signal, "removeEventListener").mockImplementation((type: any, listener: any, options: any) => {
        if (type === "abort") listenerCount--;
        return originalRemove(type, listener, options);
      });

      // Simulate an HTTP fetcher that correctly respects AbortSignal and cleans up its own listeners natively
      const mockFetch = jest.fn((_url: string, options: any) => {
        activeFetches++;
        return new Promise((_resolve, reject) => {
          if (!options.signal) return;
          
          const onAbort = () => {
            activeFetches--;
            options.signal.removeEventListener("abort", onAbort);
            reject(new Error("RPC instance destroyed"));
          };
          
          options.signal.addEventListener("abort", onAbort, { once: true });
        });
      });

      const config = makeConfig({ fetchFn: mockFetch as any, validationTimeout: 5000 });
      const health = makeHealth();
      const transport = new RpcTransport(config, ac, health, () => false);

      // 1. Fire off multiple concurrent HTTP requests to simulate hot allocations
      const requests = Array.from({ length: 50 }, (_, i) => 
        transport.httpCall({ url: "https://rpc.example", originalFormat: "string" as const }, i).catch(() => { /* sink errors */ })
      );

      // 2. Validate instances and listeners were allocated
      expect(activeFetches).toBe(50);
      expect(listenerCount).toBe(50);

      // 3. Mid-flight, simulate an immediate system crash / instance destruction
      ac.abort();
      await Promise.all(requests);

      // 4. STATICAL PROOF A: Explicit Fetch Tracker Count Verification
      expect(activeFetches).toBe(0);

      // 5. STATICAL PROOF B: Event Listener Leak Check
      expect(listenerCount).toBe(0);
    });
  });
});
