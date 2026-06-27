import { describe, it, expect } from "vitest";
import { parseRoadmapForPerson } from "../src/tools/dashboard";

const ROADMAP = `# Sapling Roadmap

## Team & Responsibilities

| Person     | Role          | Owns                                              |
| ---------- | ------------- | ------------------------------------------------- |
| **Jose**   | Frontend      | React app, chat UI, UX                            |
| **Andres** | Fullstack     | Cross-cutting glue, integration, releases         |

## Issue tracking — tags & ownership

Prose that is not time-phased and must be ignored.

## Now → Next 2 Weeks (through ~2026-06-21)

- **Andres** — P0 #124 (realtime chat ciphertext); start streaming chat #70.
- **Jose** — frontend audit P0s #102.

## Weeks 3–4 (~2026-06-22 → 2026-07-05)

- **Andres** — semesters API + GPA #138; document-pipeline robustness #132;
  integration testing across the migrated agents.
- **Jose** — semesters UI #139.

## July — Agent Migration

- **Andres** — decision record for the migration cutover; performance pass.

## August — Tutoring Depth

- **Jose** — interactive graph navigation.
`;

const TODAY = "2026-06-26";

describe("parseRoadmapForPerson", () => {
  it("extracts role/owns and the date-current phase, dropping past phases", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Andres", TODAY);
    expect(r.role).toBe("Fullstack");
    expect(r.owns).toBe("Cross-cutting glue, integration, releases");
    expect(r.workingNow?.title).toBe("Weeks 3–4");
    expect(r.workingNow?.window).toContain("2026-06-22");
    expect(r.workingNow?.bullet).toMatch(/^semesters API \+ GPA #138/);
    expect(r.workingNow?.issueRefs).toEqual([138, 132]);
  });

  it("skips phases where the person has no bullet (Andres has none in August)", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Andres", TODAY);
    expect(r.comingUp.map((p) => p.title)).toEqual(["July — Agent Migration"]);
  });

  it("skips intermediate no-bullet phases for another person (Jose skips July)", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Jose", TODAY);
    expect(r.workingNow?.title).toBe("Weeks 3–4");
    expect(r.comingUp.map((p) => p.title)).toEqual(["August — Tutoring Depth"]);
  });

  it("returns nulls/empties for an unmapped person", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Nobody", TODAY);
    expect(r).toEqual({ role: null, owns: null, workingNow: null, comingUp: [] });
  });

  it("falls back to the first phase when no real dates parse", () => {
    const md = `## Now → Phase One

- **Andres** — first thing #1.

## Now → Phase Two

- **Andres** — second thing #2.
`;
    const r = parseRoadmapForPerson(md, "Andres", TODAY);
    expect(r.workingNow?.title).toBe("Now → Phase One");
    expect(r.comingUp.map((p) => p.title)).toEqual(["Now → Phase Two"]);
  });
});
