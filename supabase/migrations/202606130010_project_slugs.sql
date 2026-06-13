begin;

alter table public.projects
  add column if not exists slug text;

create or replace function public.project_slug_base(source_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  value text := lower(coalesce(source_name, ''));
begin
  value := replace(value, 'щ', 'shch');
  value := replace(value, 'ж', 'zh');
  value := replace(value, 'ч', 'ch');
  value := replace(value, 'ш', 'sh');
  value := replace(value, 'ю', 'iu');
  value := replace(value, 'я', 'ia');
  value := replace(value, 'є', 'ie');
  value := replace(value, 'ї', 'i');
  value := replace(value, 'й', 'i');
  value := replace(value, 'х', 'kh');
  value := replace(value, 'ц', 'ts');
  value := replace(value, 'ґ', 'g');
  value := replace(value, 'а', 'a');
  value := replace(value, 'б', 'b');
  value := replace(value, 'в', 'v');
  value := replace(value, 'г', 'h');
  value := replace(value, 'д', 'd');
  value := replace(value, 'е', 'e');
  value := replace(value, 'з', 'z');
  value := replace(value, 'и', 'y');
  value := replace(value, 'і', 'i');
  value := replace(value, 'к', 'k');
  value := replace(value, 'л', 'l');
  value := replace(value, 'м', 'm');
  value := replace(value, 'н', 'n');
  value := replace(value, 'о', 'o');
  value := replace(value, 'п', 'p');
  value := replace(value, 'р', 'r');
  value := replace(value, 'с', 's');
  value := replace(value, 'т', 't');
  value := replace(value, 'у', 'u');
  value := replace(value, 'ф', 'f');
  value := replace(value, 'ь', '');
  value := regexp_replace(value, '[''’`]', '', 'g');
  value := regexp_replace(value, '[^a-z0-9]+', '-', 'g');
  value := trim(both '-' from value);
  return coalesce(nullif(value, ''), 'project');
end;
$$;

create or replace function public.set_project_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_slug text;
  candidate text;
  suffix integer := 1;
begin
  if new.slug is not null
     and new.slug <> ''
     and tg_op = 'UPDATE'
     and new.name is not distinct from old.name then
    return new;
  end if;

  base_slug := public.project_slug_base(new.name);
  candidate := base_slug;

  while exists (
    select 1
    from public.projects existing
    where existing.slug = candidate
      and existing.id <> new.id
  ) loop
    suffix := suffix + 1;
    candidate := base_slug || '-' || suffix::text;
  end loop;

  new.slug := candidate;
  return new;
end;
$$;

drop trigger if exists projects_set_slug on public.projects;
create trigger projects_set_slug
before insert or update of name, slug on public.projects
for each row execute function public.set_project_slug();

update public.projects
set slug = null
where slug is null or slug = '';

alter table public.projects
  alter column slug set not null;

create unique index if not exists projects_slug_unique
  on public.projects (slug);

revoke execute on function public.project_slug_base(text) from public, anon, authenticated;
revoke execute on function public.set_project_slug() from public, anon, authenticated;

commit;
