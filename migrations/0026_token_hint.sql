-- The first characters of a token's random part, kept so Settings can tell a person's
-- tokens apart. Only the SHA-256 hash is stored otherwise, so without this a listed
-- token has no name. NULL for every token minted before this migration.
ALTER TABLE mcp_tokens ADD COLUMN token_hint TEXT;
