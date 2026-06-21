begin;

insert into public.plan_limits (plan_id, limit_key, limit_value, is_unlimited)
select plan.id, 'records_per_standard_section', 1000, false
from public.subscription_plans plan
where plan.code = 'free'
on conflict (plan_id, limit_key) do update set
  limit_value = excluded.limit_value,
  is_unlimited = excluded.is_unlimited,
  updated_at = now();

commit;
