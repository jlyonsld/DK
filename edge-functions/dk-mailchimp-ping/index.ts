// DK Edge Function: dk-mailchimp-ping
//
// Helper called from the admin Mailchimp settings modal. Verifies a pasted
// API key reaches MC, lists audiences, lists merge fields for a given
// audience, and (optionally) creates missing required merge fields.
//
// Auth: requires a JWT belonging to a super_admin user.
//
// Request: {
//   api_key: string,                  // full key like "abc...-us21"
//   audience_id?: string,             // when set, returns merge_fields too
//   create_merge_fields?: string[]    // optional: tags to create on the audience
// }
//
// Response: {
//   ok: true,
//   account_name: string,
//   audiences: [{ id, name, member_count }],
//   merge_fields?: [{ tag, name, type }],
//   created?: string[]
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Body = {
  api_key?: string;
  audience_id?: string;
  create_merge_fields?: string[];
};

// Required merge field set the drain function depends on.
const REQUIRED_MERGE_FIELDS: { tag: string; name: string; type: string }[] = [
  { tag: "FNAME",   name: "First Name",       type: "text" },
  { tag: "LNAME",   name: "Last Name",        type: "text" },
  { tag: "STUDENT", name: "Student",          type: "text" },
  { tag: "CLASS",   name: "Class",            type: "text" },
  { tag: "SCHOOL",  name: "School",           type: "text" },
  { tag: "STATUS",  name: "Enrollment Status",type: "text" },
];

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

function parseServerPrefix(apiKey: string): string | null {
  const parts = apiKey.split("-");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].trim();
  return /^[a-z]{2}\d+$/.test(last) ? last : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse(200, { ok: true });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse(401, { error: "Missing bearer token" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, serviceKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return jsonResponse(401, { error: "Invalid JWT" });

  // Super-admin only — same gate as dk_config writes
  const { data: isSuper, error: permErr } = await userClient.rpc("is_super_admin");
  if (permErr) return jsonResponse(500, { error: "Permission check failed", detail: permErr.message });
  if (!isSuper) return jsonResponse(403, { error: "super_admin required" });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const apiKey = (body.api_key || "").trim();
  if (!apiKey) return jsonResponse(400, { error: "api_key is required" });

  const serverPrefix = parseServerPrefix(apiKey);
  if (!serverPrefix) {
    return jsonResponse(400, { error: "Could not parse server prefix from api_key (expected suffix like -us21)" });
  }

  const mcBase = `https://${serverPrefix}.api.mailchimp.com/3.0`;
  const mcAuth = "Basic " + btoa(`anystring:${apiKey}`);

  // Ping
  const pingResp = await fetch(`${mcBase}/ping`, { headers: { Authorization: mcAuth } });
  if (!pingResp.ok) {
    return jsonResponse(pingResp.status, {
      error: "Mailchimp ping failed",
      detail: (await pingResp.text()).slice(0, 240),
    });
  }

  // Account info
  const acctResp = await fetch(`${mcBase}/`, { headers: { Authorization: mcAuth } });
  const acct = acctResp.ok ? await acctResp.json() : {};

  // Audiences (lists)
  const listsResp = await fetch(`${mcBase}/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count`, {
    headers: { Authorization: mcAuth },
  });
  if (!listsResp.ok) {
    return jsonResponse(listsResp.status, {
      error: "Failed to list audiences",
      detail: (await listsResp.text()).slice(0, 240),
    });
  }
  const listsJson = await listsResp.json();
  const audiences = (listsJson.lists || []).map((l: { id: string; name: string; stats?: { member_count?: number } }) => ({
    id: l.id,
    name: l.name,
    member_count: l.stats?.member_count ?? 0,
  }));

  let mergeFields: { tag: string; name: string; type: string }[] | undefined;
  let created: string[] | undefined;

  if (body.audience_id) {
    const mfResp = await fetch(
      `${mcBase}/lists/${body.audience_id}/merge-fields?count=100&fields=merge_fields.tag,merge_fields.name,merge_fields.type`,
      { headers: { Authorization: mcAuth } },
    );
    if (!mfResp.ok) {
      return jsonResponse(mfResp.status, {
        error: "Failed to list merge fields",
        detail: (await mfResp.text()).slice(0, 240),
      });
    }
    const mfJson = await mfResp.json();
    mergeFields = (mfJson.merge_fields || []).map((m: { tag: string; name: string; type: string }) => ({
      tag: m.tag,
      name: m.name,
      type: m.type,
    }));

    if (body.create_merge_fields && body.create_merge_fields.length > 0) {
      created = [];
      for (const tag of body.create_merge_fields) {
        const def = REQUIRED_MERGE_FIELDS.find((m) => m.tag === tag);
        if (!def) continue;
        if (mergeFields.some((m) => m.tag === tag)) continue;
        const cResp = await fetch(`${mcBase}/lists/${body.audience_id}/merge-fields`, {
          method: "POST",
          headers: { Authorization: mcAuth, "Content-Type": "application/json" },
          body: JSON.stringify({ tag: def.tag, name: def.name, type: def.type, public: false }),
        });
        if (cResp.ok) {
          created.push(tag);
          mergeFields.push({ tag: def.tag, name: def.name, type: def.type });
        }
      }
    }
  }

  return jsonResponse(200, {
    ok: true,
    account_name: acct?.account_name || null,
    server_prefix: serverPrefix,
    audiences,
    merge_fields: mergeFields,
    required_merge_fields: REQUIRED_MERGE_FIELDS,
    created,
  });
});
