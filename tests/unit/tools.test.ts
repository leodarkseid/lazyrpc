import { assert } from "../../src/tools";

describe("tools", () => {
  test("assert does nothing for truthy conditions", () => {
    expect(() => assert(true, "should not throw")).not.toThrow();
  });

  test("assert throws the provided message for falsy conditions", () => {
    expect(() => assert(false, "expected failure")).toThrow("expected failure");
  });
});
