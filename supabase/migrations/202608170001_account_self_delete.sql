create or replace function public.delete_account_data(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  relation record;
  total_deleted bigint := 0;
  removed bigint := 0;
begin
  if p_user_id is null then
    raise exception 'Не вказано ідентифікатор користувача.';
  end if;

  for relation in
    select distinct
      child_ns.nspname as table_schema,
      child_class.relname as table_name,
      child_attr.attname as column_name
    from pg_constraint c
    join pg_class child_class
      on child_class.oid = c.conrelid
    join pg_namespace child_ns
      on child_ns.oid = child_class.relnamespace
    join pg_class parent_class
      on parent_class.oid = c.confrelid
    join pg_namespace parent_ns
      on parent_ns.oid = parent_class.relnamespace
    join unnest(c.conkey) with ordinality as child_keys(attnum, ord) on true
    join unnest(c.confkey) with ordinality as parent_keys(attnum, ord) on parent_keys.ord = child_keys.ord
    join pg_attribute child_attr
      on child_attr.attrelid = c.conrelid and child_attr.attnum = child_keys.attnum
    join pg_attribute parent_attr
      on parent_attr.attrelid = c.confrelid and parent_attr.attnum = parent_keys.attnum
    where c.contype = 'f'
      and child_ns.nspname in ('public', 'private')
      and (
        (parent_ns.nspname = 'public' and parent_class.relname = 'profiles' and parent_attr.attname = 'user_id')
        or
        (parent_ns.nspname = 'auth' and parent_class.relname = 'users' and parent_attr.attname = 'id')
      )
  loop
    if relation.table_schema = 'public' and relation.table_name = 'profiles' then
      continue;
    end if;

    execute format(
      'delete from %I.%I where %I = $1',
      relation.table_schema,
      relation.table_name,
      relation.column_name
    ) using p_user_id;
    get diagnostics removed = row_count;
    total_deleted := total_deleted + removed;
  end loop;

  delete from public.profiles where user_id = p_user_id;
  get diagnostics removed = row_count;
  total_deleted := total_deleted + removed;

  return total_deleted::integer;
end;
$$;

revoke all on function public.delete_account_data(uuid) from anon, authenticated;
