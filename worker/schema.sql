-- nhforum D1 schema. Only identity and sessions live here.
-- The posts are in the Durable Object's SQLite, because they are the log.

CREATE TABLE IF NOT EXISTS users (
  author      TEXT PRIMARY KEY,
  handle      TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  verified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  handle     TEXT NOT NULL,
  author     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  author     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS magic_email ON magic (email, created_at);
CREATE INDEX IF NOT EXISTS sessions_author ON sessions (author);
