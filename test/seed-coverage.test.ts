import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { getMyWork } from "../src/tools/mywork";
import { get_plan } from "../src/tools/plan";
import { query, get_feed, list_proposals, list_needs_triage, list_adrs, list_identity_tasks, list_tickets, get_ticket, ticket_badge } from "../src/tools/reads";
import { all } from "../src/db";
import docs from "../fixtures/dev/docs.json";
import feed from "../fixtures/dev/feed.json";
import adrs from "../fixtures/dev/adrs.json";
import triage from "../fixtures/dev/triage.json";
import roadmap from "../fixtures/dev/roadmap.json";
import events from "../fixtures/dev/events.json";
import identity from "../fixtures/dev/identity.json";
import tickets from "../fixtures/dev/tickets.json";

const fx = { docs, feed, adrs, triage, roadmap, events, identity, tickets };

beforeEach(async () => {
  for (const stmt of buildSeedStatements(fx)) {
    await env.DB.prepare(stmt).run();
  }
});

describe("dev seed lights up every surface", () => {
  it("My Work: previous activity + to-dos for AndresL230", async () => {
    const mw = await getMyWork(env.DB, "AndresL230");
    expect(mw.degraded).toBe(false);
    expect(mw.person).toBe("Andres");
    expect(mw.previousActivity.length).toBeGreaterThan(0);
    expect(mw.todo.length).toBeGreaterThan(0);
    // Priority tags parsed + stripped from assigned issues.
    expect(mw.todo.some((t) => t.priority === "P0")).toBe(true);
    expect(mw.todo.some((t) => t.priority === "P1")).toBe(true);
    // Structured summaries (0018) reach the DTO, not just the prose mirror.
    expect(mw.previousActivity.some((p) => p.what !== null && p.displayTitle !== null)).toBe(true);
    expect(mw.previousActivity.some((p) => p.baseRef === "main")).toBe(true);
    expect(mw.todo.some((t) => t.displayTitle !== null && t.nextStep !== null)).toBe(true);
    // Widened issue raw (0018): milestone title/due_on renders on a card.
    expect(mw.todo.some((t) => t.milestone !== null && t.milestone.title.length > 0)).toBe(true);
  });

  it("Roadmap: narrative + sprints carrying progress, the 0025 fields, and resources", async () => {
    const plan = await get_plan(env.DB);
    expect(plan.narrative.length).toBeGreaterThan(0);
    expect(plan.sprints.length).toBe(7);
    expect(plan.sprints.some((sp) => sp.progress.total > 0)).toBe(true);
    // Sprints span multiple roadmap phases…
    expect(new Set(plan.sprints.map((sp) => sp.phase)).size).toBeGreaterThan(1);
    // …and the seed exercises every 0025 field, so the Roadmap card has something
    // to render for each of them.
    expect(plan.sprints.every((sp) => sp.summary !== null && sp.dates !== null)).toBe(true);
    expect(new Set(plan.sprints.map((sp) => sp.urgency))).toEqual(new Set(["low", "normal", "high"]));
    expect(plan.sprints.every((sp) => sp.lead !== null && sp.domain !== null)).toBe(true);
    expect(plan.sprints.some((sp) => sp.active)).toBe(true);

    const resources = await all<{ sprint_id: number; kind: string }>(env.DB, `SELECT * FROM sprint_resources`);
    expect(new Set(resources.map((r) => r.sprint_id)).size).toBe(2);
    expect(new Set(resources.map((r) => r.kind))).toEqual(new Set(["github", "figma", "plain"]));
  });

  it("People: the four engineers plus the two non-engineer requesters", async () => {
    const persons = await all<{ handle: string }>(env.DB, `SELECT handle FROM persons ORDER BY handle`);
    expect(persons.map((p) => p.handle)).toEqual(
      ["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch", "meilin", "sanaok"].sort()
    );
    // meilin / sanaok are Google-only: no github identity, so they can never
    // collide with an event subject_login.
    const ids = await all<{ provider: string; person: string }>(env.DB, `SELECT provider, person FROM identities`);
    expect(ids.filter((i) => i.person === "meilin").map((i) => i.provider)).toEqual(["google"]);
    expect(ids.filter((i) => i.person === "sanaok").map((i) => i.provider)).toEqual(["google"]);
  });

  it("Tickets: the queue lights up — badge, links, nesting, sprint labels, comments, history", async () => {
    // The sidebar badge is non-zero, so the nav renders it out of the box.
    const badge = await ticket_badge(env.DB);
    expect(badge).toBeGreaterThan(0);

    // `seg=open` = submitted + in_progress only; nothing closed leaks in.
    const open = await list_tickets(env.DB, { seg: "open" });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((t) => t.status === "submitted" || t.status === "in_progress")).toBe(true);
    // …and the closed segment is populated too (the seed has a done and a declined).
    const closed = await list_tickets(env.DB, { seg: "closed" });
    expect(new Set(closed.map((t) => t.status))).toEqual(new Set(["done", "declined"]));

    // Every requester is one of the two non-engineer staff — the queue's whole point.
    const allTickets = await list_tickets(env.DB, { seg: "all" });
    expect(new Set(allTickets.map((t) => t.requester))).toEqual(new Set(["meilin", "sanaok"]));
    // …and the badge counts exactly the unassigned open ones.
    expect(badge).toBe(open.filter((t) => t.assignees.length === 0).length);

    // A ticket with two links, and it is a parent with a child.
    const linked = allTickets.find((t) => t.link_count === 2);
    expect(linked, "no seeded ticket carries two links").toBeDefined();
    expect(linked!.sub_count).toBe(1);
    expect(linked!.sprint_label, "a sprint-assigned ticket shows its sprint label").not.toBeNull();

    const detail = (await get_ticket(env.DB, linked!.id))!;
    expect(detail.children.length).toBe(1);
    expect(detail.parent).toBeNull();
    expect(new Set(detail.links.map((l) => l.kind))).toEqual(new Set(["github", "figma"]));
    expect(detail.comments.length).toBeGreaterThan(0);
    // The opening row is there, so the history reads "opened · SUBMITTED".
    expect(detail.events[0].from_status).toBeNull();
    expect(detail.events[0].to_status).toBe("submitted");

    // The child points back at it, and lives in a different sprint.
    const child = (await get_ticket(env.DB, detail.children[0].id))!;
    expect(child.parent?.id).toBe(detail.id);
    expect(child.sprint?.id).not.toBe(detail.sprint?.id);

    // Assignees are engineers; assignee:'me' narrows to one person's tickets.
    const mine = await list_tickets(env.DB, { seg: "all", assignee: "me", me: "AndresL230" });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assignees.includes("AndresL230"))).toBe(true);
  });

  it("Search: ranked hits for a known term", async () => {
    const r = await query(env.DB, { q: "MCP", include_staged: true });
    expect(r.primary.length).toBeGreaterThan(0);
  });

  it("Feed: tagged entries present", async () => {
    expect((await get_feed(env.DB, {})).length).toBeGreaterThan(0);
    expect((await get_feed(env.DB, { tags: ["auth"] })).length).toBeGreaterThan(0);
  });

  // Four queues, and four is now the total: the roadmap-proposal queue was
  // dropped along with its table in 0025, so these are all of them.
  it("Triage: all four queues populated", async () => {
    expect((await list_proposals(env.DB)).length).toBeGreaterThan(0);
    expect((await list_needs_triage(env.DB)).length).toBeGreaterThan(0);
    expect((await list_adrs(env.DB, "draft")).length).toBeGreaterThan(0);
    expect((await list_identity_tasks(env.DB)).length).toBeGreaterThan(0);
  });
});
