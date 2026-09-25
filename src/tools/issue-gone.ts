// An issue delivered with one of these actions has LEFT the repo: `deleted`, or
// `transferred` to another repository. Its snapshot in `events` still reads
// `state: "open"` (GitHub sends the issue as it was), so every reader that asks
// "is this issue open?" off the latest snapshot must also ask whether it is gone.
// Kept in its own module so mywork / progress / repo / the ticket mirror can all
// import it without an import cycle through src/webhook.ts.
export const ISSUE_GONE_ACTIONS: readonly string[] = ["deleted", "transferred"];

export const isIssueGone = (action: string | null | undefined): boolean =>
  action != null && ISSUE_GONE_ACTIONS.includes(action);
