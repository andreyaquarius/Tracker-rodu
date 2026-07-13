begin;

-- This RPC returns private subscription and project access data. Keep it
-- inaccessible to anonymous callers, while repairing production ACL drift for
-- signed-in users after repeated CREATE OR REPLACE migrations.
revoke execute on function public.get_my_subscription_context(uuid) from public, anon;
grant execute on function public.get_my_subscription_context(uuid) to authenticated;

commit;
