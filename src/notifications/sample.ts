// Canned sections for the admin preview / test send when the store has nothing
// to say (a fresh org, a quiet window). Built on the same card/row/chip helpers
// as the live renderers so the full layout is visible. Clearly marked as sample.
import type { Section } from "@shared/notifications";
import { EMAIL_STYLE as S, EMAIL_CARD as K, THEME } from "./assemble";

const pr = (n: number, title: string, what: string, why: string | null, impact: string | null) =>
  K.card(
    K.title(title, n, `https://github.com/SaplingLearn/sapling/pull/${n}`) +
      K.rows([K.row("What changed", K.prose(what)), ...(why ? [K.row("Why", K.prose(why))] : []), ...(impact ? [K.row("Impact", K.prose(impact))] : [])]) +
      K.footer(`${K.chip("MERGED", "green")}<span style="padding-left:8px;">into <span style="font-family:'Geist Mono',ui-monospace,Menlo,monospace;">main</span></span>`)
  );
const issue = (n: number, title: string, summary: string, milestone: string | null, next: string | null, prio: string | null, labels: string[]) =>
  K.card(
    K.title(title, n, `https://github.com/SaplingLearn/sapling/issues/${n}`) +
      K.rows([K.row("Summary", K.prose(summary)), ...(milestone ? [K.row("Milestone", milestone)] : []), ...(next ? [K.row("Next step", K.prose(next), "accent")] : [])]) +
      K.footer([prio ? K.chip(prio, "amber") : "", ...labels.map((l) => K.chip(l, "muted"))].filter(Boolean).join(" "))
  );
const review = (kind: "proposal" | "decision", title: string, summary: string, meta: string, low = false, first = false) =>
  `<tr><td style="padding:${first ? "4px" : "11px"} 0 11px 0;${first ? "" : `border-top:1px solid ${THEME.border.light};`}">` +
  `<div>${K.chip(kind.toUpperCase(), kind === "proposal" ? "accent" : "blue")}${low ? ` ${K.chip("LOW CONFIDENCE", "amber")}` : ""}<span style="${S.body}font-weight:500;padding-left:8px;">${title}</span></div>` +
  `<div style="${S.muted}padding-top:4px;">${summary}</div><div style="${S.muted}font-size:11.5px;padding-top:3px;">${meta}</div></td></tr>`;
const plan = (label: "added" | "changed" | "reordered" | "done", t: string) =>
  `<tr><td width="96" style="vertical-align:top;padding:6px 8px 6px 0;">${K.chip(label.toUpperCase(), { added: "green", changed: "blue", reordered: "muted", done: "accent" }[label] as "green" | "blue" | "muted" | "accent")}</td><td style="${S.body}">${t}</td></tr>`;

export function sampleSections(): Section[] {
  return [
    {
      heading: "My Work",
      summary: "2 PRs merged · 2 assigned issues open (sample data)",
      linkLabel: "My Work",
      deepLink: "/#mywork",
      html:
        `<div style="${S.label}padding-top:16px;">MERGED</div>` +
        pr(142, "Constant-time MCP token comparison", "Bearer tokens are now compared with `timingSafeEqual` instead of `===`, and the hash lookup no longer short-circuits on length.", "A timing side-channel could leak how many leading bytes of a token matched.", "Token checks take the same time whether or not a token is valid. No change for callers.") +
        pr(139, "GitHub org-membership check on sign-in", "The OAuth callback now calls `GET /user/memberships/orgs/SaplingLearn` and rejects anyone who is not an active member.", null, "Non-members land on the “not a member” screen instead of an empty app.") +
        `<div style="${S.label}padding-top:18px;">OPEN &amp; ASSIGNED</div>` +
        issue(175, "Audit retention + compaction policy", "Decide how long raw webhook payloads are kept and when they compact into summaries.", "Launch <span style=\"font-size:11.5px;\">&middot; due Sep 20</span>", "Draft the retention table for the ADR and get it in front of the team.", "P1", ["policy", "storage"]) +
        issue(227, "Progress bar from closed/total", "Milestone cards should show progress from the stored closed/total counts, never a live GitHub call.", null, "Wire `milestone_progress` into the roadmap card.", null, ["roadmap"]),
      text: "  merged  #142  Constant-time MCP token comparison\n                What changed: Bearer tokens are now compared with timingSafeEqual instead of ===.\n  merged  #139  GitHub org-membership check on sign-in\n  open    #175  [P1] Audit retention + compaction policy\n                Next step: Draft the retention table for the ADR and get it in front of the team.\n  open    #227  Progress bar from closed/total\n                Next step: Wire milestone_progress into the roadmap card.",
    },
    {
      heading: "Review queue",
      summary: "2 proposals, 1 decision waiting on review (sample data)",
      linkLabel: "Review",
      deepLink: "/#review",
      html:
        `<table ${S.table} style="margin-top:12px;">` +
        review("proposal", "Reference / MCP Server", "Clarify token rotation and what happens to sessions on revoke.", "by mei · high confidence", false, true) +
        review("proposal", "Context / Glossary", "Promoted vs staged definitions.", "by sana · low confidence", true) +
        review("decision", "ADR-003 — Agent write contract", "ready to ratify", "by dev") +
        `</table>`,
      text: "  proposal  Reference / MCP Server — Clarify token rotation (by mei · high confidence)\n  proposal  Context / Glossary — Promoted vs staged definitions (by sana · low confidence, LOW CONFIDENCE)\n  decision  ADR-003 — Agent write contract — ready to ratify (by dev)",
    },
    {
      heading: "Roadmap plan changes",
      summary: "4 plan changes this week (sample data)",
      linkLabel: "Roadmap",
      deepLink: "/#roadmap",
      html:
        `<table ${S.table} style="margin-top:12px;">` +
        plan("added", "Self-host &amp; deploy guide — targeting Sep 20") +
        plan("changed", "Semantic search ranking — target moved Jul 4 → Jul 18") +
        plan("reordered", "Multi-agent session attribution now ahead of Self-host &amp; deploy guide") +
        plan("done", "Docs handbook + diagram rendering — confirmed complete") +
        `</table>`,
      text: "  added      Self-host & deploy guide — targeting Sep 20\n  changed    Semantic search ranking — target moved Jul 4 -> Jul 18\n  reordered  Multi-agent session attribution now ahead of Self-host & deploy guide\n  done       Docs handbook + diagram rendering — confirmed complete",
    },
  ];
}
