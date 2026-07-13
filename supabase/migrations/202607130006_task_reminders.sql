begin;

alter table public.tasks
  add column if not exists reminder_at timestamptz,
  add column if not exists reminder_in_app boolean not null default false,
  add column if not exists reminder_email boolean not null default false,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists reminder_claimed_at timestamptz;

alter table public.tasks
  drop constraint if exists tasks_reminder_configuration_check;

alter table public.tasks
  add constraint tasks_reminder_configuration_check
  check (
    (
      reminder_at is null
      and not reminder_in_app
      and not reminder_email
      and reminder_sent_at is null
      and reminder_claimed_at is null
    )
    or
    (
      reminder_at is not null
      and (reminder_in_app or reminder_email)
    )
  );

create or replace function public.reset_task_reminder_delivery_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reminder_at is null or not (new.reminder_in_app or new.reminder_email) then
    new.reminder_sent_at := null;
    new.reminder_claimed_at := null;
  elsif tg_op = 'UPDATE' and (
    new.reminder_at is distinct from old.reminder_at
    or new.reminder_in_app is distinct from old.reminder_in_app
    or new.reminder_email is distinct from old.reminder_email
  ) then
    new.reminder_sent_at := null;
    new.reminder_claimed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_reset_reminder_delivery_state on public.tasks;
create trigger tasks_reset_reminder_delivery_state
before insert or update of reminder_at, reminder_in_app, reminder_email
on public.tasks
for each row execute function public.reset_task_reminder_delivery_state();

create index if not exists tasks_due_reminders_idx
  on public.tasks (reminder_at, id)
  include (project_id, created_by, reminder_in_app, reminder_email, reminder_claimed_at)
  where reminder_at is not null
    and reminder_sent_at is null
    and (reminder_in_app or reminder_email);

comment on column public.tasks.reminder_at is
  'UTC delivery time selected by the user; null means no reminder.';
comment on column public.tasks.reminder_in_app is
  'Whether the task creator should receive an in-app reminder.';
comment on column public.tasks.reminder_email is
  'Whether the task creator should receive an email reminder.';
comment on column public.tasks.reminder_sent_at is
  'Set when the reminder delivery worker creates the selected channel deliveries.';
comment on column public.tasks.reminder_claimed_at is
  'Claim time used by the reminder delivery worker. The reminder recipient is tasks.created_by.';

revoke execute on function public.reset_task_reminder_delivery_state() from public, anon, authenticated;

commit;
