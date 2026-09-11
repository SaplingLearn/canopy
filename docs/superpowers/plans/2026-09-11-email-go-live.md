# Email notifications — go-live runbook (spec §10 step 6)

Everything up to step 5 is merged via `feat/email-notifications`. Production stays in **local mode**
(no `NOTIFICATIONS_MODE`, so Resend is never called) until every step below is done, in order.

## 1. Sending domain (Resend + DNS)

1. In Resend, add the domain `mail.canopy.saplinglearn.com` (a subdomain: apex reputation stays isolated).
2. Add the DNS records Resend shows for that subdomain at the registrar: the DKIM `TXT`/`CNAME` records,
   the SPF `TXT` (`v=spf1 include:amazonses.com ~all` or whatever Resend prints), and the MX for bounces.
3. Add a DMARC record on the subdomain: `_dmarc.mail.canopy.saplinglearn.com TXT "v=DMARC1; p=quarantine; rua=mailto:<mailbox>"`.
4. Wait for Resend to show the domain as **Verified**.

## 2. Production configuration

```sh
# the Resend API key (Sending access, scoped to the domain above)
wrangler secret put RESEND_API_KEY

# schema: notification_* tables + users.email / email_unsubscribed
npm run db:migrate:remote
```

Then, in `wrangler.toml` `[vars]`, uncomment `NOTIFICATIONS_MODE = "resend"` and confirm
`PUBLIC_ORIGIN = "https://canopy.saplinglearn.com"`. Deploy with `npm run deploy`.

The from address defaults to `Canopy <canopy@mail.canopy.saplinglearn.com>` (migration 0021) — change it in
Maintenance › NOTIFICATIONS · SCHEDULE if the mailbox name differs.

## 3. First send

1. Every teammate signs in once so `users.email` is seeded from GitHub (`user:email` scope — existing
   sessions re-consent). Check Maintenance › OUTBOX after the first weekday window for one row per user.
2. Dry run without waiting for 08:00: temporarily set `send_hour` in Maintenance to the current org-local
   hour; the next `0 * * * *` tick runs the daily digest. Set it back afterwards.
3. Inspect the first messages in a mail client: subject `Canopy daily, <Mon D>`, the `List-Unsubscribe`
   headers, and that "Unsubscribe" in the footer lands on `#unsubscribe` and flips the flag.
4. A `failed` row shows the Resend error inline in the outbox; the retry job re-attempts hourly for 48h.

## Rollback

Remove `NOTIFICATIONS_MODE` from `[vars]` and redeploy: runs keep claiming outbox rows (so nothing is
double-sent later) but bodies go to the dev table and Resend is never called.
