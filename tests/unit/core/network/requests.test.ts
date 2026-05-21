import { executeHttpRpcCall, executeWsRpcCall } from "../../../../src/core/network/requests.js";
import { LazyRpcError } from "../../../../src/core/error.js";

const mockSafeJsonOptions = {
  maxBytes: 2000,
  maxDepth: 10,
  maxKeys: 1000,
  maxArrayLength: 1000,
  maxStringBytes: 1000,
  requireJsonContentType: true,
  errorPrefix: "LazyRpc",
};

describe("Stateless Transport Requests", () => {
  describe("executeHttpRpcCall", () => {
    test("works with standard fetch", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x42" }),
      });

      const result = await executeHttpRpcCall({
        endpoint: { url: "https://rpc.example.com", originalFormat: "string" as const },
        id: 1,
        fetchFn: mockFetch as any,
        safeJsonOptions: mockSafeJsonOptions,
      });

      expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: "0x42" });
      expect(mockFetch).toHaveBeenCalledWith("https://rpc.example.com", expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }));
    });

    test("resolves function-based dynamic query and headers natively", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x42" }),
      });

      const dynamicQuery = jest.fn().mockResolvedValue({ foo: "bar", token: "xyz" });
      const dynamicHeaders = jest.fn().mockResolvedValue({ "X-Custom-Auth": "secret123" });

      await executeHttpRpcCall({
        endpoint: { 
          url: "https://rpc.example.com", 
          originalFormat: "object" as const,
          query: dynamicQuery,
          headers: dynamicHeaders
        },
        id: 1,
        fetchFn: mockFetch as any,
        safeJsonOptions: mockSafeJsonOptions,
      });

      expect(dynamicQuery).toHaveBeenCalled();
      expect(dynamicHeaders).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith("https://rpc.example.com/?foo=bar&token=xyz", expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Custom-Auth": "secret123"
        })
      }));
    });

    test("works with Axios-like custom wrapper function", async () => {
      // Simulate an axios-based fetch adapter
      const fakeAxios = {
        post: jest.fn().mockResolvedValue({
          status: 200,
          headers: { "content-type": "application/json" },
          data: { jsonrpc: "2.0", id: 2, result: "0xcafe" }
        })
      };

      const axiosAdapter = async (url: string, init?: RequestInit) => {
        // Adapt standard fetch options to axios
        const response = await fakeAxios.post(url, init?.body ? JSON.parse(init.body as string) : undefined, {
          headers: init?.headers as any,
          signal: init?.signal as any,
        });

        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          headers: new Headers(response.headers as any),
          text: async () => JSON.stringify(response.data)
        };
      };

      const result = await executeHttpRpcCall({
        endpoint: { url: "https://axios.example.com", originalFormat: "string" as const },
        id: 2,
        fetchFn: axiosAdapter as any,
        safeJsonOptions: mockSafeJsonOptions,
      });

      expect(result).toEqual({ jsonrpc: "2.0", id: 2, result: "0xcafe" });
      expect(fakeAxios.post).toHaveBeenCalled();
    });

    test("works with Undici agent passed via options", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 3, result: "0xabc" }),
      });

      const fakeDispatcher = { isUndiciDispatcher: true };

      await executeHttpRpcCall({
        endpoint: { url: "https://undici.example.com", originalFormat: "string" as const },
        id: 3,
        fetchFn: mockFetch as any,
        agent: fakeDispatcher,
        safeJsonOptions: mockSafeJsonOptions,
      });

      expect(mockFetch).toHaveBeenCalledWith("https://undici.example.com", expect.objectContaining({
        dispatcher: fakeDispatcher
      }));
    });

    test("validates JSON-RPC response strictly", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: 123 }), // Invalid result type
      });

      await expect(executeHttpRpcCall({
        endpoint: { url: "https://rpc.example.com", originalFormat: "string" as const },
        id: 1,
        fetchFn: mockFetch as any,
        safeJsonOptions: mockSafeJsonOptions,
      })).rejects.toThrow("Invalid eth_blockNumber result");
    });
  });

  describe("executeWsRpcCall", () => {
    test("handles normal WebSocket lifecycle and resolves", async () => {
      class MockWS {
        onopen: any; onmessage: any; onerror: any; onclose: any;
        send = jest.fn();
        close = jest.fn();
        readyState = 1;
        constructor(public url: string) {
          setTimeout(() => {
            if (this.onopen) this.onopen();
          }, 10);
          this.send.mockImplementation(() => {
            setTimeout(() => {
              if (this.onmessage) {
                this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x42" }) });
              }
            }, 10);
          });
        }
      }

      const result = await executeWsRpcCall({
        endpoint: { url: "wss://ws.example.com", originalFormat: "string" as const },
        id: 1,
        websocketClass: MockWS as any,
        timeoutMs: 1000,
        safeJsonOptions: mockSafeJsonOptions,
      });

      expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: "0x42" });
    });

    test("resolves function-based dynamic query and headers natively", async () => {
      const capturedArgs: any[] = [];
      class MockWS {
        onopen: any; onmessage: any; onerror: any; onclose: any;
        send = jest.fn();
        close = jest.fn();
        readyState = 1;
        constructor(url: string, protocols: any, options: any) {
          capturedArgs.push({ url, protocols, options });
          setTimeout(() => {
            if (this.onopen) this.onopen();
          }, 10);
          this.send.mockImplementation(() => {
            setTimeout(() => {
              if (this.onmessage) {
                this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x42" }) });
              }
            }, 10);
          });
        }
      }

      const dynamicQuery = jest.fn().mockResolvedValue({ wss_token: "abc" });
      const dynamicHeaders = jest.fn().mockResolvedValue({ "Authorization": "Bearer wss" });

      await executeWsRpcCall({
        endpoint: { 
          url: "wss://ws.example.com", 
          originalFormat: "object" as const,
          query: dynamicQuery,
          headers: dynamicHeaders
        },
        id: 1,
        websocketClass: MockWS as any,
        timeoutMs: 1000,
        safeJsonOptions: mockSafeJsonOptions,
      });

      expect(dynamicQuery).toHaveBeenCalled();
      expect(dynamicHeaders).toHaveBeenCalled();
      
      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0].url).toBe("wss://ws.example.com/?wss_token=abc");
      expect(capturedArgs[0].options).toEqual({ headers: { "Authorization": "Bearer wss" } });
    });

    test("rejects gracefully on connection error", async () => {
      class MockWS {
        onopen: any; onmessage: any; onerror: any; onclose: any;
        send = jest.fn(); close = jest.fn();
        constructor(public url: string) {
          setTimeout(() => {
            if (this.onerror) this.onerror(new Error("Connection refused"));
          }, 10);
        }
      }

      await expect(executeWsRpcCall({
        endpoint: { url: "wss://error.example.com", originalFormat: "string" as const },
        id: 1,
        websocketClass: MockWS as any,
        timeoutMs: 1000,
        safeJsonOptions: mockSafeJsonOptions,
      })).rejects.toThrow("WebSocket connection failed");
    });

    test("rejects gracefully on timeout", async () => {
      jest.useFakeTimers();
      class HangingWS {
        onopen: any; onmessage: any; onerror: any; onclose: any;
        send = jest.fn(); close = jest.fn();
        constructor(public url: string) { }
      }

      const promise = executeWsRpcCall({
        endpoint: { url: "wss://hanging.example.com", originalFormat: "string" as const },
        id: 1,
        websocketClass: HangingWS as any,
        timeoutMs: 5000,
        safeJsonOptions: mockSafeJsonOptions,
      });

      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow("WebSocket timeout");
      jest.useRealTimers();
    });

    test("cleans up AbortSignal listeners to prevent memory leaks", async () => {
      const ac = new AbortController();
      let listenerCount = 0;

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

      class MockWS {
        onopen: any; onmessage: any; onerror: any; onclose: any;
        send = jest.fn(); close = jest.fn();
        constructor(public url: string) { }
      }

      const promise = executeWsRpcCall({
        endpoint: { url: "wss://leak.example.com", originalFormat: "string" as const },
        id: 1,
        websocketClass: MockWS as any,
        timeoutMs: 5000,
        signal: ac.signal,
        safeJsonOptions: mockSafeJsonOptions,
      });

      // Listeners should be attached while the request is hanging
      expect(listenerCount).toBeGreaterThan(0);

      // Abort gracefully
      ac.abort();

      await expect(promise).rejects.toThrow(); // The rejection will be handled by the abort branch

      // Verify the event listener was explicitly detached, freeing the memory reference
      expect(listenerCount).toBe(0);
    });
  });
});
