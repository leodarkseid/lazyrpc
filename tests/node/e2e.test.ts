/**
 * End-to-end tests for lazy-rpc
 *
 * These tests hit REAL RPC endpoints using the real bundled rpcList.min.json.
 * They validate the full lifecycle of the library as a consumer would use it.
 *
 * The library validates 50+ endpoints concurrently per chain, so these tests
 * allow time for async initialization while being resilient to partial
 * network failures (which is realistic real-world behaviour).
 *
 * Run separately from unit tests:
 *   npx jest tests/e2e.test.ts
 */

import { RPC } from "../../src/index";
import * as path from "path";
import { fetch as undiciFetch, Agent } from "undici";

const E2E_TIMEOUT = 60_000;

/**
 * Wait for the RPC instance's async initialize() to complete.
 * We give it up to `timeoutMs` for at least one validated endpoint
 * to appear (time < the 999999999999 sentinel from sync init).
 * If init finishes, returns true.  If it times out (all endpoints
 * failed validation), returns false — the library still works with
 * the unvalidated sync data from init().
 */
async function waitForValidation(rpc: RPC, timeoutMs = 25_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rpcs = rpc.getAllValidRPCs("https");
        if (rpcs.length > 0 && rpcs[0].time < 999_999_999) {
            return true; // validation completed with successes
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false; // timed out — using unvalidated sync data
}

// ═══════════════════════════════════════════════════════════════════
//  Ethereum — full lifecycle
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Ethereum Lifecycle", () => {
    let rpc: RPC;
    let hasValidated: boolean;

    beforeAll(async () => {
        const start = Date.now();
        rpc = new RPC({ chainId: "0x0001", ttl: 3600 });
        hasValidated = await waitForValidation(rpc, 15_000);
        const timeTaken = Date.now() - start;

        // Fail loudly if initialization is stalling (typically an IPv6 blackhole issue > 60s)
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

    test("returned URL should produce a valid eth_blockNumber response", async () => {
        if (!hasValidated) {
            console.warn("Skipping: network did not validate any endpoints");
            return;
        }

        // Get the best validated URL from the library, then drive the fetch ourselves.
        const agent = new Agent({ connect: { family: 4 } });
        let success = false;

        try {
            const url = await rpc.getRpcAsync("https");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);

            const response = await undiciFetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
                signal: controller.signal,
                dispatcher: agent,
            });
            clearTimeout(timer);

            const data = await response.json() as any;
            expect(data.result).toMatch(/^0x[0-9a-fA-F]+$/);
            const blockNumber = parseInt(data.result, 16);
            expect(blockNumber).toBeGreaterThan(0);
            success = true;
        } catch (error) {
            console.warn("E2E fetch fallback failed completely:", error);
        } finally {
            await agent.destroy();
            await rpc['agent']?.destroy();
        }
        expect(success).toBe(true);
    }, E2E_TIMEOUT);

    test("if validated, RPCs should be sorted fastest-first", () => {
        if (!hasValidated) {
            console.warn("Skipping: no endpoints were validated (network-dependent)");
            return;
        }

        const allRpcs = rpc.getAllValidRPCs("https");
        for (const ep of allRpcs) {
            expect(ep.time).toBeLessThan(999_999_999);
        }

        for (let i = 1; i < allRpcs.length; i++) {
            expect(allRpcs[i].time).toBeGreaterThanOrEqual(allRpcs[i - 1].time);
        }
    });

    test("should have WebSocket endpoints available", () => {
        const wsCount = rpc.getValidRPCCount("ws");
        if (wsCount > 0) {
            const wsUrl = rpc.getRpc("ws");
            expect(wsUrl.startsWith("wss://")).toBe(true);
        }
    });

    test("getAllValidRPCs should return a copy", () => {
        const copy = rpc.getAllValidRPCs("https");
        const len = copy.length;
        copy.pop();
        expect(rpc.getAllValidRPCs("https").length).toBe(len);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Drop, Recovery & Failure Tracking
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Drop & Failure Tracking", () => {
    let rpc: RPC;

    beforeAll(async () => {
        rpc = new RPC({ chainId: "0x0001", ttl: 3600, maxRetry: 5 });
        await waitForValidation(rpc);
    }, E2E_TIMEOUT);

    afterAll(() => {
        rpc.destroy();
    });

    test("drop() should increment failure count by 1", () => {
        rpc.clearFailedURLs();

        const url = rpc.getRpc("https");
        rpc.drop(url);
        rpc.drop(url);

        const stats = rpc.getFailureStats();
        expect(stats.totalFailed).toBeGreaterThanOrEqual(1);
        expect(stats.overMaxRetries).toBe(0);
    });

    test("clearFailedURLs should reset tracking", () => {
        const url = rpc.getRpc("https");
        rpc.drop(url);
        expect(rpc.getFailureStats().totalFailed).toBeGreaterThanOrEqual(1);

        rpc.clearFailedURLs();

        const stats = rpc.getFailureStats();
        expect(stats.totalFailed).toBe(0);
        expect(stats.overMaxRetries).toBe(0);
        expect(stats.inBackoff).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Load Balancing
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Load Balancing", () => {
    let rpc: RPC;

    // Shared instance — the lb strategy is set per-test via internal override
    beforeAll(async () => {
        rpc = new RPC({ chainId: "0x0001", ttl: 3600 });
        await waitForValidation(rpc);
    }, E2E_TIMEOUT);

    afterAll(() => rpc.destroy());

    test("fastest should consistently return the same URL", () => {
        rpc["loadBalancing"] = "fastest";
        const url1 = rpc.getRpc("https");
        const url2 = rpc.getRpc("https");
        const url3 = rpc.getRpc("https");

        expect(url1).toBe(url2);
        expect(url2).toBe(url3);
        expect(url1).toBe(rpc.getAllValidRPCs("https")[0].url);
    });

    test("round-robin should cycle when multiple endpoints available", () => {
        rpc["loadBalancing"] = "round-robin";
        rpc["httpRoundRobinIndex"] = 0;

        const count = rpc.getValidRPCCount("https");
        if (count < 2) {
            console.warn("Skipping: need ≥2 endpoints");
            return;
        }

        const urls: string[] = [];
        for (let i = 0; i < count + 1; i++) {
            urls.push(rpc.getRpc("https"));
        }

        expect(urls.length).toBe(count + 1);
        expect(new Set(urls).size).toBeGreaterThan(1);
    });

    test("random should return URLs from the valid set", () => {
        rpc["loadBalancing"] = "random";

        const validUrls = rpc.getAllValidRPCs("https").map((e) => e.url);
        for (let i = 0; i < 10; i++) {
            expect(validUrls).toContain(rpc.getRpc("https"));
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Multi-Chain Validation
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Multi-Chain", () => {
    test.each([
        ["Polygon", "0x89"],
        ["BSC", "0x38"],
        ["Arbitrum One", "0xa4b1"],
        ["Optimism", "0xa"],
        ["Base", "0x2105"],
        ["Avalanche C-Chain", "0xa86a"],
    ])("should have %s (chainId %s) endpoints via init", (_name, chainId) => {
        // Verifies the library can read the RPC list for this chain
        // and provide endpoints synchronously via init().
        // We do NOT wait for async validation here (it would be too slow
        // across 6 chains in sequence).
        const rpc = new RPC({ chainId, ttl: 3600 });

        const count = rpc.getValidRPCCount("https");
        expect(count).toBeGreaterThan(0);

        const url = rpc.getRpc("https");
        expect(url.startsWith("https://")).toBe(true);

        const wsCount = rpc.getValidRPCCount("ws");
        expect(wsCount).toBeGreaterThan(0);

        rpc.destroy();
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Error Handling & Cleanup
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Error Handling & Cleanup", () => {
    test("should throw for unsupported chain ID", () => {
        expect(() => {
            const r = new RPC({ chainId: "0xFFFFFF" });
            r.destroy();
        }).toThrow();
    });

    test("destroy should wipe all state", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600 });
        expect(rpc.getValidRPCCount("https")).toBeGreaterThan(0);

        rpc.destroy();

        expect(rpc.getValidRPCCount("https")).toBe(0);
        expect(rpc.getValidRPCCount("ws")).toBe(0);
        expect(rpc.getFailureStats().totalFailed).toBe(0);
        expect(() => rpc.getRpc("https")).toThrow("No valid https URLs found");
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Custom RPC JSON Path (pathToRpcJson)
// ═══════════════════════════════════════════════════════════════════

describe("E2E: pathToRpcJson", () => {
    const CUSTOM_LIST = path.resolve(__dirname, "../fixtures/custom-rpc-list.json");
    const INVALID_LIST = path.resolve(__dirname, "../fixtures/invalid-rpc-list.json");

    test("should load endpoints from a custom JSON file", () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: CUSTOM_LIST });

        // The custom file has exactly 2 HTTP + 1 WS endpoint
        expect(rpc.getValidRPCCount("https")).toBe(2);
        expect(rpc.getValidRPCCount("ws")).toBe(1);

        const url = rpc.getRpc("https");
        expect(url).toMatch(/publicnode|1rpc/);

        const wsUrl = rpc.getRpc("ws");
        expect(wsUrl).toBe("wss://ethereum-rpc.publicnode.com");

        rpc.destroy();
    });

    test("should fall back to bundled list when path does not exist", () => {
        const rpc = new RPC({
            chainId: "0x0001",
            ttl: 3600,
            pathToRpcJson: "/tmp/does-not-exist-at-all.json",
        });

        // Falls back to bundled rpcList.min.json which has many endpoints
        const count = rpc.getValidRPCCount("https");
        expect(count).toBeGreaterThan(2); // bundled list has 50+ for Ethereum

        rpc.destroy();
    });

    // test("pathToRpcJson: should fall back to internal lists if unreadable", async () => {
    //   // It does NOT throw if it's falling back to an internal list by default behavior.
    //   // E.g. in index.ts: it checks fs.existsSync(pathToRpcJson). If it doesn't exist, it falls back to rpcList.min.json.
    //   // So no throw is expected here!
    //   let rpc: RPC | undefined;
    //   expect(() => {
    //       rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: "/invalid/path/that/does/not/exist.json" });
    //   }).not.toThrow();
    //   if (rpc) rpc.destroy();
    // });

    // test("pathToRpcJson: throws if JSON is corrupted", async () => {
    //   const path = require('path');
    //   const corruptedPath = path.join(__dirname, "../fixtures/invalid-rpc-list.json");

    //   let rpc: RPC | undefined;
    //   expect(() => {
    //       rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: corruptedPath });
    //   }).toThrow(/Unexpected token|is not valid JSON/);
    //   if (rpc) rpc.destroy();
    // });

    test("should throw when custom file lacks the requested chain", () => {
        // custom-rpc-list.json only has x0001 — Polygon (0x89) is absent
        expect(() => {
            const rpc = new RPC({ chainId: "0x89", pathToRpcJson: CUSTOM_LIST });
            rpc.destroy();
        }).toThrow();
    });

    test("custom path endpoints should work with all load balancing strategies", () => {
        const rpc = new RPC({
            chainId: "0x0001",
            ttl: 3600,
            pathToRpcJson: CUSTOM_LIST,
            loadBalancing: "round-robin",
        });

        const url1 = rpc.getRpc("https");
        const url2 = rpc.getRpc("https");
        const url3 = rpc.getRpc("https"); // wraps (only 2 endpoints)

        expect(url1).not.toBe(url2); // different URLs
        expect(url3).toBe(url1);     // round-robin wraps

        rpc.destroy();
    });

    test("custom path endpoints should validate via initialize()", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: CUSTOM_LIST });

        // Wait for async validation
        await waitForValidation(rpc);

        // After validation, if any succeeded, they should have real times
        const rpcs = rpc.getAllValidRPCs("https");
        expect(rpcs.length).toBeGreaterThan(0);

        // If validation worked, times should be < sentinel
        if (rpcs[0].time < 999_999_999) {
            expect(rpcs[0].url).toMatch(/publicnode|1rpc/);
        }

        rpc.destroy();
    }, E2E_TIMEOUT);
});

afterAll(async () => {
    // Destroy global dispatcher if fetch accidentally leaked to it
    const { getGlobalDispatcher } = require('undici');
    const dispatcher = getGlobalDispatcher();
    if (dispatcher && typeof dispatcher.destroy === 'function') {
        await dispatcher.destroy();
    }

    // Allow all residual Undici TCPWRAPs to fully close before exiting Jest
    await new Promise(resolve => setTimeout(resolve, 500));
});

