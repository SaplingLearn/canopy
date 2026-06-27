import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ingestFocusUpdate } from "../src/consumer";
import { get_focus } from "../src/tools/reads";
import { all } from "../src/db";
import type { FocusRow } from "@shared/rows";

describe("focus write path (set_focus → ingestFocusUpdate)", () => {
  it("upserts one row per author; a re-write overwrites (no duplicate)", async () => {
    const r = await ingestFocusUpdate(env.DB, { working_on: "wire dashboard", next_up: "tests" }, "andres");
    expect(r.outcome).toBe("written");

    let row = await get_focus(env.DB, "andres");
    expect(row?.working_on).toBe("wire dashboard");
    expect(row?.next_up).toBe("tests");

    await ingestFocusUpdate(env.DB, { working_on: "ship dashboard" }, "andres");
    row = await get_focus(env.DB, "andres");
    expect(row?.working_on).toBe("ship dashboard");
    expect(row?.next_up).toBeNull();

    expect(await all<FocusRow>(env.DB, `SELECT * FROM focus`)).toHaveLength(1);
  });

  it("stores under the passed-in author, and returns null for an author with no focus", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "x" }, "luke");
    expect((await get_focus(env.DB, "luke"))?.author).toBe("luke");
    expect(await get_focus(env.DB, "nobody")).toBeNull();
  });
});
