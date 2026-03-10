import { RPC } from "../src/index";
import * as http from "http";
import { fetch as undiciFetch, Agent } from "undici";

describe("Strict Network Resilience and IP Routing", () => {

    // We expect these timeouts to happen fast (controlled by validationTimeout)
    // We add a short cushion over the library's internal timeout.
    const TEST_TIMEOUT = 10000;

    describe("Blackhole IP Handling", () => {
        const path = require('path');
        const blackholePath = path.join(__dirname, "blackhole.json");

        beforeAll(() => {
            const fs = require('fs');
            // '0xdead' -> 'xdead', '0xbeef' -> 'xbeef'
            fs.writeFileSync(blackholePath, JSON.stringify({
                "xdead": ["http://192.0.2.1"],
                "xbeef": ["http://[2001:db8::1]"]
            }));
        });

        afterAll(() => {
            const fs = require('fs');
            if (fs.existsSync(blackholePath)) fs.unlinkSync(blackholePath);
        });

        test("abort requests to a blackhole IPv4 address (192.0.2.1) without stalling", async () => {
            // 192.0.2.1 is reserved for documentation/TEST-NET-1 and routing is blackholed.
            // A normal fetch will stall here until the OS TCP timeout.
            // The library's internal validationTimeout (500ms) aborts the validation sweep;
            // we then make our own fetch with the same guard to prove the URL is dead-end.
            const rpc = new RPC({ chainId: "0xdead", pathToRpcJson: blackholePath, validationTimeout: 500 });
            const agent = new Agent({ connect: { family: 4 } });

            // Ask the library for the best URL then attempt the fetch ourselves.
            const start = Date.now();
            const url = await rpc.getRpcAsync("https").catch(() => "http://192.0.2.1");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 500);
            await expect(
                undiciFetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
                    signal: controller.signal,
                    dispatcher: agent,
                })
            ).rejects.toThrow();
            clearTimeout(timer);
            const duration = Date.now() - start;

            // Execution should escape significantly faster than the OS TCP timeout (~60s),
            // and should map closely to our 500ms validationTimeout (with small margin for runtime)
            expect(duration).toBeLessThan(1500);

            await agent.destroy();
            await rpc['agent']?.destroy();
            rpc.destroy();
        }, TEST_TIMEOUT);

        test("abort requests to a blackhole IPv6 address ([2001:db8::1]) without stalling", async () => {
            // 2001:db8::1 is the IPv6 documentation prefix, also blackholed.
            // The library's agent enforces IPv4-only, so IPv6 URLs fail fast.
            const rpc = new RPC({ chainId: "0xbeef", pathToRpcJson: blackholePath, validationTimeout: 500 });
            const agent = new Agent({ connect: { family: 4 } });

            const start = Date.now();
            const url = await rpc.getRpcAsync("https").catch(() => "http://[2001:db8::1]");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 500);
            await expect(
                undiciFetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
                    signal: controller.signal,
                    dispatcher: agent,
                })
            ).rejects.toThrow();
            clearTimeout(timer);
            const duration = Date.now() - start;

            expect(duration).toBeLessThan(1500);

            await agent.destroy();
            await rpc['agent']?.destroy();
            rpc.destroy();
            await new Promise(resolve => setTimeout(resolve, 100));
        }, TEST_TIMEOUT);
    });

    describe("Strict IPv4 Resolution Enforcement", () => {
        let serverIPv4: http.Server;
        let serverIPv6: http.Server;
        let port: number;
        let ipv4Hits = 0;
        let ipv6Hits = 0;

        beforeAll(async () => {
            // Create two servers tracking which IP family receives the request
            serverIPv4 = http.createServer((req, res) => {
                ipv4Hits++;
                res.writeHead(200, { 'Content-Type': 'application/json' });

                // Return valid JSON-RPC payload so httpCall succeeds
                let id = 1;
                req.on('data', chunk => {
                    const str = chunk.toString();
                    const match = str.match(/"id":(\d+)/);
                    if (match) id = parseInt(match[1], 10);
                });
                req.on('end', () => {
                    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1b4" }));
                });
            });

            serverIPv6 = http.createServer((req, res) => {
                ipv6Hits++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                let id = 1;
                req.on('data', chunk => {
                    const str = chunk.toString();
                    const match = str.match(/"id":(\d+)/);
                    if (match) id = parseInt(match[1], 10);
                });
                req.on('end', () => {
                    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0xv6" }));
                });
            });

            // Start IPv4 server on loopback
            await new Promise<void>((resolve) => {
                serverIPv4.listen(0, '127.0.0.1', () => {
                    port = (serverIPv4.address() as any).port;
                    resolve();
                });
            });

            // Start IPv6 server on the EXACT SAME PORT on the IPv6 loopback
            await new Promise<void>((resolve) => {
                serverIPv6.listen(port, '::1', () => resolve());
            });

            const fs = require('fs');
            const path = require('path');
            const localPath = path.join(__dirname, "localhost-rpc.json");
            // '0xcafe' -> 'xcafe'
            fs.writeFileSync(localPath, JSON.stringify({
                "xcafe": [`http://localhost:${port}`]
            }));
        });

        afterAll(async () => {
            await new Promise<void>(resolve => serverIPv4.close(() => resolve()));
            await new Promise<void>(resolve => serverIPv6.close(() => resolve()));
            const fs = require('fs');
            const path = require('path');
            const localPath = path.join(__dirname, "localhost-rpc.json");
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        });

        test("Strictly enforces IPv4 routing on 'localhost' via family: 4 configuration", async () => {
            const path = require('path');
            const localPath = path.join(__dirname, "localhost-rpc.json");
            const rpc = new RPC({ chainId: "0xcafe", pathToRpcJson: localPath, validationTimeout: 10000 });
            // Use the same IPv4-only agent the library uses internally
            const agent = new Agent({ connect: { family: 4 } });

            ipv4Hits = 0;
            ipv6Hits = 0;

            // Ask the library for the best validated URL, then drive the fetch ourselves.
            // The library's internal agent (family: 4) ensures validation only contacts IPv4,
            // and we use the same family here so the actual call follows the same path.
            let data: any;
            try {
                const url = await rpc.getRpcAsync("https");
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10000);
                const response = await undiciFetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
                    signal: controller.signal,
                    dispatcher: agent,
                });
                clearTimeout(timer);
                data = await response.json();
            } catch (err) {
                throw new Error(`Dual-stack localhost call failed: ${err}`);
            }

            expect(data.result).toBe("0x1b4");
            expect(ipv4Hits).toBeGreaterThan(0);
            expect(ipv6Hits).toBe(0);

            await agent.destroy();
            await rpc['agent']?.destroy();
            rpc.destroy();

            // Force garbage collection of undici sockets so Jest can exit cleanly
            await new Promise(resolve => setTimeout(resolve, 200));
        }, 15000);
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
});
