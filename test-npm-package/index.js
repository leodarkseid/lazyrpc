import { RPC } from "lazy-rpc";

async function main() {
    console.log("🚀 Testing lazy-rpc Package...\n");

    try {
        // 1. Initialize RPC for Polygon (chain ID 0x89)
        const polygonRPC = new RPC({
            chainId: "0x89",
            log: false, // Output debug errors
            maxRetry: 2,
            validationTimeout: 10000
        });

        console.log("⏳ Fetching and validating Polygon RPCs...");

        try {
            // getRpcAsync automatically waits for the first validation round
            const polyHttp = await polygonRPC.getRpcAsync("https");
            const polyWs = await polygonRPC.getRpcAsync("ws");

            console.log("✅ Polygon Fast HTTP RPC:", polyHttp);
            console.log("✅ Polygon Fast WebSocket RPC:", polyWs);
            console.log(`📊 Valid Active Polygon HTTP RPCs: ${polygonRPC.getValidRPCCount("https")}\n`);
        } catch (e) {
            console.log("⚠️ Polygon network fully partitioned offline in this environment:", e.message, "\n");
        }

        // 2. Initialize RPC for Arbitrum (chain ID 0xa4b1) 
        // Testing the random load balancing strategy
        console.log("⏳ Initializing Arbitrum RPCs with Random Load Balancing...");
        const arbitrumRPC = new RPC({
            chainId: "0xa4b1",
            loadBalancing: "random",
            log: false,
            validationTimeout: 10000
        });

        try {
            // We can also use refresh() to manually wait for validation
            await arbitrumRPC.refresh();

            // Grab a few URLs to demonstrate randomness
            const arbRpc1 = arbitrumRPC.getRpc("https");
            const arbRpc2 = arbitrumRPC.getRpc("https");

            console.log("🎲 Random Arbitrum HTTP RPC 1:", arbRpc1);
            console.log("🎲 Random Arbitrum HTTP RPC 2:", arbRpc2);
        } catch (e) {
            console.log("⚠️ Arbitrum network fully partitioned offline in this environment:", e.message);
        }

        // Show failure statistics
        const stats = arbitrumRPC.getFailureStats();
        console.log(`📈 Arbitrum Failure Stats: ${JSON.stringify(stats)}\n`);

        // 3. Initialize RPC for Ethereum Mainnet (chain ID 0x1)
        console.log("\n⏳ Initializing Ethereum (Mainnet) RPCs...");
        const ethRPC = new RPC({
            chainId: "0x1",
            loadBalancing: "fastest",
            validationTimeout: 5000,
            log: false
        });

        console.log("✅ Testing resilient .call() Wrapper on Ethereum...");
        try {
            const blockNumberHex = await ethRPC.call("https", "eth_blockNumber", [], 8000, 3);
            console.log(`✅ Ethereum Latest Block Number: ${parseInt(blockNumberHex, 16)}\n`);
        } catch (callError) {
            console.error("❌ call() failed:", callError.message);
        }


        // Clean up instances when done to clear internal timers
        polygonRPC.destroy();
        arbitrumRPC.destroy();
        ethRPC.destroy();
        console.log("\n🧹 Cleaned up RPC instances.");

    } catch (error) {
        console.error("❌ Error running script:", error.message);
    }
}

main();
