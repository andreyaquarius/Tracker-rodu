begin;

-- TZ 13, section 26: saved Research Graph views can select one of the three
-- implemented renderers.  Config version 1 is intentionally retained because
-- this only widens an existing enum-like field; every radial row remains valid.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

alter table security_private.context_graph_saved_views
  drop constraint if exists context_graph_saved_views_layout;
alter table security_private.context_graph_saved_views
  add constraint context_graph_saved_views_layout
  check (layout_id in ('radial', 'hierarchical', 'force'));

-- Keep the original, thoroughly checked v1 save function as the canonical
-- parser for all fields.  Non-radial input is temporarily normalized to the
-- legacy radial value, passed through that parser, and only then is the
-- allowlisted layout written to the same owner-scoped row.  Updates still
-- advance the optimistic lock inside the original function, so an existing
-- public share is suspended exactly as it was for radial configuration edits.
create or replace function security_private.save_context_graph_saved_view_layout_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  payload jsonb := coalesce(p_payload, '{}'::jsonb);
  view_state jsonb;
  radial_payload jsonb;
  saved_result jsonb;
  saved_id uuid;
  layout_value text;
  result_row security_private.context_graph_saved_views%rowtype;
begin
  -- Preserve the exact legacy validation/error for a malformed top-level or
  -- viewState payload rather than attempting to repair it in this adapter.
  if jsonb_typeof(payload) <> 'object' then
    return security_private.save_context_graph_saved_view_v1(
      p_project_id, p_payload, p_expected_lock_version
    );
  end if;
  view_state := coalesce(payload->'viewState', '{}'::jsonb);
  if jsonb_typeof(view_state) <> 'object' then
    return security_private.save_context_graph_saved_view_v1(
      p_project_id, p_payload, p_expected_lock_version
    );
  end if;

  layout_value := lower(btrim(coalesce(view_state->>'layoutId', 'radial')));
  if layout_value not in ('radial', 'hierarchical', 'force') then
    -- Let the original body preserve authorization and validation ordering.
    return security_private.save_context_graph_saved_view_v1(
      p_project_id, p_payload, p_expected_lock_version
    );
  end if;
  if layout_value = 'radial' then
    return security_private.save_context_graph_saved_view_v1(
      p_project_id, p_payload, p_expected_lock_version
    );
  end if;

  radial_payload := jsonb_set(
    payload,
    '{viewState}',
    jsonb_set(view_state, '{layoutId}', to_jsonb('radial'::text), true),
    true
  );
  saved_result := security_private.save_context_graph_saved_view_v1(
    p_project_id, radial_payload, p_expected_lock_version
  );
  begin
    saved_id := (saved_result->>'id')::uuid;
  exception when invalid_text_representation or null_value_not_allowed then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND' using errcode = 'P0002';
  end;

  update security_private.context_graph_saved_views saved
  set layout_id = layout_value
  where saved.id = saved_id
    and saved.project_id = p_project_id
    and saved.owner_id = actor_id
  returning saved.* into result_row;
  if not found then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform security_private.validate_context_graph_saved_view_v1(result_row);
  return security_private.context_graph_saved_view_json_v1(result_row);
end;
$function$;

create or replace function public.save_context_graph_saved_view_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.save_context_graph_saved_view_layout_v1(
    p_project_id, p_payload, p_expected_lock_version
  );
$function$;

revoke all on function security_private.save_context_graph_saved_view_layout_v1(
  uuid, jsonb, integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.save_context_graph_saved_view_layout_v1(
  uuid, jsonb, integer
) to authenticated;

revoke all on function public.save_context_graph_saved_view_v1(
  uuid, jsonb, integer
) from public, anon, authenticated, service_role;
grant execute on function public.save_context_graph_saved_view_v1(
  uuid, jsonb, integer
) to authenticated;

notify pgrst, 'reload schema';

commit;
