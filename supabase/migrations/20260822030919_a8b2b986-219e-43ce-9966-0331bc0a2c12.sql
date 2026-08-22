ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_reply_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_reply_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_muted_at timestamptz;

CREATE INDEX IF NOT EXISTS conversations_ai_reply_due_idx
  ON public.conversations (ai_reply_due_at)
  WHERE ai_reply_due_at IS NOT NULL;