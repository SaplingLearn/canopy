INSERT INTO sections (name, description) VALUES
  ('reference', 'Stable reference docs and architecture'),
  ('context', 'Working context and background'),
  ('decisions', 'Architecture decision records'),
  ('needs-triage', 'Catch-all for items needing human placement');

INSERT INTO tags (tag, description) VALUES
  ('auth', 'Authentication and authorization'),
  ('architecture', 'System architecture and structure'),
  ('infra', 'Infrastructure and deployment'),
  ('api', 'API surface and routes'),
  ('ui', 'Frontend and UI'),
  ('data', 'Data model and storage');
