/**
 * @jest-environment jsdom
 */

jest.mock("../../src/rpcList.min.json", () => ({
  x0001: ["https://rpc.example"],
  x0001_WS: ["wss://ws.example"],
}), { virtual: true });

import type { RPC as BrowserRPC } from "../../src/browser";

class MockWebSocket {
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  readyState = 1;
  close = jest.fn();

  constructor(public url: string) {
    setTimeout(() => this.onopen?.({}), 1);
  }

  send = jest.fn((payload: string) => {
    const id = JSON.parse(payload).id;
    setTimeout(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }),
      });
    }, 1);
  });
}

describe("browser", () => {
  let RPC: typeof BrowserRPC;

  const fetchMock = jest.fn(async (_url: string, options: any) => ({
    ok: true,
    json: async () => ({
      jsonrpc: "2.0",
      id: JSON.parse(options.body).id,
      result: "0x1",
    }),
  }));

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    window.fetch = fetchMock as any;
    window.WebSocket = MockWebSocket as any;
    RPC = require("../../src/browser").RPC;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test("constructs RPCBase with browser fetch, WebSocket, and bundled chain list", () => {
    const rpc = new RPC({ chainId: "0x1" });

    expect(rpc.getRpc("https")).toBe("https://rpc.example");
    expect(rpc.getRpc("ws")).toBe("wss://ws.example");

    rpc.destroy();
  });

  test("throws when fetch is missing from the browser environment", () => {
    const originalFetch = window.fetch;
    (window as any).fetch = undefined;

    expect(() => new RPC({ chainId: "0x1" })).toThrow("Browser environment not detected");

    window.fetch = originalFetch;
  });

  test("throws when WebSocket is missing from the browser environment", () => {
    const originalWebSocket = window.WebSocket;
    (window as any).WebSocket = undefined;

    expect(() => new RPC({ chainId: "0x1" })).toThrow("Browser environment not detected");

    window.WebSocket = originalWebSocket;
  });
});
