import { FastestBalancer, RandomBalancer, RoundRobinBalancer } from "../../../../src/core/balancing";
import type { RPCEndpoint } from "../../../../src/types";

const endpoints: RPCEndpoint[] = [
  { url: "https://rpc-1.example", time: 30 },
  { url: "https://rpc-2.example", time: 20 },
  { url: "https://rpc-3.example", time: 10 },
];

describe("core/balancing", () => {
  describe("FastestBalancer", () => {
    test("selects the first endpoint that is not skipped", () => {
      const balancer = new FastestBalancer();

      expect(balancer.select(endpoints, (url) => url === endpoints[0].url)).toBe(endpoints[1]);
    });

    test("returns undefined when every endpoint is skipped", () => {
      const balancer = new FastestBalancer();

      expect(balancer.select(endpoints, () => true)).toBeUndefined();
    });

    test("returns undefined for an empty endpoint list", () => {
      const balancer = new FastestBalancer();

      expect(balancer.select([], () => false)).toBeUndefined();
    });
  });

  describe("RoundRobinBalancer", () => {
    test("cycles through endpoints and wraps to the beginning", () => {
      const balancer = new RoundRobinBalancer();

      expect([
        balancer.select(endpoints, () => false)?.url,
        balancer.select(endpoints, () => false)?.url,
        balancer.select(endpoints, () => false)?.url,
        balancer.select(endpoints, () => false)?.url,
      ]).toEqual([
        "https://rpc-1.example",
        "https://rpc-2.example",
        "https://rpc-3.example",
        "https://rpc-1.example",
      ]);
    });

    test("skips failing endpoints without advancing past the chosen endpoint", () => {
      const balancer = new RoundRobinBalancer();
      const skipSecond = (url: string) => url === "https://rpc-2.example";

      expect(balancer.select(endpoints, skipSecond)?.url).toBe("https://rpc-1.example");
      expect(balancer.select(endpoints, skipSecond)?.url).toBe("https://rpc-3.example");
      expect(balancer.select(endpoints, skipSecond)?.url).toBe("https://rpc-1.example");
    });

    test("returns undefined when no endpoint is selectable", () => {
      const balancer = new RoundRobinBalancer();

      expect(balancer.select(endpoints, () => true)).toBeUndefined();
    });

    test("keeps independent cursor state per balancer instance", () => {
      const first = new RoundRobinBalancer();
      const second = new RoundRobinBalancer();

      expect(first.select(endpoints, () => false)?.url).toBe("https://rpc-1.example");
      expect(first.select(endpoints, () => false)?.url).toBe("https://rpc-2.example");
      expect(second.select(endpoints, () => false)?.url).toBe("https://rpc-1.example");
    });
  });

  describe("RandomBalancer", () => {
    const randomSpy = jest.spyOn(Math, "random");

    afterEach(() => {
      randomSpy.mockReset();
    });

    afterAll(() => {
      randomSpy.mockRestore();
    });

    test("selects from the unskipped endpoint set", () => {
      randomSpy.mockReturnValue(0.99);
      const balancer = new RandomBalancer();

      expect(balancer.select(endpoints, (url) => url === endpoints[1].url)?.url).toBe("https://rpc-3.example");
    });

    test("uses Math.random to choose the valid endpoint index", () => {
      randomSpy.mockReturnValue(0.34);
      const balancer = new RandomBalancer();

      expect(balancer.select(endpoints, () => false)?.url).toBe("https://rpc-2.example");
    });

    test("returns undefined when all endpoints are skipped", () => {
      randomSpy.mockReturnValue(0);
      const balancer = new RandomBalancer();

      expect(balancer.select(endpoints, () => true)).toBeUndefined();
    });
  });
});
