begin;

update public.subscription_plans
set
  price_monthly = case code
    when 'researcher' then 229
    when 'professional' then 699
    else price_monthly
  end,
  price_yearly = case code
    when 'researcher' then 2290
    when 'professional' then 6990
    else price_yearly
  end,
  currency = 'UAH',
  updated_at = now()
where code in ('researcher', 'professional');

commit;
