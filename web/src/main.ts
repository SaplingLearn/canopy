// Placeholder smoke test of the same-origin wiring + the shared/ import path.
// Importing a runtime value from @shared proves web/ and src/ truly share shared/.
import { SECTIONS } from "@shared/vocabulary";

const out = document.getElementById("out")!;
const header = `sections (from @shared/vocabulary): ${SECTIONS.join(", ")}`;

out.textContent = `${header}\n\nfetching /feed …`;

fetch("/feed")
  .then((r) => r.json())
  .then((data) => {
    out.textContent = `${header}\n\n/feed response:\n${JSON.stringify(data, null, 2)}`;
  })
  .catch((err) => {
    out.textContent = `${header}\n\nerror fetching /feed: ${String(err)}`;
  });
