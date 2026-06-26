-- Add avatar_url column to users so the GitHub profile picture can be stored
-- and served back via /auth/me. NULL for users created before this migration.
ALTER TABLE users ADD COLUMN avatar_url TEXT;
