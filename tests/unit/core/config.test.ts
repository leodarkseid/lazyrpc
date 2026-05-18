import { buildInternalConfig, resolveBaseUrls } from "../../../src/core/config";
import { defaultLogger, silentLogger, type Logger } from "../../../src/core/logger";

const deps = {
  fetchFn: jest.fn() as any,
  websocketClass: class {} as any,
  agent: { name: "agent" },
};

describe("core/config", () => {
  describe("buildInternalConfig", () => {
    test("applies defaults and freezes the internal config", () => {
      const internal = buildInternalConfig({ chainId: "0x1" }, deps);

      expect(internal).toMatchObject({
        chainId: "0x1",
        ttl: 10,
        maxRetry: 3,
        loadBalancing: "fastest",
        baseBackoffDelay: 2_000,
        maxBackoffDelay: 300_000,
        validationTimeout: 5_000,
        enforceHttps: true,
        timeToResetFailedURL: 6 * 60 * 60 * 1_000,
        fetchFn: deps.fetchFn,
        websocketClass: deps.websocketClass,
        agent: deps.agent,
      });
      expect(Object.isFrozen(internal)).toBe(true);
    });

    test("uses explicit config values over defaults", () => {
      const customLogger: Logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const internal = buildInternalConfig({
        chainId: "0x89",
        ttl: 60,
        maxRetry: 7,
        log: customLogger,
        loadBalancing: "random",
        baseBackoffDelay: 50,
        maxBackoffDelay: 500,
        validationTimeout: 750,
        enforceHttps: false,
      }, deps);

      expect(internal).toMatchObject({
        chainId: "0x89",
        ttl: 60,
        maxRetry: 7,
        logger: customLogger,
        loadBalancing: "random",
        baseBackoffDelay: 50,
        maxBackoffDelay: 500,
        validationTimeout: 750,
        enforceHttps: false,
      });
    });

    test("maps log true to the default logger and false/undefined to the silent logger", () => {
      expect(buildInternalConfig({ chainId: "0x1", log: true }, deps).logger).toBe(defaultLogger);
      expect(buildInternalConfig({ chainId: "0x1", log: false }, deps).logger).toBe(silentLogger);
      expect(buildInternalConfig({ chainId: "0x1" }, deps).logger).toBe(silentLogger);
    });

    test("delegates config validation before building", () => {
      expect(() => buildInternalConfig({ chainId: "1" }, deps)).toThrow("chainId must be in hex format");
    });
  });

  describe("resolveBaseUrls", () => {
    const chainList = {
      x0001: [
        "https://rpc-1.example",
        "https://rpc-1.example",
        "http://rpc-2.example",
        "http://localhost:8545",
      ],
      x0001_WS: [
        "wss://ws-1.example",
        "ws://ws-2.example",
        "ws://localhost:8546",
      ],
    };

    test("throws when no chain list is provided", () => {
      expect(() => resolveBaseUrls(null, "0x1")).toThrow("Chain list must be provided to dependencies");
    });

    test("throws when the requested chain is missing", () => {
      expect(() => resolveBaseUrls({}, "0x123")).toThrow("Chain ID 0x123 not found in RPC list");
    });

    test("deduplicates and filters insecure remote URLs by default", () => {
      expect(resolveBaseUrls(chainList, "0x1")).toEqual({
        http: ["https://rpc-1.example", "http://localhost:8545"],
        ws: ["wss://ws-1.example", "ws://localhost:8546"],
      });
    });

    test("keeps insecure remote URLs when enforceHttps is disabled", () => {
      expect(resolveBaseUrls(chainList, "0x1", undefined, false)).toEqual({
        http: ["https://rpc-1.example", "http://rpc-2.example", "http://localhost:8545"],
        ws: ["wss://ws-1.example", "ws://ws-2.example", "ws://localhost:8546"],
      });
    });

    test("merges custom URLs before secure filtering", () => {
      expect(resolveBaseUrls(chainList, "0x1", {
        http: ["https://custom.example", "http://custom.example"],
        ws: ["wss://custom.example", "ws://custom.example"],
      })).toEqual({
        http: ["https://rpc-1.example", "http://localhost:8545", "https://custom.example"],
        ws: ["wss://ws-1.example", "ws://localhost:8546", "wss://custom.example"],
      });
    });
  });
});
