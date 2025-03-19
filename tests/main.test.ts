import { RPC } from "../src/main";
import * as fs from "fs";

global.fetch = jest.fn(async () =>
  Promise.resolve({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }),
  })
) as jest.Mock;

global.WebSocket = class {
  onopen: () => void = () => {};
  onmessage: (event: { data: any }) => void = () => {};
  send = jest.fn();
  close = jest.fn();
} as any;

describe("RPC Class Test", () => {
  let rpc: RPC;
  let initializeSpy: jest.SpyInstance;
  let fsPromises: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        x0001: ["https://rpc1.com", "https://rpc2.com"],
        x0001_WS: ["wss://ws1.com", "wss://ws2.com"],
      })
    );
    fsPromises = jest.spyOn(fs.promises, "readFile").mockResolvedValue(
      JSON.stringify({
        x0001: ["https://mock-http-rpc.com", "https://rpc2.com"],
        x0001_WS: ["wss://mock-ws-rpc.com", "wss://ws2.com"],
      })
    );

    jest.useFakeTimers(); // Control time-related functions
    initializeSpy = jest.spyOn(RPC.prototype as any, "intialize");
    rpc = new RPC({ chainId: "0x0001", ttl: 5, maxRetry: 3 });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
  });

  test("should initialize with the correct RPC endpoints", () => {
    expect(rpc.getRpc("https")).toBe("https://mock-http-rpc.com");
    expect(rpc.getRpc("ws")).toBe("wss://mock-ws-rpc.com");
  });

  test("should call intialize() periodically", () => {
    expect(initializeSpy).toHaveBeenCalledTimes(1); // First call happens in the constructor

    jest.advanceTimersByTime(5000); // Simulate 5 seconds passing
    expect(initializeSpy).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(5000); // Simulate another 5 seconds
    expect(initializeSpy).toHaveBeenCalledTimes(2);
  });

  test("should make a valid HTTP call", async () => {
    await rpc["httpCall"]("https://mock-http-rpc.com", 1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://mock-http-rpc.com",
      expect.any(Object)
    );
  });

  test("should update RPC list based on response time", async () => {
    await rpc["intialize"]();
    expect(rpc.getRpc("https")).toBe("https://mock-http-rpc.com");
    expect(rpc.getRpc("ws")).toBe("wss://mock-ws-rpc.com");
  });

  test("should throw an error for invalid type", () => {
    expect(() => rpc.getRpc("invalid" as any)).toThrow("Invalid Type");
  });

  it("should mark an RPC as failed when drop is called", () => {
    const rpc = new RPC({ chainId: "0x0001" });
    rpc.drop("https://mock-http-rpc.com");

    expect(rpc["failedURL"].has("https://mock-http-rpc.com")).toBe(true);
  });

  // it("should retry and drop an RPC URL after max retries", async () => {
  //   jest
  //     .spyOn(fs.promises, "readFile")
  //     .mockResolvedValue(JSON.stringify({ "0001": ["https://mock-fail.com"] }));

  //   global.fetch = jest
  //     .fn()
  //     .mockRejectedValueOnce(new Error("Network Error")) // First try fails
  //     .mockResolvedValueOnce({
  //       ok: true,
  //       json: async () => ({ id: 1, result: "0x10" }),
  //     }); // Second try succeeds

  //   const rpc = new RPC({ chainId: "0x0001", maxRetry: 2 });
  //   await rpc.start();

  //   expect(rpc.getRpc("https")).toBe("https://mock-fail.com");
  // });
});
