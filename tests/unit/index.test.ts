const mockFetch = jest.fn();
const mockAgentDestroy = jest.fn();
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock("undici", () => ({
  fetch: (...args: any[]) => mockFetch(...args),
  Agent: class {
    destroy = mockAgentDestroy;
    constructor(public options: any) {}
  },
}));

jest.mock("ws", () => ({
  WebSocket: class {},
}));

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

import { RPC } from "../../src/index";

describe("index", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
    });
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      x0001: ["https://rpc.example"],
      x0001_WS: [],
    }));
    mockAgentDestroy.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test("loads the bundled RPC list when a custom path is absent or missing", () => {
    const rpc = new RPC({ chainId: "0x1" });

    expect(mockReadFileSync.mock.calls[0][0]).toContain("rpcList.min.json");
    expect(rpc.getAllCandidateRPCs("https")).toEqual(["https://rpc.example"]);
    expect(() => rpc.getRpc("https")).toThrow("No validated https RPC URLs available yet");

    rpc.destroy();
  });

  test("loads a custom RPC list when the configured path exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      x0001: ["https://custom.example"],
    }));

    const rpc = new RPC({ chainId: "0x1", pathToRpcJson: "/tmp/custom-rpcs.json" });

    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/custom-rpcs.json", "utf-8");
    expect(rpc.getAllCandidateRPCs("https")).toEqual(["https://custom.example"]);

    rpc.destroy();
  });

  test("uses a supplied agent instead of constructing ownership-sensitive behavior", async () => {
    const agent = { destroy: jest.fn() };
    const rpc = new RPC({ chainId: "0x1", agent });

    await rpc.destroy();

    expect(agent.destroy).toHaveBeenCalledTimes(1);
  });

  test("rethrows JSON parsing failures from the RPC list", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new SyntaxError("bad json");
    });

    expect(() => new RPC({ chainId: "0x1" })).toThrow("bad json");
  });
});
