import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import { completeSignIn, linkSignIn, suggestHandle, sealOnboard, openOnboard, type ProviderProfile } from "../src/auth/onboard";
import { createInvite } from "../src/auth/invites";
import { seedPerson } from "./helpers/persons";
import type { IdentityRow, PersonRow } from "@shared/rows";

const google = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "google", subject: "g-123", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: "https://lh3/p.png", ...over,
});
const github = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "github", subject: "newdev", label: "newdev", email: "newdev@example.com", name: "New Dev", avatar_url: null, ...over,
});

describe("completeSignIn — the fork", () => {
  it("1. known identity → session; name/avatar refreshed, email COALESCEd", async () => {
    const r = await completeSignIn(env.DB, github({ subject: "AndresL230", label: "AndresL230", name: "Andrés L", email: "x@y.z" }));
    expect(r).toEqual({ kind: "session", handle: "AndresL230" });
    const p = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(p.name).toBe("Andrés L");
    expect(p.email).toBe("x@y.z"); // was NULL in the seed → filled
  });
  it("2. unknown identity, verified email matches a person → linked + session, no onboarding", async () => {
    await seedPerson("priya", { email: "priya.n@gmail.com", github: true });
    const r = await completeSignIn(env.DB, google());
    expect(r).toEqual({ kind: "session", handle: "priya" });
    const id = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'google' AND subject = 'g-123'`);
    expect(id?.person).toBe("priya");
    expect(id?.linked_by).toBe("priya");
  });
  it("3a. unknown Google identity with a live invite → onboard payload (nothing written)", async () => {
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: "Priya", invitedBy: "AndresL230" });
    const r = await completeSignIn(env.DB, google());
    expect(r.kind).toBe("onboard");
    if (r.kind !== "onboard") throw new Error();
    expect(r.payload.suggested_handle).toBe("priya-n");
    expect(r.payload.invite_email).toBe("priya.n@gmail.com");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-123'`)).toBeNull();
    expect(await first(env.DB, `SELECT 1 AS x FROM persons WHERE handle = 'priya-n'`)).toBeNull();
  });
  it("3b. unknown GitHub identity (org member) → onboard with the login as suggested handle, no invite needed", async () => {
    const r = await completeSignIn(env.DB, github());
    expect(r.kind).toBe("onboard");
    if (r.kind !== "onboard") throw new Error();
    expect(r.payload.suggested_handle).toBe("newdev");
    expect(r.payload.invite_email).toBeNull();
  });
  it("4. unknown Google identity, no match, no invite (or revoked) → denied", async () => {
    expect(await completeSignIn(env.DB, google())).toEqual({ kind: "denied" });
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    await env.DB.prepare(`UPDATE invites SET revoked_at = 't' WHERE email = 'priya.n@gmail.com'`).run();
    expect(await completeSignIn(env.DB, google())).toEqual({ kind: "denied" });
  });
  it("a null email never auto-links", async () => {
    await seedPerson("priya", { email: null });
    expect(await completeSignIn(env.DB, google({ email: null }))).toEqual({ kind: "denied" });
  });
});

describe("linkSignIn", () => {
  it("attaches a free identity to the caller; refuses one that belongs to someone else", async () => {
    await seedPerson("priya");
    expect(await linkSignIn(env.DB, "AndresL230", google())).toBe("linked");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("AndresL230");
    expect(await linkSignIn(env.DB, "priya", google())).toBe("belongs_to_other");
  });
});

describe("suggestHandle + onboard cookie", () => {
  it("github → the login lowercased; google → local part in the handle alphabet", () => {
    expect(suggestHandle(github({ subject: "NewDev" }))).toBe("newdev");
    expect(suggestHandle(google({ email: "Priya.N+x@gmail.com" }))).toBe("priya-n-x");
    expect(suggestHandle(google({ email: "9lives@x.io" }))).toBe("p-9lives");
  });
  it("seal/open round-trips and rejects tampering", async () => {
    const payload = { ...google(), suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
    const sealed = await sealOnboard(payload, "s");
    expect(await openOnboard(sealed, "s")).toEqual(payload);
    expect(await openOnboard(sealed + "x", "s")).toBeNull();
    expect(await openOnboard(sealed, "other")).toBeNull();
  });
});
