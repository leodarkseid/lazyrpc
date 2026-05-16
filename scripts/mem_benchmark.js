import { fetch as undiciFetch, Agent } from "undici";
import { performance } from "node:perf_hooks";

const URL = "https://cloudflare-eth.com"; 
const REQUESTS = 100;
const CONCURRENCY = 10;

const PAYLOAD = JSON.stringify({
  jsonrpc: "2.0",
  method: "eth_blockNumber",
  params: [],
  id: 1,
});

const HEADERS = { "Content-Type": "application/json" };

// Using the explicitly tuned Agent to prevent socket exhaustion!
const nodeAgent = new Agent({ 
  connect: { family: 4 },
  connections: 100, 
});

/**
 * Wraps a benchmark function to continuously poll V8 Heap Memory
 */
async function trackMemoryMetrics(fn) {
  // 1. Force a brutal Garbage Collection to get a clean baseline
  if (global.gc) global.gc(); 
  
  const startHeap = process.memoryUsage().heapUsed;
  const memorySamples = [];

  // 2. Poll the memory bloat every 5 milliseconds
  const poller = setInterval(() => {
    const currentHeap = process.memoryUsage().heapUsed;
    // Track how many bytes we have bloated above the starting baseline
    memorySamples.push(Math.max(0, currentHeap - startHeap));
  }, 5);

  // 3. Run the actual network requests
  await fn();
  
  // 4. Stop polling
  clearInterval(poller);

  // Fallback just in case the benchmark ran faster than 5ms
  if (memorySamples.length === 0) {
      memorySamples.push(Math.max(0, process.memoryUsage().heapUsed - startHeap));
  }

  // 5. Calculate statistical distribution of the memory bloat
  const count = memorySamples.length;
  const sum = memorySamples.reduce((acc, val) => acc + val, 0);
  
  const peak = Math.max(...memorySamples);
  const end = memorySamples[count - 1]; // Memory state right as it finished
  const avg = sum / count;
  
  // Variance/StdDev shows how violently the memory spiked up and down
  const variance = memorySamples.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / count;
  const stdDev = Math.sqrt(variance);

  // Convert everything from Bytes to Megabytes (MB)
  return {
    peakMB: peak / 1024 / 1024,
    endMB: end / 1024 / 1024,
    avgMB: avg / 1024 / 1024,
    stdDevMB: stdDev / 1024 / 1024,
  };
}

async function benchFetch() {
  let completed = 0;
  async function worker() {
    while (true) {
      if (completed >= REQUESTS) break;
      completed++;
      try {
        const res = await fetch(URL, { method: "POST", headers: HEADERS, body: PAYLOAD });
        await res.json(); 
      } catch (err) {}
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function benchUndici() {
  let completed = 0;
  async function worker() {
    while (true) {
      if (completed >= REQUESTS) break;
      completed++;
      try {
        const res = await undiciFetch(URL, { 
            method: "POST", 
            headers: HEADERS, 
            body: PAYLOAD,
            dispatcher: nodeAgent // Use our tuned agent
        });
        await res.json(); 
      } catch (err) {}
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function printMemoryComparisonTable(fetchStats, undiciStats) {
  console.log(`\n=== 🧠 UNDICI vs FETCH: MEMORY EFFICIENCY ===`);
  console.log(`(Positive Green = Undici uses LESS memory | Negative Red = Undici uses MORE memory)\n`);
  
  const header = `${"Metric".padEnd(20)} | ${"Fetch".padEnd(12)} | ${"Undici".padEnd(12)} | ${"Diff %"}`;
  console.log(header);
  console.log("-".repeat(64));

  const rows = [
    { key: 'peakMB', label: 'Peak Heap Bloat', unit: 'MB' },
    { key: 'avgMB', label: 'Average Bloat', unit: 'MB' },
    { key: 'endMB', label: 'End State Bloat', unit: 'MB' },
    { key: 'stdDevMB', label: 'Volatility (StdDev)', unit: 'MB' },
  ];

  for (const m of rows) {
    const fVal = fetchStats[m.key];
    const uVal = undiciStats[m.key];
    
    // For memory, lower is always better. 
    // If Undici is lower, the diff is positive (green).
    const diffPercent = fVal === 0 ? 0 : ((fVal - uVal) / fVal) * 100;

    let colorCode = '\x1b[0m'; 
    let sign = '';
    
    if (diffPercent > 0.5) {
       colorCode = '\x1b[32m'; // Green (Undici saved memory)
       sign = '+';
    } else if (diffPercent < -0.5) {
       colorCode = '\x1b[31m'; // Red (Undici wasted memory)
    }

    const diffStr = `${colorCode}${sign}${diffPercent.toFixed(2)}%\x1b[0m`;
    const fStr = `${fVal.toFixed(2)} ${m.unit}`;
    const uStr = `${uVal.toFixed(2)} ${m.unit}`;

    console.log(`${m.label.padEnd(20)} | ${fStr.padEnd(12)} | ${uStr.padEnd(12)} | ${diffStr}`);
  }
}

(async () => {
  if (!global.gc) {
    console.log("\x1b[31m%s\x1b[0m", "🚨 FATAL: You must run this script with 'node --expose-gc script.js' to get accurate memory readings!");
    process.exit(1);
  }

  console.log(`\nRunning Ethereum RPC Memory Benchmark (${REQUESTS} requests, ${CONCURRENCY} concurrent)...\n`);

  const fetchStats = await trackMemoryMetrics(benchFetch);
  
  // Give Node a moment to settle
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const undiciStats = await trackMemoryMetrics(benchUndici);

  printMemoryComparisonTable(fetchStats, undiciStats);
  console.log("\n");
})();