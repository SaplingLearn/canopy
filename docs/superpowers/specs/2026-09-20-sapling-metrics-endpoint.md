# sapling-metrics-endpoint.md

The one endpoint `SaplingLearn/sapling`'s backend has to expose so the Repo dashboard's **Active users**
row (Usage tab, per environment, 24h / 7d / 30d) can show a number. Companion to Task 18 of
`docs/superpowers/plans/2026-09-20-repo-dashboard-capture.md` (Phase 5) — that task built the CANOPY side
(`pollSaplingMetrics` in `src/repo/poll.ts`, its minute-0 arm in `src/repo/cron.ts`, and the `users`
projection in `src/tools/repo.ts`). This doc is the other half: a change to `SaplingLearn/sapling`, a
**different repository**, which is why it lives here as a spec rather than as a diff this repo can apply.
Status: written, not opened — no issue or PR has been filed anywhere. Date: 2026-09-20.

> **Extended by contract v2** — `2026-09-21-sapling-product-metrics.md`. The response may now ALSO carry
> `counts` (windowed) and `totals` (point-in-time) product metrics, which Canopy stores and shows per
> environment. v2 is purely additive: everything below about `active_users` (shape, whole-or-nothing
> validation, auth, cadence) still holds, and a response with only `active_users` stays valid forever.
> Where this doc says the endpoint returns "three integers and nothing else", read "for `active_users`" —
> §5's privacy rule (aggregate counts only, nothing per-user) is unchanged and is restated in v2 §2.

## 1. Why Sapling has to answer this

Every other number on the Usage tab comes from somewhere Canopy can ask on its own: requests and errors
from Cloudflare's analytics API, CPU and memory from Railway's. **Active users is the exception.** "How
many distinct people signed in and did something" is only knowable from Sapling's own database — Cloudflare
counts requests, not people, and Canopy holds no Sapling credentials, no database connection and no user
table of Sapling's, and should not. So the number has to be computed where the data lives and handed over.

The hand-over is a **pull**, not a push: Canopy's repo cron already wakes at minute 0 of every hour to
poll Cloudflare and Railway, and asking one more URL costs it one request per environment. A pull also
needs **no new inbound endpoint and no new auth class on Canopy** (a binding constraint of the
repo-dashboard plan) — the new surface is on Sapling's side, and it is one read-only route.

Until the endpoint exists, Canopy writes nothing and the row reads **"not connected"** under Active users
— beside live Requests / Error rate once Cloudflare is connected. That is the designed state, not a
broken one: the dashboard never shows a number no capture supports.

## 2. The contract

### Request

```
GET {apiUrl}/api/internal/metrics
Authorization: Bearer <token>
User-Agent: canopy-metrics
```

- `{apiUrl}` is the environment's backend origin from Canopy's `REPO_ENVIRONMENTS` var — today
  `https://api.staging.saplinglearn.com` and `https://api.saplinglearn.com`. The path is fixed.
- No query string, no body, no other headers of note.
- **https only.** Canopy refuses to call an `apiUrl` that is not `https:` — a bearer token is never sent
  in clear.
- **No redirects.** Canopy sends `redirect: "manual"` and treats a 3xx as a failure, so the token is never
  carried to a second URL. Serve the route at exactly this path — no trailing-slash redirect
  (`/api/internal/metrics/` → FastAPI's default `redirect_slashes` would 307 it; declare the route
  without the trailing slash), no apex→www hop.
- 8-second timeout, no retries. A miss costs one hourly reading; the next hour asks again.

### Response — `200`, `Content-Type: application/json`

```json
{ "active_users": { "24h": 74, "7d": 318, "30d": 318 } }
```

Exactly three keys under `active_users`, each a JSON **integer**. Extra top-level or nested keys are
ignored today, but see §5 before adding any.

### What "active user" means, per window

> The number of **distinct AUTHENTICATED users** with **at least one request** in the trailing
> **24 hours / 7 days / 30 days**, computed **at request time** ("as of now").

- *Distinct*: one person making 500 requests counts once.
- *Authenticated*: anonymous traffic, health checks, bots and Canopy's own polls are not users.
- *Trailing, as of now*: `now() - interval '24 hours'`, not "since midnight" and not "yesterday".
- By construction **`24h ≤ 7d ≤ 30d`** — everyone active in the last day was active in the last week.
  Canopy checks this (§3), so three independently-cached counts that can disagree would be refused.

"At least one request" is the definition to aim for. If Sapling has no per-request log and the closest
durable signal is something coarser (a `last_seen_at` column, a sessions table, a sign-in event), use
that and say so in the PR — what matters is that the three windows share ONE definition and nest.
Note a bare `last_seen_at` still nests correctly (it answers "was last seen within N days"), which is
exactly the trailing-window question.

### Anything else

Any status other than `200` (`401`, `404`, `5xx`, a `3xx`), a timeout, a body that is not JSON, or a body
that fails §3: **Canopy writes nothing for that environment for that hour.** The tile keeps showing the
last reading for up to 3 hours, then stops showing a number and reads "no recent reading" — the endpoint IS
connected, it has just gone quiet. ("not connected" is reserved for an environment with no reading at all in
the last 30 days.) Nothing is ever guessed, interpolated or carried forward past that.

## 3. The validation Canopy applies — the whole response or nothing

`saplingActiveUsers` in `src/repo/poll.ts`. **All** of these must hold, or **none** of the three numbers
is stored:

| Check | Refused examples |
|---|---|
| `active_users` is a JSON object | missing, `null`, an array, a number |
| each of `24h`, `7d`, `30d` is present | `{ "24h": 6, "7d": 9 }` |
| each is a JSON **number** | `"74"` (a string), `true`, `null` |
| each is an **integer** | `74.5` |
| each is `≥ 0` and `≤ 10,000,000` | `-1`, `10000001` |
| `24h ≤ 7d ≤ 30d` | `{ "24h": 10, "7d": 9, "30d": 12 }` |

One bad window refuses the other two: numbers that contradict each other are not evidence for anything.
(`74.0` parses as the integer 74 in JSON and is accepted; a Python `int` serialises as `74` anyway. Do not
send a string or a `Decimal`-as-string — it is dropped, silently from Sapling's point of view.) The reason
for the strictness: Canopy's `repo_metrics` table is append-only and first-write-wins per hour, so a bad
number stored once would be permanent.

## 4. A reference sketch (FastAPI)

**The table and column names below are placeholders.** Sapling's database is Supabase/Postgres and which
table actually records "this user made a request" — a request log, a sessions table, a `last_seen_at`
column — is Sapling's call, as is whether to reach it through SQLAlchemy, `asyncpg`, or a Supabase RPC.
What the sketch fixes is the SHAPE: the route, the auth, and one `COUNT(DISTINCT user_id)` per window.

```python
# backend/routes/internal_metrics.py
import hmac
import os

from fastapi import APIRouter, Header, HTTPException

router = APIRouter()

# ONE query, one COUNT(DISTINCT ...) per window, all as of the same now() —
# which is also what guarantees 24h <= 7d <= 30d.
# PLACEHOLDER table/columns: `request_log(user_id, created_at)`.
ACTIVE_USERS_SQL = """
SELECT
  COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '24 hours') AS d1,
  COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days')   AS d7,
  COUNT(DISTINCT user_id)                                                          AS d30
FROM request_log
WHERE user_id IS NOT NULL
  AND created_at >= now() - interval '30 days'
"""


@router.get("/api/internal/metrics")  # no trailing slash — Canopy does not follow a redirect
async def internal_metrics(authorization: str | None = Header(default=None)):
    expected = os.environ.get("CANOPY_METRICS_TOKEN", "")
    if not expected:
        # Unset → the endpoint is DISABLED: indistinguishable from a route that does not exist.
        # Never fall through to a compare against "" — an empty bearer would match it.
        raise HTTPException(status_code=404)

    presented = authorization or ""
    # Constant-time, on bytes, over the WHOLE header value — no early return on a missing
    # "Bearer " prefix, no length check first.
    if not hmac.compare_digest(presented.encode(), f"Bearer {expected}".encode()):
        # One generic 401 for every mismatch: missing header, wrong scheme, wrong token.
        # The body says nothing about which, or about how the token is configured.
        raise HTTPException(status_code=401, detail="unauthorized")

    row = await db.fetch_one(ACTIVE_USERS_SQL)  # `db`: whatever handle the backend already uses
    return {"active_users": {"24h": int(row["d1"]), "7d": int(row["d7"]), "30d": int(row["d30"])}}
```

Notes on the sketch:

- **`hmac.compare_digest`, not `==`.** A plain string compare returns at the first differing byte, which
  leaks the token one character at a time to anyone who can time the response.
- **`404` when the env var is unset, `401` on a mismatch.** An environment that never set the variable
  behaves as if the feature does not exist; one that did set it gives the same bare `401` for every kind
  of wrong credential and never explains which part was wrong.
- **`int(...)`** on the way out. Postgres `COUNT` comes back as a `bigint`; some drivers surface that as a
  `Decimal` or a string, and a string is refused by §3.
- **No caching headers needed** — Canopy asks once an hour and does not cache. If the query is expensive,
  caching the three counts **together** for a few minutes is fine; caching them separately (different
  TTLs) is what produces a `24h > 7d` response that Canopy refuses.
- Register the router wherever `backend/routes/` routers are already included. Keep the route out of any
  public OpenAPI listing if Sapling publishes one (`include_in_schema=False`).
- If a global auth dependency or middleware guards every `/api/*` route, this route must be exempted from
  it — Canopy has no Sapling user session, only the bearer token — and must NOT be exempted from rate
  limiting.
- An index on `(created_at)` or `(created_at, user_id)` of whichever table backs the query keeps the 30-day
  scan cheap; at Sapling's current scale it will be fast regardless.

## 5. Privacy

The endpoint returns **three integers and nothing else** — no user ids, no emails, no names, no per-user
rows, no per-route breakdown. Canopy stores exactly those three integers per environment per hour and has
no field to put anything else in. Please keep it that way on the Sapling side too: if a future need
argues for more (say, sign-ups per day), it should be a new aggregate count with its own line in this
contract, never a list of people. The numbers are visible to every signed-in member of the Canopy org.

## 6. Operational notes

- **Cadence**: once an hour per environment, at minute 0 UTC (give or take a few seconds), from
  **Cloudflare's network** (the Canopy Worker's `scheduled()` handler) — so there is no fixed source IP to
  allow-list; the bearer token is the whole authentication. User-agent `canopy-metrics`. (The separate
  `canopy-health` user-agent hitting `/api/health` every 10 minutes is Canopy's reachability ping and is
  unrelated.)
- **The token** is one shared secret, set to the SAME value on both sides: `SAPLING_METRICS_TOKEN` as a
  Worker secret in Canopy (`wrangler secret put SAPLING_METRICS_TOKEN` — never in `wrangler.toml`), and an
  environment variable of Sapling's own choosing there (the sketch calls it `CANOPY_METRICS_TOKEN`).
  Generate it with e.g. `openssl rand -hex 32`. It grants read access to three aggregate counts and
  nothing else, but treat it as a secret anyway.
- **One token for every environment — a real limitation, stated plainly.** Canopy holds a SINGLE
  `SAPLING_METRICS_TOKEN` and sends it to every configured environment's `apiUrl`. So Sapling's staging
  and production deployments must both accept that one value; they cannot have different tokens today.
  The consequence: the staging deployment's environment holds a credential that also works against
  production's metrics route. Given what the route returns (§5) that was judged acceptable; if it stops
  being so, the change is on Canopy's side (a per-environment secret, the way `RAILWAY_TOKEN_<KEY>`
  already works) and needs no change to this contract.
- **Rotation**: set the new value on Sapling (both environments), then on Canopy. In between, Canopy gets
  `401`s, writes nothing, and the tile keeps its last reading for up to 3 hours — a rotation done inside
  that window is invisible on the dashboard.
- **Staging-only first** is fine: deploy the route to staging alone and the production card simply keeps
  reading "not connected" (a `404` writes nothing) until production has it too.
- Canopy keeps the first reading of each hour (`INSERT OR IGNORE`) and prunes these hourly points after
  100 days.

## 7. Verifying it once it is live

1. From anywhere: `curl -sS -H "Authorization: Bearer $TOKEN" https://api.staging.saplinglearn.com/api/internal/metrics`
   → the §2 body. Without the header → `401`. With the env var unset → `404`.
2. On Canopy, with `SAPLING_METRICS_TOKEN` set: within an hour (the next minute-0 tick), **Repo → Usage →
   Active users** fills in for that environment, on all three ranges. The sparkline beside it appears from
   the second hourly reading on (a line needs two points).
3. If it does not, the Worker's log (`wrangler tail`, or the Cloudflare dashboard's Workers Logs) has one
   line per failed environment per hour, of the form

   ```
   pollSaplingMetrics <environment key> <reason>
   ```

   for example `pollSaplingMetrics staging HTTP 404` (the route is not deployed, or the env var is unset
   there), `pollSaplingMetrics production HTTP 401` (the two sides hold different tokens),
   `pollSaplingMetrics staging HTTP 307` (a redirect — check the trailing slash), or
   `pollSaplingMetrics staging active_users.7d is not an integer in 0–10000000 (string): {"active_users"…`
   (the body failed §3; at most 80 characters of it are quoted, and the token is never logged). **No line
   at all** at minute 0 means the poll did not run: `SAPLING_METRICS_TOKEN` is not set on the Worker.
4. No backfill exists: history starts from the first successful poll, same as every other capture path on
   the dashboard.
