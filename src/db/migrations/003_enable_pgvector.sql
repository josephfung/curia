-- Up Migration

-- Enable pgvector extension for vector similarity search.
-- Requires pgvector to be installed on the Postgres server.
-- In Docker: the postgresml/pgvector image includes it.
-- On managed Postgres: enable via provider console first.
CREATE EXTENSION IF NOT EXISTS vector;
