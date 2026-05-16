import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RPC } from "lazy-rpc";

describe("lazy-rpc Usage Package Tests", () => {
    it("should properly export the RPC class", () => {
        assert.ok(RPC, "RPC should be exported");
        assert.strictEqual(typeof RPC, "function", "RPC should be a constructable class/function");
    });

    it("should instantiate and connect to Polygon (0x89)", async () => {
        const polyRPC = new RPC({
            chainId: "0x89", // Polygon
            log: false
        });

        // Wait for initialize to fetch fastest endpoint
        const httpRpc = await polyRPC.getRpcAsync("https");
        assert.ok(httpRpc.startsWith("http"), "Should return a valid HTTP URL");

        const wsRpc = await polyRPC.getRpcAsync("ws");
        assert.ok(wsRpc.startsWith("ws"), "Should return a valid WebSocket URL");

        assert.ok(polyRPC.getValidRPCCount("https") > 0, "Should have active valid RPCs loaded");

        polyRPC.destroy();
    });

    it("should instantiate and handle zero-padded chain IDs like Ethereum (0x1)", async () => {
        const ethRPC = new RPC({
            chainId: "0x1", // Ethereum
            log: false
        });

        const ethHttp = await ethRPC.getRpcAsync("https");
        assert.ok(ethHttp.startsWith("http"), "Should return a valid HTTP URL for Ethereum");

        ethRPC.destroy();
    });

    it("should respect the Random loadBalancing configuration", async () => {
        const arbRPC = new RPC({
            chainId: "0xa4b1", // Arbitrum
            loadBalancing: "random",
            log: false
        });

        await arbRPC.refresh(); // manually trigger validation loop

        const rpc1 = arbRPC.getRpc("https");
        const rpc2 = arbRPC.getRpc("https");

        assert.ok(rpc1 && rpc2, "Should return RPCs synchronously after refresh");

        arbRPC.destroy();
    });
});
