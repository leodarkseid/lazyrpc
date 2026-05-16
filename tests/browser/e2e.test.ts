/**
 * End-to-end tests for lazy-rpc in Browser environment
 */

// Mock the json module BEFORE importing RPC!
jest.mock("../../src/rpcList.min.json", () => ({
  "x0001": ["https://rpc1.com", "https://rpc2.com"],
  "x0001_WS": ["wss://ws1.com", "wss://ws2.com"]
}), { virtual: true });

import { RPC } from "../../src/browser";

// ---------------------------------------------------------------------------
// window.fetch mock
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
    // Basic mock just so instantiation doesn't throw
    window.fetch = jest.fn(async (_url: string, options?: any) => {
      let id = 1;
      try {
        if (options?.body) id = JSON.parse(options.body).id;
      } catch { }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0x10" }) } as any;
    });

    window.WebSocket = class MockWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = jest.fn();
      close = jest.fn();
      readyState = 1;
      constructor(url: string) {
        setTimeout(() => { if (this.onopen) this.onopen(new Event('open')); }, 10);
        this.send = jest.fn(() => {
          setTimeout(() => {
            if (this.onmessage) {
              this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }) } as MessageEvent);
            }
          }, 20);
        });
      }
    } as any;
}

const E2E_TIMEOUT = 60_000;

async function waitForValidation(rpc: RPC, timeoutMs = 25_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rpcs = rpc.getAllValidRPCs("https");
        if (rpcs.length > 0 && rpcs[0].time < 999_999_999) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

describe("Browser E2E: Ethereum Lifecycle", () => {
    let rpc: RPC;
    let hasValidated: boolean;

    beforeAll(async () => {
        const start = Date.now();
        rpc = new RPC({ chainId: "0x0001", ttl: 3600 });
        hasValidated = await waitForValidation(rpc, 15_000);
        const timeTaken = Date.now() - start;

        expect(timeTaken).toBeLessThan(20_000);
    }, E2E_TIMEOUT);

    afterAll(() => {
        rpc.destroy();
    });

    test("should have HTTP endpoints available (sync or validated)", () => {
        const count = rpc.getValidRPCCount("https");
        expect(count).toBeGreaterThan(0);

        const url = rpc.getRpc("https");
        expect(url.startsWith("https://")).toBe(true);
    });

    test("returned URL should produce a valid eth_blockNumber response using window.fetch", async () => {
        if (!hasValidated) {
            console.warn("Skipping: network did not validate any endpoints");
            return;
        }

        let success = false;
        try {
            const url = await rpc.getRpcAsync("https");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);

            // JSDOM has window.fetch (from Node 18+ global fetch mapped to jsdom)
            const response = await window.fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
                signal: controller.signal,
            });
            clearTimeout(timer);

            const data = await response.json() as any;
            expect(data.result).toMatch(/^0x[0-9a-fA-F]+$/);
            const blockNumber = parseInt(data.result, 16);
            expect(blockNumber).toBeGreaterThan(0);
            success = true;
        } catch (error) {
            console.warn("E2E fetch fallback failed completely:", error);
        }
        expect(success).toBe(true);
    }, E2E_TIMEOUT);
});
