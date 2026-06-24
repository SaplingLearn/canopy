import { Hono } from "hono";
import { IngestPayload } from "@shared/contract";
import type { Env } from "./env";
import { consume } from "./consumer";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";

export const app = new Hono<{ Bindings: Env }>();

app.post("/ingest", async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = IngestPayload.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  // SEAM: today we call the consumer directly. A Cloudflare Queue producer.send(parsed.data)
  // would slot in here later with no change to consume()'s signature.
  const result = await consume(c.env.DB, parsed.data);
  return c.json({ ok: true, result });
});

app.get("/docs", async (c) => {
  const section = c.req.query("section");
  const docs = await list_docs(c.env.DB, section);
  return c.json({ docs });
});

app.get("/doc/:slug", async (c) => {
  const found = await get_doc(c.env.DB, c.req.param("slug"));
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json(found);
});

app.get("/feed", async (c) => {
  const tags = c.req.query("tags");
  const limit = c.req.query("limit");
  const feed = await get_feed(c.env.DB, {
    author: c.req.query("author"),
    tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    since: c.req.query("since"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ feed });
});

app.get("/search", async (c) => {
  const limit = c.req.query("limit");
  const results = await search_context(c.env.DB, c.req.query("q") ?? "", {
    section: c.req.query("section"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ results });
});
