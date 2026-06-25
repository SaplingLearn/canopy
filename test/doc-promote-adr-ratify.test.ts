import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { propose_doc_update, stage_adr, promote_doc, ratify_adr } from "../src/tools/writes";
import { first } from "../src/db";
import type { DocRow, DocVersionRow, AdrRow } from "@shared/rows";

const base = { slug: "architecture", section: "reference", title: "Architecture", confidence: "high" as const };

describe("promote_doc", () => {
  it("flips the version to promoted, copies body into docs, bumps current_version, keeps prior versions", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    await propose_doc_update(env.DB, { ...base, body: "# v2", change_summary: "second" }, "andres");

    const out = await promote_doc(env.DB, "architecture", 2, "andres");
    expect(out).toEqual({ slug: "architecture", version: 2, status: "promoted" });

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(2);
    expect(doc?.body).toBe("# v2");
    expect(doc?.updated_by).toBe("andres");

    const v1 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ? AND version = 1`, "architecture");
    const v2 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ? AND version = 2`, "architecture");
    expect(v1?.status).toBe("staged");   // prior version intact, untouched
    expect(v1?.body).toBe("# v1");
    expect(v2?.status).toBe("promoted");
  });

  it("rejects a version that does not exist", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    await expect(promote_doc(env.DB, "architecture", 99, "andres")).rejects.toThrow();
  });

  it("rejects promoting an already-promoted (non-staged) version", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    await promote_doc(env.DB, "architecture", 1, "andres");
    await expect(promote_doc(env.DB, "architecture", 1, "andres")).rejects.toThrow();
  });
});

describe("ratify_adr", () => {
  it("flips a draft to ratified", async () => {
    const id = await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const out = await ratify_adr(env.DB, id);
    expect(out).toEqual({ id, status: "ratified" });
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("ratified");
  });

  it("rejects a missing adr", async () => {
    await expect(ratify_adr(env.DB, 4242)).rejects.toThrow();
  });

  it("rejects an already-ratified adr", async () => {
    const id = await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    await ratify_adr(env.DB, id);
    await expect(ratify_adr(env.DB, id)).rejects.toThrow();
  });
});
