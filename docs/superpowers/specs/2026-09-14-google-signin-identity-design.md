# Google sign-in and a person-centric identity

Status: approved design, 2026-09-14. Design page: https://claude.ai/code/artifact/aa08177b-d5c7-4a7e-aca9-7060a7b54cbc

## 1. Goal

Canopy gets a second way in for teammates who are not on GitHub. Admins invite a Google address
from Maintenance, the invitee receives an email, signs in with Google, picks a handle and a color
once, and is a full person in Canopy from then on. To make that possible, every table that keys on
a GitHub login keys on a **person** instead.

Out of scope: native tickets (a later project), any change to the bearer or webhook auth classes,
any new MCP tool.

## 2. Decisions

| Decision | Choice |
|---|---|
| Who gets in via Google | Admin invite list. Only an invited, verified address may create a person. |
| Identity model | `persons` is primary. GitHub logins and Google subjects are rows in `identities`. `users` and `people` are dropped. |
| Handle | Chosen at first sign-in, prefilled with the GitHub login. Renameable from Settings; a rename rewrites every stored handle atomically (`HANDLE_COLUMNS`). |
| Color | One of ten named palette tokens, stored by name. Editable in Settings. |
| Auth classes | Still three (session cookie, bearer, webhook). Google is a second provider inside the session-cookie class. |
| Onboarding state | A sealed cookie, same pattern as the PKCE transaction cookie. No pending rows in D1. |
| Invite email | Sent on invite through `deliveryFor` (the digest delivery gate). Resendable from Maintenance, no cooldown. |
| Account linking | Settings › Profile lists sign-in methods; link starts the provider flow with a link flag; the last method cannot be unlinked. |
| Auto-link at sign-in | If an unknown Google identity's verified email equals an existing `persons.email`, link silently and sign in. |
| Existing GitHub users | Migrated with handle = login, a hashed default color, `onboarded_at = created_at`. They never see the onboarding screen. |
| MCP tokens | Any signed-in person may mint one, Google-only included. |

## 3. Data model

One migration, `migrations/0023_persons.sql`. D1 cannot rename an FK'd column, so `sessions` and
`mcp_tokens` are recreated the way `0011_fts_recreate.sql` did it.

### persons (new)

| column | notes |
|---|---|
| `handle` TEXT PK | Chosen at first sign-in; renameable from Settings (`renamePerson` rewrites every stored handle atomically). New handles match `^[a-z][a-z0-9-]{1,23}$`; migrated GitHub logins keep their casing. Unique `COLLATE NOCASE`. |
| `name` TEXT | Display name. From the provider at first sign-in; editable. |
| `color` TEXT NOT NULL | One of `moss fern sky slate plum rose rust ochre clay stone`. CHECK constraint. |
| `avatar_url` TEXT | From the provider; refreshed at each sign-in. |
| `email` TEXT | Moved from `users`. Same COALESCE-on-login rule (never overwrites a set value). |
| `email_unsubscribed` INTEGER NOT NULL DEFAULT 0 | Moved from `users`. |
| `created_at` TEXT NOT NULL | ISO8601. |
| `onboarded_at` TEXT NOT NULL | ISO8601 when handle + color were confirmed. |

Reserved handles, refused at onboarding: `github-webhook`, `system`, `admin`, `canopy`, `me`.

### identities (new)

| column | notes |
|---|---|
| `provider` TEXT | `github` or `google`. PK with `subject`. |
| `subject` TEXT | GitHub: the login (what `events.subject_login` carries). Google: the stable `sub` claim. |
| `label` TEXT NOT NULL | Human-readable: the GitHub login, or the Google email. |
| `person` TEXT NOT NULL | FK → `persons.handle`. Indexed. |
| `linked_at` TEXT NOT NULL | ISO8601. |
| `linked_by` TEXT NOT NULL | The handle that made the link: the person at sign-in, or an admin via identity triage. |

### invites (new)

| column | notes |
|---|---|
| `email` TEXT PK | Lowercased. |
| `name` TEXT | Optional; prefills the display name at onboarding. |
| `invited_by` TEXT NOT NULL | Admin handle. |
| `invited_at` TEXT NOT NULL | ISO8601. |
| `accepted_by` TEXT | The handle created from it; NULL while pending. |
| `revoked_at` TEXT | Soft revoke. A revoked invite is refused at sign-in; the row stays. |
| `email_sent_at` TEXT | Last invite-email attempt (create or resend). |
| `email_id` TEXT | Resend message id, or the local body key in local mode. |
| `email_error` TEXT | Last delivery error, NULL on success. |

### Repointed

- `sessions.user` → `sessions.person` (FK `persons.handle`). Recreated.
- `mcp_tokens.user` → `mcp_tokens.person` (FK `persons.handle`). Recreated.
- `notification_prefs.user_id`, `notification_outbox.*`: already opaque strings holding the
  handle. No schema change.
- `notification_outbox_bodies`: recreated **without** its FK to `notification_outbox`, so it can
  hold any dev-mode message (invite emails included). Key stays `idempotency_key`.

### Dropped

- `users`: every row becomes a person (`handle = github_login`, name, avatar_url, email,
  email_unsubscribed, created_at, `onboarded_at = created_at`, `color` = stable hash of the
  handle over the ten tokens) plus one `identities` row `(github, github_login)`.
- `people`: each `(login, person)` row becomes an `identities` row `(github, login)` pointing at
  the person whose `users.name = people.person`. If no such person exists (a display name that
  never logged in), the migration does not guess: it inserts an `identity_tasks` row for the
  login so an admin maps it in Maintenance. The migration prints nothing; the test asserts both
  branches.

`shared/rows.ts` gains `PersonRow`, `IdentityRow`, `InviteRow`; `scripts/seed/reset.mjs` adds the
three tables to the truncation list.

## 4. Auth

### Principal

`Principal` becomes `{ handle: string }` (rename of `login`; the value for migrated users is
identical). `ADMIN_LOGINS` keeps its name and semantics: a comma-separated list of handles.
`isAdmin` is unchanged.

### Providers

- **GitHub**: unchanged authorize/exchange/user/membership code in `src/auth/github.ts`.
- **Google**: new `src/auth/google.ts`. Authorize URL at `https://accounts.google.com/o/oauth2/v2/auth`
  with `scope=openid email profile`, `code_challenge` (S256), `state`, and `login_hint` when the
  request carries one. Code exchange at `https://oauth2.googleapis.com/token`. The ID token is
  parsed and verified: `iss` in `{https://accounts.google.com, accounts.google.com}`, `aud` equals
  `GOOGLE_CLIENT_ID`, `exp` in the future, `email_verified === true`. Signature verification uses
  Google's JWKS fetched at callback time (`https://www.googleapis.com/oauth2/v3/certs`) via Web
  Crypto RS256. `fetchImpl` is injectable for tests. New secrets: `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`.

### Transaction cookie

`oauth_tx` is sealed with `COOKIE_SECRET` and now carries `state.verifier.provider.mode`, where
`mode` is `signin` or `link`. `link` is only issued when a session principal exists; the callback
re-resolves the session and refuses (403) if it is gone.

### The fork (shared by both callbacks, `src/auth/onboard.ts`)

After the provider gate passes (GitHub: active org member; Google: `email_verified`):

1. `identities(provider, subject)` exists → `recordSignIn` (refresh name/avatar, COALESCE email),
   create session, redirect `/`.
2. Not found, but `persons.email = <verified email>` (GitHub: primary verified address from
   `GET /user/emails`; Google: the `email` claim) → insert the identity row (`linked_by` = that
   person), then as (1).
3. Not found, but `invites.email = <email>` with `revoked_at IS NULL AND accepted_by IS NULL`, **or**
   the provider is GitHub (org membership is the invite) → set the `onboard` cookie and redirect to
   `/#onboard`.
4. Otherwise → redirect `/?denied=invite` (Google) or `/?denied=1` (GitHub, unchanged).

In `link` mode the fork is skipped: if `(provider, subject)` already belongs to another person →
409 page; else insert the identity for the current principal and redirect `/#settings`.

### Onboarding cookie

`onboard`, HttpOnly, Secure, SameSite=Lax, 10-minute max-age, sealed with `COOKIE_SECRET`:
`{ provider, subject, label, email, name, avatar_url, suggested_handle, invite_email | null }`.
`suggested_handle` is the GitHub login for GitHub, else the local part of the email lowercased
and stripped to the handle alphabet.

### Routes (all in `src/auth/routes.ts` unless noted)

| Route | Auth | Behavior |
|---|---|---|
| `GET /auth/login` | public | Unchanged. `?link=1` requires a session and issues a link-mode tx. |
| `GET /auth/callback` | public | GitHub. Membership check, then the fork. |
| `GET /auth/google/login` | public | Google PKCE start. Accepts `?login_hint=`, `?prompt=select_account` (passed through) and `?link=1`. |
| `GET /auth/google/callback` | public | Exchange, verify ID token, then the fork. |
| `GET /auth/onboard` | onboard cookie | Returns the cookie payload minus `subject`, for prefill. 401 without a valid cookie. |
| `GET /auth/handle-check?handle=` | onboard cookie | `{ available: boolean, reason?: "invalid" \| "reserved" \| "taken" }`. |
| `POST /auth/onboard` | onboard cookie | Body `{ handle, name, color }`. Validates all three; inserts `persons` + `identities`; marks the invite `accepted_by`; clears the cookie; creates the session. 409 `{ error: "handle_taken" }` on a race. |
| `GET /auth/me` | session | Returns `{ handle, name, color, avatar_url, identities: [{provider, label, linked_at}], admin }`. |
| `PUT /auth/me` | session | Body `{ name?, color? }`. Handle is not editable. |
| `POST /auth/identities/:provider/unlink` | session | Deletes the caller's own row for that provider. 409 if it is the last one. |
| `POST /auth/mcp-token` | session | Unchanged. |
| `GET /invites` | session, admin | Pending and accepted invites with email status. In `src/routes.ts`. |
| `POST /invites` | session, admin | Body `{ email, name? }`. Inserts (409 if the address is already a person's email or a live invite), then sends the invite email. |
| `POST /invites/:email/revoke` | session, admin | Sets `revoked_at`. Idempotent. |
| `POST /invites/:email/resend` | session, admin | Sends the invite email again; updates the three email columns. |

`PUBLIC_PATHS` in `src/auth/principal.ts` grows by the Google login/callback and the three
onboard-cookie routes (which gate themselves on the cookie).

MCP surface: no tool shape changes. `get_my_work` resolves the bearer's handle directly instead
of through the `people` map.

## 5. Invite email

`src/notifications/invite.ts` exports `sendInvite(env, db, invite, invitedByName, fetchImpl?)`.
It renders subject `"<Name> invited you to Canopy"`, an HTML body and a text body using the digest
template layer, with one button linking to
`${PUBLIC_ORIGIN}/auth/google/login?login_hint=<email>`. It calls `deliveryFor(env, …)`: in
`local` mode the body is written to `notification_outbox_bodies` under key
`invite:<email>:<invited_at>`; in `resend` mode it is sent. The outcome is written to
`invites.email_sent_at / email_id / email_error`. A delivery failure does not fail the invite; the
row is created and the error is shown in Maintenance.

Two changes to the shared sender: `Delivery.send` accepts an optional `unsubscribeUrl`; when
absent, `resendDelivery` sends no `List-Unsubscribe` headers. `localDelivery` no longer requires
an outbox row (the FK is gone per §3).

This is not a `NotificationKind`: no cadence, no prefs, no window, no registry entry.

## 6. Reads and writers that change

- `src/tools/mywork.ts`: person lookup becomes `SELECT p.* FROM identities i JOIN persons p ON
  p.handle = i.person WHERE i.provider='github' AND i.subject = ?` for event subjects, and a
  direct `persons` fetch for the bearer.
- `src/tools/writes.ts` `map_identity`: inserts an `identities` row `(github, login, label=login,
  person=<handle>, linked_by=<admin>)` and resolves the task. The Maintenance picker lists persons
  by handle.
- `src/tools/reads.ts` `list_identity_tasks` and any `people` join: same replacement.
- `src/notifications/*`: every `users` read becomes `persons`; renderers carry `color` so the
  avatar chip in the digest matches the app. `routes.ts` `users/:login` becomes `persons/:handle`.
- `src/auth/users.ts` is replaced by `src/auth/persons.ts` (`recordSignIn`, `createPerson`,
  `handleAvailable`, `updateProfile`).

## 7. Web

- **Sign-in card**: existing GitHub button, an `or` rule, an outline `Continue with Google`
  button (`/auth/google/login`). Footer copy: "GitHub for engineers. Google for everyone else on
  the team, by invitation."
- **Not invited**: `?denied=invite` renders the Google twin of the non-member card, naming the
  address and offering "Try a different account" (`/auth/google/login?prompt=select_account`).
- **Onboarding** (`#onboard`): loads `GET /auth/onboard`; one form with handle (live check,
  debounced 250 ms), display name, ten color swatches (radiogroup), a feed-row preview, and
  "Enter Canopy". On 409 the handle field shows "taken" and re-checks.
- **Settings › Profile**: display name, color swatches, handle shown read-only, Sign-in methods
  list with Link/Unlink per provider. Unlink is disabled on the last method.
- **Maintenance › People**: invite input + button; one row per person (avatar chip in their
  color, name, handle, identity chips) and per pending invite (email, invited-by, email status,
  Resend, Revoke).
- **Avatar chip**: one helper in `web/src/ui.ts` renders initials on the person's color with the
  provider image on top when present. Used in feed rows, author chips, decision authors, the
  sidebar chip, People, and the digest.
- **Color tokens**: `--p-<name>` per theme in `web/src/canopy.css` (light / dark / midnight = dark):
  moss `#6f8a3a/#9aab65`, fern `#2f7d57/#5ab88a`, sky `#3e6f8a/#6aa8c4`, slate `#5b6b8c/#8d9bc0`,
  plum `#7a4f8f/#b48ac8`, rose `#a84a68/#d47a97`, rust `#b4562c/#d98a52`, ochre `#a8791e/#d4a84a`,
  clay `#8c5a3c/#c2895f`, stone `#6b665e/#9a958d`. The email template inlines the light set.

## 8. Errors and edge cases

- Google returns an unverified email → treated as gate failure → `?denied=invite`.
- ID token fails any check → 401 `{ error: "identity_failed" }`, same as GitHub's failure shape.
- Invite revoked between email and sign-in → `?denied=invite`.
- Two people onboard the same handle concurrently → the second insert violates the NOCASE unique
  index → 409 `handle_taken`; the cookie is kept so they can retry.
- A GitHub user signs in with Google whose email matches nobody and no invite → `?denied=invite`.
  They link from Settings instead.
- Link mode where the identity belongs to someone else → 409 page with the other handle hidden.
- Unlinking the last identity → 409 `{ error: "last_identity" }`.
- Delivery config error (`resend` mode without key) → the invite is still created; `email_error`
  records the config error.
- `DEV_LOGIN` keeps working: it names a handle.

## 9. Tests

All against real Miniflare D1; provider and Resend I/O via injected `fetchImpl`.

- `test/migrations.persons.test.ts`: seeds pre-0023 `users` and `people` rows (including a
  `people` display name with no user), runs the migration, asserts persons, identities, the
  identity task, repointed sessions/tokens.
- `test/auth.google.test.ts`: authorize URL shape; ID token verification (bad iss, aud, exp,
  unverified email, bad signature); each fork branch; link mode incl. the 409.
- `test/onboard.test.ts`: cookie sealing/expiry; handle-check (invalid, reserved, taken, case);
  POST creates person + identity + accepts invite + session; concurrent-handle 409.
- `test/invites.test.ts`: admin gate; create sends (bodies row in local mode); resend; revoke
  refused at sign-in; email failure recorded, invite still created.
- `test/profile.test.ts`: PUT name/color validation; unlink incl. last-identity 409.
- Existing auth, mywork, identity-triage and notification tests updated for `persons`.

## 10. Docs

- `CLAUDE.md`: Auth section says three classes, two providers in the session class; the identity
  paragraph says persons + identities, not users + people; migrations list adds `0023_persons`;
  env adds the two Google secrets; a new short Invites paragraph under Email notifications.
- `.claude/skills/canopy`: the authority model names the person/handle.

## 11. Estimate

About four and a half days: migration and identity refactor 1.5, Google provider + fork +
onboarding API 1, invite email + linking 0.5, screens 1, tests/docs 0.5.
