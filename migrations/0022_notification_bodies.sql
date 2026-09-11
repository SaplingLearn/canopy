-- Dev-only rendered-message store (canopy-email.md §9). In local mode the run
-- assembler writes the full message here instead of calling Resend, so bodies
-- can be inspected and tests can assert on rows. Never written in production
-- (the Resend delivery path does not touch it).
CREATE TABLE notification_outbox_bodies (
  idempotency_key TEXT PRIMARY KEY REFERENCES notification_outbox(idempotency_key),
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
