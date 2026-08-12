begin;

-- Both catalogue pedigree RPCs return a column named person_id. In PL/pgSQL
-- that output parameter is also a variable, so an unqualified person_id in an
-- INSERT ... ON CONFLICT clause is ambiguous at runtime even though the
-- function itself compiles successfully. Prefer SQL columns for every such
-- reference in the two already-deployed implementations.
do $migration$
declare
  function_signature regprocedure;
  function_definition text;
  patched_definition text;
begin
  foreach function_signature in array array[
    to_regprocedure(
      'security_private.list_family_tree_direct_ancestor_order_v1(uuid,uuid)'
    ),
    to_regprocedure(
      'security_private.list_family_tree_root_kinship_v1(uuid,uuid)'
    )
  ]
  loop
    if function_signature is null then
      raise exception 'PERSON_PEDIGREE_FUNCTION_MISSING';
    end if;

    select pg_get_functiondef(function_signature)
      into function_definition;

    if position('#variable_conflict use_column' in function_definition) = 0 then
      patched_definition := replace(
        function_definition,
        E'\ndeclare\n',
        E'\n#variable_conflict use_column\ndeclare\n'
      );
      if patched_definition = function_definition then
        raise exception 'PERSON_PEDIGREE_FUNCTION_CONTRACT_CHANGED';
      end if;
      execute patched_definition;
    end if;
  end loop;
end;
$migration$;

comment on function public.list_family_tree_direct_ancestor_order_v1(uuid, uuid) is
  'Complete stable direct-ancestor order for the persisted tree root.';
comment on function public.list_family_tree_root_kinship_v1(uuid, uuid) is
  'Nearest RLS-aware blood or one-partner kinship to the persisted family-tree root.';

notify pgrst, 'reload schema';

commit;
