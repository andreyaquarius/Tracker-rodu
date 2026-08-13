-- Preserve the complete tree timeline. The original demography query retained
-- only the latest 160 distinct event years, which silently moved the visible
-- beginning of older trees forward (for example, to 1850).
do $migration$
declare
  function_definition text;
  definition_changed boolean := false;
  old_fragment constant text := 'group by event_year order by event_year desc limit 160';
  new_fragment constant text := 'group by event_year';
  old_names_fragment constant text := '''name-decades'',''title'',''Популярність імен за десятиліттями'',''type'',''line''';
  new_names_fragment constant text := '''name-decades'',''title'',''Популярність імен за десятиліттями'',''type'',''horizontal-bar''';
begin
  select pg_get_functiondef(
    'security_private.get_family_tree_statistics_tab_v1(jsonb,text)'::regprocedure
  ) into function_definition;

  if function_definition is null then
    raise exception 'FAMILY_TREE_STATISTICS_FUNCTION_NOT_FOUND';
  end if;

  if position(old_fragment in function_definition) > 0 then
    function_definition := replace(function_definition, old_fragment, new_fragment);
    definition_changed := true;
  elsif position(
    'from event_years where event_year is not null group by event_year) x'
    in function_definition
  ) = 0 then
    raise exception 'UNEXPECTED_FAMILY_TREE_STATISTICS_TIMELINE_DEFINITION';
  end if;

  if position(old_names_fragment in function_definition) > 0 then
    function_definition := replace(function_definition, old_names_fragment, new_names_fragment);
    definition_changed := true;
  elsif position(new_names_fragment in function_definition) = 0 then
    raise exception 'UNEXPECTED_FAMILY_TREE_STATISTICS_NAMES_DEFINITION';
  end if;

  if definition_changed then
    execute function_definition;
  end if;
end;
$migration$;

-- Previously cached demography payloads still contain the truncated range.
delete from security_private.family_tree_statistics_cache
where tab in ('demography','names');
