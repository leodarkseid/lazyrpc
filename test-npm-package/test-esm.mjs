import { RPC } from "lazy-rpc";

async function run() {
    try {
        const polygonRPC = new RPC({
            chainId: "0x89",
            log: false
        });
        const url = await polygonRPC.getRpcAsync("https");
        console.log("ESM loaded URL:", url);
        polygonRPC.destroy();
    } catch(err) {
        console.error("ESM ERROR:", err);
    }
}
run();
