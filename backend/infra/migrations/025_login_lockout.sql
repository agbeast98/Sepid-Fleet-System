ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0 CHECK (failed_login_attempts BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS login_locked_until timestamptz;
