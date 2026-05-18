import {
  filterSecureUrls,
  formatChainId,
  mergeCustomUrls,
  validateUrl,
} from "../../../../src/core/validation/url.validation";

describe("core/validation/url.validation", () => {
  describe("validateUrl", () => {
    test.each([
      ["https://rpc.example", "http"],
      ["http://localhost:8545", "http"],
      ["wss://rpc.example", "ws"],
      ["ws://localhost:8546", "ws"],
    ] as const)("accepts %s as %s", (url, type) => {
      expect(validateUrl(url, type, { shouldThrow: true })).toBe(true);
    });

    test("returns false for malformed URLs when not throwing", () => {
      expect(validateUrl("not a url", "http", { shouldThrow: false })).toBe(false);
    });

    test("throws a labelled error for malformed custom URLs", () => {
      expect(() => validateUrl("not a url", "http", {
        shouldThrow: true,
        label: "customRpcs.http",
      })).toThrow('Invalid URL in customRpcs.http: "not a url" is not a valid URL');
    });

    test("rejects HTTP URLs with WebSocket protocols", () => {
      expect(validateUrl("wss://rpc.example", "http", { shouldThrow: false })).toBe(false);
      expect(() => validateUrl("wss://rpc.example", "http", { shouldThrow: true }))
        .toThrow('expected "http:" or "https:"');
    });

    test("rejects WebSocket URLs with HTTP protocols", () => {
      expect(validateUrl("https://rpc.example", "ws", { shouldThrow: false })).toBe(false);
      expect(() => validateUrl("https://rpc.example", "ws", { shouldThrow: true }))
        .toThrow('expected "ws:" or "wss:"');
    });
  });

  describe("mergeCustomUrls", () => {
    test("returns the original base list when custom URLs are omitted", () => {
      const base = ["https://rpc.example"];

      expect(mergeCustomUrls(base, undefined, "http")).toBe(base);
    });

    test("validates, merges, and deduplicates custom URLs", () => {
      expect(mergeCustomUrls(
        ["https://rpc.example"],
        ["https://rpc.example", "https://custom.example"],
        "http",
      )).toEqual(["https://rpc.example", "https://custom.example"]);
    });

    test("throws for empty custom URL arrays", () => {
      expect(() => mergeCustomUrls([], [], "ws")).toThrow("customRpcs.ws must be a non-empty array");
    });

    test("throws for invalid custom URL protocols", () => {
      expect(() => mergeCustomUrls([], ["ftp://rpc.example"], "http")).toThrow("Invalid protocol in customRpcs.http");
    });
  });

  describe("filterSecureUrls", () => {
    test("keeps HTTPS endpoints and local HTTP endpoints", () => {
      expect(filterSecureUrls([
        "https://rpc.example",
        "http://rpc.example",
        "http://localhost:8545",
        "http://127.0.0.1:8545",
      ], "http")).toEqual([
        "https://rpc.example",
        "http://localhost:8545",
        "http://127.0.0.1:8545",
      ]);
    });

    test("keeps WSS endpoints and local WS endpoints", () => {
      expect(filterSecureUrls([
        "wss://rpc.example",
        "ws://rpc.example",
        "ws://localhost:8546",
        "ws://127.0.0.1:8546",
      ], "ws")).toEqual([
        "wss://rpc.example",
        "ws://localhost:8546",
        "ws://127.0.0.1:8546",
      ]);
    });
  });

  describe("formatChainId", () => {
    test.each([
      ["0x1", "x0001"],
      ["0x0001", "x0001"],
      ["0x89", "x89"],
      ["0xA", "xa"],
    ])("formats %s as %s", (chainId, expected) => {
      expect(formatChainId(chainId)).toBe(expected);
    });
  });
});
