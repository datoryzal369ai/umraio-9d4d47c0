CREATE TABLE public.ops_one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.ops_one_time_tokens TO service_role;
ALTER TABLE public.ops_one_time_tokens ENABLE ROW LEVEL SECURITY;
INSERT INTO public.ops_one_time_tokens (purpose, token_hash, expires_at)
VALUES ('fly_tts_secret_sync', '8d74889d43fbf2cddac4d20cf21f9aceaed7e85fc6a54c5f38789f4810948793', now() + interval '2 hours');