-- Docs gain a top-level "space" — the Sapling/Canopy split shown as a toggle in the
-- Docs UI. Existing docs (the Canopy tooling docs) default to 'canopy'; Sapling product
-- docs are inserted with space='sapling'. Grouping/display only — not an access boundary.
ALTER TABLE docs ADD COLUMN space TEXT NOT NULL DEFAULT 'canopy';
CREATE INDEX idx_docs_space ON docs(space, section);
