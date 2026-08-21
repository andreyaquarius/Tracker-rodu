-- Zagulyaky RPC ACL hardening
--
-- PostgreSQL gives newly created functions EXECUTE to PUBLIC by default.  The
-- feature migrations deliberately establish narrower ACLs, but several
-- replacement/deprecation paths pre-date an explicit anon revoke.  Reapply
-- the complete public-RPC contract here so a direct grant cannot survive a
-- function replacement, and so future audit reads the intended API boundary
-- in one place.
--
-- This migration is intentionally limited to Zagulyaky functions in the
-- exposed public schema.  `security_private` helpers remain non-exposed and
-- keep their narrowly scoped grants from their owning migrations.

begin;

-- Anonymous catalogue: these are the only direct public RPCs.  They already
-- enforce published/cleared visibility and living-person redaction internally.
revoke all on function public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_public_zagulyaka_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_zagulyaky_public_stats_v1()
  from public, anon, authenticated, service_role;

grant execute on function public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid)
  to anon, authenticated, service_role;
grant execute on function public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)
  to anon, authenticated, service_role;
grant execute on function public.get_public_zagulyaka_v1(text)
  to anon, authenticated, service_role;
grant execute on function public.get_zagulyaky_public_stats_v1()
  to anon, authenticated, service_role;

-- Author workflows require a browser session.  The service role retains its
-- existing trusted-server capability; every function validates auth.uid() and
-- ownership/record-state rules before changing data.
revoke all on function public.create_zagulyaka_draft_v1(text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.submit_zagulyaka_v1(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.withdraw_zagulyaka_v1(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_zagulyaky_v1(text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_zagulyaka_draft_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_zagulyaka_v1(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_zagulyaka_claim_v1(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_zagulyaka_bookmark_v1(uuid,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.attach_my_zagulyaka_file_v1(uuid,integer,text,text,text,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_draft_v3(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.create_zagulyaka_draft_v1(text,jsonb)
  to authenticated, service_role;
grant execute on function public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb)
  to authenticated, service_role;
grant execute on function public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)
  to authenticated, service_role;
grant execute on function public.submit_zagulyaka_v1(uuid,integer)
  to authenticated, service_role;
grant execute on function public.withdraw_zagulyaka_v1(uuid,integer)
  to authenticated, service_role;
grant execute on function public.get_my_zagulyaky_v1(text,integer,integer)
  to authenticated, service_role;
grant execute on function public.get_my_zagulyaka_draft_v1(uuid)
  to authenticated, service_role;
grant execute on function public.confirm_zagulyaka_v1(uuid,text,text)
  to authenticated, service_role;
grant execute on function public.create_zagulyaka_claim_v1(uuid,text,text)
  to authenticated, service_role;
grant execute on function public.set_zagulyaka_bookmark_v1(uuid,boolean)
  to authenticated, service_role;
grant execute on function public.attach_my_zagulyaka_file_v1(uuid,integer,text,text,text,bigint,text)
  to authenticated, service_role;
grant execute on function public.delete_my_zagulyaka_draft_v3(uuid,integer)
  to authenticated, service_role;
grant execute on function public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)
  to authenticated, service_role;

-- Moderation, claims, privacy consent and publication facades are callable by
-- signed-in users only.  Their SECURITY INVOKER/DEFINER implementations make
-- the final moderator-permission decision, never the anonymous API role.
revoke all on function public.admin_list_zagulyaky_queue_v1(text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_list_zagulyaky_claims_v1(text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaka_privacy_clearance_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaka_attachment_review_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_prepare_zagulyaka_attachment_publication_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_zagulyaka_attachment_publication_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaky_ingestion_batch_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.admin_list_zagulyaky_queue_v1(text,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text)
  to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_claims_v1(text,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)
  to authenticated, service_role;
grant execute on function public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)
  to authenticated, service_role;
grant execute on function public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)
  to authenticated, service_role;
grant execute on function public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)
  to authenticated, service_role;
grant execute on function public.admin_get_zagulyaka_privacy_clearance_v1(uuid)
  to authenticated, service_role;
grant execute on function public.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text)
  to authenticated, service_role;
grant execute on function public.admin_get_zagulyaka_attachment_review_v1(uuid)
  to authenticated, service_role;
grant execute on function public.admin_prepare_zagulyaka_attachment_publication_v2(uuid)
  to authenticated, service_role;
grant execute on function public.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)
  to authenticated, service_role;
grant execute on function public.admin_revoke_zagulyaka_attachment_publication_v2(uuid)
  to authenticated, service_role;
grant execute on function public.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb)
  to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_ingestion_batch_v1(uuid)
  to authenticated, service_role;

-- Cleanup and import workers have no browser-facing RPC path.  The author may
-- ask for only their own pending cleanup paths; the queue worker and import
-- chunk/finalization functions remain service-role-only.
revoke all on function public.claim_my_zagulyaky_storage_cleanup_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_zagulyaky_storage_cleanup_queue_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_zagulyaky_storage_cleanup_task_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_finalize_zagulyaky_facebook_import_v1(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_get_public_zagulyaka_attachment_delivery_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_my_zagulyaky_storage_cleanup_v1(integer)
  to authenticated;
grant execute on function public.claim_zagulyaky_storage_cleanup_queue_v1(integer)
  to service_role;
grant execute on function public.claim_zagulyaky_storage_cleanup_task_v1(uuid)
  to service_role;
grant execute on function public.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)
  to service_role;
grant execute on function public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text)
  to service_role;
grant execute on function public.service_finalize_zagulyaky_facebook_import_v1(uuid,text)
  to service_role;
grant execute on function public.service_get_public_zagulyaka_attachment_delivery_v1(uuid)
  to service_role;

-- Obsolete facades must stay unavailable even to service-role callers.  They
-- either bypass the durable Storage outbox or pre-date closed-claim/privacy
-- workflows.  Attachment delivery remains available anonymously through the
-- zagulyaka-attachment Edge Function, which calls the service-only facade
-- above and returns a short-lived URL instead of bucket/path coordinates.
revoke all on function public.delete_my_zagulyaka_draft_v1(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_draft_v2(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_attachment_v1(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_resolve_zagulyaka_claim_v1(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_prepare_zagulyaka_attachment_publication_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_complete_zagulyaka_attachment_publication_v1(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_zagulyaka_attachment_publication_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_public_zagulyaka_attachment_delivery_v1(uuid)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
