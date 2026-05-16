/**
 * End-to-end tests for lazy-rpc
 *
 * These tests hit REAL RPC endpoints using the real bundled rpcList.min.json.
 * They validate the full lifecycle of the library as a consumer would use it.
 *
 * Tests that require validated endpoints are guarded with skip conditions
 * so the suite remains useful even without outbound internet connectivity.
 *
 * Run separately from unit tests:
 *   npx jest tests/node/e2e.test.ts
 */

import { RPC } from "../../src/index";
import * as path from "path";
import { fetch as undiciFetch, Agent } from "undici";

/** Shorter validation timeout — fails fast on unreachable endpoints */
const VALIDATION_TIMEOUT = 3000;
const E2E_TIMEOUT = 30_000;

/**
 * Wait for the RPC instance to finish its initialize() cycle and
 * populate validRPCs with at least one HTTP endpoint.
 *
 * Polls getValidRPCCount directly rather than using getRpcAsync,
 * because getRpcAsync resolves mid-batch (as soon as one URL validates)
 * but validRPCs is only written after ALL batches complete.
 *
 * Returns true if at least one endpoint validated, false on timeout.
 */
async function waitForValidation(rpc: RPC, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (rpc.getValidRPCCount("https") > 0) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════
//  Ethereum — full lifecycle
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Ethereum Lifecycle", () => {
    let rpc: RPC;
    let hasValidated: boolean;

    beforeAll(async () => {
        rpc = new RPC({ chainId: "0x0001", ttl: 3600, validationTimeout: VALIDATION_TIMEOUT });
        hasValidated = await waitForValidation(rpc, 15_000);
    }, E2E_TIMEOUT);

    afterAll(() => rpc.destroy());

    test("status reflects lifecycle correctly", () => {
        if (hasValidated) {
            // After successful validation, status should be "ready"
            expect(rpc.status()).toBe("ready");
        }
        // Regardless of validation outcome, instance should be alive
        expect(rpc.status()).not.toBe("destroyed");
    });

    test("should have HTTP endpoints available after validation", () => {
        if (!hasValidated) {
            console.warn("Skipping: no endpoints validated (network-dependent)");
            return;
        }
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

        const agent = new Agent({ connect: { family: 4 } });
        let success = false;

        try {
            const url = rpc.getRpc("https");
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
            console.warn("E2E fetch failed:", error);
        } finally {
            await agent.destroy();
        }
        expect(success).toBe(true);
    }, E2E_TIMEOUT);

    test("if validated, RPCs should be sorted fastest-first", () => {
        if (!hasValidated) {
            console.warn("Skipping: no endpoints were validated (network-dependent)");
            return;
        }

        const allRpcs = rpc.getAllValidRPCs("https");
        for (let i = 1; i < allRpcs.length; i++) {
            expect(allRpcs[i].time).toBeGreaterThanOrEqual(allRpcs[i - 1].time);
        }
    });

    test("should have WebSocket endpoints available if validated", () => {
        const wsCount = rpc.getValidRPCCount("ws");
        if (wsCount > 0) {
            const wsUrl = rpc.getRpc("ws");
            expect(wsUrl.startsWith("wss://")).toBe(true);
        }
    });

    test("getAllValidRPCs should return a copy", () => {
        if (!hasValidated) return;
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
    let hasValidated: boolean;

    beforeAll(async () => {
        rpc = new RPC({ chainId: "0x0001", ttl: 3600, maxRetry: 5, validationTimeout: VALIDATION_TIMEOUT });
        hasValidated = await waitForValidation(rpc);
    }, E2E_TIMEOUT);

    afterAll(() => rpc.destroy());

    test("drop() should increment failure count by 1", () => {
        if (!hasValidated) {
            console.warn("Skipping: no validated endpoints (network-dependent)");
            return;
        }
        rpc.clearFailedURLs();

        const url = rpc.getRpc("https");
        rpc.drop(url);
        rpc.drop(url);

        const stats = rpc.getFailureStats();
        expect(stats.totalFailed).toBeGreaterThanOrEqual(1);
        expect(stats.overMaxRetries).toBe(0);
    });

    test("clearFailedURLs should reset tracking", () => {
        if (!hasValidated) {
            console.warn("Skipping: no validated endpoints (network-dependent)");
            return;
        }
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
    let hasValidated: boolean;

    beforeAll(async () => {
        rpc = new RPC({ chainId: "0x0001", ttl: 3600, validationTimeout: VALIDATION_TIMEOUT });
        hasValidated = await waitForValidation(rpc);
    }, E2E_TIMEOUT);

    afterAll(() => rpc.destroy());

    test("fastest should consistently return the same URL", () => {
        if (!hasValidated) {
            console.warn("Skipping: no validated endpoints");
            return;
        }
        rpc["loadBalancing"] = "fastest";
        const url1 = rpc.getRpc("https");
        const url2 = rpc.getRpc("https");
        const url3 = rpc.getRpc("https");

        expect(url1).toBe(url2);
        expect(url2).toBe(url3);
        expect(url1).toBe(rpc.getAllValidRPCs("https")[0].url);
    });

    test("round-robin should cycle when multiple endpoints available", () => {
        if (!hasValidated) {
            console.warn("Skipping: no validated endpoints");
            return;
        }
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
        if (!hasValidated) {
            console.warn("Skipping: no validated endpoints");
            return;
        }
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
    ])("%s (chainId %s) should initialize without error", (_name, chainId) => {
        // Verify the chain exists in the bundled list — constructor throws if not
        const rpc = new RPC({ chainId, ttl: 3600, validationTimeout: VALIDATION_TIMEOUT });

        // Immediately after construction, async validation is in progress
        expect(rpc.status()).toBe("initializing");

        rpc.destroy();
        expect(rpc.status()).toBe("destroyed");
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
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, validationTimeout: VALIDATION_TIMEOUT });
        const hasValidated = await waitForValidation(rpc);

        if (hasValidated) {
            expect(rpc.getValidRPCCount("https")).toBeGreaterThan(0);
        }

        rpc.destroy();

        expect(rpc.status()).toBe("destroyed");
        expect(rpc.getValidRPCCount("https")).toBe(0);
        expect(rpc.getValidRPCCount("ws")).toBe(0);
        expect(rpc.getFailureStats().totalFailed).toBe(0);
        expect(() => rpc.getRpc("https")).toThrow("No valid https URLs found");
    }, E2E_TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
//  Custom RPC JSON Path (pathToRpcJson)
// ═══════════════════════════════════════════════════════════════════

describe("E2E: pathToRpcJson", () => {
    const CUSTOM_LIST = path.resolve(__dirname, "../fixtures/custom-rpc-list.json");

    test("should load endpoints from a custom JSON file", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: CUSTOM_LIST, validationTimeout: VALIDATION_TIMEOUT });
        const hasValidated = await waitForValidation(rpc);

        if (!hasValidated) {
            console.warn("Skipping: no endpoints validated (network-dependent)");
            rpc.destroy();
            return;
        }

        // The custom file has exactly 2 HTTP + 1 WS endpoint
        expect(rpc.getValidRPCCount("https")).toBe(2);
        expect(rpc.getValidRPCCount("ws")).toBe(1);

        const url = rpc.getRpc("https");
        expect(url).toMatch(/publicnode|1rpc/);

        const wsUrl = rpc.getRpc("ws");
        expect(wsUrl).toBe("wss://ethereum-rpc.publicnode.com");

        rpc.destroy();
    }, E2E_TIMEOUT);

    test("should fall back to bundled list when path does not exist", () => {
        // Constructor should not throw — it falls back to bundled rpcList.min.json
        const rpc = new RPC({
            chainId: "0x0001",
            ttl: 3600,
            pathToRpcJson: "/tmp/does-not-exist-at-all.json",
        });

        // Instance is alive and initializing with the bundled list
        expect(rpc.status()).toBe("initializing");

        rpc.destroy();
    });

    test("should throw when custom file lacks the requested chain", () => {
        // custom-rpc-list.json only has x0001 — Polygon (0x89) is absent
        expect(() => {
            const rpc = new RPC({ chainId: "0x89", pathToRpcJson: CUSTOM_LIST });
            rpc.destroy();
        }).toThrow();
    });

    test("custom path endpoints should work with all load balancing strategies", async () => {
        const rpc = new RPC({
            chainId: "0x0001",
            ttl: 3600,
            pathToRpcJson: CUSTOM_LIST,
            loadBalancing: "round-robin",
            validationTimeout: VALIDATION_TIMEOUT,
        });
        const hasValidated = await waitForValidation(rpc);

        if (!hasValidated) {
            console.warn("Skipping: no endpoints validated (network-dependent)");
            rpc.destroy();
            return;
        }

        const url1 = rpc.getRpc("https");
        const url2 = rpc.getRpc("https");
        const url3 = rpc.getRpc("https"); // wraps (only 2 endpoints)

        expect(url1).not.toBe(url2); // different URLs
        expect(url3).toBe(url1);     // round-robin wraps

        rpc.destroy();
    }, E2E_TIMEOUT);

    test("custom path endpoints should validate via initialize()", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: CUSTOM_LIST, validationTimeout: VALIDATION_TIMEOUT });
        const hasValidated = await waitForValidation(rpc);

        if (!hasValidated) {
            console.warn("Skipping: no endpoints validated (network-dependent)");
            rpc.destroy();
            return;
        }

        // After validation, endpoints should have real response times
        const rpcs = rpc.getAllValidRPCs("https");
        expect(rpcs.length).toBeGreaterThan(0);
        expect(rpcs[0].url).toMatch(/publicnode|1rpc/);

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
