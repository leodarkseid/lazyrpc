import { RPC } from "../../src/index";

describe("RPC Memory & Garbage Collection Tests", () => {

    // Safety check to ensure the user ran the test with --expose-gc
    beforeAll(() => {
        if (!global.gc) {
            console.warn("Garbage collection is not exposed. Run tests with --expose-gc");
        }
    });

    test("1. closure trap: instance is garbage collected if user forgets to call destroy()", async () => {
        // We must skip this test if GC isn't exposed
        if (!global.gc) return;

        let weakTracker: WeakRef<RPC>;

        // We use an IIFE (Immediately Invoked Function Expression) to simulate 
        // a local function scope where the user creates the RPC but drops it.
        (() => {
            const orphanedRpc = new RPC({ chainId: "0x1", validationTimeout: 1, ttl: 10 });

            // We attach a WeakRef to it so the test can spy on it 
            // without accidentally keeping it alive.
            weakTracker = new WeakRef(orphanedRpc);
        })();

        await new Promise((resolve) => setTimeout(resolve, 100));

        // 1. Verify it currently exists in memory
        // expect(weakTracker.deref()).toBeDefined();

        // 2. Force the Node.js Garbage Collector to run NOW
        global.gc();
        global.gc();
        for (let i = 0; i < 10; i++) {
            global.gc();
            await new Promise(r => setTimeout(r, 20));
        }

        // 3. Give the event loop a tiny tick to sweep
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // 4. THE MOMENT OF TRUTH: If the closure trap is fixed, deref() will return undefined.
        // If there is a memory leak, it will still return the RPC instance.
        expect(weakTracker.deref()).toBeUndefined();
    });


    test("2. memory footprint remains flat after heavy initialization", async () => {
        if (!global.gc) return;

        // Force a baseline GC before we start measuring
        global.gc();
        const baselineMemory = process.memoryUsage().heapUsed;

        // Simulate a heavy workload: creating 50 RPC instances simultaneously
        const activeRPCs: RPC[] = [];
        for (let i = 0; i < 50; i++) {
            activeRPCs.push(new RPC({ chainId: "0x1", ttl: 60 }));
        }

        // Measure memory during peak load
        const peakMemory = process.memoryUsage().heapUsed;

        // Ensure memory went up (proving our test is actually measuring something)
        expect(peakMemory).toBeGreaterThan(baselineMemory);

        // Now, let's destroy them and clear our array to drop the references
        activeRPCs.forEach(rpc => rpc.destroy());
        activeRPCs.length = 0;

        // Force the GC to clean up the aftermath
        global.gc();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Measure the final memory
        const finalMemory = process.memoryUsage().heapUsed;

        // Calculate the difference in Megabytes
        const diffMB = (finalMemory - baselineMemory) / 1024 / 1024;

        // THE ASSERTION: 
        // Memory should return to practically exactly where it started. 
        // We allow a tiny 1MB variance for Node's internal V8 engine caching.
        console.log({ diffMB })
        expect(diffMB).toBeLessThan(1); // Fails if memory leaked!
    });
});