import { describe, it, expect } from "vitest";
import { FocusUpdate } from "@shared/contract";

describe("FocusUpdate contract", () => {
  it("accepts working_on with optional next_up", () => {
    expect(FocusUpdate.parse({ working_on: "ship dashboard", next_up: "tests" }))
      .toEqual({ working_on: "ship dashboard", next_up: "tests" });
    expect(FocusUpdate.parse({ working_on: "x" }).next_up).toBeUndefined();
  });
  it("rejects an empty or missing working_on", () => {
    expect(FocusUpdate.safeParse({ working_on: "" }).success).toBe(false);
    expect(FocusUpdate.safeParse({ next_up: "y" }).success).toBe(false);
  });
});
