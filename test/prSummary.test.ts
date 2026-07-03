import { describe, it, expect } from "vitest";
import { parseStructuredSummary } from "@shared/prSummary";

describe("parseStructuredSummary", () => {
  it("parses What changed + Why into separate fields", () => {
    const raw = "**What changed:** Fixed the login bug.\n**Why:** Users were being logged out unexpectedly.";
    expect(parseStructuredSummary(raw)).toEqual({
      what: "Fixed the login bug.",
      why: "Users were being logged out unexpectedly.",
    });
  });

  it("parses What changed alone, why:null, when there is no Why line", () => {
    const raw = "**What changed:** Fixed the login bug.";
    expect(parseStructuredSummary(raw)).toEqual({ what: "Fixed the login bug.", why: null });
  });

  it("handles What changed and Why on the same line", () => {
    const raw = "**What changed:** Fixed the login bug. **Why:** Users were affected.";
    expect(parseStructuredSummary(raw)).toEqual({
      what: "Fixed the login bug.",
      why: "Users were affected.",
    });
  });

  it("is case-insensitive on the labels", () => {
    const raw = "**what changed:** Fixed the login bug.\n**why:** Users were affected.";
    expect(parseStructuredSummary(raw)).toEqual({
      what: "Fixed the login bug.",
      why: "Users were affected.",
    });
  });

  it("returns null for old-style prose with no convention", () => {
    expect(parseStructuredSummary("Fixed a bug that was breaking the login flow.")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseStructuredSummary("")).toBeNull();
  });

  it("returns null when the What field is empty even if a Why is present", () => {
    const raw = "**What changed:** \n**Why:** something";
    expect(parseStructuredSummary(raw)).toBeNull();
  });
});
