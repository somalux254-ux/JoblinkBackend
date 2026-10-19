-- Add indexes to speed up common queries and reduce sequential scans
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles (lower(email));
CREATE INDEX IF NOT EXISTS idx_profiles_id ON public.profiles (id);
CREATE INDEX IF NOT EXISTS idx_follows_followed_id ON public.follows (followed_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON public.follows (follower_id);

-- Consider adding partial indexes for active rows if you have soft-deletes
-- CREATE INDEX IF NOT EXISTS idx_follows_followed_id_active ON public.follows (followed_id) WHERE deleted_at IS NULL;

-- If you use queries on likes table frequently, add similar indexes:
-- CREATE INDEX IF NOT EXISTS idx_likes_liked_profile_id ON public.likes (liked_profile_id);
