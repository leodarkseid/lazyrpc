import { RPC } from "../dist/index.js";

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function stressTest() {
    if (!global.gc) {
        console.log("Run node with --expose-gc");
        return;
    }

    const ITERATIONS = 200;
    const INSTANCES = 50;

    global.gc();
    let baseline = process.memoryUsage().heapUsed;

    for (let i = 0; i < ITERATIONS; i++) {
        const rpcs = [];

        for (let j = 0; j < INSTANCES; j++) {
            rpcs.push(new RPC({ chainId: "0x1", ttl: 5 }));
        }

        await sleep(20);

        rpcs.forEach(r => r.destroy());
        rpcs.length = 0;

        global.gc();
        await sleep(20);

        if (i % 10 === 0) {
            const mem = process.memoryUsage().heapUsed;
            console.log(`cycle ${i}`, (mem - baseline) / 1024 / 1024, "MB");
        }
    }
}

stressTest();