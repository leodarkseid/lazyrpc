import { RPC } from "../src/index";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

describe("URL Oracle: The Doomsday Thundering Herd", () => {
    const TEST_TIMEOUT = 10000;
    const jsonPath = path.join(__dirname, "temp-doomsday.json");

    let httpServers: http.Server[] = [];
    let wsServers: WebSocketServer[] = [];

    let urls: Record<string, string> = {};
    let wsUrls: Record<string, string> = {};

    beforeAll(async () => {
        // --- 1. SETUP DEAD HTTP SERVERS ---

        // Dead 1: Instantly returns HTTP 500 (Internal Server Error)
        urls.Http500 = await new Promise<string>((resolve) => {
            const srv = http.createServer((req, res) => {
                res.writeHead(500);
                res.end("Internal Server Error");
            });
            httpServers.push(srv);
            srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`));
        });

        // Dead 2: The Blackhole. Accepts connection but NEVER responds.
        urls.HttpHang = await new Promise<string>((resolve) => {
            const srv = http.createServer((req, res) => {
                // Do absolutely nothing. Wait for the Oracle to Abort the request.
            });
            httpServers.push(srv);
            srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`));
        });

        // --- 2. SETUP DEAD WEBSOCKET SERVERS ---

        // Dead 3: Instantly closes the connection upon receiving a message
        wsUrls.WsClose = await new Promise<string>((resolve) => {
            const wss = new WebSocketServer({ port: 0 }, () => resolve(`ws://127.0.0.1:${(wss.address() as any).port}`));
            wss.on('connection', (ws) => {
                ws.on('message', () => ws.close(1011, "Internal Error"));
            });
            wsServers.push(wss);
        });

        // Dead 4: The WS Blackhole. Accepts message but NEVER responds.
        wsUrls.WsHang = await new Promise<string>((resolve) => {
            const wss = new WebSocketServer({ port: 0 }, () => resolve(`ws://127.0.0.1:${(wss.address() as any).port}`));
            wss.on('connection', (ws) => {
                ws.on('message', () => { /* Silence */ });
            });
            wsServers.push(wss);
        });

        // Write the doomed fleet to JSON
        fs.writeFileSync(jsonPath, JSON.stringify({
            "x0001": [urls.Http500, urls.HttpHang],
            "x0001_WS": [wsUrls.WsClose, wsUrls.WsHang]
        }));
    });

    afterAll(async () => {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

        for (const srv of httpServers) {
            srv.closeAllConnections();
            await new Promise<void>(resolve => srv.close(() => resolve()));
        }

        for (const ws of wsServers) {
            for (const client of ws.clients ?? []) client.terminate();
            await new Promise<void>(resolve => ws.close(() => resolve()));
        }
    });

    test("HTTP Doomsday: 100 concurrent calls survive total network failure cleanly", async () => {
        // Set a short validation timeout (500ms) to kill the hanging servers quickly
        const rpc = new RPC({ chainId: "0x1", pathToRpcJson: jsonPath, validationTimeout: 500, ttl: 60 });

        // Fire 100 concurrent requests while the network is completely dead
        const promises = [];
        for (let i = 0; i < 100; i++) {
            promises.push(rpc.getRpcAsync("https"));
        }

        // If the library crashes Node.js or throws an unhandled rejection, this next line will fail the test.
        const results = await Promise.allSettled(promises);

        // Assertion 1: All 100 requests resolved successfully.
        expect(results).toHaveLength(100);

        // Assertion 2: The Graceful Fallback. 
        // Because ALL nodes failed, validRPCs is empty. The Oracle should safely return the FIRST URL 
        // in the JSON file so the user's app doesn't completely halt.



        results.forEach((url: any) => {
            expect(url.status).toBe("rejected");
            expect(url.reason).toBeInstanceOf(Error);
            expect(url.reason).toStrictEqual(new Error("All https URLs are currently failing or in backoff"));
        })


        rpc.destroy();
    });

    test("WebSocket Doomsday: 100 concurrent calls survive total WS failure cleanly", async () => {
        const rpc = new RPC({ chainId: "0x1", pathToRpcJson: jsonPath, validationTimeout: 500, ttl: 60 });

        const promises = [];
        for (let i = 0; i < 100; i++) {
            promises.push(rpc.getRpcAsync("ws"));
        }

        const results = await Promise.allSettled(promises);

        expect(results).toHaveLength(100);

        // Graceful fallback for WebSockets
        results.forEach((url: any) => {
            expect(url.status).toBe("rejected");
            expect(url.reason).toBeInstanceOf(Error);
            expect(url.reason).toStrictEqual(new Error("All ws URLs are currently failing or in backoff"));
        })

        rpc.destroy();
    });
});