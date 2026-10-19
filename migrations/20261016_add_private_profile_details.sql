CREATE TABLE IF NOT EXISTS public.private_profile_details (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_of_birth date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS private_profile_details_auth_user_id_idx
  ON public.private_profile_details (auth_user_id);

ALTER TABLE public.private_profile_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own private profile details" ON public.private_profile_details;
CREATE POLICY "Users can read their own private profile details"
  ON public.private_profile_details FOR SELECT
  USING (auth.uid() = auth_user_id);

DROP POLICY IF EXISTS "Users can insert their own private profile details" ON public.private_profile_details;
CREATE POLICY "Users can insert their own private profile details"
  ON public.private_profile_details FOR INSERT
  WITH CHECK (
    auth.uid() = auth_user_id
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = profile_id AND p.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own private profile details" ON public.private_profile_details;
CREATE POLICY "Users can update their own private profile details"
  ON public.private_profile_details FOR UPDATE
  USING (auth.uid() = auth_user_id)
  WITH CHECK (
    auth.uid() = auth_user_id
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = profile_id AND p.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own private profile details" ON public.private_profile_details;
CREATE POLICY "Users can delete their own private profile details"
  ON public.private_profile_details FOR DELETE
  USING (auth.uid() = auth_user_id);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS date_of_birth date;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE date_of_birth IS NOT NULL
      AND date_of_birth::text <> ''
      AND date_of_birth::text !~ '^\d{4}-\d{2}-\d{2}$'
  ) THEN
    RAISE EXCEPTION 'Cannot safely migrate invalid profiles.date_of_birth values; correct them before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE date_of_birth IS NOT NULL
      AND date_of_birth::text <> ''
      AND auth_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot safely migrate dates of birth for profiles without an auth_user_id.';
  END IF;
END $$;

INSERT INTO public.private_profile_details (profile_id, auth_user_id, date_of_birth)
SELECT id, auth_user_id, NULLIF(date_of_birth::text, '')::date
FROM public.profiles
WHERE date_of_birth IS NOT NULL
  AND date_of_birth::text <> ''
  AND date_of_birth::text ~ '^\d{4}-\d{2}-\d{2}$'
ON CONFLICT (profile_id) DO UPDATE
SET auth_user_id = EXCLUDED.auth_user_id,
    date_of_birth = EXCLUDED.date_of_birth,
    updated_at = now();

ALTER TABLE public.profiles DROP COLUMN IF EXISTS date_of_birth;
