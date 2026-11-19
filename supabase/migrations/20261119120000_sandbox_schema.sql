-- The public sandbox's store, in Postgres. Synthetic data only (see scripts/sandbox-seed.ts).
-- It lives in its own schema, which the Data API does not expose, and every table has
-- row level security on with no policy, so the anon and authenticated keys can read
-- and write nothing. The Edge Function connects directly (SUPABASE_DB_URL) as a role
-- that bypasses it.

create extension if not exists vector with schema extensions;
create schema if not exists sandbox;

-- Facts about the whole sandbox: the quota payload, and the embedding model the stored
-- vectors were made with. A query embedded by another model is not comparable to them
-- (ada-002 and 3-small are both 1536-wide, so nothing would fail, the ranking would
-- just be wrong), so the function refuses to search when the two differ.
create table sandbox.meta (
  key   text primary key,
  value jsonb not null
);

create table sandbox.conversations (
  id              uuid primary key,
  store_id        uuid not null,
  channel         text not null,
  handover_status text not null,
  started_at      timestamptz not null,
  activity        timestamptz not null, -- last_message_at, else started_at: the list order
  body            jsonb not null        -- the conversation as the API returns it, without its messages
);
create index conversations_list_idx on sandbox.conversations (store_id, activity desc);

create table sandbox.messages (
  id              text primary key,
  conversation_id uuid not null references sandbox.conversations (id) on delete cascade,
  seq             integer not null,
  body            jsonb not null,
  unique (conversation_id, seq)
);

create table sandbox.tool_logs (
  id              bigserial primary key,
  store_id        uuid not null,
  conversation_id uuid,
  tool_name       text not null,
  created_at      timestamptz not null,
  body            jsonb not null
);
create index tool_logs_conversation_idx on sandbox.tool_logs (conversation_id, created_at);
create index tool_logs_store_idx on sandbox.tool_logs (store_id, created_at desc);

-- One row per passage, like knowledge_embeddings in the production API.
-- No vector index on purpose. Production had an IVFFlat index (lists=100, probes=1) on
-- a few hundred rows; it searched one of 100 lists, then filtered by store, and returned
-- empty or short results with no error (AGEN-62; migration 401 dropped it). At this size an
-- exact scan is the right answer.
create table sandbox.knowledge (
  id          bigserial primary key,
  store_id    uuid not null,
  kb_item_id  text not null,
  title       text not null,
  chunk_text  text not null,
  embedding   extensions.vector(1536)
);
create index knowledge_store_idx on sandbox.knowledge (store_id);

-- Searches embed the query with a paid API, and the token is public. This counts them so
-- the function can refuse past a limit, whichever isolate answers.
create table sandbox.search_log (
  at timestamptz not null default now()
);
create index search_log_at_idx on sandbox.search_log (at);

alter table sandbox.meta enable row level security;
alter table sandbox.conversations enable row level security;
alter table sandbox.messages enable row level security;
alter table sandbox.tool_logs enable row level security;
alter table sandbox.knowledge enable row level security;
alter table sandbox.search_log enable row level security;
