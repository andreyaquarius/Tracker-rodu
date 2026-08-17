import {
  authenticatedContext,
  corsHeaders,
  errorMessage,
  json,
} from "../_shared/ai.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user, admin } = await authenticatedContext(request);

    const { data: deletedRows, error: deleteRowsError } = await admin.rpc(
      "delete_account_data",
      { p_user_id: user.id },
    );
    if (deleteRowsError) throw deleteRowsError;

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteUserError) throw deleteUserError;

    return json({
      deleted: true,
      userId: user.id,
      removedRows: typeof deletedRows === "number" ? deletedRows : undefined,
    });
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося видалити акаунт.") }, 400);
  }
});
