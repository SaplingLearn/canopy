// Canned sections for the admin preview / test send when the store has nothing
// to say (a fresh org, a quiet window). Content mirrors the Canopy Email design
// examples so the full layout is visible. Clearly marked as sample data.
import type { Section } from "@shared/notifications";
import { EMAIL_STYLE as S } from "./assemble";

const row = (n: string, t: string) => `<tr><td width="48" style="${S.mono}">${n}</td><td style="${S.body}">${t}</td></tr>`;
const plan = (l: string, t: string) => `<tr><td width="92" style="${S.label}vertical-align:top;padding:5px 0;">${l}</td><td style="${S.body}">${t}</td></tr>`;

export function sampleSections(): Section[] {
  return [
    {
      heading: "My Work",
      summary: "2 PRs merged · 2 assigned issues open (sample data)",
      linkLabel: "My Work",
      deepLink: "/#mywork",
      html:
        `<div style="${S.label}padding-top:16px;">MERGED</div><table ${S.table} style="margin-top:4px;">` +
        row("#142", "Switched MCP token comparison to constant-time") +
        row("#139", "Wired GitHub org-membership check into sign-in") +
        `</table><div style="${S.label}padding-top:12px;">OPEN &amp; ASSIGNED</div><table ${S.table} style="margin-top:4px;">` +
        row("#175", "Audit retention + compaction policy") +
        row("#227", "Progress bar from closed/total") +
        `</table>`,
      text: "  merged  #142  Switched MCP token comparison to constant-time\n  merged  #139  Wired GitHub org-membership check into sign-in\n  open    #175  Audit retention + compaction policy\n  open    #227  Progress bar from closed/total",
    },
    {
      heading: "Review queue",
      summary: "2 proposals, 1 decision waiting on review (sample data)",
      linkLabel: "Review",
      deepLink: "/#review",
      html:
        `<table ${S.table} style="margin-top:12px;">` +
        `<tr><td style="${S.body}line-height:1.6;padding:3px 0;">Reference / MCP Server — clarify token rotation <span style="${S.meta}">(Mei, high confidence)</span></td></tr>` +
        `<tr><td style="${S.body}line-height:1.6;padding:3px 0;">Context / Glossary — promoted vs staged definitions <span style="${S.meta}">(Sana)</span></td></tr>` +
        `<tr><td style="${S.body}line-height:1.6;padding:3px 0;">ADR-003 — Agent write contract, ready to ratify <span style="${S.meta}">(Dev)</span></td></tr>` +
        `</table>`,
      text: "  Reference / MCP Server — clarify token rotation (Mei, high confidence)\n  Context / Glossary — promoted vs staged definitions (Sana)\n  ADR-003 — Agent write contract, ready to ratify (Dev)",
    },
    {
      heading: "Roadmap plan changes",
      summary: "4 plan changes this week (sample data)",
      linkLabel: "Roadmap",
      deepLink: "/#roadmap",
      html:
        `<table ${S.table} style="margin-top:12px;">` +
        plan("ADDED", "Self-host &amp; deploy guide — targeting Sep 20") +
        plan("CHANGED", "Semantic search ranking — target moved Jul 4 → Jul 18") +
        plan("REORDERED", "Multi-agent session attribution now ahead of Self-host &amp; deploy guide") +
        plan("DONE", "Docs handbook + diagram rendering — confirmed complete") +
        `</table>`,
      text: "  added      Self-host & deploy guide — targeting Sep 20\n  changed    Semantic search ranking — target moved Jul 4 -> Jul 18\n  reordered  Multi-agent session attribution now ahead of Self-host & deploy guide\n  done       Docs handbook + diagram rendering — confirmed complete",
    },
  ];
}
