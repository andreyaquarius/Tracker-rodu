begin;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);

revoke all on schema supabase_migrations from public, anon, authenticated;
revoke all on table supabase_migrations.schema_migrations
  from public, anon, authenticated;

commit;
