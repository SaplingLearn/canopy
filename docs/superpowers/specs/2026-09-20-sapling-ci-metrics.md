# sapling-ci-metrics.md

What to add to `SaplingLearn/sapling`'s `.github/workflows/ci.yml` so its CI feeds the Repo dashboard's
Coverage, Bundle size and TODO/FIXME tiles. Companion to Task 14 of
`docs/superpowers/plans/2026-09-20-repo-dashboard-capture.md` (Phase 4) — that task built the CANOPY side
(`metricsFromStatus` in `src/repo/capture.ts`, the `status` arm of `handleGithubWebhook` in
`src/webhook.ts`, and the coverage/bundle/todos reads in `src/tools/repo.ts`). This doc is the other half:
a PR against `SaplingLearn/sapling`, a **different repository**, which is why it lives here as a spec
rather than as a diff this repo can apply. Status: written, not opened. Date: 2026-09-20.

## 1. Why a commit status

Canopy cannot measure test coverage, bundle size or a TODO/FIXME count itself — it has no checkout of the
target repo and never will (the render path is D1-only, by the project's core invariant). The target
repo's own CI already has the checkout and already runs the tools that can compute these numbers. The
cheapest way to get a number from CI into Canopy, with **no new inbound endpoint and no new auth class**,
is a GitHub commit status: CI posts a status whose `context` names the metric and whose `description` is
the number, GitHub delivers it as a `status` webhook event, and it lands on the SAME HMAC-verified
`/webhook/github` endpoint every other repo-capture event already uses.

Canopy's side is already built (this repo, Task 14): `metricsFromStatus` reads three contexts —

| Context           | `repo_metrics.metric` | Feeds                          |
|--------------------|-----------------------|----------------------------------|
| `canopy/coverage`  | `coverage`             | Code & Deploys tab — Test coverage |
| `canopy/bundle-kb` | `bundle_kb`            | Code & Deploys tab — Bundle size — web |
| `canopy/todo`      | `todo_count`           | Team & Planning tab — TODO / FIXME in source |

`description` must be a **BARE decimal number** — digits, an optional `.digits`, nothing else: no leading
`+`/`-`, no exponent (`1e3`), no hex (`0x10`), and critically **no `%` and no unit suffix**
(`metricsFromStatus` in `src/repo/capture.ts`, this repo, validates it with a strict regex, trims
surrounding whitespace, and range-checks it per metric — coverage 0–100, bundle 0–10,000,000 KB, TODO
0–10,000,000 as an INTEGER). Post `"78.4"`, never `"78.4%"`; post `"412"`, never `"412 KB"`. Anything that
fails that check — a non-numeric description, an out-of-range one, an unrelated context (Railway's or
CodeRabbit's own statuses, which arrive constantly once the webhook is subscribed to Statuses), or a status
on any branch other than the first configured environment's branch (today `main`; `envs[0].branch`,
`"main"` as the fallback if `REPO_ENVIRONMENTS` is ever unset) — is dropped. **Nothing needs to change in
this repo for the numbers to start flowing once the two steps below both land**; this doc only covers the
CI-side half.

## 2. Two things must BOTH be true before the tiles light up

1. **This PR merges** — CI starts posting the three statuses on every push to `main`.
2. **Canopy's GitHub webhook is subscribed to the `Statuses` event.** Today it is not (see
   `CLAUDE.md`'s "Environments, deploy history, check state and CI failures" section — the webhook is not
   yet subscribed to `deployment_status` / `check_run` / `workflow_run` / `pull_request_review` either).
   An admin adds `Statuses` in the repo's **Settings → Webhooks → (the Canopy webhook) → Which events would
   you like to trigger this webhook?**. No code change on Canopy's side is needed for this — `"status"` is
   already in `REPO_EVENT_NAMES` (`src/webhook.ts`).

Until both are true, `coverage`, `bundle` and `todos` all read `not_connected` on the dashboard — never a
guessed or stale number. This is the same pattern as the deploy/check/run sections: the capture path
exists in code before the GitHub-side subscription is flipped on.

## 3. Job-level, not workflow-level: `permissions`

Posting a commit status needs `statuses: write`, which the default `GITHUB_TOKEN` permissions may not
grant depending on the repo/org's default settings. Add it as a **job-level** `permissions:` block on
each job that gains a Canopy-reporting step (backend, and whichever job gets the TODO/bundle steps below)
— NOT a workflow-level one:

```yaml
jobs:
  backend:
    permissions:
      contents: read
      statuses: write
    steps:
      # ...
```

A workflow-level `permissions:` block narrows EVERY job in the file to none-unless-listed, not just the
one that needs `statuses: write` — this workflow almost certainly has other jobs (build, deploy triggers,
release steps) whose permission needs this doc has no business enumerating or keeping in sync with.
`contents: read` is what checkout already implicitly needs — spell it out once `permissions` is added
explicitly on that job, since adding the block at all narrows every other default permission on THAT JOB
to none unless listed.

## 4. Backend job — coverage

The backend job runs `pytest` today with no `--cov`. Two changes:

**a. Add `pytest-cov` to `backend/requirements.lock` WITH HASHES.** The backend install uses
`pip install --require-hashes -r requirements.lock` (or equivalent) — a lockfile where every line pins a
package version to its SHA256 hash(es). You cannot just append `pytest-cov==5.0.0` as a bare line; a
hash-required install rejects any requirement with no hash. Regenerate the lock the way this repo already
does (`pip-compile --generate-hashes` / `uv pip compile` / whatever `backend/requirements.lock`'s own
header comment says produced it), adding `pytest-cov` to the input requirements first so the regenerated
lock carries hashes for it and its transitive dependency (`coverage`) in the same pinned, hashed form as
everything else in the file. **Do not hand-edit the lock file** — a manually-added hash that doesn't match
the actual package bytes fails the install exactly like a missing one.

**b. Extend the pytest invocation and post the result.** Wherever the backend job currently runs
`pytest …`, append coverage flags and add a step right after it:

```yaml
      - name: Run backend tests
        run: pytest --cov=backend --cov-report=json:coverage.json
        # Scope --cov to the package directory (backend here — adjust to wherever
        # the actual package lives), NOT --cov=. : `--cov=.` also counts the test
        # files themselves in the denominator, which understates real coverage.

      - name: Report coverage to Canopy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        continue-on-error: true
        env:
          GH_TOKEN: "${{ github.token }}"
        run: |
          set -o pipefail
          [ -s coverage.json ] || exit 0
          PCT=$(python -c "import json;print(round(json.load(open('coverage.json'))['totals']['percent_covered'],1))")
          gh api "repos/${{ github.repository }}/statuses/${{ github.sha }}" \
            -f state=success -f context=canopy/coverage -f description="$PCT"
```

`continue-on-error: true` matters beyond tidiness — every Canopy-reporting step in this doc carries it:
dashboard telemetry (a transient `gh api` 5xx, a rate limit, a `python -c` KeyError on an unexpected JSON
shape) must NEVER fail a product build. `[ -s coverage.json ] || exit 0` guards the case pytest did not
produce (or produced an empty) `coverage.json` — an explicit no-op rather than letting `python -c` raise
past whatever `continue-on-error` silently swallows. The description posted must be a BARE decimal number
— no `%`, no unit suffix; Canopy's server-side validator now rejects anything else (see §1).

The `if:` guard matters for two more reasons, not just tidiness: (1) a status on any branch other than
`main` is dropped by `metricsFromStatus`'s branch filter anyway, so posting from a PR branch is pure
waste; (2) it keeps the number honest — a feature branch's coverage percentage is not the repo's number,
and a `push`-only guard (as opposed to running on every trigger including `pull_request`) avoids a PR run
double-posting a status for a sha that never lands on `main`.

## 5. Any job with a checkout — TODO/FIXME count

This can go in the backend job, the frontend job, or its own lightweight job — anywhere that already has
`actions/checkout` for the full tree. It's a plain grep, no test framework involved:

```yaml
      - name: Report TODO/FIXME count to Canopy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        continue-on-error: true
        env:
          GH_TOKEN: "${{ github.token }}"
        run: |
          N=$(grep -rIE --include='*.py' --include='*.ts' --include='*.tsx' -e 'TODO|FIXME' backend frontend/src | wc -l | tr -d ' ')
          gh api "repos/${{ github.repository }}/statuses/${{ github.sha }}" \
            -f state=success -f context=canopy/todo -f description="$N"
```

`continue-on-error: true` for the same reason every reporting step in this doc has it: this is telemetry,
never allowed to fail the product build. No `set -o pipefail`/missing-file guard is needed here the way
coverage/bundle need one — `wc -l | tr -d ' '` always emits a bare non-negative integer, even for zero
matches (`grep` finding nothing is a valid "0 TODOs" answer, not a missing-report case).

Adjust `backend frontend/src` if Sapling's actual source layout differs — the intent is "the same source
tree a person would scan for a TODO", not every vendored or generated file in the checkout.

## 6. Bundle size — optional, skip unless wanted

Sapling's CI does not build the frontend today — Cloudflare's own Workers Builds does that, off a push to
the frontend branch, entirely outside this workflow. Measuring bundle size in CI therefore means either:

- duplicating the OpenNext build inside CI (extra minutes, a second place the build config can drift from
  what Cloudflare actually ships), or
- skipping it.

**Recommendation: skip it.** The dashboard already renders `not_connected` for "Bundle size — web" for as
long as no `canopy/bundle-kb` status exists — that is not a broken or degraded state, it is the correct
"nothing captures this yet" answer the whole Repo dashboard uses everywhere else. Add it only if the team
decides the extra CI cost (an OpenNext build just to measure its own output) is worth paying. If so, in the
frontend job after its existing `npm ci`:

```yaml
      - name: Build and report bundle size to Canopy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        continue-on-error: true
        env:
          GH_TOKEN: "${{ github.token }}"
        run: |
          set -o pipefail
          npx opennextjs-cloudflare build
          [ -s .open-next/worker.js ] || exit 0
          KB=$(gzip -c .open-next/worker.js | wc -c | awk '{print int($1/1024)}')
          gh api "repos/${{ github.repository }}/statuses/${{ github.sha }}" \
            -f state=success -f context=canopy/bundle-kb -f description="$KB"
```

Two additions beyond `continue-on-error`, both there to stop a missing build output from posting a
fabricated `0`: `set -o pipefail` makes a failure anywhere in the `gzip | wc | awk` pipeline (a `gzip`
error, an unreadable file) fail the STEP instead of letting `wc` happily count zero bytes of nothing and
post a small-but-real-looking `0` KB — no server-side check can catch a `0` that looks like a legitimate
reading. `[ -s .open-next/worker.js ] || exit 0` catches the same failure mode one step earlier, for the
common case (the build step failed, or ran but produced an empty file): an explicit no-op instead of
relying on `pipefail` alone to convert it into a failure that `continue-on-error` then has to swallow.

## 7. Opening the PR

Not done by this doc or by Canopy's automation — a human opens this against `SaplingLearn/sapling`,
reviews the regenerated `backend/requirements.lock` diff carefully (a lockfile regen can shift unrelated
transitive pins if the toolchain version moved since the file was last generated), and merges it through
Sapling's own review process. Once merged AND the webhook's Statuses subscription is added (§2), the next
push to `main` should light up all three tiles (bundle size only if §6 was included) within one webhook
delivery — no backfill exists for these metrics, so history starts from whenever capture began, same as
every other Phase 1–3 capture path.
