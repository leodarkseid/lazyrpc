import { fetch as undiciFetch, Agent } from "undici";
import { performance } from "node:perf_hooks";

// Using a fast public aggregator
const URL = "https://cloudflare-eth.com"; 
const REQUESTS = 100;
const CONCURRENCY = 10;

// The standard JSON-RPC payload for getting the latest block
const PAYLOAD = JSON.stringify({
  jsonrpc: "2.0",
  method: "eth_blockNumber",
  params: [],
  id: 1,
});

const HEADERS = {
  "Content-Type": "application/json",
};

/**
 * Calculates comprehensive statistical metrics from an array of latencies
 */
function calculateMetrics(latencies, totalTimeMs) {
  if (latencies.length === 0) return null;
  
  latencies.sort((a, b) => a - b);
  
  const count = latencies.length;
  const sum = latencies.reduce((acc, val) => acc + val, 0);
  
  const rps = count / (totalTimeMs / 1000);
  const avg = sum / count;
  const min = latencies[0];
  const max = latencies[count - 1];
  
  const p50 = latencies[Math.floor(count * 0.50)];
  const p90 = latencies[Math.floor(count * 0.90)];
  const p95 = latencies[Math.floor(count * 0.95)];
  const p99 = latencies[Math.floor(count * 0.99)];
  
  const variance = latencies.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / count;
  const stdDev = Math.sqrt(variance);

  return { rps, totalTimeMs, min, max, avg, stdDev, p50, p90, p95, p99 };
}

async function benchFetch() {
  const latencies = [];
  let completed = 0;
  let errors = 0;
  
  const start = performance.now();

  async function worker() {
    while (true) {
      if (completed >= REQUESTS) break;
      completed++;
      
      const reqStart = performance.now();
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: HEADERS,
          body: PAYLOAD,
        });
        await res.json(); 
        latencies.push(performance.now() - reqStart);
      } catch (err) {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const end = performance.now();
  
  return { metrics: calculateMetrics(latencies, end - start), errors };
}

const nodeAgent = new Agent({ 
  connect: { family: 4 },
  connections: 100, // Explicitly open up the connection pool
});

async function benchUndici() {
  const latencies = [];
  let completed = 0;
  let errors = 0;
  
  const start = performance.now();

  async function worker() {
    while (true) {
      if (completed >= REQUESTS) break;
      completed++;
      
      const reqStart = performance.now();
      try {
        // 3. Use undiciFetch with the explicitly tuned dispatcher
        const res = await undiciFetch(URL, {
          method: "POST",
          headers: HEADERS,
          body: PAYLOAD,
          dispatcher: nodeAgent, // Inject the tuned socket pool
        });
        await res.json(); 
        latencies.push(performance.now() - reqStart);
      } catch (err) {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const end = performance.now();
  
  return { metrics: calculateMetrics(latencies, end - start), errors };
}

function drawBar(label, rps, max) {
  const width = 40;
  const size = Math.round((rps / max) * width) || 1;
  const bar = "█".repeat(size);
  console.log(`${label.padEnd(10)} | ${bar} ${rps.toFixed(1)} req/s`);
}

function printComparisonTable(fetchStats, undiciStats) {
  console.log(`\n=== 📊 UNDICI vs FETCH: PERFORMANCE IMPROVEMENT ===`);
  console.log(`(Positive Green = Undici is Better | Negative Red = Undici is Worse)\n`);
  
  const header = `${"Metric".padEnd(18)} | ${"Fetch".padEnd(12)} | ${"Undici".padEnd(12)} | ${"Diff %"}`;
  console.log(header);
  console.log("-".repeat(60));

  const rows = [
    { key: 'rps', label: 'Throughput', invert: false, unit: 'req/s' },
    { key: 'totalTimeMs', label: 'Total Time', invert: true, unit: 'ms' },
    { key: 'min', label: 'Min Latency', invert: true, unit: 'ms' },
    { key: 'max', label: 'Max Latency', invert: true, unit: 'ms' },
    { key: 'avg', label: 'Average (Mean)', invert: true, unit: 'ms' },
    { key: 'stdDev', label: 'Jitter (StdDev)', invert: true, unit: 'ms' },
    { key: 'p50', label: 'p50 (Median)', invert: true, unit: 'ms' },
    { key: 'p90', label: 'p90 Latency', invert: true, unit: 'ms' },
    { key: 'p95', label: 'p95 Latency', invert: true, unit: 'ms' },
    { key: 'p99', label: 'p99 Latency', invert: true, unit: 'ms' },
  ];

  for (const m of rows) {
    const fVal = fetchStats[m.key];
    const uVal = undiciStats[m.key];
    
    let diffPercent = 0;
    if (m.invert) {
       // For time/latency, lower is better. 
       diffPercent = ((fVal - uVal) / fVal) * 100;
    } else {
       // For RPS, higher is better.
       diffPercent = ((uVal - fVal) / fVal) * 100;
    }

    // ANSI Color Codes
    let colorCode = '\x1b[0m'; // Reset
    let sign = '';
    
    // We give a tiny 0.1% buffer for exact ties to prevent rendering "-0.00%"
    if (diffPercent > 0.1) {
       colorCode = '\x1b[32m'; // Green
       sign = '+';
    } else if (diffPercent < -0.1) {
       colorCode = '\x1b[31m'; // Red
    }

    const diffStr = `${colorCode}${sign}${diffPercent.toFixed(2)}%\x1b[0m`;
    const fStr = `${fVal.toFixed(2)} ${m.unit}`;
    const uStr = `${uVal.toFixed(2)} ${m.unit}`;

    console.log(`${m.label.padEnd(18)} | ${fStr.padEnd(12)} | ${uStr.padEnd(12)} | ${diffStr}`);
  }
}

(async () => {
  console.log(`\nRunning Ethereum RPC benchmark (${REQUESTS} requests, ${CONCURRENCY} concurrent)...\n`);

  const fetchResult = await benchFetch();
  // Brief cooldown to let sockets clear
  await new Promise(resolve => setTimeout(resolve, 1000));
  const undiciResult = await benchUndici();

  const fetchStats = fetchResult.metrics;
  const undiciStats = undiciResult.metrics;

  const maxRps = Math.max(fetchStats.rps, undiciStats.rps);

  console.log("=== THROUGHPUT COMPARISON ===");
  drawBar("fetch", fetchStats.rps, maxRps);
  drawBar("undici", undiciStats.rps, maxRps);

  printComparisonTable(fetchStats, undiciStats);
  console.log("\n");
})();