import { RPC } from "../src/index";
import * as http from "http";

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
            // Our RPC class uses an AbortController with `validationTimeout` (here set to 500ms for speed).
            const rpc = new RPC({ chainId: "0xdead", pathToRpcJson: blackholePath, validationTimeout: 500 });

            // We use the public call method. It should attempt the fetch, fail, and throw an Error quickly.
            const start = Date.now();
            await expect(rpc.call("https", "eth_blockNumber", [], 500)).rejects.toThrow();
            const duration = Date.now() - start;

            // Execution should escape significantly faster than the OS TCP timeout (~60s),
            // and should map closely to our 500ms validationTimeout (with small margin for runtime)
            expect(duration).toBeLessThan(1500);

            rpc.destroy();
        }, TEST_TIMEOUT);

        test("abort requests to a blackhole IPv6 address ([2001:db8::1]) without stalling", async () => {
            // 2001:db8::1 is the IPv6 documentation prefix, also blackholed.
            const rpc = new RPC({ chainId: "0xbeef", pathToRpcJson: blackholePath, validationTimeout: 500 });

            const start = Date.now();
            await expect(rpc.call("https", "eth_blockNumber", [], 500)).rejects.toThrow();
            const duration = Date.now() - start;

            expect(duration).toBeLessThan(1500);

            rpc.destroy();
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

            ipv4Hits = 0;
            ipv6Hits = 0;

            // We use 'localhost' internally in the JSON configuration. 
            // It should resolve directly to IPv4 because of `{connect: {family: 4}}` on undici agent.
            let response;
            try {
                // Testing via the public API entirely
                response = await rpc.call("https", "eth_blockNumber", [], 10000);
            } catch (err) {
                throw new Error(`Dual-stack localhost call failed: ${err}`);
            }

            expect(response).toBe("0x1b4");
            expect(ipv4Hits).toBeGreaterThan(0);
            expect(ipv6Hits).toBe(0);

            rpc.destroy();

            // Force garbage collection of undici sockets so Jest can exit cleanly
            await new Promise(resolve => setTimeout(resolve, 100));
        }, 15000);
    });
});
