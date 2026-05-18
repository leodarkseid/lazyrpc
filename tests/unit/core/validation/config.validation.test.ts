import { validateConfig } from "../../../../src/core/validation/config.validation";

describe("core/validation/config.validation", () => {
  test("accepts the minimum valid config", () => {
    expect(() => validateConfig({ chainId: "0x0001" })).not.toThrow();
  });

  test.each([
    [{ chainId: "" }, "chainId is required"],
    [{ chainId: "1" }, "chainId must be in hex format"],
    [{ chainId: "0x1", ttl: 0 }, "ttl must be between 1 and 3600 seconds"],
    [{ chainId: "0x1", ttl: 3601 }, "ttl must be between 1 and 3600 seconds"],
    [{ chainId: "0x1", maxRetry: -1 }, "maxRetry must be between 0 and 10"],
    [{ chainId: "0x1", maxRetry: 11 }, "maxRetry must be between 0 and 10"],
    [{ chainId: "0x1", loadBalancing: "least-connections" }, "loadBalancing must be 'fastest', 'round-robin', or 'random'"],
  ] as const)("rejects invalid config %#", (config, message) => {
    expect(() => validateConfig(config as any)).toThrow(message);
  });

  test.each(["fastest", "round-robin", "random"] as const)("accepts %s load balancing", (loadBalancing) => {
    expect(() => validateConfig({ chainId: "0x1", loadBalancing })).not.toThrow();
  });
});
