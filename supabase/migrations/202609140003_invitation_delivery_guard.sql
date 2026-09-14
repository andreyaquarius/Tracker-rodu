begin;
set local lock_timeout = '5s';
create table security_private.invitation_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.project_invitations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_id uuid not null references public.profiles(user_id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default (now() + interval '2 minutes'),
  sent_at timestamptz
);
alter table security_private.invitation_email_deliveries enable row level security;
revoke all on security_private.invitation_email_deliveries from public, anon, authenticated, service_role;
create index invitation_email_latest_idx on security_private.invitation_email_deliveries(invitation_id, created_at desc);
create index invitation_email_actor_rate_idx on security_private.invitation_email_deliveries(actor_id, created_at);
create index invitation_email_project_rate_idx on security_private.invitation_email_deliveries(project_id, created_at);

create function security_private.claim_invitation_email_v1(target_invitation_id uuid, target_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare inv public.project_invitations; delivery security_private.invitation_email_deliveries; project_name text; inviter_name text;
begin
  select * into inv from public.project_invitations where id=target_invitation_id for update;
  if not found or inv.invited_by <> target_actor_id or inv.status <> 'pending' or inv.expires_at <= now()
    or not exists(select 1 from public.project_members pm where pm.project_id=inv.project_id and pm.user_id=target_actor_id and pm.role in ('owner','editor')) then
    raise exception 'INVITATION_ACCESS_DENIED' using errcode='42501';
  end if;
  -- Serialize budgets across different invitations as well as duplicate calls.
  perform pg_advisory_xact_lock(hashtextextended('invitation-actor:' || target_actor_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitation-project:' || inv.project_id::text, 0));
  select * into delivery from security_private.invitation_email_deliveries
    where invitation_id=inv.id order by created_at desc limit 1 for update;
  if found then
    if delivery.lease_until > now() or delivery.last_attempt_at > now() - interval '1 minute'
      or delivery.sent_at > now() - interval '10 minutes' then
      return jsonb_build_object('status','cooldown','retry_after',greatest(1,ceil(extract(epoch from
        greatest(delivery.lease_until, delivery.last_attempt_at + interval '1 minute', delivery.sent_at + interval '10 minutes') - now())))::int);
    end if;
    -- Ambiguous provider/network failure: retry the SAME frozen message/key,
    -- safely inside Resend's 24-hour idempotency window.
    if delivery.sent_at is null and delivery.created_at > now() - interval '23 hours' then
      update security_private.invitation_email_deliveries
        set lease_token=gen_random_uuid(), lease_until=now()+interval '2 minutes', last_attempt_at=now()
        where id=delivery.id returning * into delivery;
      return jsonb_build_object('status','claimed','id',delivery.id,'lease_token',delivery.lease_token,'snapshot',delivery.snapshot);
    end if;
  end if;
  if (select count(*) from security_private.invitation_email_deliveries where actor_id=target_actor_id and created_at > now()-interval '1 hour') >= 20
    or (select count(*) from security_private.invitation_email_deliveries where project_id=inv.project_id and created_at > now()-interval '1 hour') >= 50 then
    return jsonb_build_object('status','rate_limited','retry_after',3600);
  end if;
  select name into project_name from public.projects where id=inv.project_id;
  select coalesce(nullif(to_jsonb(p)->>'full_name',''),'Користувач') into inviter_name from public.profiles p where user_id=target_actor_id;
  insert into security_private.invitation_email_deliveries(invitation_id, project_id, actor_id, snapshot)
    values(inv.id, inv.project_id, target_actor_id,
      jsonb_build_object('email',inv.email,'role',inv.role,'expires_at',inv.expires_at,'project_name',project_name,'inviter_name',inviter_name))
    returning * into delivery;
  return jsonb_build_object('status','claimed','id',delivery.id,'lease_token',delivery.lease_token,'snapshot',delivery.snapshot);
end $$;

create function security_private.finish_invitation_email_v1(delivery_id uuid, claim_token uuid, delivered boolean)
returns void language sql security definer set search_path = '' as $$
  update security_private.invitation_email_deliveries set lease_until=now(), sent_at=case when delivered then now() else sent_at end
    where id=delivery_id and lease_token=claim_token;
$$;
revoke all on function security_private.claim_invitation_email_v1(uuid,uuid), security_private.finish_invitation_email_v1(uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function security_private.claim_invitation_email_v1(uuid,uuid), security_private.finish_invitation_email_v1(uuid,uuid,boolean) to service_role;
create function public.claim_invitation_email_v1(target_invitation_id uuid, target_actor_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select security_private.claim_invitation_email_v1(target_invitation_id,target_actor_id);
$$;
create function public.finish_invitation_email_v1(delivery_id uuid, claim_token uuid, delivered boolean)
returns void language sql security invoker set search_path = '' as $$
  select security_private.finish_invitation_email_v1(delivery_id,claim_token,delivered);
$$;
revoke all on function public.claim_invitation_email_v1(uuid,uuid), public.finish_invitation_email_v1(uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.claim_invitation_email_v1(uuid,uuid), public.finish_invitation_email_v1(uuid,uuid,boolean) to service_role;
commit;
