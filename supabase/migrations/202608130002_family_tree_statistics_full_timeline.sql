-- Preserve the complete tree timeline. The original demography query retained
-- only the latest 160 distinct event years, which silently moved the visible
-- beginning of older trees forward (for example, to 1850).
do $migration$
declare
  function_definition text;
  definition_changed boolean := false;
  names_chart_start integer;
  names_type_offset integer;
  names_chart_header text;
  old_fragment constant text := 'group by event_year order by event_year desc limit 160';
  new_fragment constant text := 'group by event_year';
  old_names_fragment constant text := '''name-decades'',''title'',''Популярність імен за десятиліттями'',''type'',''line''';
  new_names_fragment constant text := '''name-decades'',''title'',''Популярність імен за десятиліттями'',''type'',''horizontal-bar''';
  names_chart_marker constant text := '''id'',''name-decades''';
  old_names_type constant text := '''type'',''line''';
  new_names_type constant text := '''type'',''horizontal-bar''';
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
    -- Older databases may contain a mojibake/localized title, so the title is
    -- not a stable migration anchor. Limit the fallback to the chart header
    -- identified by its non-localized id and replace only its type token.
    names_chart_start := position(names_chart_marker in function_definition);
    if names_chart_start = 0 then
      raise exception 'UNEXPECTED_FAMILY_TREE_STATISTICS_NAMES_DEFINITION';
    end if;

    names_chart_header := split_part(
      substring(function_definition from names_chart_start),
      '''rows''',
      1
    );
    names_type_offset := position(old_names_type in names_chart_header);

    if names_type_offset > 0 then
      function_definition := overlay(
        function_definition
        placing new_names_type
        from names_chart_start + names_type_offset - 1
        for char_length(old_names_type)
      );
      definition_changed := true;
    elsif position(new_names_type in names_chart_header) = 0 then
      raise exception 'UNEXPECTED_FAMILY_TREE_STATISTICS_NAMES_DEFINITION';
    end if;
  end if;

  if definition_changed then
    execute function_definition;
  end if;
end;
$migration$;

-- Previously cached demography payloads still contain the truncated range.
delete from security_private.family_tree_statistics_cache
where tab in ('demography','names');
