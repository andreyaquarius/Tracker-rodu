import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
export const conflictMigration = migration("202609190001_zagulyaky_version_conflict_response");
export const conflictOwner = "70919000-0000-4000-8000-000000000001";
export const conflictOther = "70919000-0000-4000-8000-000000000002";
export const conflictRecord = "70919000-0000-4000-8000-000000000003";
export const versionedRpcNames = [
  "update_my_zagulyaka_draft_v1", "replace_my_zagulyaka_details_v1",
  "submit_zagulyaka_v1", "withdraw_zagulyaka_v1", "attach_my_zagulyaka_file_v1",
  "delete_my_zagulyaka_attachment_v2", "delete_my_zagulyaka_draft_v3",
  "admin_review_zagulyaka_v1", "admin_merge_zagulyaka_duplicate_v1",
  "admin_publish_archival_zagulyaka_v1",
];

export function extractSqlFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll(".", "\\.")}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const tag = tail.match(/as (\$\w+\$)/)![1];
  return tail.slice(0, tail.indexOf(`${tag};`) + tag.length + 1);
}

// Isolated, synthetic fixtures. The record table, update implementation, lock
// trigger and all old/new public facades are the real migration SQL. Other
// private implementations are probes: they exercise translation, argument
// forwarding and rollback without constructing unrelated storage/moderation data.
export function conflictFixtureSql(): string {
  const foundation = migration("202608180002_zagulyaky_foundation");
  const isolation = migration("202608250005_zagulyaky_security_definer_api_isolation");
  const tableStart = foundation.indexOf("create table if not exists public.zagulyaky_records");
  const table = foundation.slice(tableStart, foundation.indexOf("\n);", tableStart) + 3);
  const touch = extractSqlFunction(foundation, "security_private.touch_zagulyaky_record_v1");
  const update = extractSqlFunction(foundation, "public.update_my_zagulyaka_draft_v1")
    .replace("function public.", "function security_private.")
    // Non-transactional counter measures retries even when each call rolls back.
    .replace("begin\n", "begin\n  perform nextval('public.test_calls');\n");
  const wrappers = versionedRpcNames.map(name => {
    const source = name === "admin_publish_archival_zagulyaka_v1"
      ? migration("202609120001_zagulyaky_archival_publication")
      : name === "admin_merge_zagulyaka_duplicate_v1"
        ? migration("202608180004_zagulyaky_moderation_workflows") : isolation;
    const facade = extractSqlFunction(source, `public.${name}`);
    const header = facade.slice(0, facade.indexOf("\nreturns"));
    const args = header.match(/p_\w+\s+(uuid|integer|text|jsonb|bigint)/g)!;
    const signature = `${name}(${args.map(arg => arg.split(/\s+/)[1]).join(",")})`;
    const params = args.map((_, i) => `$${i + 1}`).join(", ");
    const implementation = name === "update_my_zagulyaka_draft_v1" ? update : `
      ${header.replace("function public.", "function security_private.")}
      returns jsonb language plpgsql security definer set search_path = pg_catalog
      as $probe$ begin
        return security_private.conflict_probe(jsonb_build_array(${params}));
      end; $probe$;`;
    const roles = name === "admin_publish_archival_zagulyaka_v1" ? "authenticated" : "authenticated, service_role";
    return `${implementation}\n${facade}
      revoke all on function public.${signature}, security_private.${signature} from public, anon, authenticated, service_role;
      grant execute on function public.${signature}, security_private.${signature} to ${roles};`;
  }).join("\n");
  return `
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    create schema auth; create schema security_private;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
    $$;
    grant usage on schema auth, security_private to authenticated, service_role;
    create table profiles(user_id uuid primary key);
    insert into profiles values ('${conflictOwner}'), ('${conflictOther}');
    create sequence test_calls;
    create table probe_writes(value jsonb);
    create function security_private.conflict_probe(value jsonb) returns jsonb
      language plpgsql security definer set search_path = pg_catalog as $$
    declare code text := nullif(current_setting('test.failure_code', true), '');
    begin
      perform nextval('public.test_calls');
      insert into public.probe_writes values (value);
      if code is not null then
        raise exception using errcode = code,
          message = coalesce(nullif(current_setting('test.failure_message', true), ''), 'ZAGULYAKA_VERSION_CONFLICT');
      end if;
      return value;
    end $$;
    ${table}
    ${touch}
    create trigger zagulyaky_records_touch before update on zagulyaky_records
      for each row execute function security_private.touch_zagulyaky_record_v1();
    insert into zagulyaky_records(id, kind, title, created_by) values
      ('${conflictRecord}', 'person', 'Synthetic draft', '${conflictOwner}');
    alter table zagulyaky_records enable row level security;
    revoke all on table zagulyaky_records from public, anon, authenticated;
    ${wrappers}
  `;
}
