/**
 * The @mention picker's pure core (`web/src/mentions.ts`).
 *
 * Same idiom as test/hash.test.ts: no DOM, no D1, no `state` — main.ts owns the
 * textarea and the caret, and everything decidable from (text, caret, persons)
 * is decided by these three functions, so the RULES are unit-tested here.
 */
import { describe, it, expect } from "vitest";
import { mentionTokenAt, mentionCandidates, applyMention } from "../web/src/mentions";
import type { PersonSummary } from "../web/src/api";

// Every fixture name is capitalized the same way on purpose: the ordering
// assertions below must not depend on how `localeCompare` ranks case.
const PERSONS: PersonSummary[] = [
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null },
  { handle: "sanaok", name: "Sana Okafor", color: "ochre", avatar_url: null },
  { handle: "jose-a", name: "Jose Alvarez", color: "moss", avatar_url: null },
  { handle: "sam", name: "Samir Mehta", color: "sky", avatar_url: null },
];

describe("mentionTokenAt", () => {
  it("opens on an @ at the start of the text", () => {
    expect(mentionTokenAt("@mei", 4)).toEqual({ start: 0, query: "mei" });
  });

  it("opens on an @ right after a space", () => {
    expect(mentionTokenAt("ping @mei", 9)).toEqual({ start: 5, query: "mei" });
  });

  it("opens on an @ right after a newline", () => {
    expect(mentionTokenAt("ping\n@mei", 9)).toEqual({ start: 5, query: "mei" });
  });

  it("opens with an EMPTY query the moment the @ is typed", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTokenAt("hey @", 5)).toEqual({ start: 4, query: "" });
  });

  it("reads only up to the caret, not the whole token", () => {
    // Caret parked mid-token: the query is what is BEFORE it.
    expect(mentionTokenAt("@meilin", 3)).toEqual({ start: 0, query: "me" });
  });

  it("is null mid-word — `a@b` is not a mention", () => {
    expect(mentionTokenAt("a@b", 3)).toBeNull();
    expect(mentionTokenAt("someone@example.com", 12)).toBeNull();
  });

  it("is null when the caret sits BEFORE the @", () => {
    expect(mentionTokenAt("hi @mei", 3)).toBeNull();   // just before the @
    expect(mentionTokenAt("hi @mei", 0)).toBeNull();
  });

  it("is null once the token is closed by a space", () => {
    expect(mentionTokenAt("@mei ", 5)).toBeNull();
    expect(mentionTokenAt("@mei and", 8)).toBeNull();
  });

  it("is null with no @ anywhere, and for out-of-range carets", () => {
    expect(mentionTokenAt("plain text", 5)).toBeNull();
    expect(mentionTokenAt("", 0)).toBeNull();
    expect(mentionTokenAt("@mei", 99)).toBeNull();
    expect(mentionTokenAt("@mei", -1)).toBeNull();
  });

  it("accepts the handle character class (letters, digits, _ and -)", () => {
    expect(mentionTokenAt("@jose-a", 7)).toEqual({ start: 0, query: "jose-a" });
    expect(mentionTokenAt("@a_1", 4)).toEqual({ start: 0, query: "a_1" });
  });
});

describe("mentionCandidates", () => {
  const handles = (q: string, limit?: number) =>
    mentionCandidates(PERSONS, q, limit).map((p) => p.handle);

  it("matches on a handle prefix", () => {
    expect(handles("mei")).toEqual(["meilin"]);
  });

  it("matches on a FIRST-name prefix", () => {
    expect(handles("sana")).toEqual(["sanaok"]);
  });

  it("matches on a LAST-name prefix (any whitespace-separated word)", () => {
    expect(handles("zhao")).toEqual(["meilin"]);
    expect(handles("alvarez")).toEqual(["jose-a"]);
  });

  it("is case-insensitive in both directions", () => {
    expect(handles("MEI")).toEqual(["meilin"]);
    expect(handles("Okafor")).toEqual(["sanaok"]);
  });

  it("orders by name ascending when nothing is an exact handle", () => {
    expect(handles("sa")).toEqual(["sam", "sanaok"]);       // Samir Mehta < Sana Okafor
    expect(handles("")).toEqual(["jose-a", "meilin", "sam", "sanaok"]);
  });

  it("puts an EXACT handle match first, ahead of the name order", () => {
    const pair: PersonSummary[] = [
      { handle: "zed", name: "Zed Zulu", color: "rose", avatar_url: null },
      { handle: "zedd", name: "Aaron Zedd", color: "moss", avatar_url: null },
    ];
    const h = (q: string) => mentionCandidates(pair, q).map((p) => p.handle);
    // Both match "zed"; the exact handle wins even though "Aaron Zedd" sorts first.
    expect(h("zed")).toEqual(["zed", "zedd"]);
    // No exact match → plain name order, which is the OTHER way round.
    expect(h("ze")).toEqual(["zedd", "zed"]);
  });

  it("falls back to the handle for ordering when a person has no name", () => {
    const fb: PersonSummary[] = [
      { handle: "aaa", name: "zebra one", color: "rose", avatar_url: null },   // key: "zebra one"
      { handle: "mmm", name: null, color: "moss", avatar_url: null },          // key: "mmm"
    ];
    // Ordering by handle would give ["aaa","mmm"]; by `name ?? handle` it is:
    expect(mentionCandidates(fb, "").map((p) => p.handle)).toEqual(["mmm", "aaa"]);
  });

  it("lists everyone on an empty query", () => {
    expect(mentionCandidates(PERSONS, "")).toHaveLength(PERSONS.length);
  });

  it("caps at 6 by default", () => {
    const many: PersonSummary[] = Array.from({ length: 12 }, (_, i) => ({
      handle: `p${i}`, name: `Person ${String.fromCharCode(97 + i)}`, color: "moss", avatar_url: null,
    }));
    expect(mentionCandidates(many, "")).toHaveLength(6);
    expect(mentionCandidates(many, "p")).toHaveLength(6);
    expect(mentionCandidates(many, "", 3)).toHaveLength(3);
  });

  it("returns nothing when nothing matches", () => {
    expect(mentionCandidates(PERSONS, "qqq")).toEqual([]);
  });

  it("never mutates the caller's array", () => {
    const order = PERSONS.map((p) => p.handle);
    mentionCandidates(PERSONS, "");
    expect(PERSONS.map((p) => p.handle)).toEqual(order);
  });
});

describe("applyMention", () => {
  it("replaces the token with @handle plus a trailing space", () => {
    const tok = mentionTokenAt("@mei", 4)!;
    expect(applyMention("@mei", tok.start, 4, "meilin")).toEqual({ text: "@meilin ", caret: 8 });
  });

  it("puts the caret right after the trailing space", () => {
    const out = applyMention("hey @sa", 4, 7, "sanaok");
    expect(out.text).toBe("hey @sanaok ");
    expect(out.caret).toBe(12);
    expect(out.text.slice(0, out.caret)).toBe("hey @sanaok ");
  });

  it("only touches the token when it sits mid-sentence", () => {
    const text = "hey @sa can you look at this?";
    const tok = mentionTokenAt(text, 7)!;
    const out = applyMention(text, tok.start, 7, "sanaok");
    expect(out.text).toBe("hey @sanaok  can you look at this?");   // token's own space + the original
    expect(out.caret).toBe(12);
    expect(out.text.slice(out.caret)).toBe(" can you look at this?");
  });

  it("expands an empty token (just the @)", () => {
    expect(applyMention("hey @", 4, 5, "jose-a")).toEqual({ text: "hey @jose-a ", caret: 12 });
  });

  it("round-trips: the result's caret is no longer inside a mention token", () => {
    const out = applyMention("hey @sa", 4, 7, "sanaok");
    expect(mentionTokenAt(out.text, out.caret)).toBeNull();
  });
});
