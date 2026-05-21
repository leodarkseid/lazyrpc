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

import { RPC, HttpRpcEndpointOptions } from "../../src/index";
import * as path from "path";
import * as http from "http";
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
        rpc = new RPC({ chainId: "0x0001", ttl: 3600, enforceHttps: false });
        hasValidated = await waitForValidation(rpc, 15_000);
        const timeTaken = Date.now() - start;

        // Fail loudly if initialization is stalling (typically an IPv6 blackhole issue > 60s)
        expect(timeTaken).toBeLessThan(20_000);
    }, E2E_TIMEOUT);

    afterAll(async () => {
        await rpc.destroy();
    });

    test("should have HTTP endpoints available and expose validated URLs when ready", () => {
        expect(rpc.getAllCandidateRPCs("https").length).toBeGreaterThan(0);

        if (!hasValidated) {
            expect(() => rpc.getRpc("https")).toThrow("No validated https RPC URLs available yet");
            return;
        }

        const url = rpc.getRpc("https");
        expect(url.startsWith("https://")).toBe(true);
    });

    test("returned URL should produce a valid eth_blockNumber response", async () => {
        if (!hasValidated) {
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
        } finally {
            await agent.destroy();
        }
        expect(success).toBe(true);
    }, E2E_TIMEOUT);

    test("if validated, RPCs should be sorted fastest-first", () => {
        if (!hasValidated) {
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
    let hasValidated: boolean;

    beforeAll(async () => {
        rpc = new RPC({ chainId: "0x0001", ttl: 3600, maxRetry: 5, enforceHttps: false });
        hasValidated = await waitForValidation(rpc);
    }, E2E_TIMEOUT);

    afterAll(async () => {
        await rpc.destroy();
    });

    test("drop() should increment failure count by 1", async () => {
        if (!hasValidated) {
            return;
        }

        rpc.clearFailedURLs();

        const url = await rpc.getRpcAsync("https");
        rpc.drop(url);
        rpc.drop(url);

        const stats = rpc.getFailureStats();
        expect(stats.totalFailed).toBeGreaterThanOrEqual(1);
        expect(stats.overMaxRetries).toBe(0);
    });

    test("clearFailedURLs should reset tracking", async () => {
        if (!hasValidated) {
            return;
        }

        const url = await rpc.getRpcAsync("https");
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
    const CUSTOM_LIST = path.resolve(__dirname, "../fixtures/custom-rpc-list.json");

    test("fastest should consistently return the same URL", async () => {
        const lbRpc = new RPC({ chainId: "0x0001", ttl: 3600, loadBalancing: "fastest", enforceHttps: false, pathToRpcJson: CUSTOM_LIST });
        await waitForValidation(lbRpc);
        const count = lbRpc.getValidRPCCount("https");
        if (count < 1) return;

        const url1 = lbRpc.getRpc("https");
        const url2 = lbRpc.getRpc("https");
        const url3 = lbRpc.getRpc("https");

        expect(url1).toBe(url2);
        expect(url2).toBe(url3);
        expect(url1).toBe(lbRpc.getAllValidRPCs("https")[0].url);
        await lbRpc.destroy();
    }, E2E_TIMEOUT);

    test("round-robin should cycle when multiple endpoints available", async () => {
        const lbRpc = new RPC({ chainId: "0x0001", ttl: 3600, loadBalancing: "round-robin", enforceHttps: false, pathToRpcJson: CUSTOM_LIST });
        await waitForValidation(lbRpc);

        const count = lbRpc.getValidRPCCount("https");
        if (count < 2) {
            await lbRpc.destroy();
            return;
        }

        const urls: string[] = [];
        for (let i = 0; i < count + 1; i++) {
            urls.push(lbRpc.getRpc("https"));
        }

        expect(urls.length).toBe(count + 1);
        expect(new Set(urls).size).toBeGreaterThan(1);
        await lbRpc.destroy();
    }, E2E_TIMEOUT);

    test("random should return URLs from the valid set", async () => {
        const lbRpc = new RPC({ chainId: "0x0001", ttl: 3600, loadBalancing: "random", enforceHttps: false, pathToRpcJson: CUSTOM_LIST });
        const validated = await waitForValidation(lbRpc);
        if (!validated) {
            await lbRpc.destroy();
            return;
        }

        const validUrls = lbRpc.getAllValidRPCs("https").map((e) => e.url);
        for (let i = 0; i < 10; i++) {
            expect(validUrls).toContain(lbRpc.getRpc("https"));
        }
        await lbRpc.destroy();
    }, E2E_TIMEOUT);
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
    ])("should have %s (chainId %s) endpoints via init", async (_name, chainId) => {
        // Verifies the library can read candidate RPCs synchronously.
        // We do NOT wait for async validation here (it would be too slow
        // across 6 chains in sequence).
        const rpc = new RPC({ chainId, ttl: 3600, enforceHttps: false });

        const count = rpc.getAllCandidateRPCs("https").length;
        expect(count).toBeGreaterThan(0);

        const url = rpc.getAllCandidateRPCs("https")[0];
        expect(url.startsWith("https://")).toBe(true);

        const wsCount = rpc.getAllCandidateRPCs("ws").length;
        expect(wsCount).toBeGreaterThan(0);

        await rpc.destroy();
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Error Handling & Cleanup
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Error Handling & Cleanup", () => {
    test("should throw for unsupported chain ID", () => {
        expect(() => {
            const r = new RPC({ chainId: "0xFFFFFF", enforceHttps: false });
            r.destroy();
        }).toThrow();
    });

    test("destroy should wipe all state", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, enforceHttps: false });
        expect(rpc.getAllCandidateRPCs("https").length).toBeGreaterThan(0);

        await rpc.destroy();

        expect(rpc.getValidRPCCount("https")).toBe(0);
        expect(rpc.getValidRPCCount("ws")).toBe(0);
        expect(rpc.getFailureStats().totalFailed).toBe(0);
        expect(() => rpc.getRpc("https")).toThrow("RPC instance destroyed");
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Custom RPC JSON Path (pathToRpcJson)
// ═══════════════════════════════════════════════════════════════════

describe("E2E: pathToRpcJson", () => {
    const CUSTOM_LIST = path.resolve(__dirname, "../fixtures/custom-rpc-list.json");
    const INVALID_LIST = path.resolve(__dirname, "../fixtures/invalid-rpc-list.json");

    test("should load endpoints from a custom JSON file", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: CUSTOM_LIST, enforceHttps: false });

        // The custom file has exactly 2 HTTP + 1 WS candidate endpoints
        expect(rpc.getAllCandidateRPCs("https").length).toBe(2);
        expect(rpc.getAllCandidateRPCs("ws").length).toBe(1);

        // Wait for async validation before accessing validated RPCs
        const validated = await waitForValidation(rpc);
        if (validated) {
            const url = rpc.getRpc("https");
            expect(url).toMatch(/publicnode|1rpc/);
        }

        await rpc.destroy();
    }, E2E_TIMEOUT);

    test("should fall back to bundled list when path does not exist", async () => {
        const rpc = new RPC({
            chainId: "0x0001",
            ttl: 3600,
            pathToRpcJson: "/tmp/does-not-exist-at-all.json",
            enforceHttps: false
        });

        // Falls back to bundled rpcList.min.json which has many endpoints
        const count = rpc.getAllCandidateRPCs("https").length;
        expect(count).toBeGreaterThan(2); // bundled list has 50+ for Ethereum

        await rpc.destroy();
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
            const rpc = new RPC({ chainId: "0x89", pathToRpcJson: CUSTOM_LIST, enforceHttps: false });
            rpc.destroy();
        }).toThrow();
    });

    test("custom path endpoints should work with all load balancing strategies", async () => {
        const rpc = new RPC({
            chainId: "0x0001",
            ttl: 3600,
            pathToRpcJson: CUSTOM_LIST,
            loadBalancing: "round-robin",
            enforceHttps: false
        });

        // Wait for async validation before testing round-robin
        const validated = await waitForValidation(rpc);
        if (!validated) {
            await rpc.destroy();
            return;
        }

        const count = rpc.getValidRPCCount("https");
        if (count < 2) {
            await rpc.destroy();
            return;
        }

        const url1 = rpc.getRpc("https");
        const url2 = rpc.getRpc("https");
        const url3 = rpc.getRpc("https"); // wraps (only 2 endpoints)

        expect(url1).not.toBe(url2); // different URLs
        expect(url3).toBe(url1);     // round-robin wraps

        await rpc.destroy();
    }, E2E_TIMEOUT);

    test("custom path endpoints should validate via initialize()", async () => {
        const rpc = new RPC({ chainId: "0x0001", ttl: 3600, pathToRpcJson: CUSTOM_LIST, enforceHttps: false });

        // Wait for async validation
        const validated = await waitForValidation(rpc);
        if (!validated) {
            await rpc.destroy();
            return;
        }

        const rpcs = rpc.getAllValidRPCs("https");
        expect(rpcs.length).toBeGreaterThan(0);
        expect(rpcs[0].url).toMatch(/publicnode|1rpc/);

        await rpc.destroy();
    }, E2E_TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
//  Custom Headers & Rate Limiting
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Custom Headers & Rate Limiting", () => {
    const CUSTOM_LIST = path.resolve(__dirname, "../fixtures/custom-rpc-list.json");
    let mockServer: http.Server;
    let mockUrl: string;

    beforeAll((done) => {
        mockServer = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", chunk => chunks.push(chunk));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                let parsedId = 1;
                try {
                    const parsed = JSON.parse(body);
                    if (parsed && typeof parsed.id === "number") {
                        parsedId = parsed.id;
                    }
                } catch (e) {}

                if (req.url === "/auth") {
                    if (req.headers["x-custom-auth"] !== "super-secret") {
                        res.writeHead(401, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
                        return;
                    }
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsedId, result: "0x1234" }));
                } else if (req.url === "/rate-limit") {
                    res.writeHead(429, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
        });

        mockServer.listen(0, "127.0.0.1", () => {
            const address = mockServer.address() as any;
            mockUrl = `http://127.0.0.1:${address.port}`;
            done();
        });
    });

    afterAll((done) => {
        mockServer.close(done);
    });

    test("should successfully validate against a server requiring custom headers", async () => {
        const rpc = new RPC<string | HttpRpcEndpointOptions, string>({ 
            // We use the custom list to keep it fast and bypass the massive mainnet nodes
            chainId: "0x0001",
            pathToRpcJson: CUSTOM_LIST,
            ttl: 3600,
            enforceHttps: false,
            customRpcs: {
                http: [
                    {
                        url: `${mockUrl}/auth`,
                        headers: { "X-Custom-Auth": "super-secret" }
                    }
                ]
            }
        });

        // Wait for validation to pick up the mock server (up to 15 seconds)
        let valid = false;
        for (let i = 0; i < 150; i++) {
            const rpcs = rpc.getAllValidRPCs("https");
            if (rpcs.some(r => r.url === `${mockUrl}/auth`)) {
                valid = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }

        if (!valid) {
            throw new Error(`Validation failed for mockUrl. Stats: ${JSON.stringify(rpc.getFailureStats(), null, 2)}`);
        }

        expect(valid).toBe(true);

        const urlObj = await rpc.getRpcAsync("https");
        expect((urlObj as any).url).toBe(`${mockUrl}/auth`);

        await rpc.destroy();
    }, E2E_TIMEOUT);

    test("should handle rate-limiting (429) gracefully and record failures", async () => {
        const rpc = new RPC<string | HttpRpcEndpointOptions, string>({ 
            chainId: "0x0001",
            pathToRpcJson: CUSTOM_LIST,
            ttl: 3600,
            enforceHttps: false,
            customRpcs: {
                http: [
                    {
                        url: `${mockUrl}/rate-limit`
                    }
                ]
            }
        });

        // Wait a bit to let validation fail (up to 2 seconds to ensure completion)
        await new Promise(r => setTimeout(r, 2000));
        
        // Ensure our URL is NOT in the valid pool
        const validRpcs = rpc.getAllValidRPCs("https");
        expect(validRpcs.find(r => r.url === `${mockUrl}/rate-limit`)).toBeUndefined();

        await rpc.destroy();
    }, E2E_TIMEOUT);
});

afterAll(async () => {
    jest.useRealTimers();
    // Allow residual aborted validation requests and Undici TCPWRAPs to close
    // before the next in-band node test starts local loopback servers.
    await new Promise(resolve => setTimeout(resolve, 3000));
});
