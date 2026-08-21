-- The v1 resolver pre-dates the closed-claim state machine introduced in v2.
-- Keeping it executable would let a moderator reopen a resolved or rejected
-- claim and bypass the newer audit/protection workflow. Keep the definition
-- for migration compatibility, but remove every API-role entry point.

begin;

revoke all on function public.admin_resolve_zagulyaka_claim_v1(uuid,text,text)
  from public, anon, authenticated, service_role;

comment on function public.admin_resolve_zagulyaka_claim_v1(uuid,text,text) is
  'DEPRECATED: execution is disabled. Use public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text), which preserves closed-claim invariants.';

commit;
