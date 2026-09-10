begin;

-- A scalar JSON response is not truncated by PostgREST's 1,000-row limit.
-- Count the complete profile directory, but send only 50 subscriptions.
-- Keep the legacy endpoint intact for clients running the previous frontend.
create or replace function public.admin_list_subscriptions_page_v1(
  p_page integer default 1,
  p_query text default '',
  p_plan text default 'all',
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  query_text text := lower(btrim(coalesce(p_query, '')));
  plan_filter text := coalesce(p_plan, 'all');
  status_filter text := coalesce(p_status, 'all');
  result jsonb;
begin
  -- Same guard and table RLS as admin_list_subscriptions; no elevated access.
  if not public.is_app_admin((select auth.uid())) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if char_length(query_text) > 200
    or plan_filter not in ('all', 'admin', 'free', 'researcher', 'professional')
    or status_filter not in ('all', 'active', 'trialing', 'past_due', 'cancelled', 'expired') then
    raise exception 'Invalid subscription filters' using errcode = '22023';
  end if;

  with source as materialized (
    select profile.user_id, profile.email, profile.display_name, profile.created_at,
      public.is_app_admin(profile.user_id) as is_admin,
      subscription.status as stored_status, subscription.trial_ends_at,
      subscription.current_period_end, plan.code as stored_plan
    from public.profiles profile
    left join public.user_subscriptions subscription on subscription.user_id = profile.user_id
    left join public.subscription_plans plan on plan.id = subscription.plan_id
  ), effective as (
    select user_id, email, display_name, created_at, is_admin,
      case
        when is_admin then 'professional'
        when stored_status = 'trialing' and trial_ends_at > now() then 'professional'
        when stored_status = 'active' and (current_period_end is null or current_period_end > now()) then stored_plan
        else 'free'
      end as plan_code,
      case
        when is_admin then 'active'
        when stored_status = 'trialing' and trial_ends_at <= now() then 'expired'
        when stored_status = 'active' and current_period_end is not null and current_period_end <= now() then 'expired'
        else coalesce(stored_status, 'active')
      end as status,
      case when is_admin then null else trial_ends_at end as trial_ends_at,
      case when is_admin then null else current_period_end end as current_period_end
    from source
  ), filtered as materialized (
    select * from effective row
    where (plan_filter = 'all' or (plan_filter = 'admin' and row.is_admin)
      or (not row.is_admin and row.plan_code = plan_filter))
      and (status_filter = 'all' or row.status = status_filter)
      -- Literal substring search: %, _ and backslashes are not SQL wildcards.
      and (query_text = '' or strpos(lower(concat_ws(' ', row.display_name, row.email,
        row.plan_code, row.status, case when row.is_admin then 'адміністратор admin' else '' end)), query_text) > 0)
  ), counts as (
    select (select count(*) from source) as total_count, count(*) as filtered_count from filtered
  ), pagination as (
    select *, least(greatest(coalesce(p_page, 1), 1)::bigint,
      greatest(1, (filtered_count + 49) / 50)) as page from counts
  ), page_rows as (
    select * from filtered
    order by is_admin desc, created_at desc, user_id asc
    limit 50 offset (select (page - 1) * 50 from pagination)
  )
  select jsonb_build_object(
    'total_count', pagination.total_count,
    'filtered_count', pagination.filtered_count,
    'page', pagination.page,
    'page_size', 50,
    'items', coalesce((select jsonb_agg(to_jsonb(row) - 'created_at'
      order by row.is_admin desc, row.created_at desc, row.user_id asc) from page_rows row), '[]'::jsonb)
  ) into result from pagination;
  return result;
end;
$$;

revoke all on function public.admin_list_subscriptions_page_v1(integer, text, text, text) from public, anon;
grant execute on function public.admin_list_subscriptions_page_v1(integer, text, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
