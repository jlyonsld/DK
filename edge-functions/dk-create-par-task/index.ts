// DK Edge Function: dk-create-par-task
//
// T17a — Forwards a DK task to PAR's `spoke-create-task` endpoint, then
// stamps the returned PAR uuid onto the local DK row's `par_task_id`
// column. Mirrors Margin's federation pattern (built 2026-05-06) almost
// verbatim. See CLAUDE.md §4.33 for the full architecture rationale.
//
// Auth: requires a DK user JWT belonging to a `manage_tasks` holder
// (super_admin / admin / manager). The user-bound RPC pattern from §5
// is critical — has_permission() reads auth.uid() internally and would
// always return false under the service-role admin client.
//
// Secrets (Edge Function env):
//   - SUPABASE_URL                  (auto-populated)
//   - SUPABASE_SERVICE_ROLE_KEY     (auto-populated)
//   - DK_SPOKE_API_KEY              (set after PAR /admin/spokes registers `dk`)
//
// Per-deployment config:
//   - dk_config.par_franchise_org_id  (singleton, populated at install per §4.7)
//
// Request: {
//   task_id: uuid,             // required — local DK tasks.id; we stamp par_task_id back
//   title: string,             // required
//   description?: string,
//   assignee_label?: string,   // free-form; PAR resolves to a user if matchable
//   due_at?: string,           // ISO 8601
//   priority?: 'low'|'medium'|'high',
//   project_name?: string
// }
//
// Response 200: { par_task_id: uuid }
// Response 400: { error: 'invalid_payload', detail }
// Response 401: { error: 'invalid_jwt' }
// Response 403: { error: 'forbidden_manage_tasks_required' }
// Response 404: { error: 'task_not_found' }
// Response 501: { error: 'par_not_wired', missing_env?: [...], missing_config?: [...] }
// Response 502: { error: 'upstream_error', status, detail }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAR_SPOKE_CREATE_TASK_URL =
  "https://dzcmfiahnxxqqeheimis.supabase.co/functions/v1/spoke-create-task";

const SPOKE_SLUG = "dk";

type Body = {
  task_id?: string;
  title?: string;
  description?: string | null;
  assignee_label?: string | null;
  due_at?: string | null;
  priority?: "low" | "medium" | "high" | null;
  project_name?: string | null;
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse(200, { ok: true });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse(401, { error: "missing_bearer_token" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const spokeKey = Deno.env.get("DK_SPOKE_API_KEY");

  // Authenticate caller. User-bound client so has_permission() can read
  // auth.uid() inside the RPC. Same pattern as dk-send-intake-form (§5).
  const userClient = createClient(supabaseUrl, serviceKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse(401, { error: "invalid_jwt" });
  }

  const { data: hasPerm, error: permErr } = await userClient.rpc(
    "has_permission",
    { perm: "manage_tasks" },
  );
  if (permErr) {
    return jsonResponse(500, {
      error: "permission_check_failed",
      detail: permErr.message,
    });
  }
  if (!hasPerm) {
    return jsonResponse(403, { error: "forbidden_manage_tasks_required" });
  }

  // Parse + validate body.
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid_payload", detail: "body must be JSON" });
  }
  const taskId = (body.task_id || "").trim();
  const title = (body.title || "").trim();
  if (!taskId) return jsonResponse(400, { error: "invalid_payload", detail: "task_id required" });
  if (!title) return jsonResponse(400, { error: "invalid_payload", detail: "title required" });

  // Read dk_config.par_franchise_org_id at request time, NOT init time
  // (§4.33: singleton can theoretically change post-deploy if the install
  // flow re-runs). Service-role read so this works even before the caller
  // has SELECT on dk_config — defense in depth, since manage_tasks holders
  // already have it in practice.
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: cfg, error: cfgErr } = await adminClient
    .from("dk_config")
    .select("par_franchise_org_id")
    .single();
  if (cfgErr) {
    return jsonResponse(500, { error: "dk_config_read_failed", detail: cfgErr.message });
  }
  const orgId = cfg?.par_franchise_org_id || null;

  // The 501 fallback. Surface BOTH missing pieces in one shot so the
  // operator's deploy-debug experience is one round-trip (Margin's
  // pattern from the design doc). Don't 500 here — 501 = "deliberately
  // unconfigured", 500 = "broken".
  const missingEnv: string[] = [];
  const missingConfig: string[] = [];
  if (!spokeKey) missingEnv.push("DK_SPOKE_API_KEY");
  if (!orgId) missingConfig.push("dk_config.par_franchise_org_id");
  if (missingEnv.length || missingConfig.length) {
    return jsonResponse(501, {
      error: "par_not_wired",
      ...(missingEnv.length ? { missing_env: missingEnv } : {}),
      ...(missingConfig.length ? { missing_config: missingConfig } : {}),
    });
  }

  // Confirm the local task row exists. We don't strictly need this — PAR
  // would happily create a task for a fake taskId — but we want to fail
  // before incurring a PAR API call AND we need a row to stamp par_task_id
  // back onto. The service-role read sees every row regardless of RLS.
  const { data: localTask, error: localErr } = await adminClient
    .from("tasks")
    .select("id, par_task_id")
    .eq("id", taskId)
    .maybeSingle();
  if (localErr) {
    return jsonResponse(500, { error: "task_lookup_failed", detail: localErr.message });
  }
  if (!localTask) {
    return jsonResponse(404, { error: "task_not_found" });
  }
  if (localTask.par_task_id) {
    // Idempotent: return the existing par_task_id rather than creating a
    // duplicate. Matches Margin's UI shape ("→ PAR ✓" badge stays put).
    return jsonResponse(200, { par_task_id: localTask.par_task_id, idempotent: true });
  }

  // Forward to PAR. Margin's payload contract verbatim.
  const upstreamBody = {
    spoke_slug: SPOKE_SLUG,
    org_id: orgId,
    title,
    description: body.description ?? null,
    assignee_name: body.assignee_label ?? null,
    due_at: body.due_at ?? null,
    priority: body.priority ?? "medium",
    project_name: body.project_name ?? null,
    external_ref: taskId,
  };

  let upstream: Response;
  try {
    upstream = await fetch(PAR_SPOKE_CREATE_TASK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${spokeKey}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return jsonResponse(502, {
      error: "upstream_unreachable",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const upstreamPayload = await upstream.json().catch(() => ({} as Record<string, unknown>));
  if (!upstream.ok) {
    return jsonResponse(502, {
      error: "upstream_error",
      status: upstream.status,
      detail: upstreamPayload,
    });
  }

  const parTaskId = (upstreamPayload as { task_id?: string }).task_id;
  if (!parTaskId) {
    return jsonResponse(502, {
      error: "upstream_missing_task_id",
      detail: upstreamPayload,
    });
  }

  // Stamp par_task_id back onto the local row. Service-role write so it
  // succeeds regardless of which RLS policy the caller's UPDATE would
  // otherwise hit — this is bookkeeping, not a user action.
  const { error: stampErr } = await adminClient
    .from("tasks")
    .update({ par_task_id: parTaskId })
    .eq("id", taskId);
  if (stampErr) {
    // Don't fail the whole request — PAR has the row, the user can retry
    // (idempotent on PAR side via external_ref) and the next round-trip
    // will reconcile. Return success with a warning.
    return jsonResponse(200, {
      par_task_id: parTaskId,
      warning: "stamp_failed",
      stamp_detail: stampErr.message,
    });
  }

  return jsonResponse(200, { par_task_id: parTaskId });
});
