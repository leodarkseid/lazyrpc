import { RPC } from "../../src/index";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

describe("Validation: False Positive 200 OK responses", () => {
    const jsonPath = path.join(__dirname, "temp-false-positive.json");

    let httpServers: http.Server[] = [];
    let urls: Record<string, string> = {};

    beforeAll(async () => {
        // 1. Returns 200 OK but with a JSON-RPC error (e.g. Unauthorized)
        urls.Http200JsonRpcError = await new Promise<string>((resolve) => {
            const srv = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    error: { code: -32000, message: "Unauthorized IP" }
                }));
            });
            httpServers.push(srv);
            srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`));
        });

        // 2. Returns 200 OK but with HTML payload (e.g. Cloudflare block or Captcha page)
        urls.Http200Html = await new Promise<string>((resolve) => {
            const srv = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end("<html><body>Please complete the captcha</body></html>");
            });
            httpServers.push(srv);
            srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`));
        });

        // 3. Returns 200 OK but missing 'result' field (malformed JSON-RPC or custom API)
        urls.Http200Malformed = await new Promise<string>((resolve) => {
            const srv = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    status: "ok" // Missing 'result' which core.ts expects
                }));
            });
            httpServers.push(srv);
            srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`));
        });

        fs.writeFileSync(jsonPath, JSON.stringify({
            "x0001": [urls.Http200JsonRpcError, urls.Http200Html, urls.Http200Malformed],
        }));
    });

    afterAll(async () => {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        for (const srv of httpServers) {
            srv.closeAllConnections();
            await new Promise<void>(resolve => srv.close(() => resolve()));
        }
        
        jest.useRealTimers();
    });

    test("should reject endpoints that return 200 OK but contain errors or invalid payloads", async () => {
        const rpc = new RPC({ chainId: "0x1", pathToRpcJson: jsonPath, ttl: 60, enforceHttps: false });

        // Wait for the initialization cycle to run and attempt to validate the bad endpoints
        const promise = rpc.getRpcAsync("https");

        // All endpoints should fail validation gracefully, resulting in an empty valid list
        await expect(promise).rejects.toThrow("Failed To Find A Valid RPC");

        // Ensure absolutely no endpoints were marked as actually valid
        const validatedCount = rpc.getAllValidRPCs("https").filter(r => r.time < 999_999_999).length;
        expect(validatedCount).toBe(0);

        rpc.destroy();
    });
});
