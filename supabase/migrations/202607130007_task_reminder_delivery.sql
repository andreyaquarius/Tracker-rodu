begin;

create table if not exists public.task_notifications (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  scheduled_for timestamptz not null,
  task_title text not null,
  task_description text not null default '',
  task_deadline text not null default '',
  project_name text not null,
  in_app_enabled boolean not null default true,
  email_enabled boolean not null default false,
  email_status text not null default 'not_requested'
    check (email_status in ('not_requested', 'pending', 'sending', 'sent', 'failed')),
  email_attempts integer not null default 0 check (email_attempts >= 0),
  email_claim_token uuid,
  email_claimed_at timestamptz,
  email_next_attempt_at timestamptz,
  email_sent_at timestamptz,
  email_error text,
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (task_id, user_id, scheduled_for)
);

create index if not exists task_notifications_user_unread_idx
  on public.task_notifications (user_id, created_at desc)
  where in_app_enabled and read_at is null;

create index if not exists task_notifications_user_idx
  on public.task_notifications (user_id, created_at desc);

create index if not exists task_notifications_project_idx
  on public.task_notifications (project_id);

create index if not exists task_notifications_email_due_idx
  on public.task_notifications (email_status, email_next_attempt_at, created_at)
  where email_enabled and email_status in ('pending', 'failed', 'sending');

alter table public.task_notifications enable row level security;

revoke all on public.task_notifications from public, anon, authenticated;
grant select on public.task_notifications to authenticated;
grant update (read_at) on public.task_notifications to authenticated;
grant select, insert, update, delete on public.task_notifications to service_role;

drop policy if exists task_notifications_select_own on public.task_notifications;
create policy task_notifications_select_own
on public.task_notifications
for select
to authenticated
using (
  user_id = (select auth.uid())
  and in_app_enabled
  and public.is_project_member(project_id)
);

drop policy if exists task_notifications_mark_own_read on public.task_notifications;
create policy task_notifications_mark_own_read
on public.task_notifications
for update
to authenticated
using (
  user_id = (select auth.uid())
  and in_app_enabled
  and public.is_project_member(project_id)
)
with check (
  user_id = (select auth.uid())
  and in_app_enabled
  and public.is_project_member(project_id)
);

create or replace function public.claim_due_task_reminders(
  batch_limit integer default 100
)
returns table (
  notification_id uuid,
  claim_token uuid,
  recipient_user_id uuid,
  recipient_email text,
  task_id uuid,
  task_title text,
  task_description text,
  task_deadline text,
  project_id uuid,
  project_name text,
  scheduled_for timestamptz,
  email_attempt integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '10s'
as $$
declare
  bounded_limit integer := least(greatest(coalesce(batch_limit, 100), 1), 250);
begin
  if current_user <> 'service_role'
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  with due as (
    select task.id
    from public.tasks task
    where task.reminder_at is not null
      and task.reminder_at <= clock_timestamp()
      and task.reminder_sent_at is null
      and (task.reminder_in_app or task.reminder_email)
      and task.status not in ('закрито', 'перевірено')
      and exists (
        select 1
        from public.project_members membership
        where membership.project_id = task.project_id
          and membership.user_id = task.created_by
      )
    order by task.reminder_at, task.id
    for update skip locked
    limit bounded_limit
  ),
  marked as (
    update public.tasks task
    set reminder_claimed_at = clock_timestamp(),
        reminder_sent_at = clock_timestamp()
    where task.id in (select due.id from due)
    returning task.*
  )
  insert into public.task_notifications as existing_notification (
    task_id,
    project_id,
    user_id,
    scheduled_for,
    task_title,
    task_description,
    task_deadline,
    project_name,
    in_app_enabled,
    email_enabled,
    email_status,
    email_next_attempt_at
  )
  select
    task.id,
    task.project_id,
    task.created_by,
    task.reminder_at,
    task.title,
    task.description,
    task.deadline,
    project.name,
    task.reminder_in_app,
    task.reminder_email,
    case when task.reminder_email then 'pending' else 'not_requested' end,
    case when task.reminder_email then clock_timestamp() else null end
  from marked task
  join public.projects project on project.id = task.project_id
  on conflict on constraint task_notifications_task_id_user_id_scheduled_for_key do update
  set task_title = excluded.task_title,
      task_description = excluded.task_description,
      task_deadline = excluded.task_deadline,
      project_name = excluded.project_name,
      in_app_enabled = excluded.in_app_enabled,
      email_enabled = excluded.email_enabled,
      email_status = case
        when not excluded.email_enabled then 'not_requested'
        when not existing_notification.email_enabled then 'pending'
        else existing_notification.email_status
      end,
      email_attempts = case
        when not excluded.email_enabled then 0
        when excluded.email_enabled and not existing_notification.email_enabled then 0
        else existing_notification.email_attempts
      end,
      email_claim_token = case
        when not excluded.email_enabled then null
        when excluded.email_enabled and not existing_notification.email_enabled then null
        else existing_notification.email_claim_token
      end,
      email_claimed_at = case
        when not excluded.email_enabled then null
        when excluded.email_enabled and not existing_notification.email_enabled then null
        else existing_notification.email_claimed_at
      end,
      email_next_attempt_at = case
        when excluded.email_enabled and not existing_notification.email_enabled
          then excluded.email_next_attempt_at
        when not excluded.email_enabled then null
        else existing_notification.email_next_attempt_at
      end,
      email_sent_at = case
        when excluded.email_enabled then existing_notification.email_sent_at
        else null
      end,
      email_error = case
        when excluded.email_enabled then existing_notification.email_error
        else null
      end,
      read_at = case
        when excluded.in_app_enabled and not existing_notification.in_app_enabled then null
        else existing_notification.read_at
      end,
      updated_at = clock_timestamp();

  return query
  with eligible as (
    select notification.id
    from public.task_notifications notification
    where notification.email_enabled
      and notification.email_attempts < 3
      and (
        notification.email_status = 'pending'
        or (
          notification.email_status = 'failed'
          and notification.email_next_attempt_at is not null
          and notification.email_next_attempt_at <= clock_timestamp()
        )
        or (
          notification.email_status = 'sending'
          and notification.email_claimed_at <= clock_timestamp() - interval '15 minutes'
        )
      )
    order by notification.created_at, notification.id
    for update skip locked
    limit bounded_limit
  ),
  claimed as (
    update public.task_notifications notification
    set email_status = 'sending',
        email_attempts = notification.email_attempts + 1,
        email_claim_token = gen_random_uuid(),
        email_claimed_at = clock_timestamp(),
        email_next_attempt_at = null,
        email_error = null,
        updated_at = clock_timestamp()
    where notification.id in (select eligible.id from eligible)
    returning notification.*
  )
  select
    claimed.id,
    claimed.email_claim_token,
    claimed.user_id,
    profile.email,
    claimed.task_id,
    claimed.task_title,
    claimed.task_description,
    claimed.task_deadline,
    claimed.project_id,
    claimed.project_name,
    claimed.scheduled_for,
    claimed.email_attempts
  from claimed
  join public.profiles profile on profile.user_id = claimed.user_id;
end;
$$;

create or replace function public.complete_task_reminder_delivery(
  target_notification_id uuid,
  target_claim_token uuid,
  delivered boolean,
  delivery_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $$
declare
  changed_rows integer;
begin
  if current_user <> 'service_role'
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  update public.task_notifications notification
  set email_status = case when delivered then 'sent' else 'failed' end,
      email_sent_at = case when delivered then clock_timestamp() else null end,
      email_error = case
        when delivered then null
        else left(coalesce(delivery_error, 'Unknown email delivery error'), 1000)
      end,
      email_next_attempt_at = case
        when delivered or notification.email_attempts >= 3 then null
        when notification.email_attempts = 1 then clock_timestamp() + interval '15 minutes'
        else clock_timestamp() + interval '1 hour'
      end,
      email_claim_token = null,
      email_claimed_at = null,
      updated_at = clock_timestamp()
  where notification.id = target_notification_id
    and notification.email_claim_token = target_claim_token
    and notification.email_status = 'sending';

  get diagnostics changed_rows = row_count;
  return changed_rows = 1;
end;
$$;

revoke execute on function public.claim_due_task_reminders(integer)
  from public, anon, authenticated;
revoke execute on function public.complete_task_reminder_delivery(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.claim_due_task_reminders(integer)
  to service_role;
grant execute on function public.complete_task_reminder_delivery(uuid, uuid, boolean, text)
  to service_role;

comment on table public.task_notifications is
  'Per-user in-app and email deliveries generated from task reminder settings.';

commit;
