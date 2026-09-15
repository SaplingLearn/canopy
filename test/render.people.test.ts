import { describe, it, expect } from "vitest";
import { peopleSection } from "../web/src/maintenance";
import { profileSection, initialState } from "../web/src/render";
import { peopleFromPersons } from "../web/src/triage-map";
import { handleTag } from "../web/src/people";

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "https://a/p.png" },
];
const invites = [
  { email: "m.okafor@gmail.com", name: null, invited_by: "AndresL230", invited_at: "2026-09-12T10:00:00Z", accepted_by: null, revoked_at: null, email_sent_at: "2026-09-12T10:00:01Z", email_id: null, email_error: null },
  { email: "done@x.io", name: "Done", invited_by: "AndresL230", invited_at: "2026-09-01T10:00:00Z", accepted_by: "done", revoked_at: null, email_sent_at: "t", email_id: null, email_error: null },
  { email: "bad@x.io", name: null, invited_by: "AndresL230", invited_at: "2026-09-11T10:00:00Z", accepted_by: null, revoked_at: null, email_sent_at: "t", email_id: null, email_error: "resend 500" },
];

describe("peopleSection", () => {
  it("lists persons with colored chips and pending invites with Resend/Revoke; accepted invites are not pending", () => {
    const html = peopleSection({ persons, invites, inviteDraft: "", loading: false, error: null });
    expect(html).toContain("PEOPLE");
    expect(html).toContain("@AndresL230");
    expect(html).toContain("var(--p-plum)");
    expect(html).toContain("m.okafor@gmail.com");
    expect(html).toContain('data-act="inviteResend" data-arg="m.okafor@gmail.com"');
    expect(html).toContain('data-act="inviteRevoke" data-arg="m.okafor@gmail.com"');
    expect(html).not.toContain('data-arg="done@x.io"');
    expect(html).toContain("resend 500");
    expect(html).toContain('data-act="inviteDraft"');
    expect(html).toContain('data-act="inviteSend"');
  });
  it("disables Invite until the draft looks like an email", () => {
    expect(peopleSection({ persons, invites: [], inviteDraft: "nope", loading: false, error: null })).toMatch(/data-act="inviteSend"[^>]*disabled/);
    expect(peopleSection({ persons, invites: [], inviteDraft: "a@b.co", loading: false, error: null })).not.toMatch(/data-act="inviteSend"[^>]*disabled/);
  });
});

describe("profileSection", () => {
  it("shows handle read-only, ten swatches with mine selected, and link/unlink per provider", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false };
    s.displayName = "Andres";
    const html = profileSection(s);
    expect(html).toContain("@AndresL230");
    expect(html).toContain('data-arg="moss" class="cnpy-sw is-on compact"');
    expect(html).toContain('data-act="linkProvider" data-arg="google"');
    expect(html).toMatch(/data-act="unlinkProvider" data-arg="github"[^>]*disabled/); // last identity
    s.me.identities.push({ provider: "google", label: "a@b.c", linked_at: "t" });
    const both = profileSection(s);
    expect(both).not.toMatch(/data-act="unlinkProvider" data-arg="github"[^>]*disabled/);
    expect(both).toContain('data-act="unlinkProvider" data-arg="google"');
  });

  it("handle editor: shows the draft input + warning with an enabled Save when available, disabled when taken", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false };
    s.handleEdit = true;
    s.handleDraft = "andres";
    s.handleCheck = "available";
    const available = profileSection(s);
    expect(available).toContain('data-act="handleDraft"');
    expect(available).toContain('value="andres"');
    expect(available).toContain("Every entry you've written is re-attributed to the new handle. Links to the old one stop working.");
    expect(available).not.toMatch(/data-act="handleSave"[^>]*disabled/);

    s.handleCheck = "taken";
    const taken = profileSection(s);
    expect(taken).toMatch(/data-act="handleSave"[^>]*disabled/);
  });
});

describe("handleTag", () => {
  it("renders the handle in the person's color when mapped", () => {
    const html = handleTag({ handle: "priya", color: "plum" }, "priya");
    expect(html).toContain("var(--p-plum)");
    expect(html).toContain("@priya");
  });

  it("falls back to a muted, uncolored tag when unmapped", () => {
    const html = handleTag(null, "mystery-dev");
    expect(html).toContain("@mystery-dev");
    expect(html).not.toContain("var(--p-");
  });
});

describe("peopleFromPersons", () => {
  it("maps directory rows to picker entries keyed by handle", () => {
    expect(peopleFromPersons(persons)[1]).toEqual({ id: "priya", name: "Priya Natarajan", initials: "PN", color: "plum", avatar_url: "https://a/p.png" });
  });
});
