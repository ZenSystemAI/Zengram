-- Expose the same text fallback as reembed.js to Ptah's column-based source.
-- A generated column follows payload edits without another application write.
-- Adding a STORED column rewrites the table: schedule this one-time setup.
SET lock_timeout = '5s';
ALTER TABLE public.memories ADD COLUMN embedding_text text GENERATED ALWAYS AS (
  COALESCE(NULLIF(payload->>'text', ''), NULLIF(payload->>'content', ''),
           NULLIF(payload->>'note', ''), payload->>'title', '')
) STORED;
