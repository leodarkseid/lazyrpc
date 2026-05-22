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
        chainId: "x0001",
        ttl: 1200,
        maxRetry: 3,
        loadBalancing: "fastest",
        baseBackoffDelay: 1_800_000,
        maxBackoffDelay: 3_600_000,
        validationTimeout: 5_000,
        enforceHttps: true,
        timeToResetFailedURL: 6 * 60 * 60 * 1_000,
        fetchFn: deps.fetchFn,
        websocketClass: deps.websocketClass,
        agent: deps.agent,
        maxPayloadBytes: 2048,
        maxPayloadDepth: 3,
        maxPayloadKeys: 10,
        maxPayloadArrayLength: 10,
        maxPayloadStringBytes: 100,
        requireJsonContentType: true,
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
        maxPayloadBytes: 2048,
        maxPayloadDepth: 8,
        maxPayloadKeys: 50,
        maxPayloadArrayLength: 25,
        maxPayloadStringBytes: 512,
        requireJsonContentType: false,
      }, deps);

      expect(internal).toMatchObject({
        chainId: "x89",
        ttl: 60,
        maxRetry: 7,
        logger: customLogger,
        loadBalancing: "random",
        baseBackoffDelay: 50,
        maxBackoffDelay: 500,
        validationTimeout: 750,
        enforceHttps: false,
        maxPayloadBytes: 2048,
        maxPayloadDepth: 8,
        maxPayloadKeys: 50,
        maxPayloadArrayLength: 25,
        maxPayloadStringBytes: 512,
        requireJsonContentType: false,
      });
    });

    test("maps log true to the default logger and false/undefined to the silent logger", () => {
      expect(buildInternalConfig({ chainId: "0x1", log: true }, deps).logger).toBe(defaultLogger);
      expect(buildInternalConfig({ chainId: "0x1", log: false }, deps).logger).toBe(silentLogger);
      expect(buildInternalConfig({ chainId: "0x1" }, deps).logger).toBe(silentLogger);
    });

    test("incorporates custom agent from RPCConfig properly, overriding dependencies agent", () => {
      const customAgent = { name: "custom-undici-agent" };
      const internal = buildInternalConfig({ chainId: "0x1", agent: customAgent }, deps);
      expect(internal.agent).toBe(customAgent);
    });

    test("falls back to dependencies agent when RPCConfig omits agent", () => {
      const internal = buildInternalConfig({ chainId: "0x1" }, deps);
      expect(internal.agent).toBe(deps.agent);
    });

    test("handles full spectrum of valid configurations", () => {
      const fullConfig = {
        chainId: "0xaa36a7",
        ttl: 3600,
        maxRetry: 10,
        log: true,
        loadBalancing: "round-robin" as const,
        baseBackoffDelay: 100,
        maxBackoffDelay: 60000,
        validationTimeout: 10000,
        timeToResetFailedURL: 300000,
        customRpcs: {
          http: ["https://full-custom-http.com"],
          ws: ["wss://full-custom-ws.com"],
        },
        enforceHttps: true,
        agent: { custom: true },
        maxPayloadBytes: 500,
        maxPayloadDepth: 5,
        maxPayloadKeys: 10,
        maxPayloadArrayLength: 5,
        maxPayloadStringBytes: 100,
        requireJsonContentType: false,
      };

      const internal = buildInternalConfig(fullConfig, deps);

      expect(internal).toMatchObject({
        chainId: "xaa36a7",
        ttl: 3600,
        maxRetry: 10,
        logger: defaultLogger,
        loadBalancing: "round-robin",
        baseBackoffDelay: 100,
        maxBackoffDelay: 60000,
        validationTimeout: 10000,
        timeToResetFailedURL: 300000,
        enforceHttps: true,
        agent: fullConfig.agent,
        maxPayloadBytes: 500,
        maxPayloadDepth: 5,
        maxPayloadKeys: 10,
        maxPayloadArrayLength: 5,
        maxPayloadStringBytes: 100,
        requireJsonContentType: false,
      });
    });

    test("parses chainId correctly from various input formats", () => {
      // Hex strings
      expect(buildInternalConfig({ chainId: "0x1" }, deps).chainId).toBe("x0001");
      expect(buildInternalConfig({ chainId: "0X1" }, deps).chainId).toBe("x0001");
      expect(buildInternalConfig({ chainId: "0xaa36a7" }, deps).chainId).toBe("xaa36a7");
      
      // Numeric strings
      expect(buildInternalConfig({ chainId: "137" }, deps).chainId).toBe("x89");
      expect(buildInternalConfig({ chainId: "1" }, deps).chainId).toBe("x0001");

      // Hex strings without 0x
      expect(buildInternalConfig({ chainId: "aa36a7" }, deps).chainId).toBe("xaa36a7");

      // Numbers
      expect(buildInternalConfig({ chainId: 137 }, deps).chainId).toBe("x89");
      expect(buildInternalConfig({ chainId: 1 }, deps).chainId).toBe("x0001");

      // Invalid inputs
      expect(() => buildInternalConfig({ chainId: -1 }, deps)).toThrow("chainId number must be a positive integer");
      expect(() => buildInternalConfig({ chainId: "invalid" }, deps)).toThrow("chainId must be in hex format");
      expect(() => buildInternalConfig({ chainId: null as any }, deps)).toThrow("chainId is required");
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
        http: [
          { url: "https://rpc-1.example", originalFormat: "string" },
          { url: "http://localhost:8545", originalFormat: "string" }
        ],
        ws: [
          { url: "wss://ws-1.example", originalFormat: "string" },
          { url: "ws://localhost:8546", originalFormat: "string" }
        ],
      });
    });

    test("keeps insecure remote URLs when enforceHttps is disabled", () => {
      expect(resolveBaseUrls(chainList, "0x1", undefined, false)).toEqual({
        http: [
          { url: "https://rpc-1.example", originalFormat: "string" },
          { url: "http://rpc-2.example", originalFormat: "string" },
          { url: "http://localhost:8545", originalFormat: "string" }
        ],
        ws: [
          { url: "wss://ws-1.example", originalFormat: "string" },
          { url: "ws://ws-2.example", originalFormat: "string" },
          { url: "ws://localhost:8546", originalFormat: "string" }
        ],
      });
    });

    test("merges custom URLs before secure filtering", () => {
      expect(resolveBaseUrls(chainList, "0x1", {
        http: ["https://custom.example", "http://custom.example"],
        ws: ["wss://custom.example", "ws://custom.example"],
      })).toEqual({
        http: [
          { url: "https://rpc-1.example", originalFormat: "string" },
          { url: "http://localhost:8545", originalFormat: "string" },
          { url: "https://custom.example", originalFormat: "string" }
        ],
        ws: [
          { url: "wss://ws-1.example", originalFormat: "string" },
          { url: "ws://localhost:8546", originalFormat: "string" },
          { url: "wss://custom.example", originalFormat: "string" }
        ],
      });
    });

    test("merges custom endpoint objects before secure filtering", () => {
      expect(resolveBaseUrls(chainList, "0x1", {
        http: [
          "https://custom.example", 
          { url: "https://custom2.example", query: { "key": "val" } }
        ] as any,
        ws: [
          "wss://custom.example", 
          { url: "wss://custom2.example", headers: { "X-Auth": "token" } }
        ] as any,
      })).toEqual({
        http: [
          { url: "https://rpc-1.example", originalFormat: "string" },
          { url: "http://localhost:8545", originalFormat: "string" },
          { url: "https://custom.example", originalFormat: "string" },
          { url: "https://custom2.example", originalFormat: "object", query: { "key": "val" } }
        ],
        ws: [
          { url: "wss://ws-1.example", originalFormat: "string" },
          { url: "ws://localhost:8546", originalFormat: "string" },
          { url: "wss://custom.example", originalFormat: "string" },
          { url: "wss://custom2.example", originalFormat: "object", headers: { "X-Auth": "token" } }
        ],
      });
    });
  });
});
