import { RPC } from "../src/index"; // Adjust path as needed
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

describe("URL Oracle: The Thundering Herd (Concurrent Boot Lock)", () => {
    const TEST_TIMEOUT = 10000;
    const jsonPath = path.join(__dirname, "temp-thundering-herd.json");

    let httpServers: http.Server[] = [];
    let wsServers: WebSocketServer[] = [];

    let httpUrls: Record<string, string> = {};
    let wsUrls: Record<string, string> = {};

    // The most important part of this test: Counting the actual network pings
    let httpCallCounts = { A: 0, B: 0, C: 0 };
    let wsCallCounts = { X: 0, Y: 0, Z: 0 };

    beforeAll(async () => {
        // --- 1. SETUP HTTP SERVERS ---
        const createHttpServer = (name: keyof typeof httpCallCounts, delay: number) => {
            return new Promise<string>((resolve) => {
                const srv = http.createServer((req, res) => {
                    let body = "";
                    req.on("data", chunk => body += chunk);
                    req.on("end", () => {
                        httpCallCounts[name]++; // Increment the tracker!
                        const parsed = JSON.parse(body);
                        setTimeout(() => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: "0x1" }));
                        }, delay);
                    });
                });
                httpServers.push(srv);
                srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`));
            });
        };

        // HTTP A is the fastest (50ms)
        httpUrls.A = await createHttpServer("A", 50);
        httpUrls.B = await createHttpServer("B", 150);
        httpUrls.C = await createHttpServer("C", 300);

        // --- 2. SETUP WEBSOCKET SERVERS ---
        const createWsServer = (name: keyof typeof wsCallCounts, delay: number) => {
            return new Promise<string>((resolve) => {
                const wss = new WebSocketServer({ port: 0 }, () => resolve(`ws://127.0.0.1:${(wss.address() as any).port}`));
                wss.on('connection', (ws) => {
                    ws.on('message', (message: any) => {
                        wsCallCounts[name]++; // Increment the tracker!
                        const parsed = JSON.parse(message.toString());
                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: "0x1" }));
                            }
                        }, delay);
                    });
                });
                wsServers.push(wss);
            });
        };

        // WS X is the fastest (50ms)
        wsUrls.X = await createWsServer("X", 50);
        wsUrls.Y = await createWsServer("Y", 150);
        wsUrls.Z = await createWsServer("Z", 300);

        // Write the fleet to JSON
        fs.writeFileSync(jsonPath, JSON.stringify({
            "x0001": [httpUrls.A, httpUrls.B, httpUrls.C],
            "x0001_WS": [wsUrls.X, wsUrls.Y, wsUrls.Z]
        }));
    });

    afterAll(async () => {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

        // Clean up HTTP
        for (const srv of httpServers) {
            srv.closeAllConnections();
            await new Promise<void>(resolve => srv.close(() => resolve()));
        }

        // Clean up WS
        for (const ws of wsServers) {
            for (const client of ws.clients ?? []) client.terminate();
            await new Promise<void>(resolve => ws.close(() => resolve()));
        }
    });

    test("HTTP: 50 concurrent requests trigger exactly ONE network validation", async () => {
        httpCallCounts = { A: 0, B: 0, C: 0 };
        const rpc = new RPC({ chainId: "0x1", pathToRpcJson: jsonPath, ttl: 60 });

        // Fire 50 requests at the EXACT SAME TIME
        const promises = [];
        for (let i = 0; i < 50; i++) {
            promises.push(rpc.getRpcAsync("https"));
        }

        // Wait for all 50 to resolve
        const results = await Promise.all(promises);

        // Assertion 1: All 50 callers must receive the exact same fastest URL (A)
        results.forEach(url => {
            expect(url).toBe(httpUrls.A);
        });

        // Assertion 2: The Oracle must NOT have pinged the servers 50 times!
        // It should have locked the gate, pinged them exactly once, and distributed the answer.
        expect(httpCallCounts.A).toBe(1);
        expect(httpCallCounts.B).toBe(1);
        expect(httpCallCounts.C).toBe(1);

        rpc.destroy();
    });

    test("WebSocket: 50 concurrent requests trigger exactly ONE network validation", async () => {
        wsCallCounts = { X: 0, Y: 0, Z: 0 };
        const rpc = new RPC({ chainId: "0x1", pathToRpcJson: jsonPath, ttl: 60 });

        // Fire 50 requests at the EXACT SAME TIME
        const promises = [];
        for (let i = 0; i < 50; i++) {
            promises.push(rpc.getRpcAsync("ws"));
        }

        const results = await Promise.all(promises);

        // Assertion 1: All 50 callers must receive the fastest WS URL (X)
        results.forEach(url => {
            expect(url).toBe(wsUrls.X);
        });

        // Assertion 2: The WebSocket lock held perfectly. 
        // Only ONE connection and ONE ping was sent to each server.
        expect(wsCallCounts.X).toBe(1);
        expect(wsCallCounts.Y).toBe(1);
        expect(wsCallCounts.Z).toBe(1);

        rpc.destroy();
    });
});