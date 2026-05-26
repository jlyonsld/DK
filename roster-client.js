/* roster-client.js — read DK's classes / students / enrollments from Roster
 * (the system of record), through the dk-roster edge proxy.
 *
 * The Roster API key is held server-side in the dk-roster edge fn — never in the
 * browser. This client just calls dk-roster with the DK user's session (the DK
 * Supabase client supplies auth automatically via functions.invoke).
 *
 * Setup:
 *   1. Deploy the dk-roster edge fn (done) and set ROSTER_API_KEY on the DK
 *      Supabase project (see ROSTER_INTEGRATION.md). Until then every call throws
 *      "roster_not_configured".
 *   2. Include this file after your Supabase client is created, then init it:
 *        Roster.init(supabase);            // pass your DK Supabase client
 *   3. Use it:
 *        const classes     = await Roster.classes();      // [{id,name,status,programs,enrollments:[{count}]}]
 *        const students    = await Roster.students();      // [{id,first_name,last_name,status,families}]
 *        const enrollments = await Roster.enrollments();   // [{id,status,student_id,offering_id,...}]
 *        const oneRoster   = await Roster.roster(classId); // [{status,students:{first_name,last_name}}]
 */
(function () {
  let _client = null;

  function client() {
    const c = _client || window.supabase || window.sb || window._supabase || null;
    if (!c || typeof c.functions?.invoke !== "function") {
      throw new Error("Roster: no Supabase client. Call Roster.init(yourSupabaseClient) first.");
    }
    return c;
  }

  async function call(resource, extra) {
    const { data, error } = await client().functions.invoke("dk-roster", { body: { resource, ...(extra || {}) } });
    if (error) {
      // Surface the dormant case clearly.
      let detail = error.message;
      try { const b = await error.context.json(); detail = b?.error || detail; } catch { /* ignore */ }
      if (detail === "roster_not_configured") {
        throw new Error("Roster isn't connected yet — set ROSTER_API_KEY on the DK project (see ROSTER_INTEGRATION.md).");
      }
      throw new Error(detail || "Roster request failed");
    }
    if (data?.error) throw new Error(data.error);
    return data?.data || [];
  }

  window.Roster = {
    init(supabaseClient) { _client = supabaseClient; return this; },
    classes() { return call("classes"); },
    students() { return call("students"); },
    enrollments() { return call("enrollments"); },
    roster(offeringId) { return call("roster", { offering_id: offeringId }); },
  };
})();
