-- Normalize the docs `space` vocabulary to exactly {technical, product}.
-- Historically `space` was a loose sapling|canopy value defaulting to 'canopy',
-- disconnected from the Technical|Product tabs the Docs UI actually renders. The
-- write boundary is now a hard enum {technical, product} (default 'technical');
-- this folds any pre-existing off-vocab value (the one stray 'sapling' doc — an
-- engineering reference — plus any 'canopy'/other) into the 'technical' default.
-- Idempotent and self-defending; a no-op on a fresh local/test DB.
UPDATE docs SET space = 'technical' WHERE space NOT IN ('technical', 'product');
