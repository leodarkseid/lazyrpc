import { RPC } from "../src/index"; // Adjust path as needed
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

describe("URL Oracle: WebSocket Fleet Racing and Dynamic Failover", () => {
  const TEST_TIMEOUT = 10000;
  const jsonPath = path.join(__dirname, "temp-ws-fleet-test.json");

  let wsServers: WebSocketServer[] = [];
  let urls: Record<string, string> = {};
  let callCounts = { A: 0, B: 0, C: 0 };

  beforeAll(async () => {
    // Helper to spin up a local WebSocket server
    const createTestWSServer = (name: string, behaviorHandler: (id: number, ws: WebSocket) => void) => {
      return new Promise<string>((resolve) => {
        const wss = new WebSocketServer({ port: 0 }, () => {
          const port = (wss.address() as any).port;
          resolve(`ws://127.0.0.1:${port}`);
        });

        wss.on('connection', (ws) => {
          ws.on('message', (message: any) => {
            try {
              const parsed = JSON.parse(message.toString());
              // Pass the parsed JSON-RPC ID and the active socket connection
              behaviorHandler(parsed.id, ws);
            } catch (e) {
              ws.close(1008, "Invalid JSON");
            }
          });
        });

        wsServers.push(wss);
      });
    };

    const latenciesA = [50, 500, 150, 50, 500, 150, 50, 500, 150, 50]; // Wins on 0, 3, 6, 9
    const latenciesB = [150, 50, 500, 150, 50, 500, 150, 50, 500, 150]; // Wins on 1, 4, 7
    const latenciesC = [500, 150, 50, 500, 150, 50, 500, 150, 50, 500]; // Wins on 2, 5, 8

    urls.A = await createTestWSServer("A", (id, ws) => {
      const delay = latenciesA[callCounts.A] || 500;
      callCounts.A++;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
        }
      }, delay);
    });

    urls.B = await createTestWSServer("B", (id, ws) => {
      const delay = latenciesB[callCounts.B] || 500;
      callCounts.B++;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
        }
      }, delay);
    });

    urls.C = await createTestWSServer("C", (id, ws) => {
      const delay = latenciesC[callCounts.C] || 500;
      callCounts.C++;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
        }
      }, delay);
    });

    // Write the dynamic fleet to the JSON configuration
    // Notice we are passing the WS urls to the `_WS` key this time!
    fs.writeFileSync(jsonPath, JSON.stringify({
      "x0001": [],
      "x0001_WS": [urls.A, urls.B, urls.C]
    }));
  });

  afterAll(async () => {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

    // Forcefully close all WebSocket clients and servers so Jest exits cleanly
    for (const ws of wsServers) {
      for (const client of ws.clients ?? []) {
        client.terminate();
      }
      await new Promise<void>(resolve => ws.close(() => resolve()));
    }
  });

  test("WS Manual Refresh: Oracle accurately tracks shifting latencies", async () => {
    callCounts = { A: 0, B: 0, C: 0 };

    const rpc = new RPC({
      chainId: "0x1",
      pathToRpcJson: jsonPath,
      validationTimeout: 1000,
      ttl: 600
    });

    const expectedWinners = [
      urls.A, urls.B, urls.C,
      urls.A, urls.B, urls.C,
      urls.A, urls.B, urls.C,
      urls.A
    ];

    // Boot it up asking for "wss"
    let currentFastest = await rpc.getRpcAsync("ws");
    expect(currentFastest).toBe(expectedWinners[0]);

    for (let round = 1; round < 10; round++) {
      await rpc.refresh();
      currentFastest = rpc.getRpc("ws");
      expect(currentFastest).toBe(expectedWinners[round]);
    }

    rpc.destroy();
  }, 20000);

  test("WS Auto-TTL: Background loop successfully tracks network chaos using polling", async () => {
    callCounts = { A: 0, B: 0, C: 0 };

    const rpc = new RPC({
      chainId: "0x1",
      pathToRpcJson: jsonPath,
      validationTimeout: 1000,
      ttl: 1
    });

    const expectedWinners = [
      urls.A, urls.B, urls.C,
      urls.A, urls.B, urls.C,
      urls.A, urls.B, urls.C,
      urls.A
    ];

    let currentFastest = await rpc.getRpcAsync("ws");
    expect(currentFastest).toBe(expectedWinners[0]);

    for (let round = 1; round < 10; round++) {
      const previousWinner = expectedWinners[round - 1];
      let attempts = 0;

      // Poll the WSS cache
      while (currentFastest === previousWinner && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        currentFastest = rpc.getRpc("ws");
        attempts++;
      }

      expect(currentFastest).toBe(expectedWinners[round]);
    }

    rpc.destroy();
  }, 30000);
});