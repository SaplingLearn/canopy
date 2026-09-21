# Sapling → Canopy: product metrics (contract v2)

Extends `2026-09-20-sapling-metrics-endpoint.md`. Same endpoint, same auth, same cadence — the response
grows. **v2 is purely additive**: a v1 response (only `active_users`) stays valid forever, and Canopy
ignores any key it does not understand.

## 1. The response

`GET {apiUrl}/api/internal/metrics`, `Authorization: Bearer <token>`, `200` →

```json
{
  "active_users": { "24h": 74, "7d": 318, "30d": 402 },
  "counts": {
    "signups":        { "24h": 3,  "7d": 21,  "30d": 96 },
    "llm_cost_cents": { "24h": 412, "7d": 2961, "30d": 11830 }
  },
  "totals": { "users": 1204, "users_pending": 7 }
}
```

- **`active_users`** — unchanged from v1 (whole-or-nothing, see the v1 spec).
- **`counts`** — *windowed* numbers: how many of something happened in the trailing 24 hours / 7 days /
  30 days. Every entry is `{ "24h", "7d", "30d" }`, computed at request time from ONE `now()`, each
  narrower window a subset of the wider one — so `24h ≤ 7d ≤ 30d` holds **by construction** for every key.
- **`totals`** — *point-in-time* numbers: how many of something exist right now. One integer per key.

Everything is a **non-negative JSON integer**. No floats, no strings, no nulls, no nested objects beyond
what is shown. Money is sent as **integer cents** (`llm_cost_cents`), rounded half-up from the sum — never
as dollars.

### Keys

A key is `^[a-z][a-z0-9_]{0,39}$`. At most **48** keys in `counts` and **24** in `totals`.

Canopy is **generic over keys**: it stores whatever valid keys arrive, so Sapling can add a metric later
with no Canopy change (Canopy shows an unknown key under "Other", labelled from the key). The keys Canopy
knows how to label and group today:

| Group | `counts` keys | `totals` keys |
|---|---|---|
| Growth | `signups`, `approvals`, `logins` | `users`, `users_pending` |
| Learning activity | `tutor_sessions`, `chat_messages`, `quizzes_started`, `quizzes_completed`, `documents_uploaded`, `documents_processed`, `notes_created`, `flashcards_created`, `xp_events`, `achievements_earned` | `documents`, `flashcards`, `notes` |
| Community | `room_messages`, `feedback`, `issue_reports` | `rooms` |
| AI spend | `llm_calls`, `llm_tokens`, `llm_cost_cents` | — |
| Reliability | `errors_5xx`, `errors_4xx`, `quiz_generation_failed`, `quiz_context_write_failed`, `rag_retrieval_failed`, `rag_visibility_resync_failed`, `rag_chunks_dropped` | `rag_chunks`, `rag_document_chunks` |

This table is what Sapling **serves** (SaplingLearn/Sapling#654), which differs from this spec's first draft:
`study_guides` is **omitted** (that table is a cache, so a count of it is not a count of anything a user
did — were it ever sent, it would land under "Other"), and `logins`, `quiz_context_write_failed` and
`rag_visibility_resync_failed` were **added**. Four keys are labelled or footnoted on the dashboard for
what the number really is:

| Key | On the dashboard |
|---|---|
| `rag_chunks_dropped` | labelled "RAG runs that dropped chunks" — it counts RUNS, not chunks |
| `flashcards_created` | note: "lower bound — deleted cards are not counted" |
| `errors_4xx` | note: "includes bot traffic and refused polls" |
| `llm_cost_cents` | shown as dollars; note: "lower bound — unpriced models are not counted" |

**Send only what the database can answer honestly.** A key whose source is doubtful is OMITTED, never
approximated and never sent as `0` — an absent key reads "not reported" on the dashboard, a `0` reads as a
measured zero. `llm_cost_cents` is a LOWER bound where a model is unpriced (`cost_usd IS NULL`); that is
acceptable and is said on the dashboard.

## 2. What is deliberately NOT in the contract

- **Anything per-user or that names a person.** No ids, emails, handles, per-user rollups.
- **Distinct-users-per-feature and averages over small cohorts** (average quiz score, tier distributions):
  in a small org "1 user used notes today" is close to naming them. Counts of *events* only.
- **Latency.** Successful requests write nothing to Sapling's database, so it cannot be answered honestly
  from there; Canopy already has request/error data from Cloudflare and CPU/memory from Railway.
- **Free text** of any kind (feedback comments, issue descriptions — encrypted at rest anyway).

## 3. The validation Canopy applies

`active_users`: unchanged — whole-or-nothing.

`counts` and `totals` are validated **per key** — one bad key never costs the others, and never costs
`active_users`:

| Check | Effect when it fails |
|---|---|
| `counts` / `totals` is a JSON object | that whole section is ignored |
| more than 48 / 24 keys | the section is ignored (a runaway producer is not evidence) |
| the key matches `^[a-z][a-z0-9_]{0,39}$` | that key is dropped |
| `counts[key]` is an object with exactly the numbers `24h`, `7d`, `30d` | that key is dropped |
| each value is a JSON integer, `0 ≤ v ≤ 1,000,000,000,000` | that key is dropped |
| `24h ≤ 7d ≤ 30d` | that key is dropped |
| `totals[key]` is a JSON integer, `0 ≤ v ≤ 1,000,000,000,000` | that key is dropped |

Dropped keys are logged once per poll (key names only, never values beyond a short excerpt) and reported
in the on-demand "Poll now" outcome as a count — on an `ok` outcome and, appended to the refusal, on a
`failed` one (`active_users` refused). An ignored section is named once (`counts.*`) and counts every key
it held. A name is scrubbed of the token BEFORE it is cut to 40 characters.

## 4. What Canopy does with it

- Stored hourly as gauges in `repo_metrics` (`sap_c_<key>_<24h|7d|30d>`, `sap_t_<key>`; `env` = the
  environment, `at` = the current hour's floor; first write of the hour wins).
- **Shown** on the Repo dashboard's Usage tab, per environment, grouped as in §1. A figure is shown only
  if its reading is ≤ 3 hours old; otherwise it reads "no recent reading". A key with no reading at all
  inside the read window (the last 3 hours, or a 00:00 UTC row in the last 30 days) is absent from the
  screen entirely — it is not claimed to be zero and not claimed to be quiet. The 24h / 7d / 30d selector
  picks the window for `counts`; `totals` ignore it.
- **Trend** = the daily totals: for a `counts` key its `24h` reading, for a `totals` key its own reading,
  stamped at 00:00 UTC of each of the last 30 days. A day
  whose midnight poll was missed is ABSENT (never zero). Fewer than 2 points → no sparkline.
- **Retention:** hourly `sap_*` rows are kept 7 days; the 00:00 UTC rows are kept 100 days.

## 5. Sapling-side requirements (in addition to v1's)

- **One SQL statement, one `now()`** for the whole response, so numbers can never contradict each other
  (the pattern `canopy_active_users()` set). A single function returning one JSONB document is ideal.
- `REVOKE` execute from `PUBLIC` / `anon` / `authenticated`; `GRANT` to `service_role`.
- Bounded cost: every windowed read is limited to 30 days and should hit an index on the timestamp
  column; add indexes where a table has none. It runs once an hour per environment, against an 8-second
  client timeout — keep the whole call well under a second at today's volume, and say in the PR what it
  would cost at 10×.
- Soft-deleted rows: state per key whether they are counted (recommended: `counts` of *created* things
  include rows later deleted — it is a count of what happened; `totals` exclude deleted rows).
- The route keeps v1's failure behaviour: any internal error → a generic 5xx and NO body numbers.
