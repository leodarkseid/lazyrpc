import { RPC } from "../src/index"; 
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

describe("URL Oracle: Fleet Racing and Dynamic Failover", () => {
  // We use real time, so give the test a generous timeout just in case CI is slow
  const TEST_TIMEOUT = 10000;
  const jsonPath = path.join(__dirname, "temp-fleet-test.json");

  let servers: http.Server[] = [];
  let urls: Record<string, string> = {};
  let callCounts = { A: 0, B: 0, C: 0 };

  beforeAll(async () => {
    // Helper to spin up a real local HTTP server and extract the JSON-RPC ID
    const createTestServer = (
      name: string,
      behaviorHandler: (id: number, res: http.ServerResponse) => void,
    ) => {
      return new Promise<string>((resolve) => {
        const srv = http.createServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              // Pass the exact request ID to the handler so it can format a valid response
              behaviorHandler(parsed.id, res);
            } catch (e) {
              res.writeHead(400).end();
            }
          });
        });

        servers.push(srv);
        srv.listen(0, "127.0.0.1", () => {
          const port = (srv.address() as any).port;
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    };

    const latenciesA = [50, 500, 150, 50, 500, 150, 50, 500, 150, 50]; // Wins on 0, 3, 6, 9
    const latenciesB = [150, 50, 500, 150, 50, 500, 150, 50, 500, 150]; // Wins on 1, 4, 7
    const latenciesC = [500, 150, 50, 500, 150, 50, 500, 150, 50, 500]; // Wins on 2, 5, 8

    urls.A = await createTestServer("A", (id, res) => {
      const delay = latenciesA[callCounts.A] || 500;
      callCounts.A++;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
      }, delay);
    });

    urls.B = await createTestServer("B", (id, res) => {
      const delay = latenciesB[callCounts.B] || 500;
      callCounts.B++;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
      }, delay);
    });

    urls.C = await createTestServer("C", (id, res) => {
      const delay = latenciesC[callCounts.C] || 500;
      callCounts.C++;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
      }, delay);
    });

    // Write the dynamic fleet to the JSON configuration
    // Note: formatChainId maps "0x1" to "x0001"
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        x0001: [urls.A, urls.B, urls.C],
        x0001_WS: [],
      }),
    );
  });

  afterAll(async () => {
    // Clean up the JSON file
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

    // Forcefully close all Keep-Alive sockets so Jest exits cleanly
    for (const srv of servers) {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  test("Manual Refresh: Oracle accurately tracks shifting latencies over 10 rounds", async () => {
    // Reset counters
    callCounts = { A: 0, B: 0, C: 0 };

    const rpc = new RPC({
      chainId: "0x1",
      pathToRpcJson: jsonPath,
      validationTimeout: 1000,
      ttl: 600, // High TTL so we purely test the manual refresh
    });

    // The expected winners for the 10 rounds based on the latency arrays above
    const expectedWinners = [
      urls.A,
      urls.B,
      urls.C,
      urls.A,
      urls.B,
      urls.C,
      urls.A,
      urls.B,
      urls.C,
      urls.A,
    ];

    // Boot it up (Round 0)
    let currentFastest = await rpc.getRpcAsync("https");
    expect(currentFastest).toBe(expectedWinners[0]);

    // Loop through Rounds 1 to 9
    for (let round = 1; round < 10; round++) {
      // Force the Oracle to test the network again
      await rpc.refresh();

      // Ask for the new truth
      currentFastest = rpc.getRpc("https");

      // Assert it perfectly shifted to the new fastest node
      expect(currentFastest).toBe(expectedWinners[round]);
    }

    rpc.destroy();
  }, 20000); // Generous timeout for 10 rounds of real HTTP requests

  test("Auto-TTL: Background loop successfully tracks network chaos hands-free", async () => {
    // Reset counters
    callCounts = { A: 0, B: 0, C: 0 };

    const rpc = new RPC({
      chainId: "0x1",
      pathToRpcJson: jsonPath,
      validationTimeout: 1000,
      ttl: 1,
    });

    const expectedWinners = [
      urls.A,
      urls.B,
      urls.C,
      urls.A,
      urls.B,
      urls.C,
      urls.A,
      urls.B,
      urls.C,
      urls.A,
    ];

    // Round 0: Cold Boot
    let currentFastest = await rpc.getRpcAsync("https");
    expect(currentFastest).toBe(expectedWinners[0]);

    // Loop through Rounds 1 to 9
    for (let round = 1; round < 10; round++) {
      const previousWinner = expectedWinners[round - 1];
      let attempts = 0;

      // THE POLLER: Check every 100ms until the background loop updates the array.
      // Timeout after 30 attempts (3 seconds) to prevent infinite hangs if something breaks.
      while (currentFastest === previousWinner && attempts < 30) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        currentFastest = rpc.getRpc("https"); // Synchronous, zero-latency check
        attempts++;
      }

      // Once it breaks out of the while-loop, it means the URL changed!
      // Assert that it changed to the CORRECT next node.
      expect(currentFastest).toBe(expectedWinners[round]);
    }

    rpc.destroy();
  }, 30000);
});
