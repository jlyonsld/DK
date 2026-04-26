/* Drama Kids Response Console — v3 (Supabase-backed)
 *
 * All data comes from the Supabase Postgres database. Writes hit the DB
 * directly; no local persistence layer. Authentication is required;
 * unauthenticated users see the login screen.
 */

(function () {
  "use strict";

  /* ═════════════ Supabase client ═════════════ */

  if (!window.supabase || !window.DK_CONFIG) {
    alert("Config or Supabase SDK not loaded — check config.js and CDN script tag.");
    return;
  }
  const sb = window.supabase.createClient(window.DK_CONFIG.supabaseUrl, window.DK_CONFIG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  window.__dk_supabase = sb; // expose for debugging

  /* ═════════════ In-memory state ═════════════ */

  const state = {
    session: null,
    profile: null,
    categories: [],
    templates: [],
    classes: [],
    infographics: [],
    teachers: [],
    classTeachers: [],      // rows { class_id, teacher_id, role, start_date, end_date, notes }
    classInfographics: [],  // rows { class_id, infographic_id, sort_order, notes }
    students: [],
    enrollments: [],
    attendance: [],         // attendance rows (enrollment-scoped); RLS-filtered per role
    clockIns: [],           // clock_ins rows; teacher sees own, admin sees all
    matchCandidates: [],    // unresolved student_match_candidates rows (admin-visible)
    teacherInvitations: [],
    subRequests: [],        // sub_requests rows (RLS-filtered: open visible to all,
                            // your own visible to you, all visible to admin/manager)
    subClaims: [],          // sub_claims rows (RLS-filtered)
    schools: [],            // schools rows (every signed-in role can SELECT)
    classCancellations: [], // class_cancellations rows (one per cancelled session)
    closures: [],
    curriculumItems: [],
    curriculumAssignments: [],   // (curriculum_item_id, class_id, teacher_id) rows
                                 // RLS: admin/manager see all; teacher sees own.
    paymentMethods: [],          // T6c: super_admin-managed list of options
                                 // for teachers.payment_method. SELECT open
                                 // to all authenticated; writes super_admin.
    teacherPaymentDetails: [],   // T6b: bank/routing/account/handle. RLS:
                                 // manage_teacher_payments (admin+super_admin).
    teacherDocuments: [],        // T6b: tax forms, certs metadata. RLS:
                                 // manage_teacher_compliance (admin+super_admin).
    liabilityWaivers: [],        // T6b: versioned waiver text rows. SELECT open
                                 // to all authenticated; only one active at a time.
    waiverSignatures: [],        // T6b: append-only signature audit. Admin sees
                                 // all; teacher sees own (matched by email).
    profiles: [],                // T6d: every DK profile, used by the Users tab.
                                 // RLS: admin_or_above sees all (T6d migration);
                                 // others see only their own row → empty list here.
    usersState: { query: "", showNoRole: true, editingId: null },
    // T9: special events + their staff assignments. SELECT open to all
    // signed-in users; writes gated on edit_events (admin/manager+).
    events: [],
    eventStaff: [],
    // Events tab filter state — kindFilter ∈ {all,free_class,training,promotional,other},
    // when ∈ {upcoming,past,all}; editingId tracks the event being edited.
    evState: { kindFilter: "all", when: "upcoming", editingId: null },
    // T10: inventory items + assignments. SELECT open to all signed-in
    // users; writes gated on edit_inventory (admin/manager+).
    inventoryItems: [],
    inventoryAssignments: [],
    // Inventory tab state — query (free-text), tagFilter, showArchived;
    // editingId tracks the item being edited in the modal.
    invState: { query: "", tagFilter: "all", showArchived: false, editingId: null },
    // Pending photo uploads during a NEW item edit (no item id yet to attach
    // photos to). Each entry { url, path }. Flushed into photo_urls on save;
    // discarded on cancel + bucket-removed.
    _invPendingPhotos: [],
    // Pending tag chips for the editor input (lets us show tag chips before
    // they're committed to the row).
    _invPendingTags: [],
    // Assign-inventory modal state. target = { kind: 'class'|'event', ... }
    // captures what the picker is assigning to; selectedItemIds is the set
    // of items the admin has chosen.
    invAssignState: { target: null, selectedItemIds: new Set(), query: "" },
    dkConfig: null,
    latestSyncLog: null,
    tState: { query: "", category: "all", filled: {} },
    igState: { query: "", tag: "all" },
    cState: { showTest: false, openClassId: null },
    curState: { typeFilter: "all", showArchived: false, editingId: null },
    // Schedule state: `anchor` is the currently-focused date (ISO); mode is
    // day/week/month; onlyMine filters to the signed-in teacher's assignments.
    sState: { mode: "day", anchor: isoDate(new Date()), onlyMine: false },
    // Reports tab state: active report id + date range (ISO). Defaults to
    // last 30 days including today.
    rptState: { active: "attendance", start: null, end: null },
    // Sub-requests tab filter: "open" (default), "mine" (created/filled by me),
    // "all" (admin/manager only).
    srState: { filter: "open" },
    // Assign-curriculum modal state. itemId = which curriculum item is being
    // managed; the form fields below capture the next row to insert.
    assignCurState: { itemId: null, formClassId: "", formTeacherId: "", formLeadOverride: "", formNotes: "" },
    // Schools tab state — search + active toggle.
    schState: { query: "", showInactive: false },
    // T7a: PAR-promotion impression dedup. Keyed by variant_key; first
    // render of each variant in a session fires an `impression`, later
    // re-renders (debounced realtime mutations etc.) don't. Cleared
    // implicitly on full reload.
    _parPromoImpressions: new Set(),
    router: "home"
  };

  // Need to compute isoDate BEFORE the state initializer references it;
  // hoist via function declaration.
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /* ═════════════ Role + permissions (client-side UI gating) ═════════════
   *
   * These helpers mirror the SQL `has_permission(perm)` function exactly,
   * so UI gating and RLS enforcement agree. Client-side checks never grant
   * anything — they only hide UI that would fail RLS anyway. All real
   * enforcement happens server-side via RLS on Supabase.
   *
   * T1.5 scope: managers can write templates, categories, infographics,
   * teachers, classes, class_teachers, closures. RLS gates those tables
   * on has_permission('edit_<resource>') so per-user grants/revocations
   * work uniformly. Viewer stays read-only. class_infographics and
   * teacher_invitations remain admin-only.
   */

  const PERM_BUNDLES = {
    super_admin: [
      "manage_billing","manage_super_admins","manage_admins",
      "manage_org","hard_delete","manage_users",
      "edit_classes","edit_teachers","edit_students","edit_enrollments","edit_attendance",
      "edit_templates","edit_categories","edit_infographics","edit_closures",
      "edit_curriculum","assign_curriculum",
      "edit_events",
      "edit_inventory",
      "manage_teacher_payments","manage_teacher_compliance",
      "view_pay_rates","view_billing_status","view_parent_contact",
      "run_jackrabbit_sync","respond_to_leads",
      "reconcile_students",
      "request_sub","claim_sub_requests","manage_all_sub_requests"
    ],
    admin: [
      "manage_users",
      "edit_classes","edit_teachers","edit_students","edit_enrollments","edit_attendance",
      "edit_templates","edit_categories","edit_infographics","edit_closures",
      "edit_curriculum","assign_curriculum",
      "edit_events",
      "edit_inventory",
      "manage_teacher_payments","manage_teacher_compliance",
      "view_pay_rates","view_billing_status","view_parent_contact",
      "run_jackrabbit_sync","respond_to_leads",
      "reconcile_students",
      "request_sub","claim_sub_requests","manage_all_sub_requests"
    ],
    manager: [
      "edit_templates","edit_categories","edit_infographics",
      "edit_classes","edit_teachers","edit_closures",
      "edit_curriculum","assign_curriculum",
      "edit_events",
      "respond_to_leads",
      "view_classes_readonly","view_teachers_readonly",
      "view_students_readonly","view_enrollments_readonly",
      "claim_sub_requests","manage_all_sub_requests"
    ],
    teacher: [
      "view_own_schedule","take_own_attendance","clock_in_out",
      "view_own_curriculum","view_own_pay_history","request_sub",
      "view_own_roster","manage_own_roster_students","manage_own_enrollments",
      "claim_sub_requests"
    ],
    viewer: [
      "view_classes_readonly","view_teachers_readonly","view_students_readonly",
      "view_enrollments_readonly","view_attendance_readonly","view_billing_status_readonly"
    ]
  };

  // Test classes are marked with is_test=true. The Classes tab has a toggle
  // (cState.showTest) to display them; this helper lets the bento + schedule
  // views honor that same toggle so flipping it once reveals them everywhere.
  function includeTestClass(c) { return !!c && (state.cState.showTest || !c.is_test); }

  function currentRole() { return state.profile ? state.profile.role : null; }
  function isRole(r) { return currentRole() === r; }
  function isSuperAdmin() { return isRole("super_admin"); }
  function isAdminOrAbove() { return isRole("super_admin") || isRole("admin"); }

  function hasPerm(perm) {
    const role = currentRole();
    if (!role) return false;
    const granted = (state.profile.granted_permissions || []);
    const revoked = (state.profile.revoked_permissions || []);
    if (revoked.includes(perm)) return false;
    if (granted.includes(perm)) return true;
    return (PERM_BUNDLES[role] || []).includes(perm);
  }

  // Which tabs each role is allowed to see. (Role Management tab doesn't
  // exist in T1 — it lands in T6.)
  const ROLE_TAB_VISIBILITY = {
    super_admin: new Set(["home","schedule","templates","classes","schools","teachers","subrequests","events","inventory","curriculum","reports","users"]),
    admin:       new Set(["home","schedule","templates","classes","schools","teachers","subrequests","events","inventory","curriculum","reports","users"]),
    manager:     new Set(["home","schedule","templates","classes","schools","teachers","subrequests","events","inventory","curriculum"]),
    teacher:     new Set(["home","schedule","subrequests","events","inventory"]),
    viewer:      new Set(["home","schedule","templates","classes","schools","teachers","subrequests","events","inventory"])
  };
  function canSeeTab(tab) {
    const role = currentRole();
    if (!role) return false;
    return (ROLE_TAB_VISIBILITY[role] || new Set()).has(tab);
  }

  // Friendly role label
  function roleLabel(r) {
    return ({
      super_admin: "Super admin",
      admin: "Admin",
      manager: "Manager",
      teacher: "Teacher",
      viewer: "Viewer"
    })[r] || (r || "No role");
  }

  /* ═════════════ Helpers ═════════════ */

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
  }
  function slugify(s) {
    return (s || "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 50) || ("item-" + Date.now());
  }
  function uniqueSlug(base, existing) {
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(base + "-" + i)) i++;
    return base + "-" + i;
  }
  function detectVars(body) {
    const set = new Set();
    (body || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (m, n) => set.add(n));
    return Array.from(set);
  }
  function showToast(msg, kind) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast visible" + (kind ? " " + kind : "");
    setTimeout(() => t.classList.remove("visible"), 2400);
  }
  function flashCopied(btn) {
    if (!btn) return;
    const o = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = o; btn.classList.remove("copied"); }, 1300);
  }
  function showLoader(on) { $("#loader").classList.toggle("visible", !!on); }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      return true;
    }
  }
  async function copyImageBytes(src) {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function publicUrlFor(storagePath) {
    if (!storagePath) return null;
    const { data } = sb.storage.from("infographics").getPublicUrl(storagePath);
    return data && data.publicUrl;
  }

  /* ═════════════ Auth ═════════════ */

  async function initAuth() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      state.session = session;
      await bootApp();
    } else {
      showLogin();
    }
    sb.auth.onAuthStateChange(async (event, session) => {
      state.session = session || null;
      if (!session) {
        // Signed out
        showLogin();
        return;
      }
      // We have a session. If the login screen is still the visible one,
      // that means a session just arrived from elsewhere — likely the
      // magic-link redirect finishing its hash handoff. Boot the app.
      if ($("#loginScreen").style.display !== "none") {
        await bootApp();
      }
    });
  }

  function showLogin() {
    $("#app").style.display = "none";
    $("#loginScreen").style.display = "";
  }

  async function bootApp() {
    $("#loginScreen").style.display = "none";
    $("#app").style.display = "";
    await loadProfile();

    // If the user doesn't yet have a role, give par-identity-proxy a chance
    // to auto-promote them synchronously (it might — if this email is linked
    // to a PAR identity that owns the configured franchise org). We await
    // the refresh so the no-role screen isn't shown for a user who was just
    // about to be auto-promoted.
    if (!currentRole()) {
      try { await refreshParIdentity(); } catch (_) { /* swallow — fall through */ }
      // Re-pull profile so we see any role change the Edge Function wrote.
      try {
        const { data: refreshed } = await sb.from("profiles").select("*").eq("id", state.session.user.id).single();
        if (refreshed) state.profile = refreshed;
      } catch (_) { /* ignore */ }
    }

    if (!currentRole()) {
      showNoRoleScreen();
      return;
    }

    renderUserChip();
    await reloadAll();
    wireEvents();
    applyRoleVisibility();
    renderAll();
    // Default router may be a tab this role can't see — fall back to home.
    const startTab = canSeeTab(state.router) ? state.router : "home";
    go(startTab);
    setupRealtime();
  }

  /* No-role screen.
   *
   * Two distinct states fold into role=null:
   *   (a) Email IS linked to a PAR identity (par_person_id populated), but
   *       the PAR identity doesn't own or admin the configured franchise
   *       org. Real case: invited teachers/managers waiting for their admin
   *       to complete the promotion, or a DK profile that pre-existed the
   *       install flow. Message: "waiting for admin to assign a role."
   *   (b) Email is NOT linked to PAR at all (par_person_id is null). Most
   *       common case when someone (Sharon) signs into DK with a work email
   *       they never linked to their PAR identity. The fix: link it on PAR.
   *       Message: deep-link to PAR's linked-accounts UI.
   */
  function showNoRoleScreen() {
    $("#app").style.display = "none";
    $("#loginScreen").style.display = "none";
    $("#noRoleScreen").style.display = "";
    const user = state.session?.user;
    const parLinked = !!state.profile?.par_person_id;
    const titleEl = $("#noRoleTitle");
    const subEl   = $("#noRoleSub");
    const line    = $("#noRoleUserLine");
    const ctaEl   = $("#noRolePrimaryCta");
    const footEl  = $("#noRoleFootnote");

    if (titleEl) {
      titleEl.textContent = parLinked ? "Waiting for access" : "One more setup step";
    }
    if (subEl) {
      subEl.textContent = parLinked ? "Role not yet assigned" : "Link this email to your PAR identity";
    }
    if (line && user) {
      line.innerHTML = `Signed in as <b>${escapeHtml(user.email || "")}</b>.`;
    }
    if (footEl) {
      footEl.innerHTML = parLinked
        ? "Your account is linked to PAR, but hasn't been granted a role in this franchise yet. Ask your franchise admin to assign you a role, then refresh this page."
        : "This email isn't linked to your PAR identity yet. Open PAR's Linked Accounts settings (below), add this email there, verify the link PAR sends, then come back here and refresh.";
    }
    if (ctaEl) {
      if (parLinked) {
        ctaEl.style.display = "none";
      } else {
        ctaEl.style.display = "";
        ctaEl.href = "https://get-on-par.com/?view=settings&tab=linked-accounts";
        ctaEl.textContent = "Open PAR Linked Accounts →";
      }
    }

    const btn = $("#noRoleSignOut");
    if (btn) {
      btn.onclick = async () => {
        await sb.auth.signOut();
        state.session = null; state.profile = null;
        $("#noRoleScreen").style.display = "none";
        showLogin();
      };
    }
  }

  /* ═════════════ Realtime subscriptions ═════════════
   * Any insert/update/delete on a watched table triggers a debounced
   * reloadAll + renderAll. Covers:
   *   - user actions from this browser (instant echo, harmless)
   *   - user actions from another tab / device
   *   - Zapier webhooks creating enrollments / students
   *   - Scheduled jobs (nightly Jackrabbit sync) updating classes
   *   - par-identity-proxy caching identity on profiles
   * Debounce prevents N re-renders when a burst of events lands.
   */
  let realtimeChannel = null;
  let realtimeReloadTimer = null;

  function setupRealtime() {
    if (realtimeChannel) return;
    const tablesToWatch = [
      "profiles", "categories", "templates", "classes", "infographics",
      "teachers", "class_teachers", "class_infographics",
      "students", "enrollments", "attendance", "clock_ins", "sync_log",
      "teacher_invitations", "dk_config", "closures",
      "student_match_candidates",
      "sub_requests", "sub_claims",
      "schools", "class_cancellations",
      "curriculum_items", "curriculum_assignments",
      "teacher_payment_details", "teacher_documents",
      "liability_waivers", "liability_waiver_signatures",
      "payment_methods",
      "events", "event_staff",
      "inventory_items", "inventory_assignments"
    ];
    realtimeChannel = sb.channel("dk-realtime");
    tablesToWatch.forEach((table) => {
      realtimeChannel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (_payload) => scheduleRealtimeReload()
      );
    });
    realtimeChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("[realtime] subscribed to", tablesToWatch.length, "tables");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("[realtime] connection issue:", status, "— will rely on manual reloads until next boot");
      }
    });
  }

  function scheduleRealtimeReload() {
    clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer = setTimeout(async () => {
      await reloadAll();
      renderAll();
    }, 300);
  }

  async function loadProfile() {
    const { data, error } = await sb.from("profiles").select("*").eq("id", state.session.user.id).single();
    if (error) { console.warn("Profile load:", error); return; }
    state.profile = data;
    // Fire-and-forget PAR identity sync — updates profile cache on the backend
    refreshParIdentity().catch((e) => console.warn("PAR identity check failed:", e));
  }

  async function refreshParIdentity() {
    try {
      const { data, error } = await sb.functions.invoke("par-identity-proxy", { body: {} });
      if (error) throw error;
      // The Edge Function writes the cache to profiles directly; re-fetch locally.
      const { data: fresh } = await sb.from("profiles").select("*").eq("id", state.session.user.id).single();
      if (fresh) {
        state.profile = fresh;
        renderUserChip();
      }
      return data;
    } catch (e) {
      console.warn("PAR identity sync failed:", e);
      return null;
    }
  }

  function renderUserChip() {
    const chip = $("#userChip");
    if (!chip || !state.profile) return;
    const displayName = state.profile.par_display_name || state.profile.full_name || state.session?.user?.email || "";
    const parLinked = !!state.profile.par_person_id;
    chip.innerHTML = "";
    const name = document.createElement("span");
    name.textContent = displayName;
    chip.appendChild(name);
    // Role badge — visible at a glance which view the user is in
    const role = currentRole();
    if (role) {
      const rb = document.createElement("span");
      rb.className = "role-badge role-" + role;
      rb.textContent = roleLabel(role);
      rb.title = "Your role in this DK franchise";
      chip.appendChild(rb);
    }
    if (parLinked) {
      const badge = document.createElement("span");
      badge.className = "par-linked-badge";
      badge.title = "Linked to PAR identity: " + (state.profile.par_primary_email || "");
      badge.textContent = "PAR \u2713";
      chip.appendChild(badge);
    }
    // PAR-connect CTA used to live inside the chip; it now renders inside
    // renderUserMenu() since the chip is a <button> (no nested <a> allowed).
    renderUserMenu();
  }

  function renderUserMenu() {
    if (!state.profile) return;
    const nameEl  = $("#userMenuName");
    const emailEl = $("#userMenuEmail");
    const roleEl  = $("#userMenuRole");
    if (!nameEl || !emailEl || !roleEl) return;
    const displayName = state.profile.par_display_name || state.profile.full_name || state.session?.user?.email || "";
    nameEl.textContent  = displayName;
    emailEl.textContent = state.session?.user?.email || "";
    const role = currentRole();
    roleEl.innerHTML = "";
    if (role) {
      const rb = document.createElement("span");
      rb.className = "role-badge role-" + role;
      rb.textContent = roleLabel(role);
      roleEl.appendChild(rb);
    }
    // Append-or-replace a Connect-to-PAR row if the user isn't linked yet.
    const menu = $("#userMenu");
    const prior = menu.querySelector(".user-menu-par-cta");
    if (prior) prior.remove();
    if (!state.profile.par_person_id) {
      const a = document.createElement("a");
      a.href = "https://get-on-par.com/?view=settings&tab=linked-accounts";
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "user-menu-item user-menu-par-cta";
      a.textContent = "Connect to PAR \u2192";
      a.title = "Opens PAR's Linked Accounts settings in a new tab";
      // Insert before the Sign-out item
      menu.insertBefore(a, $("#userMenuSignOut"));
    }
  }

  function toggleUserMenu(force) {
    const menu = $("#userMenu");
    const chip = $("#userChip");
    if (!menu || !chip) return;
    const open = (typeof force === "boolean") ? force : !menu.classList.contains("open");
    menu.classList.toggle("open", open);
    menu.setAttribute("aria-hidden", open ? "false" : "true");
    chip.setAttribute("aria-expanded", open ? "true" : "false");
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const errEl = $("#loginError");
    const magicStatusEl = $("#loginMagicStatus");
    errEl.classList.remove("visible");
    if (magicStatusEl) { magicStatusEl.textContent = ""; magicStatusEl.className = "login-magic-status"; }
    if (!password) {
      errEl.textContent = "Enter a password, or use the magic-link button below instead.";
      errEl.classList.add("visible");
      return;
    }
    showLoader(true);
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    showLoader(false);
    if (error) {
      errEl.textContent = error.message || "Sign-in failed.";
      errEl.classList.add("visible");
      return;
    }
    state.session = data.session;
    await bootApp();
  });

  // Magic-link / OTP sign-in. Works for both first-time users (auto-creates
  // the auth.users row on first click) and returning users who don't want to
  // type a password. The link email Supabase sends points back at this
  // origin; the SDK's detectSessionInUrl picks up the hash and establishes
  // a session, which onAuthStateChange routes through bootApp().
  $("#loginMagicLink").addEventListener("click", async () => {
    const email = $("#loginEmail").value.trim();
    const errEl = $("#loginError");
    const statusEl = $("#loginMagicStatus");
    errEl.classList.remove("visible");
    statusEl.textContent = "";
    statusEl.className = "login-magic-status";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = "Enter your email first, then click the magic-link button.";
      errEl.classList.add("visible");
      return;
    }
    showLoader(true);
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    showLoader(false);
    if (error) {
      errEl.textContent = error.message || "Couldn't send the link. Try again in a minute.";
      errEl.classList.add("visible");
      return;
    }
    statusEl.className = "login-magic-status success";
    statusEl.innerHTML =
      "Sent. Check <b>" + escapeHtml(email) + "</b> for a link from Supabase. " +
      "Click it to finish signing in — this tab will pick up the session automatically.";
  });

  /* ═════════════ Data loading ═════════════ */

  async function reloadAll() {
    showLoader(true);
    try {
      const [cats, tpls, cls, igs, tch, ct, ci, stu, enr, invites, cfg, closures, syncLog, matches, att, clk, subs, subClm, schs, canc, cur, curA, tpd, tdocs, waivers, wSigs, pms, prof, evs, evStaff, invItems, invAssigns] = await Promise.all([
        sb.from("categories").select("*").order("sort_order", { ascending: true }),
        sb.from("templates").select("*").order("created_at", { ascending: true }),
        sb.from("classes").select("*").order("name", { ascending: true }),
        sb.from("infographics").select("*").order("name", { ascending: true }),
        sb.from("teachers").select("*").order("full_name", { ascending: true }),
        sb.from("class_teachers").select("*"),
        sb.from("class_infographics").select("*"),
        sb.from("students").select("*").order("last_name", { ascending: true }),
        sb.from("enrollments").select("*").order("enrolled_at", { ascending: false }),
        sb.from("teacher_invitations").select("*").order("sent_at", { ascending: false }),
        sb.from("dk_config").select("*").eq("id", 1).maybeSingle(),
        sb.from("closures").select("*").order("date", { ascending: true }),
        sb.from("sync_log").select("*").eq("source", "jackrabbit").eq("operation", "pull_openings").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        sb.from("student_match_candidates").select("*").is("resolved_at", null).order("detected_at", { ascending: false }),
        sb.from("attendance").select("*").order("session_date", { ascending: false }),
        sb.from("clock_ins").select("*").order("session_date", { ascending: false }),
        sb.from("sub_requests").select("*").order("session_date", { ascending: true }),
        sb.from("sub_claims").select("*").order("created_at", { ascending: false }),
        sb.from("schools").select("*").order("name", { ascending: true }),
        sb.from("class_cancellations").select("*").order("session_date", { ascending: false }),
        sb.from("curriculum_items").select("*").order("created_at", { ascending: false }),
        sb.from("curriculum_assignments").select("*").order("assigned_at", { ascending: false }),
        sb.from("teacher_payment_details").select("*"),
        sb.from("teacher_documents").select("*").order("uploaded_at", { ascending: false }),
        sb.from("liability_waivers").select("*").order("version", { ascending: false }),
        sb.from("liability_waiver_signatures").select("*").order("signed_at", { ascending: false }),
        sb.from("payment_methods").select("*").order("sort_order", { ascending: true }),
        sb.from("profiles").select("*").order("full_name", { ascending: true }),
        sb.from("events").select("*").order("starts_at", { ascending: true }),
        sb.from("event_staff").select("*"),
        sb.from("inventory_items").select("*").order("name", { ascending: true }),
        sb.from("inventory_assignments").select("*").order("usage_starts_at", { ascending: true })
      ]);
      for (const r of [cats, tpls, cls, igs, tch, ct, ci, stu, enr]) if (r.error) throw r.error;
      // Non-admin roles may not have SELECT access to teacher_invitations /
      // dk_config (self-read RLS); swallow those errors so reloadAll doesn't fail.
      state.categories       = cats.data;
      state.templates        = tpls.data;
      state.classes          = cls.data;
      state.infographics     = igs.data;
      state.teachers         = tch.data;
      state.classTeachers    = ct.data;
      state.classInfographics = ci.data;
      state.students         = stu.data;
      state.enrollments      = enr.data;
      state.teacherInvitations = (invites && !invites.error) ? invites.data : [];
      state.dkConfig         = (cfg && !cfg.error) ? cfg.data : null;
      state.closures         = (closures && !closures.error) ? closures.data : [];
      state.latestSyncLog    = syncLog.data || null;
      // Non-admin roles can't SELECT student_match_candidates (admin-only RLS);
      // swallow the error and treat as empty — banners/chips just don't render.
      state.matchCandidates  = (matches && !matches.error) ? matches.data : [];
      // Attendance RLS: admins read all, teachers read their assigned classes,
      // managers/viewers read via view_attendance_readonly. Any error falls back
      // to empty — "coming soon"-style UI still renders.
      state.attendance       = (att && !att.error) ? att.data : [];
      // Clock-ins RLS: admins read all, teachers read own rows. Errors
      // (e.g. managers/viewers without perm) fall back to empty.
      state.clockIns         = (clk && !clk.error) ? clk.data : [];
      // Sub requests + claims RLS: admins/managers read all; teachers see
      // open requests, their own requests/fills, and claims they own.
      // Viewers fall back to empty.
      state.subRequests      = (subs && !subs.error) ? subs.data : [];
      state.subClaims        = (subClm && !subClm.error) ? subClm.data : [];
      // Schools + class_cancellations: any signed-in user can SELECT.
      // Tables won't exist on Supabase until phase_t8_schools.sql is
      // applied; tolerate the error so the rest of the app stays usable.
      state.schools          = (schs && !schs.error) ? schs.data : [];
      state.classCancellations = (canc && !canc.error) ? canc.data : [];
      // Curriculum items: T5a admin/manager SELECT path; T5b widens to teachers
      // who hold ≥1 assignment for the item. Viewers stay blind.
      state.curriculumItems  = (cur && !cur.error) ? cur.data : [];
      // Curriculum assignments (T5b): admin/manager see all; teachers see own
      // rows via teachers.email join. Viewers fall back to empty.
      state.curriculumAssignments = (curA && !curA.error) ? curA.data : [];
      // T6b: payment details RLS gates SELECT to manage_teacher_payments
      // (admin+super_admin); other roles get empty. Same for documents and
      // signature audit (manage_teacher_compliance). Active waiver SELECT
      // is open to all signed-in users so teachers can read what they sign.
      state.teacherPaymentDetails = (tpd && !tpd.error) ? tpd.data : [];
      state.teacherDocuments      = (tdocs && !tdocs.error) ? tdocs.data : [];
      state.liabilityWaivers      = (waivers && !waivers.error) ? waivers.data : [];
      state.waiverSignatures      = (wSigs && !wSigs.error) ? wSigs.data : [];
      // T6c: payment_methods SELECT is open to any authenticated user;
      // empty fallback covers the brief window before the migration is
      // applied in any local-dev branch.
      state.paymentMethods        = (pms && !pms.error) ? pms.data : [];
      // T6d: profiles SELECT widened to admin_or_above. Non-admins see only
      // their own row via the pre-existing self-read policy → 1-element list
      // (or 0 if RLS denies for some reason). The Users tab gates on role,
      // so non-admins never see this data anyway.
      state.profiles              = (prof && !prof.error) ? prof.data : [];
      // T9: events + event_staff. SELECT open to all signed-in users.
      // Empty fallback covers the brief window before the migration is
      // applied in any local-dev branch.
      state.events                = (evs && !evs.error) ? evs.data : [];
      state.eventStaff            = (evStaff && !evStaff.error) ? evStaff.data : [];
      // T10: inventory items + assignments. SELECT open to all signed-in
      // users. Empty fallback covers the brief window before the migration
      // is applied in any local-dev branch.
      state.inventoryItems        = (invItems && !invItems.error) ? invItems.data : [];
      state.inventoryAssignments  = (invAssigns && !invAssigns.error) ? invAssigns.data : [];
    } catch (e) {
      console.error(e);
      showToast("Failed to load: " + e.message, "error");
    }
    showLoader(false);
  }

  function renderAll() {
    renderHomeTab();
    renderScheduleTab();
    renderInfographicsSidebar();
    renderCategoryChips();
    renderTemplates();
    renderClassesTab();
    renderSchoolsTab();
    renderTeachersTab();
    renderCategoriesTab();
    renderInfographicsTab();
    renderSubRequestsTab();
    renderEventsTab();
    renderInventoryTab();
    renderCurriculumTab();
    renderReportsTab();
    renderUsersTab();
  }

  /* ═════════════ HOME (Bento) ═════════════ */

  // Day-of-week abbreviations as stored in classes.days (populated by the
  // Jackrabbit sync: "Mon, Wed" style). Match regardless of order/spacing.
  const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_LONG  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  function classRunsOnDay(cls, date) {
    if (!cls) return false;
    // JR sync populates cls.days ("Mon, Wed"); the in-app class editor
    // populates cls.day_time ("Fridays, 3:00–3:45 PM"). Fall back to
    // day_time so manually-added classes also render on the schedule.
    const src = String(cls.days || cls.day_time || "").toLowerCase();
    if (!src) return false;
    const sd = cls.start_date ? new Date(cls.start_date + "T00:00:00") : null;
    const ed = cls.end_date   ? new Date(cls.end_date   + "T23:59:59") : null;
    if (sd && date < sd) return false;
    if (ed && date > ed) return false;
    const dayShort = DOW_SHORT[date.getDay()];
    const dayLong  = DOW_LONG[date.getDay()];
    return src.includes(dayShort.toLowerCase()) || src.includes(dayLong.toLowerCase());
  }

  // Parse a class's start time to a Date anchored to `onDate`. Prefers the
  // JR-synced cls.times ("3:00 PM - 3:45 PM") and falls back to cls.day_time
  // for in-app-edited classes ("Fridays, 3:00–3:45 PM").
  function classStartTimeOn(cls, onDate) {
    const src = cls?.times || cls?.day_time;
    if (!src) return null;
    const m = String(src).match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const isPm = m[3].toUpperCase() === "PM";
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
    const d = new Date(onDate);
    d.setHours(h, mm, 0, 0);
    return d;
  }

  function formatRelativeTimeUntil(target) {
    const diffMs = target - new Date();
    if (diffMs <= 0) return "now";
    const min = Math.round(diffMs / 60000);
    if (min < 60) return `in ${min}m`;
    const hr = Math.floor(min / 60);
    const rem = min - hr * 60;
    if (hr < 12) return `in ${hr}h ${rem}m`;
    return `in ${hr}h`;
  }

  function formatRelativePast(date) {
    const diffMs = new Date() - date;
    if (diffMs < 0) return "just now";
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  }

  function primaryTeacherOf(classId) {
    const ct = state.classTeachers.find((x) => x.class_id === classId && x.role === "primary");
    if (ct) return state.teachers.find((t) => t.id === ct.teacher_id);
    const any = state.classTeachers.find((x) => x.class_id === classId);
    return any ? state.teachers.find((t) => t.id === any.teacher_id) : null;
  }

  function renderHomeTab() {
    const grid = $("#bentoGrid");
    if (!grid) return;

    // Teachers get their own scoped bento. Admins/managers/viewers share the
    // existing admin bento; quick actions and pay-rate fields are gated
    // inside their own renderers.
    if (isRole("teacher")) {
      renderTeacherHome(grid);
      return;
    }

    const now = new Date();
    const todayClasses = state.classes
      .filter((c) => includeTestClass(c) && c.active !== false && classRunsOnDay(c, now))
      .map((c) => ({ cls: c, startAt: classStartTimeOn(c, now) }))
      .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));

    const upcomingToday = todayClasses.filter((x) => x.startAt && x.startAt > now);
    const nextClass = upcomingToday[0];

    const activeClasses = state.classes.filter((c) => includeTestClass(c) && c.active !== false).length;
    const activeTeachers = state.teachers.filter((t) => t.status === "active").length;
    const activeEnrollments = state.enrollments.filter((e) => e.status === "active").length;

    grid.innerHTML = `
      <div class="bento-card bento-span-8">${renderTodayCard(nextClass, todayClasses.length, now)}</div>
      <div class="bento-card bento-span-4">${renderStatsCard(activeClasses, activeTeachers, activeEnrollments)}</div>
      <div class="bento-card bento-span-5" id="bentoSchedule">${renderScheduleCard(todayClasses, now)}</div>
      <div class="bento-card bento-span-4" id="bentoAttention">${renderAttentionCard()}</div>
      <div class="bento-card bento-span-3">${renderWeekCard(now)}</div>
      <div class="bento-card bento-span-5">${renderActivityCard()}</div>
      <div class="bento-card bento-span-4" id="bentoQuickActions">${renderQuickActionsCard()}</div>
      <div class="bento-card bento-span-3">${renderParBridgeCard()}</div>
    `;

    wireHomeCardEvents();
  }

  /* ═════════════ TEACHER HOME (bento) ═════════════
   *
   * Teacher-scoped home view. Pulls the teacher's own assignments via
   * email match (state.session.user.email → teachers.email). Once Phase
   * T2 lands, profiles will carry an explicit teacher_id link instead of
   * an email join.
   *
   * T1 cards: Welcome, Your next class, This week, Coming soon (T3+),
   * On PAR. Anything that needs attendance/clock-in/curriculum data is
   * stubbed honestly as "coming in Phase T3+" rather than faked.
   */
  function renderTeacherHome(grid) {
    const me = mySignedInTeacher();

    // If we can't find a teachers row for this user yet, show a "not yet
    // linked" welcome card and skip the schedule sections.
    if (!me) {
      grid.innerHTML = `
        <div class="bento-card bento-span-12">
          ${renderTeacherWelcomeCard(null)}
        </div>
        <div class="bento-card bento-span-12">
          ${renderParBridgeCard()}
        </div>
      `;
      return;
    }

    const now = new Date();
    const myAssignments = state.classTeachers.filter((ct) => ct.teacher_id === me.id);
    const myClasses = myAssignments
      .map((ct) => state.classes.find((c) => c.id === ct.class_id))
      .filter((c) => c && includeTestClass(c) && c.active !== false);

    // Today's classes I'm assigned to
    const todayClasses = myClasses
      .filter((c) => classRunsOnDay(c, now))
      .map((c) => ({ cls: c, startAt: classStartTimeOn(c, now) }))
      .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));
    const nextClass = todayClasses.find((x) => x.startAt && x.startAt > now);

    // Next 7 days I have classes
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      weekCount += myClasses.filter((c) => classRunsOnDay(c, d)).length;
    }

    // T6b: prompt teacher to sign the active waiver if they haven't.
    const w = activeWaiver();
    const sig = latestSignatureForTeacher(me.id);
    const needsWaiver = w && (!sig || sig.waiver_id !== w.id);
    const waiverBanner = needsWaiver
      ? `<div class="bento-card bento-span-12 bento-waiver-banner">
           <div class="banner-row">
             <div>
               <strong>Action required:</strong> please read &amp; sign the franchise liability waiver.
               <div class="muted small">${escapeHtml(w.title)} — v${w.version}</div>
             </div>
             <button type="button" class="btn primary small" id="teacherSelfSignWaiverBtn">Read &amp; sign</button>
           </div>
         </div>`
      : "";

    grid.innerHTML = `
      ${waiverBanner}
      <div class="bento-card bento-span-8">${renderTeacherTodayCard(nextClass, todayClasses.length, now)}</div>
      <div class="bento-card bento-span-4">${renderTeacherWeekStatsCard(myClasses.length, weekCount)}</div>
      <div class="bento-card bento-span-8">${renderTeacherScheduleCard(todayClasses, now)}</div>
      <div class="bento-card bento-span-4">${renderTeacherAttendanceCard(todayClasses, now)}</div>
      <div class="bento-card bento-span-12">${renderTeacherShiftsCard(me, todayClasses, now)}</div>
      <div class="bento-card bento-span-12">${renderTeacherCurriculumCard(me, myClasses, now)}</div>
      <div class="bento-card bento-span-8">${renderTeacherWelcomeCard(me)}</div>
      <div class="bento-card bento-span-4">${renderParBridgeCard()}</div>
    `;

    wireHomeCardEvents();
    const selfSignBtn = $("#teacherSelfSignWaiverBtn");
    if (selfSignBtn) selfSignBtn.onclick = () => openSignWaiverModal({ mode: "self", teacher: me });
  }

  function renderTeacherTodayCard(nextClass, todayCount, now) {
    if (!nextClass) {
      if (todayCount > 0) {
        return `
          <div class="bento-label"><span>Today</span></div>
          <div class="bento-today-headline">
            <span class="bento-today-icon">🌙</span>
            <div class="bento-today-body">
              <p class="bento-today-title">Today's classes are wrapped</p>
              <p class="bento-today-sub">${todayCount} class${todayCount === 1 ? "" : "es"} earlier today · none upcoming</p>
            </div>
          </div>
        `;
      }
      const dowLong = DOW_LONG[now.getDay()];
      return `
        <div class="bento-label"><span>Today</span></div>
        <div class="bento-today-headline">
          <span class="bento-today-icon">☀️</span>
          <div class="bento-today-body">
            <p class="bento-today-title">No classes for you on ${dowLong}</p>
            <p class="bento-today-sub">Enjoy the day off.</p>
          </div>
        </div>
      `;
    }
    const { cls, startAt } = nextClass;
    const when = formatRelativeTimeUntil(startAt);
    const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `
      <div class="bento-label">
        <span>Your next class</span>
        <span class="live-pill">Live</span>
      </div>
      <div class="bento-today-headline">
        <span class="bento-today-icon">🎭</span>
        <div class="bento-today-body">
          <p class="bento-today-title">${escapeHtml(cls.name)}</p>
          <p class="bento-today-sub">${timeStr} · ${when}${cls.location ? ` · ${escapeHtml(cls.location)}` : ""}</p>
        </div>
      </div>
    `;
  }

  function renderTeacherWeekStatsCard(myClassCount, weekSessionCount) {
    return `
      <div class="bento-label"><span>Your week</span></div>
      <div class="bento-stats">
        <div class="bento-stat-row">
          <span class="k"><span class="icon">🎭</span>Classes assigned</span>
          <span class="v">${myClassCount}</span>
        </div>
        <div class="bento-stat-row">
          <span class="k"><span class="icon">📅</span>Sessions this week</span>
          <span class="v">${weekSessionCount}</span>
        </div>
      </div>
    `;
  }

  function renderTeacherScheduleCard(todayClasses, now) {
    if (todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's schedule</span></div>
        <div class="bento-attention-empty">Nothing scheduled today.</div>
      `;
    }
    const items = todayClasses.map(({ cls, startAt }, i) => {
      const isPast = startAt && startAt < now;
      const isNext = startAt && !isPast && i === todayClasses.findIndex((x) => x.startAt > now);
      const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
      const timeStr = startAt ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
      const showLine = i < todayClasses.length - 1;
      return `
        <div class="bento-timeline-item" ${isPast ? 'style="opacity:.55"' : ""}>
          <div class="bento-timeline-spine">
            <div class="bento-timeline-dot ${dotClass}"></div>
            ${showLine ? '<div class="bento-timeline-line"></div>' : ""}
          </div>
          <div class="bento-timeline-body">
            <div class="bento-timeline-time">${escapeHtml(timeStr)}</div>
            <div class="bento-timeline-title">${escapeHtml(cls.name)}</div>
            <div class="bento-timeline-sub">${cls.location ? escapeHtml(cls.location) : ""}</div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's schedule</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">${todayClasses.length} class${todayClasses.length === 1 ? "" : "es"}</span></div>
      <div class="bento-timeline">${items}</div>
    `;
  }

  // T3b: live attendance CTAs for today's classes. Data-driven card
  // that replaces the static "Coming soon" stub on the teacher bento.
  function renderTeacherAttendanceCard(todayClasses, now) {
    if (!todayClasses || todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's attendance</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0;color:var(--ink-dim);font-size:12px">Nothing to take today.</p>
        </div>
      `;
    }
    const today = isoDate(new Date());
    const rows = todayClasses.map(({ cls }) => {
      const stats = attendanceStatsForSession(cls.id, today);
      const taken = stats.taken;
      const marked = stats.present + stats.absent;
      const label = taken
        ? `<span style="color:#2f7d3a">✓ ${stats.present} / ${marked} present${stats.latePickups > 0 ? ` · ${stats.latePickups} late pickup${stats.latePickups === 1 ? "" : "s"}` : ""}</span>`
        : `<span style="color:var(--ink-dim)">Not yet</span>`;
      return `
        <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle,#eee)">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cls.name)}</div>
            <div style="font-size:11px;margin-top:2px">${label}</div>
          </div>
          <button data-act="take-attendance" data-class-id="${escapeHtml(cls.id)}"
            style="flex:0 0 auto;border:1px solid var(--border);background:var(--surface);padding:4px 8px;border-radius:5px;font-size:11.5px;cursor:pointer">${taken ? "Edit" : "Take"}</button>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's attendance</span></div>
      <div>${rows}</div>
    `;
  }

  // T3d: Teacher shifts (clock-in / clock-out). One row per today's class
  // showing current clock status and the action button. Clock in is idempotent
  // server-side — the RPC returns the existing open shift if you tap twice.
  function renderTeacherShiftsCard(me, todayClasses, now) {
    if (!me || !todayClasses || todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's shifts</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0;color:var(--ink-dim);font-size:12px">No classes today — nothing to clock.</p>
        </div>
      `;
    }
    const today = isoDate(new Date());
    const rows = todayClasses.map(({ cls }) => {
      const shift = state.clockIns.find(
        (c) => c.teacher_id === me.id && c.class_id === cls.id && c.session_date === today
      );
      let status, action;
      if (!shift) {
        status = `<span style="color:var(--ink-dim)">Not clocked in</span>`;
        action = `<button data-act="clock-in" data-class-id="${escapeHtml(cls.id)}"
          class="btn primary small">Clock in</button>`;
      } else if (!shift.clocked_out_at) {
        const inTime = new Date(shift.clocked_in_at);
        const mins = Math.max(0, Math.round((now - inTime) / 60000));
        const timeStr = inTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        status = `<span style="color:#2f7d3a">⏱ Clocked in at ${escapeHtml(timeStr)} · ${mins} min</span>`;
        action = `<button data-act="clock-out" data-clock-id="${escapeHtml(shift.id)}"
          class="btn small">Clock out</button>`;
      } else {
        const durMin = Math.max(0, Math.round(
          (new Date(shift.clocked_out_at) - new Date(shift.clocked_in_at)) / 60000
        ));
        status = `<span style="color:var(--ink-dim)">✓ Done · ${durMin} min</span>`;
        action = ``;
      }
      return `
        <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-subtle,#eee)">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500">${escapeHtml(cls.name)}${cls.location ? ` <span style="color:var(--ink-dim);font-weight:400;font-size:12px">· ${escapeHtml(cls.location)}</span>` : ""}</div>
            <div style="font-size:12px;margin-top:2px">${status}</div>
          </div>
          <div>${action}</div>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's shifts</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">Tap to clock in or out</span></div>
      <div>${rows}</div>
    `;
  }

  async function doClockIn(classId) {
    showLoader(true);
    const { error } = await sb.rpc("clock_in", { p_class_id: classId });
    showLoader(false);
    if (error) { showToast("Clock in failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Clocked in", "success");
  }

  async function doClockOut(clockInId) {
    showLoader(true);
    const { error } = await sb.rpc("clock_out", { p_clock_in_id: clockInId });
    showLoader(false);
    if (error) { showToast("Clock out failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Clocked out", "success");
  }

  function renderTeacherComingSoonCard() {
    return `
      <div class="bento-label"><span>Coming soon</span></div>
      <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
        <p style="margin:0 0 6px 0;color:var(--ink)">Attendance, clock-in/out, and shift trades land in the next build phase.</p>
        <p style="margin:0;color:var(--ink-dim);font-size:11.5px">For now, your schedule view is read-only. Contact Sharon for any sub or schedule changes.</p>
      </div>
    `;
  }

  /* T5b: teacher curriculum card.
   *
   * Lists curriculum items assigned to this teacher, grouped by class.
   * Each item shows a lock/unlock state computed from the rolling per-
   * session lead window — locked items show "Unlocks in Nd"; unlocked
   * items show "Available now" + a View button. Each row also carries
   * a Notes textarea that travels with the (item, class, teacher)
   * assignment row, written via the set_curriculum_assignment_notes
   * RPC so teachers can only mutate their own teacher_notes column.
   *
   * For T5b, the View button handles `link` (opens external URL) and
   * `script` (renders inline content modal) directly. PDF / video /
   * image require the watermarked viewer in T5c, so for those types
   * View shows a "Coming in T5c" placeholder.
   */
  function renderTeacherCurriculumCard(me, myClasses, now) {
    const myAssignments = (state.curriculumAssignments || []).filter((a) => a.teacher_id === me.id);
    if (myAssignments.length === 0) {
      return `
        <div class="bento-label"><span>Your curriculum</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0;color:var(--ink-dim);font-size:12px">No curriculum items assigned to you yet. Sharon will assign lesson PDFs, scripts, and videos as terms come up.</p>
        </div>
      `;
    }

    // Group by class — render a tiny per-class section with its assigned items.
    const byClass = new Map();
    myAssignments.forEach((a) => {
      const arr = byClass.get(a.class_id) || [];
      arr.push(a);
      byClass.set(a.class_id, arr);
    });

    const sections = Array.from(byClass.entries()).map(([classId, assigns]) => {
      const cls = state.classes.find((c) => c.id === classId);
      if (!cls) return ""; // class deleted — hide gracefully
      const rows = assigns.map((a) => {
        const item = state.curriculumItems.find((x) => x.id === a.curriculum_item_id);
        if (!item) return ""; // item not visible (RLS) or removed
        const meta = CURRICULUM_TYPE_META[item.asset_type] || { label: item.asset_type, ico: "📦" };
        const win  = curriculumLeadWindowState(a, item, cls, now);
        let chip;
        if (win.unlocked) {
          chip = `<span class="cur-lock-chip cur-lock-unlocked">🔓 Available now</span>`;
        } else if (win.daysUntilUnlock == null) {
          chip = `<span class="cur-lock-chip cur-lock-pending">No upcoming session</span>`;
        } else {
          chip = `<span class="cur-lock-chip cur-lock-locked" title="Lead window: ${win.leadDays}d before each session">🔒 Unlocks in ${win.daysUntilUnlock}d</span>`;
        }
        const approved = item.dk_approved
          ? `<span class="cur-badge cur-badge-approved" title="DK Corporate approved">✓ DK approved</span>` : "";
        const adminNote = a.notes
          ? `<div class="cur-admin-note"><b>From Sharon:</b> ${escapeHtml(a.notes)}</div>` : "";
        const notesSavedHint = a.teacher_notes_updated_at
          ? ` <span class="cur-notes-saved">Saved ${escapeHtml(formatRelativePast(new Date(a.teacher_notes_updated_at)))}</span>` : "";
        const viewBtn = win.unlocked
          ? `<button class="btn primary small" data-cur-view="${escapeHtml(a.id)}">View</button>`
          : "";
        return `
          <div class="cur-teach-row">
            <div class="cur-teach-row-ico" aria-hidden="true">${meta.ico}</div>
            <div class="cur-teach-row-main">
              <div class="cur-teach-row-head">
                <span class="cur-teach-row-title">${escapeHtml(item.title)}</span>
                <span class="cur-pill">${escapeHtml(meta.label)}</span>
                ${approved}
                ${chip}
              </div>
              ${item.description ? `<div class="cur-desc">${escapeHtml(item.description)}</div>` : ""}
              ${adminNote}
              <div class="cur-notes-block">
                <label class="cur-notes-label" for="cur_notes_${escapeHtml(a.id)}">My notes ${notesSavedHint}</label>
                <textarea id="cur_notes_${escapeHtml(a.id)}" class="cur-notes-textarea"
                  placeholder="Cohort observations, what worked, what to repeat next term…">${escapeHtml(a.teacher_notes || "")}</textarea>
                <div class="cur-notes-actions">
                  <button class="btn ghost small" data-cur-save-notes="${escapeHtml(a.id)}">Save notes</button>
                </div>
              </div>
            </div>
            <div class="cur-teach-row-actions">${viewBtn}</div>
          </div>`;
      }).filter(Boolean).join("");

      if (!rows) return "";
      return `
        <div class="cur-teach-class-section">
          <div class="cur-teach-class-head">
            <span class="cur-teach-class-name">${escapeHtml(cls.name)}</span>
            ${cls.location ? `<span class="cur-teach-class-meta">· ${escapeHtml(cls.location)}</span>` : ""}
          </div>
          <div class="cur-teach-rows">${rows}</div>
        </div>`;
    }).filter(Boolean).join("");

    return `
      <div class="bento-label"><span>Your curriculum</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">${myAssignments.length} item${myAssignments.length === 1 ? "" : "s"} assigned</span></div>
      <div class="cur-teach-grid">${sections || `<div class="bento-attention-empty" style="text-align:left;padding:8px 0"><p style="margin:0;color:var(--ink-dim);font-size:12px">Assigned items aren't visible yet — check with Sharon.</p></div>`}</div>
    `;
  }

  async function saveTeacherCurriculumNotes(assignmentId) {
    if (!assignmentId) return;
    const ta = document.getElementById(`cur_notes_${assignmentId}`);
    if (!ta) return;
    const notes = ta.value;
    showLoader(true);
    const { error } = await sb.rpc("set_curriculum_assignment_notes", {
      p_assignment_id: assignmentId,
      p_notes:         notes
    });
    showLoader(false);
    if (error) { showToast("Save failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Notes saved", "success");
  }

  /* Curriculum viewer (T5b: link/script · T5c: pdf/video/image).
   * For link/script we render directly — no bucket fetch, nothing to
   * watermark. For pdf/video/image we call the curriculum-fetch Edge
   * Function (verify_jwt:true), which re-runs the lead-window check
   * server-side, mints a 5-min signed URL against the private
   * curriculum-assets bucket, and writes a row to curriculum_access_log.
   * The signed URL is then rendered behind a CSS-tiled watermark
   * overlay. None of the suppression is unbreakable — see CLAUDE.md
   * §4.22 — but a leaked screenshot is trivially traceable. */
  function openCurriculumViewer(assignmentId) {
    const a = (state.curriculumAssignments || []).find((x) => x.id === assignmentId);
    if (!a) { showToast("Assignment not found", "error"); return; }
    const item = (state.curriculumItems || []).find((x) => x.id === a.curriculum_item_id);
    const cls  = (state.classes || []).find((c) => c.id === a.class_id);
    if (!item || !cls) { showToast("Item not found", "error"); return; }

    // Defense-in-depth: re-check the lead window before opening. The
    // Edge Function will also refuse with 403 if locked.
    const win = curriculumLeadWindowState(a, item, cls, new Date());
    if (!win.unlocked) {
      showToast(`Locked — unlocks in ${win.daysUntilUnlock}d`, "error"); return;
    }

    if (item.asset_type === "link") {
      if (item.external_url) {
        window.open(item.external_url, "_blank", "noopener");
      } else {
        showToast("Link is missing a URL", "error");
      }
      return;
    }
    if (item.asset_type === "script") {
      openCurriculumScriptViewer(item, cls);
      return;
    }
    // T5a allows a `video` item to be hosted externally (Vimeo unlisted,
    // etc.) via external_url with no storage_path. The Edge Function
    // can't sign a non-bucket URL, so fall through to a new-tab open
    // — same as the `link` type. Watermarking is not enforceable on
    // external pages anyway (CLAUDE.md §4.22 acknowledges this).
    if (item.asset_type === "video" && item.external_url && !item.storage_path) {
      window.open(item.external_url, "_blank", "noopener");
      return;
    }
    // pdf / video / image (uploaded) → call the Edge Function for a
    // signed URL, then render in the watermarked stage.
    openCurriculumWatermarkedViewer({
      kind: "view",
      title: item.title,
      assetType: item.asset_type,
      payload: { assignment_id: a.id, kind: "view" },
      contextLabel: `${cls.name}${item.dk_approved ? " · DK approved" : ""}`,
    });
  }

  // Script-only viewer path — no bucket fetch, no watermark needed (the
  // user could just retype the script). Kept identical to T5b behavior.
  function openCurriculumScriptViewer(item, cls) {
    $("#curViewerTitle").textContent = item.title;
    const body = $("#curViewerBody");
    if (body) {
      body.innerHTML = `
        <div class="cur-viewer-script" style="padding:18px 22px">${escapeHtml(item.script_content || "").replace(/\n/g, "<br/>")}</div>
        <div class="cur-viewer-meta" style="padding:0 22px 16px">Script · ${escapeHtml(cls.name)} · ${escapeHtml(item.dk_approved ? "DK approved" : "")}</div>
      `;
    }
    // Hide the watermark overlay — script content isn't bucket-fetched
    // and doesn't need it.
    const wm = $("#curViewerWatermark");
    if (wm) wm.style.display = "none";
    $("#curViewerModalOverlay").classList.add("open");
  }

  /* Admin curator preview (T5c). Open from the curriculum edit modal's
   * "Preview (watermarked)" button. Same Edge Function path, kind='preview',
   * gated server-side on edit_curriculum/assign_curriculum and logged to
   * curriculum_access_log so curators are also auditable (CLAUDE.md §4.22). */
  async function openCurriculumPreview() {
    if (!hasPerm("edit_curriculum") && !hasPerm("assign_curriculum")) {
      showToast("Preview requires curriculum edit access", "error"); return;
    }
    const editingId = state.curState.editingId;
    if (!editingId) { showToast("Save the item first", "error"); return; }
    const item = (state.curriculumItems || []).find((x) => x.id === editingId);
    if (!item) { showToast("Item not found", "error"); return; }
    if (!["pdf","video","image"].includes(item.asset_type)) {
      showToast("Preview only applies to PDF/video/image items", "error"); return;
    }
    if (!item.storage_path) {
      showToast("This item has no uploaded file yet", "error"); return;
    }
    openCurriculumWatermarkedViewer({
      kind: "preview",
      title: item.title,
      assetType: item.asset_type,
      payload: { item_id: item.id, kind: "preview" },
      contextLabel: "Curator preview · audit-logged",
    });
  }

  /* The actual signed-URL + watermark renderer. Used by both teacher
   * view and admin preview paths.
   *
   * Steps:
   *   1. POST to the curriculum-fetch Edge Function. It returns a 5-min
   *      signed URL or a 403 with a lock message.
   *   2. Render the asset inside #curViewerBody:
   *        - pdf   → PDF.js canvas pages (one canvas per page)
   *        - video → <video controlsList="nodownload" disablePictureInPicture>
   *        - image → <img>
   *   3. Build the CSS-tiled watermark overlay with the user's identity
   *      + ISO timestamp.
   *   4. Wire suppression: contextmenu / selectstart / copy + Cmd-S/P/C
   *      keydown handlers on the modal. Cleared in closeCurriculumViewer.
   */
  async function openCurriculumWatermarkedViewer(opts) {
    const { title, assetType, payload, contextLabel } = opts;
    $("#curViewerTitle").textContent = title || "Curriculum item";
    const body = $("#curViewerBody");
    if (body) body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--ink-dim)">Loading…</div>`;
    const wm = $("#curViewerWatermark");
    if (wm) { wm.style.display = ""; wm.innerHTML = ""; }
    $("#curViewerModalOverlay").classList.add("open");

    showLoader(true);
    let resp;
    try {
      resp = await sb.functions.invoke("curriculum-fetch", { body: payload });
    } catch (e) {
      showLoader(false);
      if (body) body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--ink-dim)">Failed to load: ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    showLoader(false);

    if (resp.error || !resp.data?.url) {
      // supabase-js v2 wraps non-2xx responses in a FunctionsHttpError
      // whose `message` is the generic "Edge Function returned a non-2xx
      // status code". The actual Response body lives in different places
      // depending on the client version: pre-2.50 puts it on
      // `error.context`, 2.50+ exposes it as a top-level `response`. We
      // try both, plus any pre-parsed JSON on `data`.
      let msg = resp.data?.error || resp.error?.message || "Failed to fetch curriculum item";
      let status = null;
      const respObj = resp.response || resp.error?.context || null;
      if (respObj) {
        status = respObj.status ?? null;
        try {
          const parsed = await respObj.clone().json();
          if (parsed) {
            msg = parsed.error || parsed.message || JSON.stringify(parsed);
          }
        } catch {
          try {
            const txt = await respObj.clone().text();
            if (txt) msg = txt;
          } catch (textErr) {
            console.warn("[curriculum-fetch] could not read response body", textErr);
          }
        }
      }
      console.error("[curriculum-fetch] status=" + status, msg, resp);
      const display = status ? `${status} · ${msg}` : msg;
      if (body) body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--ink-dim)">${escapeHtml(display)}</div>`;
      return;
    }
    const { url } = resp.data;

    // Render the asset.
    if (body) {
      if (assetType === "image") {
        body.innerHTML = `<div class="cur-viewer-imgwrap" style="display:flex;justify-content:center;align-items:center;padding:16px;min-height:60vh"><img src="${escapeHtml(url)}" alt="" style="max-width:100%;max-height:78vh;display:block" draggable="false"/></div>`;
      } else if (assetType === "video") {
        body.innerHTML = `<div class="cur-viewer-videowrap" style="display:flex;justify-content:center;align-items:center;padding:16px;min-height:60vh"><video src="${escapeHtml(url)}" controls controlsList="nodownload noremoteplayback" disablePictureInPicture playsinline style="max-width:100%;max-height:78vh;display:block;background:#000"></video></div>`;
      } else if (assetType === "pdf") {
        body.innerHTML = `<div class="cur-viewer-pdf" id="curViewerPdfPages" style="overflow:auto;max-height:78vh;padding:16px;background:#222"></div>`;
        await renderPdfIntoContainer(url, document.getElementById("curViewerPdfPages"));
      } else {
        body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--ink-dim)">Unsupported asset type: ${escapeHtml(assetType)}</div>`;
      }
    }

    // Build watermark tile content.
    if (wm) {
      const u = state.session?.user || {};
      const tname = state.profile?.full_name || mySignedInTeacher()?.full_name || u.email || "user";
      const temail = u.email || "";
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
      const ctx = contextLabel ? ` · ${contextLabel}` : "";
      // Rendered as repeating tiles via CSS background-image: we
      // generate a single .cur-viewer-watermark-tile and let CSS
      // repeat. Using inline-spaced spans inside a tiled flex grid
      // would also work; this keeps the markup simple.
      const text = `${tname} · ${temail} · ${stamp}${ctx}`;
      // Build a grid of repeated labels so the entire surface is
      // covered regardless of viewport. 5 rows × 3 cols = 15 tiles —
      // sparser than the original 32-tile pack so each instance is
      // more visually distinct (CSS sets the 3-col grid to match).
      const tiles = [];
      for (let i = 0; i < 15; i++) tiles.push(`<span class="cur-viewer-watermark-tile">${escapeHtml(text)}</span>`);
      wm.innerHTML = tiles.join("");
    }

    // Wire suppression handlers (best-effort — see CLAUDE.md §4.22).
    installCurriculumViewerSuppression();
  }

  // PDF.js render — lazy-load via dynamic import() (no build step,
  // no global pollution). v4 ships an ESM-only default build, so we
  // import the module namespace directly. workerSrc MUST match the
  // bundle URL's version exactly or v4 throws "API version does not
  // match Worker version" — keep the constant in one place.
  const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";
  let _pdfjsModule = null;

  async function loadPdfJs() {
    if (_pdfjsModule) return _pdfjsModule;
    // dynamic import — Safari + Chrome + FF support this natively as
    // of all currently shipping versions.
    const mod = await import(/* @vite-ignore */ `${PDFJS_CDN}/pdf.min.mjs`);
    if (!mod.GlobalWorkerOptions.workerSrc) {
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
    }
    _pdfjsModule = mod;
    return mod;
  }

  async function renderPdfIntoContainer(url, container) {
    if (!container) return;
    let pdfjsLib;
    try {
      pdfjsLib = await loadPdfJs();
    } catch (e) {
      container.innerHTML = `<div style="padding:32px;text-align:center;color:#fff">PDF.js failed to load: ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    try {
      const loadingTask = pdfjsLib.getDocument({ url });
      const pdf = await loadingTask.promise;
      container.innerHTML = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.cssText = "display:block;margin:0 auto 12px auto;max-width:100%;height:auto;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4)";
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
    } catch (e) {
      container.innerHTML = `<div style="padding:32px;text-align:center;color:#fff">PDF render failed: ${escapeHtml(String(e.message || e))}</div>`;
    }
  }

  // Suppression: contextmenu / selectstart / copy + Cmd/Ctrl-S/P/C
  // keydowns on the viewer modal. Stored on a state slot so we can
  // remove the exact same listeners on close (anonymous functions
  // can't be removed). Doesn't prevent screenshots — the watermark
  // is the actual deterrent. Doesn't capture global events; only the
  // viewer modal's own subtree.
  function installCurriculumViewerSuppression() {
    const modal = $("#curViewerModalOverlay");
    if (!modal) return;
    removeCurriculumViewerSuppression();
    const block = (e) => { e.preventDefault(); return false; };
    const blockKeys = (e) => {
      const k = (e.key || "").toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (k === "s" || k === "p" || k === "c")) {
        e.preventDefault();
        return false;
      }
    };
    state._curViewerHandlers = { block, blockKeys };
    modal.addEventListener("contextmenu", block);
    modal.addEventListener("selectstart", block);
    modal.addEventListener("copy",        block);
    modal.addEventListener("keydown",     blockKeys);
  }

  function removeCurriculumViewerSuppression() {
    const modal = $("#curViewerModalOverlay");
    const h = state._curViewerHandlers;
    if (!modal || !h) return;
    modal.removeEventListener("contextmenu", h.block);
    modal.removeEventListener("selectstart", h.block);
    modal.removeEventListener("copy",        h.block);
    modal.removeEventListener("keydown",     h.blockKeys);
    state._curViewerHandlers = null;
  }

  function closeCurriculumViewer() {
    $("#curViewerModalOverlay").classList.remove("open");
    removeCurriculumViewerSuppression();
    // Stop any playing video / clear large pdf canvases so we don't
    // hang on to the signed-URL response in memory after the modal
    // closes.
    const body = $("#curViewerBody");
    if (body) body.innerHTML = "";
    const wm = $("#curViewerWatermark");
    if (wm) wm.innerHTML = "";
  }

  function renderTeacherWelcomeCard(teacherRow) {
    if (!teacherRow) {
      return `
        <div class="bento-label"><span>Welcome to PAR DK</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0 0 6px 0;color:var(--ink)">You're signed in as a teacher, but we couldn't find your teacher record yet.</p>
          <p style="margin:0;color:var(--ink-dim);font-size:11.5px">Ask Sharon to add your email (${escapeHtml(state.session?.user?.email || "")}) to your teacher profile.</p>
        </div>
      `;
    }
    const myAssignments = state.classTeachers.filter((ct) => ct.teacher_id === teacherRow.id);
    return `
      <div class="bento-label"><span>Welcome, ${escapeHtml(teacherRow.full_name.split(/\s+/)[0])}</span></div>
      <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
        <p style="margin:0 0 6px 0;color:var(--ink)">You're assigned to ${myAssignments.length} class${myAssignments.length === 1 ? "" : "es"}.</p>
        <p style="margin:0;color:var(--ink-dim);font-size:11.5px">Status: ${escapeHtml(teacherRow.status || "active")}${teacherRow.par_person_id ? " · linked to PAR" : ""}</p>
      </div>
    `;
  }

  function renderTodayCard(nextClass, todayCount, now) {
    if (!nextClass) {
      if (todayCount > 0) {
        return `
          <div class="bento-label"><span>Today</span></div>
          <div class="bento-today-headline">
            <span class="bento-today-icon">🌙</span>
            <div class="bento-today-body">
              <p class="bento-today-title">Today's classes are wrapped</p>
              <p class="bento-today-sub">${todayCount} class${todayCount === 1 ? "" : "es"} earlier today · none upcoming</p>
            </div>
          </div>
        `;
      }
      const dowLong = DOW_LONG[now.getDay()];
      return `
        <div class="bento-label"><span>Today</span></div>
        <div class="bento-today-headline">
          <span class="bento-today-icon">☀️</span>
          <div class="bento-today-body">
            <p class="bento-today-title">No classes scheduled for ${dowLong}</p>
            <p class="bento-today-sub">Enjoy the lighter day.</p>
          </div>
        </div>
      `;
    }
    const { cls, startAt } = nextClass;
    const teacher = primaryTeacherOf(cls.id);
    const when = formatRelativeTimeUntil(startAt);
    const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `
      <div class="bento-label">
        <span>Next up</span>
        <span class="live-pill">Live</span>
      </div>
      <div class="bento-today-headline">
        <span class="bento-today-icon">🎭</span>
        <div class="bento-today-body">
          <p class="bento-today-title">${escapeHtml(cls.name)}</p>
          <p class="bento-today-sub">${timeStr} · ${when}${cls.location ? ` · ${escapeHtml(cls.location)}` : ""}</p>
          ${teacher
            ? `<p class="bento-today-sub" style="margin-top:2px">Teacher: <b>${escapeHtml(teacher.full_name)}</b></p>`
            : `<p class="bento-today-dim" style="margin-top:2px">No teacher assigned</p>`
          }
        </div>
      </div>
    `;
  }

  function renderStatsCard(classes, teachers, enrollments) {
    return `
      <div class="bento-label"><span>At a glance</span></div>
      <div class="bento-stats">
        <div class="bento-stat-row">
          <span class="k"><span class="icon">🎭</span>Active classes</span>
          <span class="v">${classes}</span>
        </div>
        <div class="bento-stat-row">
          <span class="k"><span class="icon">🧑‍🏫</span>Teachers</span>
          <span class="v">${teachers}</span>
        </div>
        <div class="bento-stat-row">
          <span class="k"><span class="icon">👥</span>Active enrollments</span>
          <span class="v">${enrollments}</span>
        </div>
      </div>
    `;
  }

  function renderScheduleCard(todayClasses, now) {
    if (todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's schedule</span></div>
        <div class="bento-attention-empty">Nothing on the books today.</div>
      `;
    }
    const items = todayClasses.map(({ cls, startAt }, i) => {
      const isPast = startAt && startAt < now;
      const isNext = startAt && !isPast && i === todayClasses.findIndex((x) => x.startAt > now);
      const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
      const teacher = primaryTeacherOf(cls.id);
      const timeStr = startAt ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
      const showLine = i < todayClasses.length - 1;
      return `
        <div class="bento-timeline-item" data-open-class="${escapeHtml(cls.id)}" ${isPast ? 'style="opacity:.55"' : ""}>
          <div class="bento-timeline-spine">
            <div class="bento-timeline-dot ${dotClass}"></div>
            ${showLine ? '<div class="bento-timeline-line"></div>' : ""}
          </div>
          <div class="bento-timeline-body">
            <div class="bento-timeline-time">${escapeHtml(timeStr)}</div>
            <div class="bento-timeline-title">${escapeHtml(cls.name)}</div>
            <div class="bento-timeline-sub">${cls.location ? escapeHtml(cls.location) : ""}${teacher ? ` · ${escapeHtml(teacher.full_name)}` : ""}</div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's schedule</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">${todayClasses.length} class${todayClasses.length === 1 ? "" : "es"}</span></div>
      <div class="bento-timeline">${items}</div>
    `;
  }

  function renderAttentionCard() {
    const issues = [];
    // Classes without a primary teacher
    const noTeacher = state.classes.filter((c) =>
      includeTestClass(c) && c.active !== false &&
      !state.classTeachers.some((ct) => ct.class_id === c.id && ct.role === "primary")
    );
    if (noTeacher.length > 0) {
      issues.push({
        label: `${noTeacher.length} class${noTeacher.length === 1 ? "" : "es"} without a primary teacher`,
        hint: "Click to go to Classes and assign",
        go: "classes",
      });
    }
    // Classes without any linked infographics
    const noGraphics = state.classes.filter((c) =>
      includeTestClass(c) && c.active !== false &&
      !state.classInfographics.some((ci) => ci.class_id === c.id)
    );
    if (noGraphics.length > 0) {
      issues.push({
        label: `${noGraphics.length} class${noGraphics.length === 1 ? "" : "es"} missing linked graphics`,
        hint: "Link templates ↔ class images for faster responses",
        go: "classes",
      });
    }
    // Classes dropped from JR
    const dropped = state.classes.filter((c) => c.sync_state === "dropped_from_source");
    if (dropped.length > 0) {
      issues.push({
        label: `${dropped.length} class${dropped.length === 1 ? "" : "es"} dropped from Jackrabbit`,
        hint: "Review — may have ended or been removed",
        go: "classes",
      });
    }
    // Teachers with unresolved PAR
    const unresolvedTeachers = state.teachers.filter((t) => t.email && !t.par_person_id && t.status !== "inactive");
    if (unresolvedTeachers.length > 0) {
      issues.push({
        label: `${unresolvedTeachers.length} teacher${unresolvedTeachers.length === 1 ? "" : "s"} not linked to PAR`,
        hint: "Teachers tab → Refresh PAR links",
        go: "teachers",
      });
    }

    if (issues.length === 0) {
      return `
        <div class="bento-label"><span>Needs your attention</span></div>
        <div class="bento-attention-empty">All clear 🌱</div>
      `;
    }
    const items = issues.map((i) => `
      <div class="bento-attention-item" data-go-tab="${escapeHtml(i.go)}">
        <div class="label">${escapeHtml(i.label)}</div>
        <div class="hint">${escapeHtml(i.hint)}</div>
      </div>
    `).join("");
    return `
      <div class="bento-label"><span>Needs your attention</span></div>
      <div class="bento-attention-list">${items}</div>
    `;
  }

  function renderWeekCard(anchor) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(anchor);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      const count = state.classes.filter((c) => includeTestClass(c) && c.active !== false && classRunsOnDay(c, d)).length;
      const isToday = i === 0;
      days.push({ d, count, isToday, dow: DOW_SHORT[d.getDay()] });
    }
    const items = days.map((x) => `
      <div class="bento-week-day${x.isToday ? " today" : ""}">
        <div class="dow">${x.dow}</div>
        <div class="count${x.count === 0 ? " zero" : ""}">${x.count}</div>
      </div>
    `).join("");
    return `
      <div class="bento-label"><span>Next 7 days</span></div>
      <div class="bento-week">${items}</div>
    `;
  }

  function renderActivityCard() {
    // Pull the most recent sync_log-ish events we can derive locally.
    // We don't keep full sync_log in state — derive what we can from classes/profile.
    const events = [];
    if (state.latestSyncLog) {
      events.push({
        status: state.latestSyncLog.status,
        msg: `Jackrabbit sync — ${state.latestSyncLog.message}`,
        when: new Date(state.latestSyncLog.created_at),
      });
    }
    if (state.profile?.par_identity_last_synced) {
      events.push({
        status: state.profile.par_person_id ? "ok" : "skipped",
        msg: state.profile.par_person_id
          ? `PAR identity verified — linked as ${state.profile.par_display_name || "(no name)"}`
          : "PAR identity checked — no match yet",
        when: new Date(state.profile.par_identity_last_synced),
      });
    }
    // Recent class changes (proxy: classes with last_synced_at)
    state.classes
      .filter((c) => c.last_synced_at)
      .sort((a, b) => new Date(b.last_synced_at) - new Date(a.last_synced_at))
      .slice(0, 3)
      .forEach((c) => {
        events.push({
          status: "ok",
          msg: `${escapeHtml(c.name)} last synced from Jackrabbit`,
          when: new Date(c.last_synced_at),
        });
      });

    events.sort((a, b) => b.when - a.when);
    const top = events.slice(0, 6);

    if (top.length === 0) {
      return `
        <div class="bento-label"><span>Recent activity</span></div>
        <div class="bento-attention-empty">No activity yet.</div>
      `;
    }
    const items = top.map((e) => `
      <div class="bento-activity-item status-${escapeHtml(e.status || "ok")}">
        <span class="msg">${e.msg}</span>
        <span class="when">${formatRelativePast(e.when)}</span>
      </div>
    `).join("");
    return `
      <div class="bento-label"><span>Recent activity</span></div>
      <div class="bento-activity-list">${items}</div>
    `;
  }

  function renderQuickActionsCard() {
    // Only show actions the current role can actually perform server-side.
    const actions = [];
    if (hasPerm("edit_templates"))      actions.push({ key: "new-template",  icon: "＋",   label: "New template" });
    if (hasPerm("run_jackrabbit_sync")) actions.push({ key: "sync-jr",      icon: "⟳",   label: "Sync Jackrabbit" });
    if (hasPerm("edit_teachers"))       actions.push({ key: "new-teacher",   icon: "🧑‍🏫", label: "New teacher" });
    if (hasPerm("edit_teachers"))       actions.push({ key: "refresh-par",   icon: "↻",   label: "Refresh PAR links" });

    if (actions.length === 0) {
      return `
        <div class="bento-label"><span>Quick actions</span></div>
        <div class="bento-attention-empty">No quick actions available for your role.</div>
      `;
    }
    return `
      <div class="bento-label"><span>Quick actions</span></div>
      <div class="bento-qa-grid">
        ${actions.map((a) => `
          <button class="bento-qa-btn" data-qa="${a.key}"><span class="qa-icon">${a.icon}</span>${a.label}</button>
        `).join("")}
      </div>
    `;
  }

  /* ═════════════ T7a — PAR promotion: variant + event logging ═════════════
   *
   * Computes which copy/CTA the PAR card shows for the signed-in user,
   * and records impressions/clicks to par_promotion_events for funnel
   * analysis. Variant keys are intentionally stable strings (not enum)
   * so we can A/B new copy without a schema migration — see
   * `phase_t7a_par_promo_events.sql` for the table shape.
   *
   * Variant matrix (CLAUDE.md §4.26):
   *   unlinked_admin           — admin/manager/super_admin/viewer/null,
   *                              no par_person_id. Pitch: link your DK
   *                              email to PAR identity.
   *   unlinked_teacher         — teacher, no par_person_id. Pitch: try
   *                              PAR for your family schedule.
   *   linked_franchise_owner   — super_admin AND linked. Neutral "Open
   *                              PAR" — Sharon already pays via the
   *                              franchise org, no upsell needed.
   *   linked_admin             — admin/manager/viewer/null AND linked.
   *                              Neutral "Open PAR".
   *   linked_teacher           — teacher AND linked. Soft pitch: "Open
   *                              PAR — try the family planner."
   */
  function resolveParVariant() {
    const p = state.profile;
    const linked = !!p?.par_person_id;
    const role = p?.role || null;
    if (!linked) {
      return role === "teacher" ? "unlinked_teacher" : "unlinked_admin";
    }
    if (role === "super_admin") return "linked_franchise_owner";
    if (role === "teacher")     return "linked_teacher";
    return "linked_admin";
  }

  // Fire-and-forget logger. Failures are silent — losing a row is
  // strictly less bad than blocking a click on the user's PAR link.
  function logParPromoEvent(variantKey, eventKind, metadata) {
    const profileId = state.profile?.id;
    if (!profileId) return;
    sb.from("par_promotion_events").insert({
      profile_id:  profileId,
      variant_key: variantKey,
      event_kind:  eventKind,
      surface:     "home_bento_par_card",
      metadata:    metadata || {}
    }).then(({ error }) => {
      if (error) console.warn("par_promo log failed:", error.message);
    });
  }

  const PAR_VARIANT_COPY = {
    unlinked_admin: {
      href:  "https://get-on-par.com/?view=settings&tab=linked-accounts",
      icon:  "🔗",
      title: "Connect to PAR",
      sub:   "",
      tooltip: "Link this email on PAR to connect"
    },
    unlinked_teacher: {
      href:  "https://get-on-par.com/?view=settings&tab=linked-accounts",
      icon:  "🔗",
      title: "Link DK to PAR",
      sub:   "Try the family planner",
      tooltip: "Link this email on PAR — also great for your family schedule"
    },
    linked_franchise_owner: {
      href:  "https://get-on-par.com/",
      icon:  "👤",
      title: null,                  // null → use display name
      sub:   "",
      tooltip: "Open PAR in a new tab"
    },
    linked_admin: {
      href:  "https://get-on-par.com/",
      icon:  "👤",
      title: null,
      sub:   "",
      tooltip: "Open PAR in a new tab"
    },
    linked_teacher: {
      href:  "https://get-on-par.com/",
      icon:  "👤",
      title: null,
      sub:   "Try the family planner",
      tooltip: "Open PAR in a new tab"
    }
  };

  function renderParBridgeCard() {
    const variant = resolveParVariant();
    const copy = PAR_VARIANT_COPY[variant] || PAR_VARIANT_COPY.unlinked_admin;
    const p = state.profile;
    const titleText = copy.title
      || p?.par_display_name
      || p?.par_primary_email
      || "Open PAR";
    const subEl = copy.sub
      ? `<div class="par-sub">${escapeHtml(copy.sub)}</div>`
      : "";

    // Fire impression once per variant per session. Re-renders triggered
    // by realtime debounce or post-mutation reloadAll() won't re-fire.
    if (!state._parPromoImpressions.has(variant)) {
      state._parPromoImpressions.add(variant);
      logParPromoEvent(variant, "impression");
    }

    return `
      <div class="bento-label"><span>On PAR</span></div>
      <div class="bento-par-bridge">
        <a class="par-user" data-par-variant="${variant}"
           href="${copy.href}" target="_blank" rel="noopener"
           title="${escapeHtml(copy.tooltip)}">
          <span>${copy.icon}</span>
          <span class="par-name">
            ${escapeHtml(titleText)}
            ${subEl}
          </span>
          <span class="par-arrow">→</span>
        </a>
      </div>
    `;
  }

  function wireHomeCardEvents() {
    // Clicking a timeline item opens that class detail in the Classes tab
    $$("[data-open-class]", $("#bentoGrid")).forEach((el) => {
      el.onclick = () => {
        const classId = el.dataset.openClass;
        state.cState.openClassId = classId;
        go("classes");
      };
    });
    // Clicking an attention card jumps to the relevant tab
    $$("[data-go-tab]", $("#bentoGrid")).forEach((el) => {
      el.onclick = () => go(el.dataset.goTab);
    });
    // Quick actions
    $$("[data-qa]", $("#bentoGrid")).forEach((btn) => {
      btn.onclick = () => {
        const qa = btn.dataset.qa;
        if (qa === "new-template")   { go("templates"); openTemplateEditor(null); }
        else if (qa === "sync-jr")   { go("classes"); syncJackrabbit(); }
        else if (qa === "new-teacher"){ go("teachers"); openTeacherEditor(null); }
        else if (qa === "refresh-par"){ go("teachers"); refreshAllTeacherParLinks(); }
      };
    });
    // T3b: take-attendance CTAs on the teacher bento
    $$('[data-act="take-attendance"]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const cls = state.classes.find((c) => c.id === btn.dataset.classId);
        if (cls) openAttendanceModal(cls, isoDate(new Date()));
      };
    });
    // T3d: clock-in / clock-out CTAs on the teacher bento
    $$('[data-act="clock-in"]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); doClockIn(btn.dataset.classId); };
    });
    $$('[data-act="clock-out"]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); doClockOut(btn.dataset.clockId); };
    });
    // T5b: teacher curriculum card actions
    $$('[data-cur-view]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); openCurriculumViewer(btn.dataset.curView); };
    });
    $$('[data-cur-save-notes]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); saveTeacherCurriculumNotes(btn.dataset.curSaveNotes); };
    });
    // T7a: log PAR-card clicks before the new-tab navigation kicks off.
    // INSERT is fire-and-forget; target=_blank doesn't wait on it.
    $$('[data-par-variant]', $("#bentoGrid")).forEach((a) => {
      a.addEventListener("click", () => {
        logParPromoEvent(a.dataset.parVariant, "click");
      });
    });
  }

  /* ═════════════ Router ═════════════ */

  // Sidebar visibility: only on the two tabs where infographic access is useful
  const SIDEBAR_TABS = new Set(["templates"]);

  function go(tab) {
    // Route guard: if the role can't see this tab, fall back to home.
    if (!canSeeTab(tab)) tab = "home";
    state.router = tab;
    $$(".tab, .mtab[data-tab], .mobile-tools-item").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    $$(".tab-panel").forEach((p) => p.style.display = p.dataset.tab === tab ? "" : "none");
    $("#subBarTemplates").classList.toggle("hidden", tab !== "templates");
    const layout = document.querySelector(".layout");
    const sidebar = document.querySelector("aside.sidebar");
    const show = SIDEBAR_TABS.has(tab);
    if (layout)  layout.classList.toggle("no-sidebar", !show);
    if (sidebar) sidebar.style.display = show ? "" : "none";
  }

  /* ═════════════ Role visibility ═════════════
   * Apply role-based visibility to tabs and the top header buttons. Called
   * once on boot. Re-render of tab/page content lives in renderAll().
   */
  function applyRoleVisibility() {
    // Tab buttons (top bar + mobile bottom nav + mobile Tools sheet items)
    $$(".tab, .mtab[data-tab], .mobile-tools-item").forEach((t) => {
      t.style.display = canSeeTab(t.dataset.tab) ? "" : "none";
    });

    // Hide the Tools center slot when the role has no visible tool tabs.
    // The mobile bar uses justify-content: space-evenly, so the remaining
    // visible mtabs will center themselves naturally.
    const toolsBtn = $("#mobileToolsBtn");
    if (toolsBtn) {
      const anyTool = ["templates","schools","subrequests","events","inventory","curriculum","reports","users"].some(canSeeTab);
      toolsBtn.style.display = anyTool ? "" : "none";
    }

    // Per-tab header action buttons
    const newTplBtn         = $("#newTemplateBtn");
    const newClassBtn      = $("#newClassBtn");
    const syncJrBtn        = $("#syncJackrabbitBtn");
    const newTeacherBtn    = $("#newTeacherBtn");
    const refreshParBtn    = $("#refreshParLinksBtn");
    const newCategoryBtn   = $("#newCategoryBtn");
    const manageCategoriesBtn = $("#manageCategoriesBtn");
    const manageInfographicsBtn = $("#manageInfographicsBtn");
    const newInfographicBtn = $("#newInfographicBtn");

    if (newTplBtn)         newTplBtn.style.display         = hasPerm("edit_templates")    ? "" : "none";
    if (newClassBtn)       newClassBtn.style.display       = hasPerm("edit_classes")       ? "" : "none";
    if (syncJrBtn)         syncJrBtn.style.display         = hasPerm("run_jackrabbit_sync") ? "" : "none";
    if (newTeacherBtn)     newTeacherBtn.style.display     = hasPerm("edit_teachers")      ? "" : "none";
    if (refreshParBtn)     refreshParBtn.style.display     = hasPerm("edit_teachers")      ? "" : "none";
    if (newCategoryBtn)    newCategoryBtn.style.display    = hasPerm("edit_categories")    ? "" : "none";
    // "Manage categories" is the modal-launcher in the Templates tab head;
    // visible to anyone who can edit categories — bundled with edit_templates
    // for a clean Templates-tab affordance, even though the modal itself
    // is the same single source of truth.
    if (manageCategoriesBtn) manageCategoriesBtn.style.display = hasPerm("edit_categories") ? "" : "none";
    // "Manage infographics" is the modal-launcher in the Templates tab head;
    // visible to anyone who can edit infographics (same gate as the
    // upload button now living inside the modal).
    if (manageInfographicsBtn) manageInfographicsBtn.style.display = hasPerm("edit_infographics") ? "" : "none";
    if (newInfographicBtn) newInfographicBtn.style.display = hasPerm("edit_infographics")  ? "" : "none";

    const newCurriculumBtn = $("#newCurriculumBtn");
    if (newCurriculumBtn) newCurriculumBtn.style.display = hasPerm("edit_curriculum") ? "" : "none";

    // "Invite user" is admin+ only — creating teacher invitations calls
    // PAR's spoke-create-org-invitation and is out of scope for managers.
    const inviteUserBtn = $("#inviteUserBtn");
    if (inviteUserBtn) inviteUserBtn.style.display = isAdminOrAbove() ? "" : "none";

    // Closures: managers can manage them in T1.5 (academic-calendar work).
    const schedManageClosures = $("#schedManageClosures");
    if (schedManageClosures) schedManageClosures.style.display = hasPerm("edit_closures") ? "" : "none";
  }

  /* ═════════════ SCHEDULE (Day / Week / Month) ═════════════
   *
   * Dedicated tab with a mode toggle. Renders classes + teacher overlays +
   * closures across Day, Week, and Month projections.
   *
   * - Admin+ sees everything; teacher sees only classes they're assigned to.
   * - "Only my classes" toggle lets admins filter to their own assignments too.
   * - Teacher color assignment is a deterministic hash of teacher.id -> hue.
   * - Closures overlay visually mute a day; don't remove class blocks (we want
   *   admins to see what was supposed to run so they can communicate cancellation).
   */

  const SCHED_HOUR_START = 8;    // earliest rendered hour on week view
  const SCHED_HOUR_END   = 21;   // latest (exclusive — renders up to 20:xx)
  const SCHED_HOUR_PX    = 42;   // pixels per hour on week view

  function isoDateFromString(s) {
    // s is "YYYY-MM-DD" — return a Date at local midnight
    const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function startOfWeek(d) {
    // Sunday-start week
    const r = new Date(d); r.setHours(0,0,0,0);
    r.setDate(r.getDate() - r.getDay());
    return r;
  }
  function startOfMonth(d) {
    const r = new Date(d); r.setHours(0,0,0,0); r.setDate(1); return r;
  }
  function endOfMonth(d) {
    const r = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    r.setHours(23,59,59,999); return r;
  }

  // Deterministic hue-per-teacher from teacher_id. Produces HSL colors
  // spread evenly-ish across the wheel, at constant saturation/luma so
  // overlays read consistently on a dark background.
  function teacherHue(teacherId) {
    if (!teacherId) return 210;
    let h = 0;
    for (let i = 0; i < teacherId.length; i++) h = (h * 31 + teacherId.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function teacherColor(teacherId, alpha) {
    const hue = teacherHue(teacherId);
    return `hsla(${hue}, 62%, 58%, ${alpha == null ? 1 : alpha})`;
  }

  // Return the teacher row (or null) primary-assigned to a class.
  function primaryTeacherObj(classId) {
    const ct = state.classTeachers.find((x) => x.class_id === classId && x.role === "primary");
    if (ct) return state.teachers.find((t) => t.id === ct.teacher_id);
    const any = state.classTeachers.find((x) => x.class_id === classId);
    return any ? state.teachers.find((t) => t.id === any.teacher_id) : null;
  }

  // Two-letter initials from a teacher row. First+last for 2+ word names,
  // first two letters otherwise. Empty string if no name.
  function teacherInitials(teacher) {
    const name = (teacher?.full_name || "").trim();
    if (!name) return "";
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  // All teachers assigned to a class, primary first then subs/others.
  function teachersForClass(classId) {
    const assignments = state.classTeachers
      .filter((x) => x.class_id === classId)
      .sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : 0));
    return assignments
      .map((a) => state.teachers.find((t) => t.id === a.teacher_id))
      .filter(Boolean);
  }

  // "JL" for a primary-only class; "JL/MS" when a sub is also assigned.
  function classInitialsString(classId) {
    return teachersForClass(classId).map(teacherInitials).filter(Boolean).join("/");
  }

  // Return classes that should appear on a given date after applying
  // filters: test-excluded, active-only, onlyMine filter, teacher role
  // always filters to their own assignments.
  function classesForDate(date) {
    const role = currentRole();
    const isTeacher = role === "teacher";
    const me = isTeacher ? mySignedInTeacher() : null;
    const myId = me?.id || null;

    const onlyMine = state.sState.onlyMine || isTeacher;
    const myAssignedClassIds = onlyMine
      ? new Set(state.classTeachers.filter((ct) => ct.teacher_id === myId).map((ct) => ct.class_id))
      : null;

    return state.classes.filter((c) => {
      if (c.is_test && !state.cState.showTest) return false;
      if (c.active === false) return false;
      if (!classRunsOnDay(c, date)) return false;
      if (myAssignedClassIds && !myAssignedClassIds.has(c.id)) return false;
      return true;
    });
  }

  function closuresForDate(date) {
    const iso = isoDate(date);
    return state.closures.filter((c) => c.date === iso);
  }

  /* ═════════════ EVENTS (T9) helpers ═════════════
   *
   * Events are explicit-date special items (free classes, trainings, promo
   * events). They live in `state.events` with multi-staff in
   * `state.eventStaff`. The schedule renders them alongside classes; the
   * Events tab is the dedicated CRUD surface.
   */

  const EVENT_KIND_META = {
    free_class:  { label: "Free class",   hue: 170, abbr: "FC" },
    training:    { label: "Training",     hue: 270, abbr: "TR" },
    promotional: { label: "Promo",        hue: 38,  abbr: "PR" },
    other:       { label: "Event",        hue: 210, abbr: "EV" }
  };
  const EVENT_KIND_OPTIONS = [
    { value: "free_class",  label: "Free class" },
    { value: "training",    label: "Training" },
    { value: "promotional", label: "Promotional" },
    { value: "other",       label: "Other" }
  ];
  function eventKindMeta(k) { return EVENT_KIND_META[k] || EVENT_KIND_META.other; }
  function eventKindLabel(k) { return eventKindMeta(k).label; }
  function eventKindHue(k)   { return eventKindMeta(k).hue; }
  function eventKindAbbr(k)  { return eventKindMeta(k).abbr; }

  function eventStaffFor(eventId) {
    return state.eventStaff.filter((es) => es.event_id === eventId);
  }
  function eventStaffTeachersFor(eventId) {
    const ids = new Set(eventStaffFor(eventId).map((es) => es.teacher_id));
    return state.teachers.filter((t) => ids.has(t.id));
  }
  function eventStaffInitials(eventId) {
    return eventStaffTeachersFor(eventId)
      .map((t) => (t.full_name || "").trim().split(/\s+/).map((p) => p[0] || "").join("").slice(0, 2).toUpperCase())
      .filter(Boolean)
      .join("/");
  }

  // Returns events whose start..end window covers `date`. Multi-day events
  // (training Sat+Sun) appear on every covered day. Teachers and the
  // onlyMine toggle filter to events the signed-in teacher is staffed on.
  function eventsForDate(date) {
    const role = currentRole();
    const isTeacher = role === "teacher";
    const me = isTeacher ? mySignedInTeacher() : null;
    const myId = me?.id || null;
    const onlyMine = state.sState.onlyMine || isTeacher;

    const iso = isoDate(date);
    const myStaffedIds = onlyMine
      ? new Set(state.eventStaff.filter((es) => es.teacher_id === myId).map((es) => es.event_id))
      : null;

    return state.events.filter((ev) => {
      const startIso = isoDate(new Date(ev.starts_at));
      const endIso   = isoDate(new Date(ev.ends_at));
      if (iso < startIso || iso > endIso) return false;
      if (myStaffedIds && !myStaffedIds.has(ev.id)) return false;
      return true;
    });
  }

  // For Day-view chronological merging: returns the start time on `date`
  // for an event. Multi-day events that started on a prior day return the
  // start of `date` (00:00) so they sort to the top.
  function eventStartTimeOn(ev, date) {
    const start = new Date(ev.starts_at);
    const iso = isoDate(date);
    if (isoDate(start) === iso) return start;
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function eventEndTimeOn(ev, date) {
    const end = new Date(ev.ends_at);
    const iso = isoDate(date);
    if (isoDate(end) === iso) return end;
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  function renderScheduleTab() {
    const view = $("#schedView");
    const label = $("#schedLabel");
    if (!view || !label) return;

    const anchor = isoDateFromString(state.sState.anchor);
    const mode = state.sState.mode;

    // Mode toggle active state
    $$(".sched-mode").forEach((b) => {
      b.classList.toggle("active", b.dataset.schedMode === mode);
    });

    // Only-mine toggle: reflect current state; force-on and disable for teachers
    const onlyMineEl = $("#schedOnlyMine");
    if (onlyMineEl) {
      if (isRole("teacher")) {
        onlyMineEl.checked = true;
        onlyMineEl.disabled = true;
      } else {
        onlyMineEl.checked = !!state.sState.onlyMine;
        onlyMineEl.disabled = false;
      }
    }

    // Header label + body rendering
    if (mode === "day") {
      label.textContent = anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      renderScheduleDayView(view, anchor);
    } else if (mode === "week") {
      const weekStart = startOfWeek(anchor);
      const weekEnd   = addDays(weekStart, 6);
      label.textContent = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
      renderScheduleWeekView(view, weekStart);
    } else if (mode === "month") {
      label.textContent = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      renderScheduleMonthView(view, anchor);
    }
  }

  function renderScheduleDayView(view, date) {
    const classItems = classesForDate(date)
      .map((c) => ({ kind: "class", cls: c, startAt: classStartTimeOn(c, date), teacher: primaryTeacherObj(c.id) }));
    const eventItems = eventsForDate(date)
      .map((ev) => ({ kind: "event", ev, startAt: eventStartTimeOn(ev, date), endAt: eventEndTimeOn(ev, date) }));
    const items = [...classItems, ...eventItems]
      .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));
    const closures = closuresForDate(date);

    if (!items.length && !closures.length) {
      view.innerHTML = `
        <div class="sched-empty">
          <p>Nothing scheduled on ${escapeHtml(date.toLocaleDateString(undefined, { weekday: "long" }))}.</p>
          <p class="sched-empty-sub">Use the navigation arrows to browse other days.</p>
        </div>
      `;
      return;
    }

    const closureHtml = closures.map((cl) => `
      <div class="sched-closure-card">
        <div class="sched-closure-label">🗓 ${escapeHtml(cl.label)}</div>
        ${cl.note ? `<div class="sched-closure-note">${escapeHtml(cl.note)}</div>` : ""}
      </div>
    `).join("");

    const now = new Date();
    const isToday = isoDate(date) === isoDate(now);
    // Find the next-upcoming index across all items for the "upcoming" dot.
    const nextIdx = isToday
      ? items.findIndex((x) => x.startAt && x.startAt > now)
      : -1;
    const itemsHtml = items.map((item, i) => {
      if (item.kind === "event") {
        const { ev, startAt, endAt } = item;
        const isPast = isToday && endAt && endAt < now;
        const isNext = i === nextIdx;
        const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
        const hue = eventKindHue(ev.kind);
        const showLine = i < items.length - 1;
        const timeStr = startAt
          ? `${startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${endAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "—";
        const staff = eventStaffTeachersFor(ev.id).map((t) => t.full_name.split(/\s+/)[0]).join(", ");
        const sch = ev.school_id ? state.schools.find((s) => s.id === ev.school_id) : null;
        const loc = sch ? sch.name : (ev.location || "");
        const cancelTag = ev.is_cancelled ? '<span class="sched-cancelled-badge" style="margin-left:6px">cancelled</span>' : "";
        return `
          <div class="sched-day-item sched-day-event${ev.is_cancelled ? " sched-cancelled" : ""}" data-open-event="${escapeHtml(ev.id)}" ${isPast ? 'style="opacity:.55"' : ""}>
            <div class="sched-day-spine">
              <div class="sched-day-dot ${dotClass}" style="background:hsl(${hue}, 62%, 58%)"></div>
              ${showLine ? '<div class="sched-day-line"></div>' : ""}
            </div>
            <div class="sched-day-body" style="border-left:3px solid hsla(${hue}, 62%, 58%, .55)">
              <div class="sched-day-time">${escapeHtml(timeStr)} <span class="ev-kind-chip" style="background:hsla(${hue},62%,58%,.18); color:hsl(${hue},62%,72%); border:1px solid hsla(${hue},62%,58%,.35)">★ ${escapeHtml(eventKindLabel(ev.kind))}</span>${cancelTag}</div>
              <div class="sched-day-title">${escapeHtml(ev.title)}</div>
              <div class="sched-day-sub">
                ${loc ? escapeHtml(loc) : ""}
                ${staff ? `${loc ? " · " : ""}<span style="color:hsl(${hue}, 62%, 68%)">${escapeHtml(staff)}</span>` : ""}
              </div>
            </div>
          </div>
        `;
      }
      const { cls, startAt, teacher } = item;
      const isPast = isToday && startAt && startAt < now;
      const isNext = i === nextIdx;
      const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
      const timeStr = startAt ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : (cls.times || "—");
      const showLine = i < items.length - 1;
      const hue = teacher ? teacherHue(teacher.id) : 210;
      return `
        <div class="sched-day-item" data-open-class="${escapeHtml(cls.id)}" ${isPast ? 'style="opacity:.55"' : ""}>
          <div class="sched-day-spine">
            <div class="sched-day-dot ${dotClass}" style="background:hsl(${hue}, 62%, 58%)"></div>
            ${showLine ? '<div class="sched-day-line"></div>' : ""}
          </div>
          <div class="sched-day-body" style="border-left:3px solid hsla(${hue}, 62%, 58%, .55)">
            <div class="sched-day-time">${escapeHtml(timeStr)}</div>
            <div class="sched-day-title">${escapeHtml(cls.name)}</div>
            <div class="sched-day-sub">
              ${cls.location ? escapeHtml(cls.location) : ""}
              ${teacher ? `${cls.location ? " · " : ""}<span style="color:hsl(${hue}, 62%, 68%)">${escapeHtml(teacher.full_name)}</span>` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");

    view.innerHTML = `
      ${closureHtml}
      <div class="sched-day-list">${itemsHtml}</div>
    `;
    wireScheduleClassClicks();
  }

  function renderScheduleWeekView(view, weekStart) {
    // Build a 7-day slice; for each day, gather class+time+teacher tuples.
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const classes = classesForDate(d)
        .map((c) => ({ cls: c, startAt: classStartTimeOn(c, d), teacher: primaryTeacherObj(c.id) }))
        .filter((x) => x.startAt)  // drop classes with unparseable times
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      const events = eventsForDate(d)
        .map((ev) => ({ ev, startAt: eventStartTimeOn(ev, d), endAt: eventEndTimeOn(ev, d) }));
      days.push({ date: d, classes, events, closures: closuresForDate(d) });
    }

    const hourRows = [];
    for (let h = SCHED_HOUR_START; h < SCHED_HOUR_END; h++) {
      const label = h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
      hourRows.push(`<div class="sched-week-hour"><span>${label}</span></div>`);
    }

    const dowHeaders = [];
    const todayIso = isoDate(new Date());
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const iso = isoDate(d);
      const isToday = iso === todayIso;
      const dow = d.toLocaleDateString(undefined, { weekday: "short" });
      const dn  = d.getDate();
      dowHeaders.push(`
        <div class="sched-week-daycol-head${isToday ? " today" : ""}" data-open-day="${iso}">
          <span class="dow">${escapeHtml(dow)}</span>
          <span class="dn">${dn}</span>
        </div>
      `);
    }

    const dayColumns = days.map((d) => {
      const iso = isoDate(d.date);
      const isToday = iso === todayIso;
      const isClosed = d.closures.length > 0;
      const closureLabel = isClosed
        ? `<div class="sched-week-closure-pill" title="${escapeHtml(d.closures.map(c => c.label).join(" · "))}">🗓 ${escapeHtml(d.closures[0].label)}${d.closures.length > 1 ? ` +${d.closures.length - 1}` : ""}</div>`
        : "";

      const totalHeight = (SCHED_HOUR_END - SCHED_HOUR_START) * SCHED_HOUR_PX;
      const dayIso = isoDate(d.date);
      const blocks = d.classes.map(({ cls, startAt, teacher }) => {
        const hoursFromStart = startAt.getHours() + startAt.getMinutes() / 60 - SCHED_HOUR_START;
        if (hoursFromStart < 0 || hoursFromStart >= (SCHED_HOUR_END - SCHED_HOUR_START)) return "";
        const topPx = Math.max(0, hoursFromStart * SCHED_HOUR_PX);
        const durationMin = parseClassDurationMinutes(cls);
        const heightPx = Math.max(24, (durationMin / 60) * SCHED_HOUR_PX);
        const hue = teacher ? teacherHue(teacher.id) : 210;
        const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const subReq = activeSubRequestForSession(cls.id, dayIso);
        const subBadge = subReq
          ? `<span class="sched-sub-badge sched-sub-${escapeHtml(subReq.status)}" title="Sub request: ${escapeHtml(subReq.status)}">${subReq.status === "open" ? "🔄" : "✓"}</span>`
          : "";
        const cancellation = classCancellationFor(cls.id, dayIso);
        const cancelClass = cancellation ? " sched-cancelled" : "";
        const cancelBadge = cancellation ? `<span class="sched-sub-badge sched-cancelled-badge" title="Class cancelled${cancellation.reason ? ": " + cancellation.reason : ""}">✗</span>` : "";
        return `
          <div class="sched-week-block${cancelClass}" data-open-class="${escapeHtml(cls.id)}"
               style="top:${topPx}px;height:${heightPx}px;
                      background:hsla(${hue},62%,58%,.22);
                      border-left:3px solid hsl(${hue},62%,58%);">
            <div class="sched-week-block-time">${escapeHtml(timeStr)}${cancelBadge}${subBadge}</div>
            <div class="sched-week-block-title">${escapeHtml(cls.name)}</div>
            ${teacher ? `<div class="sched-week-block-sub">${escapeHtml(teacher.full_name.split(/\s+/)[0])}</div>` : ""}
          </div>
        `;
      }).join("");

      const eventBlocks = d.events.map(({ ev, startAt, endAt }) => {
        const hoursFromStart = startAt.getHours() + startAt.getMinutes() / 60 - SCHED_HOUR_START;
        if (hoursFromStart >= (SCHED_HOUR_END - SCHED_HOUR_START)) return "";
        const topPx = Math.max(0, hoursFromStart * SCHED_HOUR_PX);
        const durationMin = Math.max(15, (endAt - startAt) / 60000);
        const heightPx = Math.max(24, (durationMin / 60) * SCHED_HOUR_PX);
        const hue = eventKindHue(ev.kind);
        const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const initials = eventStaffInitials(ev.id);
        const cancelClass = ev.is_cancelled ? " sched-cancelled" : "";
        return `
          <div class="sched-week-block sched-week-event${cancelClass}" data-open-event="${escapeHtml(ev.id)}"
               style="top:${topPx}px;height:${heightPx}px;
                      background:hsla(${hue},62%,58%,.22);
                      border-left:3px dashed hsl(${hue},62%,58%);">
            <div class="sched-week-block-time">★ ${escapeHtml(timeStr)}</div>
            <div class="sched-week-block-title">${escapeHtml(ev.title)}</div>
            ${initials ? `<div class="sched-week-block-sub">${escapeHtml(initials)}</div>` : ""}
          </div>
        `;
      }).join("");

      return `
        <div class="sched-week-daycol${isToday ? " today" : ""}${isClosed ? " closed" : ""}"
             style="height:${totalHeight}px">
          ${closureLabel}
          ${blocks}
          ${eventBlocks}
        </div>
      `;
    }).join("");

    view.innerHTML = `
      <div class="sched-week">
        <div class="sched-week-headrow">
          <div class="sched-week-timecol-head"></div>
          ${dowHeaders.join("")}
        </div>
        <div class="sched-week-body">
          <div class="sched-week-timecol">${hourRows.join("")}</div>
          <div class="sched-week-grid">${dayColumns}</div>
        </div>
      </div>
    `;
    wireScheduleClassClicks();
  }

  // Parse a class's duration (in minutes) from the `times` field like
  // "3:00 PM - 3:45 PM". Falls back to 60 min.
  function parseClassDurationMinutes(cls) {
    const src = cls?.times || cls?.day_time;
    if (!src) return 60;
    const m = String(src).match(/(\d{1,2}):(\d{2})\s*([AP]M)\s*[-–]\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return 60;
    const toMin = (h, mm, ap) => {
      let hh = parseInt(h, 10) % 12;
      if (ap.toUpperCase() === "PM") hh += 12;
      return hh * 60 + parseInt(mm, 10);
    };
    const s = toMin(m[1], m[2], m[3]);
    const e = toMin(m[4], m[5], m[6]);
    return Math.max(15, e - s);
  }

  function renderScheduleMonthView(view, anchor) {
    const monthStart = startOfMonth(anchor);
    const monthEnd   = endOfMonth(anchor);
    // Grid starts on the Sunday on-or-before the 1st
    const gridStart = startOfWeek(monthStart);
    // Always render 6 rows of 7 cells = 42 cells for a stable layout.
    const todayIso = isoDate(new Date());

    const dowHeaders = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(
      (d) => `<div class="sched-month-dow">${d}</div>`
    ).join("");

    const cells = [];
    const MAX_ROWS = 3;
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const iso = isoDate(d);
      const inMonth = d.getMonth() === anchor.getMonth();
      const isToday = iso === todayIso;
      const closures = closuresForDate(d);
      const classRows = classesForDate(d)
        .map((c) => ({ kind: "class", cls: c, startAt: classStartTimeOn(c, d), teacher: primaryTeacherObj(c.id) }));
      const eventRows = eventsForDate(d)
        .map((ev) => ({ kind: "event", ev, startAt: eventStartTimeOn(ev, d) }));
      const merged = [...classRows, ...eventRows]
        .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));

      const visible = merged.slice(0, MAX_ROWS);
      const overflow = Math.max(0, merged.length - MAX_ROWS);

      const rowsHtml = visible.map((item) => {
        if (item.kind === "event") {
          const { ev, startAt } = item;
          const hue = eventKindHue(ev.kind);
          const timeStr = startAt
            ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(" ", "")
            : "";
          const initials = eventStaffInitials(ev.id);
          const cancelClass = ev.is_cancelled ? " sched-cancelled" : "";
          const titleTxt = [
            "★ " + ev.title,
            "— " + eventKindLabel(ev.kind),
            timeStr ? "at " + timeStr : "",
            ev.is_cancelled ? "(cancelled)" : ""
          ].filter(Boolean).join(" ");
          return `
            <div class="sched-month-row sched-month-event${cancelClass}" data-open-event="${escapeHtml(ev.id)}"
                 style="border-left-color:hsl(${hue}, 62%, 58%); border-left-style:dashed"
                 title="${escapeHtml(titleTxt)}">
              ${timeStr ? `<span class="sched-month-row-time">${escapeHtml(timeStr)}</span>` : ""}
              <span class="sched-month-row-name">★ ${escapeHtml(ev.title)}</span>
              ${initials ? `<span class="sched-month-row-initials">${escapeHtml(initials)}</span>` : ""}
            </div>
          `;
        }
        const { cls, startAt, teacher } = item;
        const hue = teacher ? teacherHue(teacher.id) : 210;
        const timeStr = startAt
          ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(" ", "")
          : "";
        const initials = classInitialsString(cls.id);
        const subReq = activeSubRequestForSession(cls.id, iso);
        const subBadge = subReq
          ? `<span class="sched-sub-badge sched-sub-${escapeHtml(subReq.status)}" title="Sub request: ${escapeHtml(subReq.status)}">${subReq.status === "open" ? "🔄" : "✓"}</span>`
          : "";
        const cancellation = classCancellationFor(cls.id, iso);
        const cancelClass = cancellation ? " sched-cancelled" : "";
        const cancelBadge = cancellation ? `<span class="sched-sub-badge sched-cancelled-badge" title="Class cancelled${cancellation.reason ? ": " + cancellation.reason : ""}">✗</span>` : "";
        const titleTxt = [
          cls.name,
          initials ? "— " + initials : "",
          timeStr ? "at " + timeStr : "",
          cancellation ? "(cancelled)" : (subReq ? `(sub ${subReq.status})` : ""),
        ].filter(Boolean).join(" ");
        return `
          <div class="sched-month-row${cancelClass}" data-open-class="${escapeHtml(cls.id)}"
               style="border-left-color:hsl(${hue}, 62%, 58%)"
               title="${escapeHtml(titleTxt)}">
            ${timeStr ? `<span class="sched-month-row-time">${escapeHtml(timeStr)}</span>` : ""}
            <span class="sched-month-row-name">${escapeHtml(cls.name)}</span>
            ${cancelBadge}
            ${subBadge}
            ${initials ? `<span class="sched-month-row-initials">${escapeHtml(initials)}</span>` : ""}
          </div>
        `;
      }).join("");

      const overflowHtml = overflow > 0
        ? `<div class="sched-month-row-more">+${overflow} more</div>`
        : "";

      // Closure treatment: red for full-day closures. When the academic-
      // calendar schema adds a short-day type, emit `closed-short` instead
      // of `closed-full` to get the yellow hatch.
      const closureClass = closures.length ? " closed-full" : "";
      const closureHtml = closures.length
        ? `<div class="sched-month-closure" title="${escapeHtml(closures.map(c => c.label).join(" · "))}">${escapeHtml(closures[0].label)}</div>`
        : "";

      cells.push(`
        <div class="sched-month-cell${inMonth ? "" : " off"}${isToday ? " today" : ""}${closureClass}"
             data-open-day="${iso}">
          <div class="sched-month-head">
            <div class="sched-month-dn">${d.getDate()}</div>
            ${merged.length ? `<div class="sched-month-count">${merged.length}</div>` : ""}
          </div>
          ${closureHtml}
          <div class="sched-month-rows">
            ${rowsHtml}
            ${overflowHtml}
          </div>
        </div>
      `);
    }

    view.innerHTML = `
      <div class="sched-month">
        <div class="sched-month-dows">${dowHeaders}</div>
        <div class="sched-month-grid">${cells.join("")}</div>
        <div class="sched-month-legend">
          Tap a class to open it, or tap a day to see its full schedule. The colored stripe on each row is the primary teacher.
        </div>
      </div>
    `;
    wireScheduleClassClicks();
  }

  /* ═════════════ Closures management ═════════════ */

  function openClosuresModal() {
    renderClosuresList();
    // Default date to the current anchor for convenience
    const d = $("#closureDate");
    if (d && !d.value) d.value = state.sState.anchor;
    $("#closuresOverlay").classList.add("open");
    setTimeout(() => $("#closureLabel").focus(), 40);
  }
  function closeClosuresModal() { $("#closuresOverlay").classList.remove("open"); }

  function renderClosuresList() {
    const wrap = $("#closureList");
    if (!wrap) return;
    if (!state.closures.length) {
      wrap.innerHTML = `<div class="closure-empty">No closures yet.</div>`;
      return;
    }
    wrap.innerHTML = state.closures
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => `
        <div class="closure-row" data-id="${escapeHtml(c.id)}">
          <div class="closure-row-date">${escapeHtml(c.date)}</div>
          <div class="closure-row-label">${escapeHtml(c.label)}</div>
          <button class="btn ghost small" data-act="del-closure" data-id="${escapeHtml(c.id)}" title="Remove">✕</button>
        </div>
      `).join("");
    $$('[data-act="del-closure"]', wrap).forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.id;
        const { error } = await sb.from("closures").delete().eq("id", id);
        if (error) return showToast(error.message, "error");
        await reloadAll(); renderAll(); renderClosuresList();
        showToast("Closure removed", "success");
      };
    });
  }

  async function addClosure() {
    const date = $("#closureDate").value;
    const label = $("#closureLabel").value.trim();
    if (!date || !label) { showToast("Date and label are required", "error"); return; }
    const { error } = await sb.from("closures").insert({ date, label });
    if (error) { showToast(error.message, "error"); return; }
    $("#closureLabel").value = "";
    await reloadAll(); renderAll(); renderClosuresList();
    showToast("Closure added", "success");
  }

  /* ═════════════ Schedule nav + wiring ═════════════ */

  function schedNav(offset) {
    const d = isoDateFromString(state.sState.anchor);
    if (state.sState.mode === "day") state.sState.anchor = isoDate(addDays(d, offset));
    else if (state.sState.mode === "week") state.sState.anchor = isoDate(addDays(d, offset * 7));
    else if (state.sState.mode === "month") {
      const r = new Date(d.getFullYear(), d.getMonth() + offset, 1);
      state.sState.anchor = isoDate(r);
    }
    renderScheduleTab();
  }

  function wireScheduleClassClicks() {
    $$("[data-open-class]", $("#schedView")).forEach((el) => {
      el.onclick = (e) => {
        // Month cells carry data-open-day and class rows sit inside them;
        // stop propagation so the cell handler doesn't also fire.
        e.stopPropagation();
        const id = el.dataset.openClass;
        state.cState.openClassId = id;
        go("classes");
      };
    });
    $$("[data-open-event]", $("#schedView")).forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        openEventEditor(el.dataset.openEvent);
      };
    });
    $$("[data-open-day]", $("#schedView")).forEach((el) => {
      el.onclick = () => {
        state.sState.anchor = el.dataset.openDay;
        state.sState.mode = "day";
        renderScheduleTab();
      };
    });
  }

  /* ═════════════ TEMPLATES ═════════════ */

  function renderCategoryChips() {
    const wrap = $("#categoryChips");
    wrap.innerHTML = "";
    [{ id: "all", label: "All" }].concat(state.categories).forEach((cat) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (state.tState.category === cat.id ? " active" : "");
      chip.textContent = cat.label;
      chip.onclick = () => { state.tState.category = cat.id; renderCategoryChips(); renderTemplates(); };
      wrap.appendChild(chip);
    });
  }

  function matchesQuery(t, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (
      (t.title || "").toLowerCase().includes(q) ||
      (t.body  || "").toLowerCase().includes(q) ||
      (t.tags  || []).some((tag) => tag.toLowerCase().includes(q)) ||
      (t.notes || "").toLowerCase().includes(q)
    );
  }

  function renderTemplates() {
    const cardsEl = $("#cards");
    const metaEl  = $("#resultsMeta");
    const filtered = state.templates.filter((t) => {
      if (state.tState.category !== "all" && t.category_id !== state.tState.category) return false;
      return matchesQuery(t, state.tState.query);
    });
    metaEl.textContent = filtered.length + (filtered.length === 1 ? " template" : " templates");
    cardsEl.innerHTML = "";
    if (filtered.length === 0) {
      cardsEl.innerHTML = '<div class="empty">No templates match. Clear the search or pick a different category — or click <b>＋ New template</b> to add one.</div>';
      return;
    }
    filtered.forEach((tpl) => cardsEl.appendChild(renderCard(tpl)));
  }

  function renderCard(tpl) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = tpl.id;

    const categoryLabel = (state.categories.find((c) => c.id === tpl.category_id) || {}).label || "—";
    const tagLine = (tpl.tags || []).slice(0, 4).map((t) => "#" + t).join(" ");

    const showEditBtns = hasPerm("edit_templates");
    card.innerHTML = `
      <div class="card-head">
        <div style="flex:1">
          <h3 class="card-title"></h3>
          <div class="card-meta">
            <span class="badge"></span>
            <span class="tag-line"></span>
          </div>
        </div>
        <div class="card-actions-head">
          ${showEditBtns ? `
            <button class="btn small ghost" data-act="edit" title="Edit template">✎</button>
            <button class="btn small ghost" data-act="dup" title="Duplicate template">⎘</button>
          ` : ""}
          <div class="expand-arrow">▸</div>
        </div>
      </div>
      <div class="card-body"></div>
    `;
    $(".card-title", card).textContent = tpl.title;
    $(".badge", card).textContent = categoryLabel;
    $(".tag-line", card).textContent = tagLine;

    if (showEditBtns) {
      $('[data-act="edit"]', card).onclick = (e) => { e.stopPropagation(); openTemplateEditor(tpl.id); };
      $('[data-act="dup"]',  card).onclick = (e) => { e.stopPropagation(); duplicateTemplate(tpl.id); };
    }
    $(".card-head", card).onclick = () => {
      const willOpen = !card.classList.contains("open");
      card.classList.toggle("open");
      if (willOpen) renderBody(card, tpl);
    };
    return card;
  }

  function renderBody(card, tpl) {
    const bodyEl = $(".card-body", card);
    bodyEl.innerHTML = "";
    const vars = (tpl.variables && tpl.variables.length) ? tpl.variables : detectVars(tpl.body);
    const filled = state.tState.filled[tpl.id] || {};

    /* Class picker */
    const classBound = ["class_name", "day_time", "location", "registration_link"];
    const usesClass = vars.some((v) => classBound.includes(v));
    if (usesClass && state.classes.length) {
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.innerHTML = `
        <div class="panel-label">Which class? <span style="font-weight:400;text-transform:none;color:var(--ink-dim)">(auto-fills class_name, day_time, location, registration_link)</span></div>
        <div class="class-picker">
          <select><option value="">— none —</option></select>
          <button class="btn small" data-act="clear-class">Clear</button>
        </div>
      `;
      const sel = $("select", panel);
      state.classes.filter((c) => c.active !== false).forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name + " · " + (c.day_time || "—");
        sel.appendChild(opt);
      });
      sel.value = filled.__class || "";
      sel.onchange = () => {
        state.tState.filled[tpl.id] = state.tState.filled[tpl.id] || {};
        state.tState.filled[tpl.id].__class = sel.value;
        const c = state.classes.find((x) => x.id === sel.value);
        if (c) {
          if (vars.includes("class_name"))        state.tState.filled[tpl.id].class_name = c.name;
          if (vars.includes("day_time"))          state.tState.filled[tpl.id].day_time = c.day_time;
          if (vars.includes("location"))          state.tState.filled[tpl.id].location = c.location;
          if (vars.includes("registration_link")) state.tState.filled[tpl.id].registration_link = c.registration_link;
        }
        renderBody(card, tpl);
      };
      $('[data-act="clear-class"]', panel).onclick = () => {
        delete (state.tState.filled[tpl.id] || {}).__class;
        classBound.forEach((k) => { if (state.tState.filled[tpl.id]) delete state.tState.filled[tpl.id][k]; });
        renderBody(card, tpl);
      };
      bodyEl.appendChild(panel);

      // Suggested infographics for the currently-picked class
      const pickedClassId = (state.tState.filled[tpl.id] || {}).__class;
      if (pickedClassId) {
        const linkedIgIds = state.classInfographics
          .filter((ci) => ci.class_id === pickedClassId)
          .map((ci) => ci.infographic_id);
        const linkedIgs = linkedIgIds
          .map((id) => state.infographics.find((ig) => ig.id === id))
          .filter(Boolean);
        if (linkedIgs.length) {
          const row = document.createElement("div");
          row.innerHTML = `
            <div class="panel-label" style="margin-bottom:6px;margin-top:-4px">Suggested for this class</div>
            <div class="suggested-ig-row"></div>
          `;
          const igRow = $(".suggested-ig-row", row);
          linkedIgs.forEach((ig) => {
            const chip = document.createElement("button");
            chip.className = "ig-suggestion";
            chip.type = "button";
            chip.innerHTML = `🖼 ${escapeHtml(ig.name)}`;
            chip.onclick = async () => {
              await handleInfographicClick(ig, chip);
              chip.classList.add("copied");
              setTimeout(() => chip.classList.remove("copied"), 1500);
            };
            igRow.appendChild(chip);
          });
          bodyEl.appendChild(row);
        }
      }
    }

    /* Variables */
    if (vars.length) {
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.innerHTML = `<div class="panel-label">Personalize (optional)</div><div class="variable-grid"></div>`;
      const grid = $(".variable-grid", panel);
      vars.forEach((v) => {
        const row = document.createElement("div");
        row.className = "variable-row";
        row.innerHTML = `<label>{${v}}</label><input type="text" placeholder="leave blank to keep {${v}}" />`;
        const input = $("input", row);
        input.value = filled[v] || "";
        input.addEventListener("input", () => {
          state.tState.filled[tpl.id] = state.tState.filled[tpl.id] || {};
          state.tState.filled[tpl.id][v] = input.value;
          refresh();
        });
        grid.appendChild(row);
      });
      bodyEl.appendChild(panel);
    }

    /* Preview */
    const preview = document.createElement("div");
    preview.className = "body-preview";
    bodyEl.appendChild(preview);

    /* Actions */
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML = `
      <button class="btn primary" data-act="copy">Copy to clipboard</button>
      <button class="btn" data-act="copy-raw">Copy raw (keep {variables})</button>
      <button class="btn ghost small" data-act="reset">Reset fields</button>
    `;
    bodyEl.appendChild(actions);

    /* Images */
    if ((tpl.images || []).length) {
      const imgs = document.createElement("div");
      imgs.className = "images-section";
      imgs.innerHTML = `<div class="panel-label">Attachments / images</div><div class="image-links"></div>`;
      const row = $(".image-links", imgs);
      tpl.images.forEach((img) => {
        const missing = !img.url || img.url.indexOf("PASTE_") === 0;
        const a = document.createElement("a");
        a.className = "image-link" + (missing ? " missing" : "");
        a.textContent = "🖼 " + img.label + (missing ? " (needs link)" : "");
        a.href = missing ? "#" : img.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        if (missing) a.onclick = (e) => { e.preventDefault(); showToast("Edit this template to add the image URL"); };
        row.appendChild(a);
      });
      bodyEl.appendChild(imgs);
    }

    /* Notes */
    if (tpl.notes) {
      const notes = document.createElement("div");
      notes.className = "notes";
      notes.textContent = tpl.notes;
      bodyEl.appendChild(notes);
    }

    $('[data-act="copy"]', actions).onclick = async () => {
      const txt = substitute(tpl.body, state.tState.filled[tpl.id] || {});
      await copyText(txt);
      flashCopied($('[data-act="copy"]', actions));
    };
    $('[data-act="copy-raw"]', actions).onclick = async () => {
      await copyText(tpl.body);
      flashCopied($('[data-act="copy-raw"]', actions));
    };
    $('[data-act="reset"]', actions).onclick = () => {
      delete state.tState.filled[tpl.id];
      renderBody(card, tpl);
    };

    refresh();
    function refresh() {
      preview.innerHTML = highlighted(tpl.body, state.tState.filled[tpl.id] || {});
    }
  }

  function highlighted(body, filled) {
    return escapeHtml(body).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => {
      const val = filled[name];
      if (val && String(val).trim()) return `<span class="var-token filled">${escapeHtml(val)}</span>`;
      return `<span class="var-token">{${name}}</span>`;
    });
  }
  function substitute(body, filled) {
    return body.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => {
      const val = filled[name];
      return (val && String(val).trim()) ? val : m;
    });
  }

  /* ═════════════ Template editor ═════════════ */

  let editingTemplateId = null;

  function openTemplateEditor(id) {
    editingTemplateId = id || null;
    const tpl = id ? state.templates.find((t) => t.id === id) : null;
    $("#templateModalTitle").textContent = tpl ? "Edit template" : "New template";
    $("#f_title").value = tpl ? tpl.title : "";
    $("#f_body").value  = tpl ? tpl.body  : "";
    $("#f_tags").value  = tpl ? (tpl.tags || []).join(", ") : "";
    $("#f_notes").value = tpl ? (tpl.notes || "") : "";
    populateCategorySelect("#f_category", tpl ? tpl.category_id : (state.categories[0]?.id));
    renderImageRows(tpl ? tpl.images : []);
    updateDetectedVars();
    $("#deleteTemplateBtn").style.display = tpl ? "" : "none";
    $("#templateModalOverlay").classList.add("open");
    setTimeout(() => $("#f_title").focus(), 50);
  }
  function closeTemplateEditor() { $("#templateModalOverlay").classList.remove("open"); editingTemplateId = null; }

  function populateCategorySelect(sel, current) {
    const el = $(sel);
    el.innerHTML = "";
    state.categories.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id; o.textContent = c.label;
      if (c.id === current) o.selected = true;
      el.appendChild(o);
    });
  }

  function renderImageRows(images) {
    const wrap = $("#f_images");
    wrap.innerHTML = "";
    (images || []).forEach((img) => addImageRow(img.label, img.url));
  }
  function addImageRow(label, url) {
    const wrap = $("#f_images");
    const row = document.createElement("div");
    row.className = "image-row";
    row.innerHTML = `
      <input type="text" placeholder="Label (e.g. Pricing flyer)" />
      <input type="text" placeholder="URL (Drive / Dropbox / web)" />
      <button type="button" class="btn ghost small">✕</button>
    `;
    const [ia, ib, rm] = row.children;
    ia.value = label || ""; ib.value = url || "";
    rm.onclick = () => row.remove();
    wrap.appendChild(row);
  }
  function updateDetectedVars() {
    const vars = detectVars($("#f_body").value);
    $("#detectedVars").textContent = vars.length ? vars.map((v) => "{" + v + "}").join(" · ") : "—";
  }

  async function saveTemplate() {
    const title = $("#f_title").value.trim();
    const body  = $("#f_body").value;
    if (!title) { showToast("Title is required", "error"); return; }
    if (!body.trim()) { showToast("Body is required", "error"); return; }
    const payload = {
      title,
      body,
      category_id: $("#f_category").value || null,
      tags: $("#f_tags").value.split(",").map((s) => s.trim()).filter(Boolean),
      notes: $("#f_notes").value || null,
      variables: detectVars(body),
      images: $$("#f_images .image-row").map((r) => ({
        label: r.children[0].value.trim(),
        url: r.children[1].value.trim()
      })).filter((i) => i.label || i.url)
    };

    showLoader(true);
    let resp;
    if (editingTemplateId) {
      resp = await sb.from("templates").update(payload).eq("id", editingTemplateId).select().single();
    } else {
      const existingSlugs = new Set(state.templates.map((t) => t.slug));
      payload.slug = uniqueSlug(slugify(title), existingSlugs);
      resp = await sb.from("templates").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeTemplateEditor();
    showToast(editingTemplateId ? "Template updated" : "Template created", "success");
  }

  async function deleteTemplate() {
    if (!editingTemplateId) return;
    if (!confirm("Delete this template? This cannot be undone.")) return;
    showLoader(true);
    const { error } = await sb.from("templates").delete().eq("id", editingTemplateId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeTemplateEditor();
    showToast("Template deleted", "success");
  }

  async function duplicateTemplate(id) {
    const src = state.templates.find((t) => t.id === id);
    if (!src) return;
    const existingSlugs = new Set(state.templates.map((t) => t.slug));
    const payload = {
      slug: uniqueSlug(src.slug + "-copy", existingSlugs),
      category_id: src.category_id,
      title: src.title + " (copy)",
      body: src.body,
      variables: src.variables || [],
      notes: src.notes,
      tags: src.tags || [],
      images: src.images || []
    };
    showLoader(true);
    const { error } = await sb.from("templates").insert(payload);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    showToast("Duplicated — open the copy to edit", "success");
  }

  /* ═════════════ CLASSES ═════════════ */

  let editingClassId = null;

  function renderClassesTab() {
    renderSyncStatus();

    const showTest = !!state.cState.showTest;
    const visible = state.classes.filter((c) => showTest || !c.is_test);
    const totalCount = state.classes.length;
    const testCount  = state.classes.filter((c) => c.is_test).length;
    const el = $("#classTable");
    $("#classMeta").innerHTML = visible.length + (visible.length === 1 ? " class" : " classes") +
      (testCount > 0 ? ` <span style="color:var(--ink-dim)">· ${testCount} test class${testCount === 1 ? "" : "es"} hidden</span>`.replace("hidden", showTest ? "shown" : "hidden") : "");

    const showClassEdit = hasPerm("edit_classes");
    const typeLabel = { weekly: "Weekly", camp: "Camp", workshop: "Workshop", contracted: "Contracted" };
    const fmtSync = (ts) => {
      if (!ts) return '<span style="color:var(--ink-dim);font-size:11px">—</span>';
      const d = new Date(ts);
      const now = new Date();
      const diffMin = Math.round((now - d) / 60000);
      if (diffMin < 2) return '<span style="font-size:11px;color:var(--success)">just now</span>';
      if (diffMin < 60) return `<span style="font-size:11px">${diffMin}m ago</span>`;
      if (diffMin < 1440) return `<span style="font-size:11px">${Math.round(diffMin/60)}h ago</span>`;
      return `<span style="font-size:11px">${Math.round(diffMin/1440)}d ago</span>`;
    };

    const cards = visible.map((c) => {
      const sourceBadge = c.is_test
        ? '<span class="source-badge source-test">TEST</span>'
        : c.source === "jackrabbit"
          ? '<span class="source-badge source-jackrabbit">JR</span>'
          : '<span class="source-badge source-local">local</span>';
      const stateTag = c.sync_state === "dropped_from_source"
        ? ' <span class="sync-state-dropped_from_source">dropped from JR</span>'
        : "";
      const isOpen = state.cState.openClassId === c.id;
      const activeEnrollments = state.enrollments.filter((e) => e.class_id === c.id && e.status === "active").length;
      const initials = classInitialsString(c.id);

      const dayTimeChip = c.day_time
        ? `<span class="cm-chip"><span class="ico">📅</span><span class="val">${escapeHtml(c.day_time)}</span></span>`
        : "";
      const locationChip = c.location
        ? `<span class="cm-chip"><span class="ico">📍</span><span class="val">${escapeHtml(c.location)}</span></span>`
        : "";
      const teacherChip = initials
        ? `<span class="cm-chip"><span class="ico">👤</span><span class="val">${escapeHtml(initials)}</span></span>`
        : `<span class="cm-chip muted"><span class="ico">👤</span><span class="val">unassigned</span></span>`;
      const enrollChip = `<span class="cm-chip"><span class="ico">👥</span><span class="val">${activeEnrollments} enrolled</span></span>`;

      const typeBadge = `<span class="type-badge type-${escapeHtml(c.type || "weekly")}">${typeLabel[c.type] || c.type || "—"}</span>`;
      const inactiveTag = c.active === false ? '<span style="color:var(--ink-dim);font-size:11px">(inactive)</span>' : "";
      const regLink = c.registration_link
        ? `<a href="${escapeHtml(c.registration_link)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);" onclick="event.stopPropagation()">Link ↗</a>`
        : "";
      const editBtn = showClassEdit
        ? `<button class="btn small ghost" data-act="edit-class" data-id="${escapeHtml(c.id)}">Edit</button>`
        : "";

      return `
        <article class="class-card${isOpen ? " open" : ""}${c.is_test ? " is-test" : ""}" data-id="${escapeHtml(c.id)}">
          <div class="class-card-head">
            <div class="class-card-title">
              <b>${escapeHtml(c.name)}</b> ${sourceBadge}${stateTag}
              ${c.age_range ? `<span class="age-sub">Ages ${escapeHtml(c.age_range)}</span>` : ""}
            </div>
            <div class="class-card-actions">${regLink}${editBtn}</div>
          </div>
          <div class="class-card-meta">
            ${dayTimeChip}${locationChip}${teacherChip}${enrollChip}
          </div>
          <div class="class-card-foot">
            <div class="left">${typeBadge}${inactiveTag}</div>
            <div class="right">${fmtSync(c.last_synced_at)}</div>
          </div>
          <div class="class-card-body">
            <div class="class-detail-body class-detail" data-class-id="${escapeHtml(c.id)}"></div>
          </div>
        </article>
      `;
    }).join("");
    el.innerHTML = `
      <div class="classes-grid">${cards || `<div style="grid-column:1/-1;text-align:center;color:var(--ink-dim);padding:24px">No classes to show.${showClassEdit ? " Click <b>⟳ Sync now</b> to pull from Jackrabbit, or <b>＋ New class</b>." : ""}</div>`}</div>
    `;
    if (showClassEdit) {
      $$('[data-act="edit-class"]', el).forEach((btn) => {
        btn.onclick = (e) => { e.stopPropagation(); openClassEditor(btn.dataset.id); };
      });
    }
    $$(".class-card", el).forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest('.class-card-body')) return;
        if (e.target.closest('a, button, input, select, textarea, [data-act]')) return;
        const id = card.dataset.id;
        state.cState.openClassId = (state.cState.openClassId === id) ? null : id;
        renderClassesTab();
      };
    });
    // Render detail body for the open class
    if (state.cState.openClassId) {
      const cls = state.classes.find((c) => c.id === state.cState.openClassId);
      if (cls) {
        const body = $(`.class-detail-body[data-class-id="${state.cState.openClassId}"]`, el);
        if (body) renderClassDetail(body, cls);
      }
    }
  }

  /* Class detail panel rendering — teacher assignments + infographic links + JR meta + enrollments */
  function renderClassDetail(rootEl, cls) {
    const teachers = state.classTeachers.filter((ct) => ct.class_id === cls.id)
      .map((ct) => ({ ...ct, teacher: state.teachers.find((t) => t.id === ct.teacher_id) }))
      .filter((x) => x.teacher);
    const linkedIgIds = new Set(state.classInfographics.filter((ci) => ci.class_id === cls.id).map((ci) => ci.infographic_id));
    const classEnrollments = state.enrollments.filter((e) => e.class_id === cls.id)
      .map((e) => ({ ...e, student: state.students.find((s) => s.id === e.student_id) }))
      .filter((x) => x.student);

    rootEl.innerHTML = `
      <div class="panels-grid">
        <div>
          <div class="section-title">Teachers</div>
          <div class="teacher-list"></div>
          <div class="add-assign">
            <select class="select-teacher"><option value="">— Add teacher —</option></select>
            <select class="select-role">
              <option value="primary">Primary</option>
              <option value="substitute">Substitute</option>
              <option value="assistant">Assistant</option>
              <option value="co-teacher">Co-teacher</option>
            </select>
            <button class="btn primary small" data-act="add-teacher">Add</button>
          </div>
        </div>
        <div>
          <div class="section-title">Linked infographics <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(click to toggle)</span></div>
          <div class="ig-chip-grid"></div>
        </div>
      </div>
      <div style="margin-top:16px">
        <div class="section-title">Enrollments <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(${classEnrollments.filter(e => e.status === 'active').length} active${classEnrollments.length > classEnrollments.filter(e => e.status === 'active').length ? ' · ' + (classEnrollments.length - classEnrollments.filter(e => e.status === 'active').length) + ' inactive' : ''})</span></div>
        <div class="reconcile-banner"></div>
        <div class="enrollments-list"></div>
        <div class="add-student-row" style="margin-top:8px"></div>
      </div>
      <div style="margin-top:16px">
        <div class="section-title">Attendance</div>
        <div class="attendance-section"></div>
      </div>
      <div style="margin-top:16px">
        <div class="section-title">Class details (from Jackrabbit)</div>
        <div class="panels-grid">
          <div>
            <div class="info-pair"><span class="k">JR ID</span><span class="v">${escapeHtml(cls.jackrabbit_class_id || "—")}</span></div>
            <div class="info-pair"><span class="k">Session</span><span class="v">${escapeHtml(cls.session || "—")}</span></div>
            <div class="info-pair"><span class="k">Tuition</span><span class="v">${escapeHtml(cls.tuition || "—")}</span></div>
            <div class="info-pair"><span class="k">Openings</span><span class="v">${cls.openings == null ? "—" : cls.openings}</span></div>
            <div class="info-pair"><span class="k">Dates</span><span class="v">${escapeHtml(cls.start_date || "—")} → ${escapeHtml(cls.end_date || "—")}</span></div>
          </div>
          <div>
            <div class="info-pair"><span class="k">Cat 1</span><span class="v">${escapeHtml(cls.cat1 || "—")}</span></div>
            <div class="info-pair"><span class="k">Cat 2</span><span class="v">${escapeHtml(cls.cat2 || "—")}</span></div>
            <div class="info-pair"><span class="k">Cat 3</span><span class="v">${escapeHtml(cls.cat3 || "—")}</span></div>
            <div class="info-pair"><span class="k">Room</span><span class="v">${escapeHtml(cls.room || "—")}</span></div>
            <div class="info-pair"><span class="k">JR instructors</span><span class="v">${escapeHtml(cls.instructors || "—")}</span></div>
          </div>
        </div>
        ${cls.description ? `<div class="jr-description" style="margin-top:8px">${escapeHtml(cls.description)}</div>` : ""}
      </div>
    `;

    // Teacher list
    const tlist = $(".teacher-list", rootEl);
    if (teachers.length === 0) {
      tlist.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:8px 0">No teachers assigned yet.</div>';
    } else {
      teachers.forEach(({ teacher, role, class_id }) => {
        const row = document.createElement("div");
        row.className = "assign-row";
        row.innerHTML = `
          <span class="teacher-name">${escapeHtml(teacher.full_name)}${teacher.status !== 'active' ? ` <span style="font-size:11px;color:var(--ink-dim)">(${escapeHtml(teacher.status)})</span>` : ""}</span>
          <span class="role-tag role-${escapeHtml(role)}">${escapeHtml(role)}</span>
          <button class="btn small ghost danger" data-act="remove-teacher" data-teacher="${escapeHtml(teacher.id)}" data-role="${escapeHtml(role)}">✕</button>
        `;
        $('[data-act="remove-teacher"]', row).onclick = async (e) => {
          e.stopPropagation();
          const { error } = await sb.from("class_teachers").delete()
            .eq("class_id", class_id).eq("teacher_id", teacher.id).eq("role", role);
          if (error) { showToast(error.message, "error"); return; }
          await reloadAll(); renderAll();
          showToast("Teacher removed", "success");
        };
        tlist.appendChild(row);
      });
    }
    // Populate teacher select with active teachers not already in the same role
    const sel = $(".select-teacher", rootEl);
    const assignedTeacherIds = new Set(teachers.map((x) => x.teacher.id + ":" + x.role));
    state.teachers.filter((t) => t.status !== 'inactive').forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.full_name;
      sel.appendChild(opt);
    });
    $('[data-act="add-teacher"]', rootEl).onclick = async (e) => {
      e.stopPropagation();
      const teacherId = sel.value;
      const role = $(".select-role", rootEl).value;
      if (!teacherId) { showToast("Pick a teacher first", "error"); return; }
      if (assignedTeacherIds.has(teacherId + ":" + role)) { showToast("Already assigned in that role", "error"); return; }
      const { error } = await sb.from("class_teachers").insert({ class_id: cls.id, teacher_id: teacherId, role });
      if (error) { showToast(error.message, "error"); return; }
      await reloadAll(); renderAll();
      showToast("Teacher assigned", "success");
    };

    // Enrollments list
    const enrollList = $(".enrollments-list", rootEl);
    if (enrollList) {
      if (classEnrollments.length === 0) {
        enrollList.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:8px 0">No enrollments yet. They\'ll appear here when Zapier sends them from Jackrabbit.</div>';
      } else {
        enrollList.innerHTML = "";
        const activeFirst = [...classEnrollments].sort((a, b) => {
          const aActive = a.status === "active" ? 0 : 1;
          const bActive = b.status === "active" ? 0 : 1;
          if (aActive !== bActive) return aActive - bActive;
          return (a.student.last_name || "").localeCompare(b.student.last_name || "");
        });
        activeFirst.forEach(({ student, status, drop_reason, dropped_at, enrolled_at }) => {
          const row = document.createElement("div");
          row.className = "assign-row";
          const statusClass = status === "active" ? "role-primary" : status === "waitlist" ? "role-substitute" : status === "dropped" ? "role-co-teacher" : "role-assistant";
          const localBadge = student.source === "dk_local"
            ? ' <span class="source-badge source-local" title="Added directly in DK — not from Jackrabbit">local</span>'
            : "";
          row.innerHTML = `
            <span class="teacher-name">${escapeHtml(student.first_name || "")} ${escapeHtml(student.last_name || "")}${localBadge}${student.dob ? ` <span style="font-size:11px;color:var(--ink-dim);font-weight:400">· DoB ${escapeHtml(student.dob)}</span>` : ""}</span>
            <span class="role-tag ${statusClass}">${escapeHtml(status)}</span>
            ${drop_reason ? `<span style="font-size:11px;color:var(--ink-dim)">· ${escapeHtml(drop_reason)}</span>` : ""}
          `;
          enrollList.appendChild(row);
        });
      }
    }

    // Match-candidate banner: shown when admins view a class whose roster
    // has any unresolved duplicate flag. Teachers can't SELECT the candidate
    // table (RLS) so state.matchCandidates is empty for them.
    const banner = $(".reconcile-banner", rootEl);
    if (banner) {
      banner.innerHTML = "";
      if (hasPerm("reconcile_students")) {
        const enrolledStudentIds = new Set(classEnrollments.map(e => e.student.id));
        const relevant = state.matchCandidates.filter(c =>
          enrolledStudentIds.has(c.dk_student_id) || enrolledStudentIds.has(c.jr_student_id)
        );
        if (relevant.length > 0) {
          const b = document.createElement("div");
          b.style.cssText = "padding:8px 12px;background:#fff7e6;border:1px solid #f0d88a;border-radius:8px;font-size:12.5px;margin:6px 0 8px;color:#7a5b00;display:flex;align-items:center;gap:8px;justify-content:space-between";
          b.innerHTML = `<span><b>${relevant.length}</b> possible duplicate${relevant.length > 1 ? "s" : ""} in this roster</span><button class="btn small" data-act="open-reconcile">Review</button>`;
          $('[data-act="open-reconcile"]', b).onclick = (e) => {
            e.stopPropagation();
            openReconcileModal(relevant[0].id);
          };
          banner.appendChild(b);
        }
      }
    }

    // "+ Add student" row: visible to admins always, and to teachers who
    // are assigned to THIS class (their perm mirrors the RLS scope).
    const addRow = $(".add-student-row", rootEl);
    if (addRow) {
      addRow.innerHTML = "";
      const canAddAsAdmin = hasPerm("edit_students");
      const canAddAsTeacher = hasPerm("manage_own_roster_students") &&
        teachers.some(t => t.teacher && (t.teacher.email || "").toLowerCase() ===
          (state.session?.user?.email || "").toLowerCase());
      if (canAddAsAdmin || canAddAsTeacher) {
        const btn = document.createElement("button");
        btn.className = "btn small";
        btn.textContent = "+ Add student";
        btn.onclick = (e) => { e.stopPropagation(); openAddStudentModal(cls); };
        addRow.appendChild(btn);
      }
    }

    // Attendance section: session history + "Take attendance for today" CTA.
    // Visible if the user can see any attendance data (RLS already filters
    // state.attendance — if the list is empty for this class, we still show
    // the take-attendance CTA so teachers can start fresh).
    const attSection = $(".attendance-section", rootEl);
    if (attSection) {
      attSection.innerHTML = "";
      const today = isoDate(new Date());
      const todayIsClassDay = classRunsOnDay(cls, new Date());
      // Admins can take/edit attendance any day (date picker handles
      // off-day sessions like make-ups or test classes with no schedule).
      // Teachers only see the button when canTakeAttendanceFor passes
      // (assignment + 2-day grace window).
      const canTake = isAdminOrAbove() || canTakeAttendanceFor(cls, today);

      // Row containing the two primary actions: Take attendance + Clock in/out.
      const actionRow = document.createElement("div");
      actionRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;align-items:center";

      if (canTake) {
        const btn = document.createElement("button");
        btn.className = "btn primary small";
        const todayStats = attendanceStatsForSession(cls.id, today);
        if (todayStats.taken) {
          btn.textContent = "Edit today's attendance";
        } else if (todayIsClassDay) {
          btn.textContent = "Take attendance for today";
        } else {
          btn.textContent = "Take attendance";
        }
        btn.onclick = (e) => { e.stopPropagation(); openAttendanceModal(cls, today); };
        actionRow.appendChild(btn);
      } else if (todayIsClassDay) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:12.5px;color:var(--ink-dim)";
        note.textContent = "Today is a class day — but you're outside the window to take attendance for it.";
        actionRow.appendChild(note);
      }

      // Clock-in / Clock-out button (T3d). Resolves the signed-in user's
      // teachers row by email; shows clocked-in time if already clocked in.
      // Admins without a teachers row will see an error toast on click —
      // that's fine for v1 (tells them they need a teachers entry).
      const myTeacher = mySignedInTeacher();
      if (myTeacher) {
        const shift = state.clockIns.find(
          (c) => c.teacher_id === myTeacher.id && c.class_id === cls.id && c.session_date === today
        );
        if (!shift) {
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.textContent = "Clock in";
          btn.onclick = (e) => { e.stopPropagation(); doClockIn(cls.id); };
          actionRow.appendChild(btn);
        } else if (!shift.clocked_out_at) {
          const mins = Math.max(0, Math.round((new Date() - new Date(shift.clocked_in_at)) / 60000));
          const label = document.createElement("span");
          label.style.cssText = "font-size:12.5px;color:#2f7d3a";
          label.textContent = `⏱ Clocked in · ${mins} min`;
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.textContent = "Clock out";
          btn.onclick = (e) => { e.stopPropagation(); doClockOut(shift.id); };
          actionRow.appendChild(label);
          actionRow.appendChild(btn);
        } else {
          const durMin = Math.max(0, Math.round(
            (new Date(shift.clocked_out_at) - new Date(shift.clocked_in_at)) / 60000
          ));
          const label = document.createElement("span");
          label.style.cssText = "font-size:12.5px;color:var(--ink-dim)";
          label.textContent = `✓ Shift done · ${durMin} min`;
          actionRow.appendChild(label);
        }
      }

      // "Request a sub" button (Phase T4). Shown to teachers assigned to
      // this class and to admins/managers (who can file on a teacher's
      // behalf). Skips if there's already a non-cancelled request for the
      // next session — surface a status pill instead so users can jump
      // straight into the Sub requests tab to manage it.
      const canRequestSub =
        hasPerm("manage_all_sub_requests") ||
        (hasPerm("request_sub") && myTeacher &&
          state.classTeachers.some((ct) => ct.class_id === cls.id && ct.teacher_id === myTeacher.id));
      if (canRequestSub) {
        const nextSession = nextSessionDateForClass(cls, new Date()) || today;
        const existingReq = activeSubRequestForSession(cls.id, nextSession);
        if (!existingReq) {
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.textContent = "Request sub";
          btn.title = `Open a sub request for ${formatSessionDate(nextSession)}`;
          btn.onclick = (e) => {
            e.stopPropagation();
            openSubRequestModal({ presetClassId: cls.id, presetSessionDate: nextSession });
          };
          actionRow.appendChild(btn);
        } else {
          const pill = document.createElement("span");
          pill.className = "sr-status sr-status-" + existingReq.status;
          pill.style.cursor = "pointer";
          pill.title = `Sub request for ${formatSessionDate(nextSession)} — click to manage`;
          pill.textContent = existingReq.status === "open"
            ? `Sub request open · ${formatSessionDate(nextSession)}`
            : `Sub ${existingReq.status} · ${formatSessionDate(nextSession)}`;
          pill.onclick = (e) => { e.stopPropagation(); go("subrequests"); };
          actionRow.appendChild(pill);
        }
      }

      // "Cancel class" / "Notify daily contact" buttons (Phase T8). Admin-only.
      // Operates on the next class day (mirrors Request sub anchor) so the
      // common case (admin reacting to a same-day issue) is one click.
      if (hasPerm("edit_classes")) {
        const nextSession = nextSessionDateForClass(cls, new Date()) || today;
        const cancellation = classCancellationFor(cls.id, nextSession);
        if (!cancellation) {
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.textContent = "Cancel class";
          btn.title = `Cancel ${cls.name} for ${formatSessionDate(nextSession)} and notify the school`;
          btn.onclick = (e) => { e.stopPropagation(); openClassCancelModal(cls, nextSession); };
          actionRow.appendChild(btn);
        } else {
          // Already cancelled — show a pill plus a "Notify again" button
          // (admins sometimes need to re-send the cancellation email).
          const pill = document.createElement("span");
          pill.className = "sr-status sr-status-cancelled";
          pill.textContent = `Cancelled · ${formatSessionDate(nextSession)}${cancellation.notified_at ? " · notified ✓" : ""}`;
          actionRow.appendChild(pill);
          const notifyBtn = document.createElement("button");
          notifyBtn.className = "btn small ghost";
          notifyBtn.textContent = cancellation.notified_at ? "Re-notify school" : "Notify school";
          notifyBtn.onclick = (e) => {
            e.stopPropagation();
            openNotifyModal({
              kind: "class_cancelled",
              cls,
              sessionDate: nextSession,
              reason: cancellation.reason || "",
              cancellationId: cancellation.id,
            });
          };
          actionRow.appendChild(notifyBtn);
          const undoBtn = document.createElement("button");
          undoBtn.className = "btn small ghost";
          undoBtn.textContent = "Restore";
          undoBtn.onclick = (e) => { e.stopPropagation(); uncancelClassSession(cancellation.id); };
          actionRow.appendChild(undoBtn);
        }

        // Always show a generic "Notify daily contact" if the school has
        // a daily contact email — useful for ad-hoc messages outside the
        // sub / cancel flows.
        const sch = schoolForClass(cls);
        if (sch && sch.daily_contact_email) {
          const adhocBtn = document.createElement("button");
          adhocBtn.className = "btn small ghost";
          adhocBtn.textContent = "✉ Notify daily contact";
          adhocBtn.title = `Open a notification email to ${sch.daily_contact_name || sch.daily_contact_email}`;
          adhocBtn.onclick = (e) => {
            e.stopPropagation();
            openNotifyModal({
              kind: "adhoc",
              cls,
              sessionDate: nextSession,
              reason: "",
            });
          };
          actionRow.appendChild(adhocBtn);
        }
      }

      // T10: "Assign inventory" button + currently-assigned-for-next-session
      // chip list. Anyone with edit_inventory can assign; everyone signed in
      // sees the chips (so a teacher knows what's been pulled for them).
      if (hasPerm("edit_inventory")) {
        const nextSession = nextSessionDateForClass(cls, new Date()) || today;
        const btn = document.createElement("button");
        btn.className = "btn small ghost";
        btn.textContent = "📦 Assign inventory";
        btn.title = `Assign inventory items to ${cls.name} on ${formatSessionDate(nextSession)}`;
        btn.onclick = (e) => {
          e.stopPropagation();
          openInventoryAssignModal({ kind: "class", classId: cls.id, sessionDate: nextSession });
        };
        actionRow.appendChild(btn);
      }

      if (actionRow.children.length > 0) {
        attSection.appendChild(actionRow);
      }

      // T10: surface inventory currently assigned to the next session of
      // this class. Shown to all roles; only admins/managers can detach.
      {
        const nextSession = nextSessionDateForClass(cls, new Date()) || today;
        const assigns = inventoryAssignmentsForClassSession(cls.id, nextSession)
          .filter((a) => !a.returned_at);
        if (assigns.length) {
          const wrap = document.createElement("div");
          wrap.className = "inv-class-panel-row";
          wrap.innerHTML = `
            <div class="inv-class-panel-label">Inventory for ${escapeHtml(formatSessionDate(nextSession))}:</div>
            <div class="inv-class-panel-chips">
              ${assigns.map((a) => {
                const it = inventoryItemById(a.item_id);
                const conflicts = conflictsForItemInWindow(a.item_id, new Date(a.usage_starts_at), new Date(a.usage_ends_at), a.id);
                const warn = conflicts.length ? ` warn` : "";
                return `<span class="inv-chip${warn}" data-inv-chip-item="${escapeHtml(a.item_id)}" title="${conflicts.length ? "Conflict — also assigned to: " + escapeHtml(conflicts.map(assignmentTargetLabel).join(", ")) : "Click to view"}">${escapeHtml(it ? it.name : "(item)")}${conflicts.length ? " ⚠" : ""}</span>`;
              }).join("")}
            </div>
          `;
          wrap.querySelectorAll("[data-inv-chip-item]").forEach((c) => {
            c.onclick = (e) => { e.stopPropagation(); openInventoryEditor(c.dataset.invChipItem); };
          });
          attSection.appendChild(wrap);
        }
      }

      // Session history table (most recent 8)
      const sessionDates = recentSessionDatesForClass(cls.id, 8);
      if (sessionDates.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "font-size:12.5px;color:var(--ink-dim);padding:4px 0";
        empty.textContent = "No attendance recorded yet for this class.";
        attSection.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:4px";
        sessionDates.forEach((d) => {
          const stats = attendanceStatsForSession(cls.id, d);
          const canEdit = canTakeAttendanceFor(cls, d);
          const row = document.createElement("div");
          row.className = "assign-row";
          row.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 8px;background:var(--surface,#fff);border:1px solid var(--border);border-radius:6px";
          const dateLabel = new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
          const lateBit = stats.latePickups > 0
            ? ` · <span style="color:#a36a00">${stats.latePickups} late pickup${stats.latePickups === 1 ? "" : "s"} (${stats.lateMinutes} min)</span>`
            : "";
          row.innerHTML = `
            <span style="flex:0 0 140px;font-weight:500">${escapeHtml(dateLabel)}</span>
            <span style="font-size:12px;color:var(--ink-dim);flex:1">
              ${stats.present} present · ${stats.absent} absent${lateBit}
            </span>
          `;
          if (canEdit) {
            const editBtn = document.createElement("button");
            editBtn.className = "btn small";
            editBtn.textContent = "Edit";
            editBtn.onclick = (e) => { e.stopPropagation(); openAttendanceModal(cls, d); };
            row.appendChild(editBtn);
          }
          list.appendChild(row);
        });
        attSection.appendChild(list);
      }
    }

    // Infographic chip grid
    const grid = $(".ig-chip-grid", rootEl);
    if (state.infographics.length === 0) {
      grid.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:8px 0">No infographics yet. Add some on the Infographics tab.</div>';
    } else {
      state.infographics.forEach((ig) => {
        const isLinked = linkedIgIds.has(ig.id);
        const chip = document.createElement("div");
        chip.className = "ig-chip" + (isLinked ? " linked" : "");
        chip.innerHTML = `<span class="check">${isLinked ? "✓" : "+"}</span><span>${escapeHtml(ig.name)}</span>`;
        chip.onclick = async (e) => {
          e.stopPropagation();
          if (isLinked) {
            const { error } = await sb.from("class_infographics").delete()
              .eq("class_id", cls.id).eq("infographic_id", ig.id);
            if (error) { showToast(error.message, "error"); return; }
          } else {
            const { error } = await sb.from("class_infographics").insert({ class_id: cls.id, infographic_id: ig.id });
            if (error) { showToast(error.message, "error"); return; }
          }
          await reloadAll(); renderAll();
        };
        grid.appendChild(chip);
      });
    }
  }

  /* ═════════════ T3a: Add-student + Reconcile modals ═════════════
   * Teacher/admin adds a DK-local student to a class (contracted classes
   * or late adds to JR classes). The student INSERT fires a server-side
   * trigger that auto-flags match candidates against JR records; admins
   * resolve them from the class-panel banner via reconcile_students RPC.
   */
  let addStudentTargetClassId = null;
  let reconcileCandidateId = null;

  function openAddStudentModal(cls) {
    addStudentTargetClassId = cls.id;
    $("#addStudentClassBanner").innerHTML =
      `Adding a student to <b>${escapeHtml(cls.name || "this class")}</b>` +
      (cls.location ? ` <span style="color:var(--ink-dim)">· ${escapeHtml(cls.location)}</span>` : "");
    $("#addStudentSourceWarn").style.display = cls.source === "jackrabbit" ? "" : "none";
    $("#as_first_name").value = "";
    $("#as_last_name").value = "";
    $("#as_dob").value = "";
    $("#addStudentModalOverlay").classList.add("open");
    setTimeout(() => $("#as_first_name").focus(), 50);
  }

  function closeAddStudentModal() {
    $("#addStudentModalOverlay").classList.remove("open");
    addStudentTargetClassId = null;
  }

  async function saveAddStudent() {
    const classId = addStudentTargetClassId;
    if (!classId) { showToast("No class selected", "error"); return; }
    const first = $("#as_first_name").value.trim();
    const last  = $("#as_last_name").value.trim();
    const dob   = $("#as_dob").value || null;
    if (!first || !last) { showToast("First and last name are required", "error"); return; }

    showLoader(true);
    // Generate the student id client-side so we can chain the enrollment
    // insert without needing SELECT visibility back on the just-inserted
    // student row (teachers can't SELECT a student until an enrollment
    // links them to a class the teacher is assigned to).
    const newStudentId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
    if (!newStudentId) { showLoader(false); showToast("This browser lacks crypto.randomUUID", "error"); return; }
    const studentPayload = {
      id: newStudentId,
      first_name: first,
      last_name: last,
      dob,
      source: "dk_local",
      jackrabbit_student_id: null,
      created_by: state.session?.user?.id || null,
    };
    const stuResp = await sb.from("students").insert(studentPayload);
    if (stuResp.error) {
      showLoader(false);
      showToast("Add student failed: " + stuResp.error.message, "error");
      return;
    }
    const enrollPayload = {
      student_id: newStudentId,
      class_id: classId,
      status: "active",
      source: "dk_local",
      enrolled_at: new Date().toISOString(),
      created_by: state.session?.user?.id || null,
    };
    const enrResp = await sb.from("enrollments").insert(enrollPayload);
    showLoader(false);
    if (enrResp.error) {
      showToast("Student created but enrollment failed: " + enrResp.error.message, "error");
      await reloadAll(); renderAll();
      return;
    }
    await reloadAll(); renderAll();
    closeAddStudentModal();
    showToast(`${first} ${last} added to class`, "success");
  }

  function openReconcileModal(candidateId) {
    const cand = state.matchCandidates.find((c) => c.id === candidateId);
    if (!cand) { showToast("Match candidate not found", "error"); return; }
    reconcileCandidateId = candidateId;
    const dk = state.students.find((s) => s.id === cand.dk_student_id);
    const jr = state.students.find((s) => s.id === cand.jr_student_id);
    const reasonLabel = cand.match_reason === "name_dob" ? "Exact name + date of birth"
      : cand.match_reason === "name_phonetic_dob" ? "Phonetic surname + date of birth"
      : cand.match_reason === "family_id" ? "Same Jackrabbit family + first name"
      : cand.match_reason;
    $("#reconcileReason").innerHTML = `<b>Match reason:</b> ${escapeHtml(reasonLabel)}`;

    const card = (s, label) => {
      if (!s) return `<div style="padding:12px;border:1px solid var(--border);border-radius:8px">${label}: <i>row missing</i></div>`;
      const enrollCount = state.enrollments.filter((e) => e.student_id === s.id).length;
      return `
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px">
          <div style="font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.5px">${label}</div>
          <div style="font-weight:600;margin-top:4px">${escapeHtml(s.first_name || "")} ${escapeHtml(s.last_name || "")}</div>
          <div style="font-size:12.5px;color:var(--ink-dim);margin-top:4px">
            Source: <b>${escapeHtml(s.source || "?")}</b><br/>
            DoB: ${escapeHtml(s.dob || "—")}<br/>
            JR ID: ${escapeHtml(s.jackrabbit_student_id || "—")}<br/>
            Family ID: ${escapeHtml(s.family_id || "—")}<br/>
            Enrollments: ${enrollCount}
          </div>
        </div>`;
    };
    $("#reconcileCompare").innerHTML = card(dk, "DK-local row") + card(jr, "Jackrabbit row");
    $("#reconcileModalOverlay").classList.add("open");
  }

  function closeReconcileModal() {
    $("#reconcileModalOverlay").classList.remove("open");
    reconcileCandidateId = null;
  }

  async function resolveReconcile(action) {
    const candId = reconcileCandidateId;
    if (!candId) return;
    const cand = state.matchCandidates.find((c) => c.id === candId);
    if (!cand) { showToast("Candidate not found", "error"); return; }
    showLoader(true);
    try {
      if (action === "link") {
        const { error } = await sb.rpc("reconcile_students", { p_candidate_id: candId });
        if (error) throw error;
        showToast("Linked — DK row archived, enrollments moved to JR record", "success");
      } else if (action === "keep") {
        const { error } = await sb.from("student_match_candidates")
          .update({
            resolved_at: new Date().toISOString(),
            resolved_by: state.session?.user?.id || null,
            resolution: "kept_separate",
          })
          .eq("id", candId);
        if (error) throw error;
        showToast("Kept separate", "success");
      } else if (action === "delete") {
        // Delete the DK-local row (cascade removes its enrollments), then
        // mark the candidate resolved as dk_deleted.
        const { error: delErr } = await sb.from("students").delete().eq("id", cand.dk_student_id);
        if (delErr) throw delErr;
        await sb.from("student_match_candidates")
          .update({
            resolved_at: new Date().toISOString(),
            resolved_by: state.session?.user?.id || null,
            resolution: "dk_deleted",
          })
          .eq("id", candId);
        showToast("DK-local row deleted", "success");
      }
      await reloadAll(); renderAll();
      closeReconcileModal();
    } catch (e) {
      showToast(e.message || "Reconcile failed", "error");
    } finally {
      showLoader(false);
    }
  }

  /* ═════════════ T3b: Attendance capture ═════════════
   * Attendance is enrollment-scoped: one row per (enrollment, session_date).
   * The modal loads the current session's marks, lets the user toggle per
   * student between Present/Late/Absent/Excused (unset = "unknown" = no row
   * sent), and bulk-upserts via the take_attendance RPC.
   *
   * Teachers can only take/edit within the 2-day RLS grace window on
   * classes they're assigned to; admins have no window. Date picker's
   * `min` and `max` reflect this.
   */
  // Status is now simplified to Present / Absent. Late pickup is tracked
  // independently via late_pickup_minutes (separate from status because a
  // student can be present AND late-pickup, and franchises may bill late-
  // pickup fees separately). 'late' and 'excused' remain valid DB values
  // for historical rows and future UIs, but the v1 roster only emits P/A.
  const ATT_STATUSES = ["present","absent"];
  let attendanceModalClassId = null;
  let attendanceModalSessionDate = null;
  // per-enrollment status overrides during an open modal session:
  // { [enrollment_id]: "present"|"absent"|"unknown" }
  let attendancePendingMarks = {};
  // per-enrollment notes overrides during an open modal session
  let attendancePendingNotes = {};
  // per-enrollment late_pickup_minutes overrides during an open modal session.
  // Value is a number, 0, or null. null = clear; 0 = explicitly "no late pickup".
  let attendancePendingLateMinutes = {};

  // Build a (enrollment_id -> attendance row) map for a class+date session.
  function attendanceMapForSession(classId, sessionDate) {
    const classEnrollmentIds = new Set(
      state.enrollments.filter((e) => e.class_id === classId).map((e) => e.id)
    );
    const out = new Map();
    for (const a of state.attendance) {
      if (!classEnrollmentIds.has(a.enrollment_id)) continue;
      if (a.session_date !== sessionDate) continue;
      out.set(a.enrollment_id, a);
    }
    return out;
  }

  // Aggregate counts for a class's session. `taken` = at least one non-unknown
  // row. latePickups counts rows where late_pickup_minutes > 0 (independent
  // of status). Historical rows with status='late'/'excused' are still
  // counted — 'late' folds into present for display, 'excused' into absent —
  // so stats remain readable across schema versions.
  function attendanceStatsForSession(classId, sessionDate) {
    const map = attendanceMapForSession(classId, sessionDate);
    const stats = { present: 0, absent: 0, latePickups: 0, lateMinutes: 0, unknown: 0, taken: false };
    for (const a of map.values()) {
      if (a.status === "present" || a.status === "late") stats.present++;
      else if (a.status === "absent" || a.status === "excused") stats.absent++;
      else stats.unknown++;
      if (a.status && a.status !== "unknown") stats.taken = true;
      if (a.late_pickup_minutes && a.late_pickup_minutes > 0) {
        stats.latePickups++;
        stats.lateMinutes += a.late_pickup_minutes;
      }
    }
    return stats;
  }

  // List recent session_dates for a class (descending) with row coverage.
  function recentSessionDatesForClass(classId, limit) {
    const classEnrollmentIds = new Set(
      state.enrollments.filter((e) => e.class_id === classId).map((e) => e.id)
    );
    const dates = new Set();
    for (const a of state.attendance) {
      if (classEnrollmentIds.has(a.enrollment_id)) dates.add(a.session_date);
    }
    return [...dates].sort((a, b) => (a < b ? 1 : -1)).slice(0, limit || 8);
  }

  function openAttendanceModal(cls, sessionDate) {
    attendanceModalClassId = cls.id;
    attendanceModalSessionDate = sessionDate || isoDate(new Date());
    attendancePendingMarks = {};
    attendancePendingNotes = {};
    attendancePendingLateMinutes = {};

    $("#attendanceClassBanner").innerHTML =
      `Taking attendance for <b>${escapeHtml(cls.name || "this class")}</b>` +
      (cls.location ? ` <span style="color:var(--ink-dim)">· ${escapeHtml(cls.location)}</span>` : "");

    const picker = $("#att_session_date");
    picker.value = attendanceModalSessionDate;
    // Admins: unconstrained (can edit history). Teachers: 2-day window, no future.
    const note = $("#attendanceWindowNote");
    if (isAdminOrAbove()) {
      picker.removeAttribute("min");
      picker.removeAttribute("max");
      note.style.display = "none";
    } else {
      const today = new Date();
      const earliest = new Date(today); earliest.setDate(earliest.getDate() - 2);
      picker.min = isoDate(earliest);
      picker.max = isoDate(today);
      note.style.display = "";
      note.textContent = "Teachers can take or edit attendance within a 2-day grace window.";
    }
    picker.onchange = () => {
      attendanceModalSessionDate = picker.value;
      attendancePendingMarks = {};
      attendancePendingNotes = {};
      attendancePendingLateMinutes = {};
      renderAttendanceRoster();
    };

    renderAttendanceRoster();
    $("#attendanceModalOverlay").classList.add("open");
  }

  function closeAttendanceModal() {
    $("#attendanceModalOverlay").classList.remove("open");
    attendanceModalClassId = null;
    attendanceModalSessionDate = null;
    attendancePendingMarks = {};
    attendancePendingNotes = {};
    attendancePendingLateMinutes = {};
  }

  // Re-render the student list in the modal based on current state.
  function renderAttendanceRoster() {
    const host = $("#attendanceRoster");
    if (!host) return;
    const cls = state.classes.find((c) => c.id === attendanceModalClassId);
    if (!cls) { host.innerHTML = ""; return; }
    const enrollments = state.enrollments
      .filter((e) => e.class_id === cls.id && e.status === "active")
      .map((e) => ({ ...e, student: state.students.find((s) => s.id === e.student_id) }))
      .filter((x) => x.student && !x.student.archived_at)
      .sort((a, b) => (a.student.last_name || "").localeCompare(b.student.last_name || ""));

    if (enrollments.length === 0) {
      host.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:12px 0">No active enrollments for this class.</div>';
      return;
    }

    const existing = attendanceMapForSession(cls.id, attendanceModalSessionDate);
    const rowsHtml = enrollments.map(({ id, student }) => {
      const existingRow = existing.get(id);
      // Normalize legacy status values so P/A buttons still reflect them.
      const existingStatus = (() => {
        const s = existingRow?.status;
        if (s === "late") return "present";
        if (s === "excused") return "absent";
        return s || "unknown";
      })();
      const pending = attendancePendingMarks[id];
      const currentStatus = pending !== undefined ? pending : existingStatus;
      const existingNotes = existingRow?.notes || "";
      const currentNotes = attendancePendingNotes[id] !== undefined ? attendancePendingNotes[id] : existingNotes;
      const existingLateMin = existingRow?.late_pickup_minutes ?? null;
      const currentLateMin = attendancePendingLateMinutes[id] !== undefined
        ? attendancePendingLateMinutes[id]
        : existingLateMin;
      const lateVal = (currentLateMin != null && currentLateMin > 0) ? String(currentLateMin) : "";

      const btns = ATT_STATUSES.map((s) => {
        const active = currentStatus === s;
        const label = s === "present" ? "Present" : "Absent";
        const color = active
          ? (s === "present" ? "#2f7d3a" : "#b3341c")
          : "transparent";
        return `<button data-att-btn data-enr="${escapeHtml(id)}" data-status="${s}" title="${s}"
          style="border:1px solid var(--border);background:${active ? color : "var(--surface)"};color:${active ? "#fff" : "var(--ink)"};border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer">${label}</button>`;
      }).join(" ");

      return `
        <div class="att-row" style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-subtle,#eee)">
          <div>
            <div style="font-weight:500">${escapeHtml(student.first_name || "")} ${escapeHtml(student.last_name || "")}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
              <input type="text" data-att-notes data-enr="${escapeHtml(id)}" placeholder="Notes (optional)" value="${escapeHtml(currentNotes)}"
                style="flex:1;min-width:140px;max-width:260px;font-size:11.5px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;color:var(--ink-dim);background:transparent" />
              <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ink-dim)">
                <span>Late pickup</span>
                <input type="number" min="0" step="1" data-att-late data-enr="${escapeHtml(id)}" value="${lateVal}" placeholder="min"
                  ${currentStatus === "absent" ? "disabled" : ""}
                  style="width:60px;font-size:11.5px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:transparent" />
              </label>
            </div>
          </div>
          <div style="display:flex;gap:6px">${btns}</div>
        </div>`;
    }).join("");

    host.innerHTML = rowsHtml;

    // Wire status buttons — click toggles; clicking the active status clears to 'unknown'.
    // Marking a student Absent also clears their late-pickup minutes (can't be late picked-up if not present).
    host.querySelectorAll("[data-att-btn]").forEach((b) => {
      b.onclick = () => {
        const enr = b.dataset.enr;
        const status = b.dataset.status;
        const existingRow = existing.get(enr);
        const existingStatus = (() => {
          const s = existingRow?.status;
          if (s === "late") return "present";
          if (s === "excused") return "absent";
          return s || "unknown";
        })();
        const pending = attendancePendingMarks[enr];
        const current = pending !== undefined ? pending : existingStatus;
        if (current === status) {
          attendancePendingMarks[enr] = "unknown";
        } else {
          attendancePendingMarks[enr] = status;
          if (status === "absent") attendancePendingLateMinutes[enr] = null;
        }
        renderAttendanceRoster();
      };
    });
    host.querySelectorAll("[data-att-notes]").forEach((inp) => {
      inp.oninput = () => { attendancePendingNotes[inp.dataset.enr] = inp.value; };
    });
    host.querySelectorAll("[data-att-late]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value.trim();
        attendancePendingLateMinutes[inp.dataset.enr] = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
      };
    });
  }

  async function markAllPresent() {
    const cls = state.classes.find((c) => c.id === attendanceModalClassId);
    if (!cls) return;
    const enrollments = state.enrollments
      .filter((e) => e.class_id === cls.id && e.status === "active");
    for (const e of enrollments) attendancePendingMarks[e.id] = "present";
    renderAttendanceRoster();
  }

  async function saveAttendance() {
    const classId = attendanceModalClassId;
    const sessionDate = attendanceModalSessionDate;
    if (!classId || !sessionDate) { showToast("No session loaded", "error"); return; }

    // Build entries array. Merge pending marks with existing rows so notes or
    // late-pickup-only changes still get persisted. Skip entries where the
    // effective status is 'unknown', there's no late pickup, AND there was
    // no existing row (nothing to record).
    const existing = attendanceMapForSession(classId, sessionDate);
    const activeEnrollments = state.enrollments
      .filter((e) => e.class_id === classId && e.status === "active");
    const entries = [];
    for (const e of activeEnrollments) {
      const prior = existing.get(e.id);
      const priorStatus = prior?.status || "unknown";
      const priorNotes  = prior?.notes || "";
      const priorLate   = prior?.late_pickup_minutes ?? null;
      const status = attendancePendingMarks[e.id] !== undefined ? attendancePendingMarks[e.id] : priorStatus;
      const notes  = attendancePendingNotes[e.id] !== undefined ? attendancePendingNotes[e.id] : priorNotes;
      const lateMin = attendancePendingLateMinutes[e.id] !== undefined
        ? attendancePendingLateMinutes[e.id]
        : priorLate;
      // Absent students can't have a late pickup; null it.
      const effectiveLate = status === "absent" ? null : lateMin;
      if (status === "unknown" && !effectiveLate && !prior) continue;
      entries.push({
        enrollment_id: e.id,
        status,
        notes: notes || null,
        late_pickup_minutes: effectiveLate != null && effectiveLate > 0 ? effectiveLate : null,
      });
    }

    if (entries.length === 0) {
      showToast("Mark at least one student before saving", "error");
      return;
    }

    showLoader(true);
    const { error } = await sb.rpc("take_attendance", {
      p_class_id: classId,
      p_session_date: sessionDate,
      p_entries: entries,
    });
    showLoader(false);
    if (error) { showToast("Save failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeAttendanceModal();
    showToast(`Attendance saved (${entries.length})`, "success");
  }

  /* ═════════════ Schools + class cancellations + notifications (Phase T8) ═════════════
   *
   * Schools:
   *   - First-class entity replacing the free-form classes.location string
   *     (the string still lives on classes — JR sync writes it; we read
   *     it as a fallback when school_id is null).
   *   - Each school has a primary contact (long-term ops, principal-level)
   *     and a daily contact (day-of-class person who needs to know about
   *     subs / cancellations). Same person allowed via copy-paste.
   *
   * Class cancellations:
   *   - Single-session class cancellations (vs. closures, which are
   *     whole-day, all-classes-at-a-school events).
   *   - Saved as one class_cancellations row per (class_id, session_date).
   *   - Schedule day/week/month views render cancelled sessions muted
   *     with a "cancelled" pill.
   *
   * Notify daily contact:
   *   - One modal handles both notification types (sub assigned, class
   *     cancelled). Pre-fills a subject + body the admin can edit, then
   *     a "Copy email" button puts the body on the clipboard plus opens
   *     a mailto: link. No actual email sending — DK doesn't have SMTP
   *     for this and admins prefer to send from their own email anyway.
   */

  function schoolForClass(cls) {
    if (!cls) return null;
    if (cls.school_id) {
      return state.schools.find((s) => s.id === cls.school_id) || null;
    }
    return null;
  }

  // The display label for a class's location: school name when linked,
  // otherwise the legacy free-form `location` string. Empty string if
  // neither is available.
  function classLocationLabel(cls) {
    const s = schoolForClass(cls);
    if (s) return s.name;
    return cls?.location || "";
  }

  function classCancellationFor(classId, sessionDate) {
    return state.classCancellations.find(
      (c) => c.class_id === classId && c.session_date === sessionDate
    ) || null;
  }

  /* ─── Schools tab ─── */

  function renderSchoolsTab() {
    const panel = document.querySelector('.tab-panel[data-tab="schools"]');
    if (!panel) return;
    if (!canSeeTab("schools")) return;

    const canEdit = hasPerm("edit_classes");
    const q = (state.schState.query || "").toLowerCase();
    const showInactive = !!state.schState.showInactive;

    const filtered = state.schools
      .filter((s) => showInactive || s.active !== false)
      .filter((s) => {
        if (!q) return true;
        const hay = [
          s.name, s.city, s.state,
          s.primary_contact_name, s.primary_contact_email,
          s.daily_contact_name, s.daily_contact_email
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });

    // Per-school class count (active classes only, regardless of test toggle).
    const classCountByLoc = new Map();
    for (const c of state.classes) {
      if (!c.school_id) continue;
      classCountByLoc.set(c.school_id, (classCountByLoc.get(c.school_id) || 0) + 1);
    }
    // Also surface a count of "unlinked" classes that still rely on the
    // free-form location string — handy banner so admins know why they
    // aren't seeing every class on a Schools card yet.
    const unlinkedCount = state.classes.filter(
      (c) => !c.school_id && c.location && c.location.trim() !== ""
    ).length;

    const cards = filtered.map((s) => renderSchoolCard(s, classCountByLoc.get(s.id) || 0)).join("");
    const empty = filtered.length === 0
      ? `<div class="sr-empty">${state.schools.length === 0
          ? "No schools yet. Click <b>＋ New school</b> to add one — or apply phase_t8_schools.sql to backfill from existing class locations."
          : "No schools match this filter."}</div>`
      : "";

    const unlinkedBanner = (unlinkedCount > 0 && canEdit)
      ? `<div class="schools-unlinked-banner">${unlinkedCount} class${unlinkedCount === 1 ? "" : "es"} still use a free-form location string. Open the class and pick a school from the dropdown to link.</div>`
      : "";

    panel.innerHTML = `
      <div class="tab-head">
        <div class="results-meta">${state.schools.length} school${state.schools.length === 1 ? "" : "s"}${state.schools.length > 0 ? ` · ${state.schools.filter(s => s.active !== false).length} active` : ""}</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <input type="search" id="schoolSearch" placeholder="Search schools…" value="${escapeHtml(state.schState.query)}" style="font-size:12.5px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;min-width:160px" />
          <label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-dim); cursor:pointer">
            <input type="checkbox" id="showInactiveSchools" ${showInactive ? "checked" : ""} /> Show inactive
          </label>
          ${canEdit ? `<button class="btn primary small" id="newSchoolBtn" type="button">＋ New school</button>` : ""}
        </div>
      </div>
      ${unlinkedBanner}
      <div class="schools-grid">${cards}${empty}</div>
    `;

    const search = panel.querySelector("#schoolSearch");
    if (search) search.oninput = (e) => { state.schState.query = e.target.value; renderSchoolsTab(); };
    const inact = panel.querySelector("#showInactiveSchools");
    if (inact) inact.onchange = (e) => { state.schState.showInactive = !!e.target.checked; renderSchoolsTab(); };
    const nb = panel.querySelector("#newSchoolBtn");
    if (nb) nb.onclick = () => openSchoolEditor(null);

    panel.querySelectorAll("[data-school-edit]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openSchoolEditor(b.dataset.schoolEdit); };
    });
  }

  function renderSchoolCard(s, classCount) {
    const canEdit = hasPerm("edit_classes");
    const inactive = s.active === false ? `<span class="school-inactive-pill">inactive</span>` : "";
    const pc = s.primary_contact_name || s.primary_contact_email
      ? `
        <div class="school-contact">
          <div class="school-contact-label">Primary contact${s.primary_contact_role ? ` · ${escapeHtml(s.primary_contact_role)}` : ""}</div>
          ${s.primary_contact_name ? `<div class="school-contact-name">${escapeHtml(s.primary_contact_name)}</div>` : ""}
          ${s.primary_contact_email ? `<div class="school-contact-line"><a href="mailto:${escapeHtml(s.primary_contact_email)}">${escapeHtml(s.primary_contact_email)}</a></div>` : ""}
          ${s.primary_contact_phone ? `<div class="school-contact-line">${escapeHtml(s.primary_contact_phone)}</div>` : ""}
        </div>
      `
      : "";
    const dc = s.daily_contact_name || s.daily_contact_email
      ? `
        <div class="school-contact">
          <div class="school-contact-label">Daily contact${s.daily_contact_role ? ` · ${escapeHtml(s.daily_contact_role)}` : ""}</div>
          ${s.daily_contact_name ? `<div class="school-contact-name">${escapeHtml(s.daily_contact_name)}</div>` : ""}
          ${s.daily_contact_email ? `<div class="school-contact-line"><a href="mailto:${escapeHtml(s.daily_contact_email)}">${escapeHtml(s.daily_contact_email)}</a></div>` : ""}
          ${s.daily_contact_phone ? `<div class="school-contact-line">${escapeHtml(s.daily_contact_phone)}</div>` : ""}
        </div>
      `
      : "";
    const noContacts = !pc && !dc
      ? `<div class="school-contact-missing">No contacts on file yet${canEdit ? " — click Edit to add." : "."}</div>`
      : "";
    const addrLine = [s.city, s.state].filter(Boolean).join(", ");
    return `
      <div class="school-card${s.active === false ? " inactive" : ""}">
        <div class="school-card-head">
          <div>
            <div class="school-name">${escapeHtml(s.name)} ${inactive}</div>
            ${addrLine ? `<div class="school-addr">${escapeHtml(addrLine)}</div>` : ""}
          </div>
          ${canEdit ? `<button class="btn small" data-school-edit="${escapeHtml(s.id)}" type="button">Edit</button>` : ""}
        </div>
        <div class="school-meta-row">
          <span class="school-class-count">${classCount} class${classCount === 1 ? "" : "es"}</span>
        </div>
        <div class="school-contacts">
          ${pc}
          ${dc}
          ${noContacts}
        </div>
      </div>
    `;
  }

  /* ─── School editor modal ─── */

  let editingSchoolId = null;

  function openSchoolEditor(id) {
    editingSchoolId = id || null;
    const s = id ? state.schools.find((x) => x.id === id) : null;
    $("#schoolModalTitle").textContent = s ? "Edit school" : "New school";
    $("#sc_name").value                 = s ? (s.name || "") : "";
    $("#sc_address_line1").value        = s ? (s.address_line1 || "") : "";
    $("#sc_address_line2").value        = s ? (s.address_line2 || "") : "";
    $("#sc_city").value                 = s ? (s.city || "") : "";
    $("#sc_state").value                = s ? (s.state || "") : "";
    $("#sc_postal_code").value          = s ? (s.postal_code || "") : "";
    $("#sc_primary_name").value         = s ? (s.primary_contact_name || "") : "";
    $("#sc_primary_role").value         = s ? (s.primary_contact_role || "") : "";
    $("#sc_primary_email").value        = s ? (s.primary_contact_email || "") : "";
    $("#sc_primary_phone").value        = s ? (s.primary_contact_phone || "") : "";
    $("#sc_daily_name").value           = s ? (s.daily_contact_name || "") : "";
    $("#sc_daily_role").value           = s ? (s.daily_contact_role || "") : "";
    $("#sc_daily_email").value          = s ? (s.daily_contact_email || "") : "";
    $("#sc_daily_phone").value          = s ? (s.daily_contact_phone || "") : "";
    $("#sc_notes").value                = s ? (s.notes || "") : "";
    $("#sc_active").value               = (s && s.active === false) ? "false" : "true";
    $("#deleteSchoolBtn").style.display = s ? "" : "none";
    $("#schoolModalOverlay").classList.add("open");
    setTimeout(() => $("#sc_name").focus(), 50);
  }

  function closeSchoolEditor() {
    $("#schoolModalOverlay").classList.remove("open");
    editingSchoolId = null;
  }

  // Copy daily-contact fields from primary-contact fields. Useful when
  // it's the same person.
  function copyPrimaryToDailyContact() {
    $("#sc_daily_name").value  = $("#sc_primary_name").value;
    $("#sc_daily_role").value  = $("#sc_primary_role").value;
    $("#sc_daily_email").value = $("#sc_primary_email").value;
    $("#sc_daily_phone").value = $("#sc_primary_phone").value;
    showToast("Copied primary contact to daily contact", "success");
  }

  async function saveSchool() {
    const name = $("#sc_name").value.trim();
    if (!name) { showToast("School name is required", "error"); return; }
    const payload = {
      name,
      address_line1: $("#sc_address_line1").value.trim() || null,
      address_line2: $("#sc_address_line2").value.trim() || null,
      city:          $("#sc_city").value.trim() || null,
      state:         $("#sc_state").value.trim() || null,
      postal_code:   $("#sc_postal_code").value.trim() || null,
      primary_contact_name:  $("#sc_primary_name").value.trim() || null,
      primary_contact_role:  $("#sc_primary_role").value.trim() || null,
      primary_contact_email: $("#sc_primary_email").value.trim() || null,
      primary_contact_phone: $("#sc_primary_phone").value.trim() || null,
      daily_contact_name:    $("#sc_daily_name").value.trim() || null,
      daily_contact_role:    $("#sc_daily_role").value.trim() || null,
      daily_contact_email:   $("#sc_daily_email").value.trim() || null,
      daily_contact_phone:   $("#sc_daily_phone").value.trim() || null,
      notes:                 $("#sc_notes").value.trim() || null,
      active: $("#sc_active").value !== "false",
    };

    showLoader(true);
    let resp;
    if (editingSchoolId) {
      resp = await sb.from("schools").update(payload).eq("id", editingSchoolId).select().single();
    } else {
      // Generate a slug client-side for new schools so we don't need to
      // round-trip a uniqueness check; collisions hit the unique index
      // and we retry once with a numeric suffix.
      const baseSlug = slugify(name) || "school";
      const existingSlugs = new Set(state.schools.map((x) => x.slug));
      payload.slug = uniqueSlug(baseSlug, existingSlugs);
      resp = await sb.from("schools").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeSchoolEditor();
    showToast(editingSchoolId ? "School updated" : "School added", "success");
  }

  async function deleteSchool() {
    if (!editingSchoolId) return;
    const linkedCount = state.classes.filter((c) => c.school_id === editingSchoolId).length;
    const warn = linkedCount > 0
      ? `Delete this school? ${linkedCount} class${linkedCount === 1 ? "" : "es"} currently linked to it will lose the school link (the free-form location string is unaffected).`
      : "Delete this school? This can't be undone.";
    if (!confirm(warn)) return;
    showLoader(true);
    const { error } = await sb.from("schools").delete().eq("id", editingSchoolId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeSchoolEditor();
    showToast("School deleted", "success");
  }

  /* ─── Class-cancellation flow ─── */

  // Cancel a specific class on a specific date. Called from the class
  // detail panel "Cancel class for [date]" action. Opens a small modal
  // for the reason; on save, INSERTs class_cancellations and immediately
  // pops the notify modal so the admin can email the daily contact.
  let cancelClassContext = null; // { cls, sessionDate }

  function openClassCancelModal(cls, sessionDate) {
    if (!cls) return;
    cancelClassContext = { cls, sessionDate };
    $("#cc_class_banner").innerHTML =
      `Cancelling <b>${escapeHtml(cls.name)}</b> on <b>${escapeHtml(formatSessionDate(sessionDate))}</b>` +
      (classLocationLabel(cls) ? ` <span style="color:var(--ink-dim)">· ${escapeHtml(classLocationLabel(cls))}</span>` : "");
    $("#cc_reason").value = "";
    $("#classCancelOverlay").classList.add("open");
    setTimeout(() => $("#cc_reason").focus(), 50);
  }

  function closeClassCancelModal() {
    $("#classCancelOverlay").classList.remove("open");
    cancelClassContext = null;
  }

  async function submitClassCancel() {
    const ctx = cancelClassContext;
    if (!ctx) return;
    const reason = $("#cc_reason").value.trim();
    showLoader(true);
    const { data, error } = await sb.from("class_cancellations").insert({
      class_id: ctx.cls.id,
      session_date: ctx.sessionDate,
      reason: reason || null,
      cancelled_by_user_id: state.session?.user?.id || null,
    }).select().single();
    showLoader(false);
    if (error) { showToast("Cancel failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeClassCancelModal();
    showToast("Class cancelled", "success");
    // Immediately offer to notify the daily contact.
    openNotifyModal({
      kind: "class_cancelled",
      cls: ctx.cls,
      sessionDate: ctx.sessionDate,
      reason: reason,
      cancellationId: data?.id || null,
    });
  }

  async function uncancelClassSession(cancellationId) {
    if (!cancellationId) return;
    if (!confirm("Un-cancel this session? The schedule will show it as a normal class day again.")) return;
    showLoader(true);
    const { error } = await sb.from("class_cancellations").delete().eq("id", cancellationId);
    showLoader(false);
    if (error) { showToast("Couldn't un-cancel: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Class restored", "success");
  }

  /* ─── Notify daily contact modal ─── */

  // Notification kinds:
  //   "sub_assigned"    — fired after fill_sub_request success
  //   "class_cancelled" — fired after a class_cancellations row is saved
  //
  // The modal pre-fills a subject + body the admin can edit. On save:
  //   - copies body to clipboard
  //   - opens mailto: in a new tab (with the daily contact pre-filled)
  //   - if a cancellation_id was passed, stamps notified_at via RPC
  let notifyContext = null;

  function openNotifyModal(opts) {
    notifyContext = opts || {};
    const { kind, cls, sessionDate } = notifyContext;
    if (!cls) { showToast("No class context for notification", "error"); return; }
    const school = schoolForClass(cls);
    const dailyEmail = school?.daily_contact_email || "";
    const dailyName = school?.daily_contact_name || "";

    const dateStr = formatSessionDate(sessionDate);
    const dayClass = state.classes.find((c) => c.id === cls.id) || cls;
    const timeStr = (() => {
      const t = classStartTimeOn(dayClass, new Date(sessionDate + "T00:00:00"));
      return t ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    })();
    const senderFromCfg = state.dkConfig?.sender_name || "Drama Kids";

    let subject, body;
    if (kind === "sub_assigned") {
      const subTeacher = notifyContext.subTeacher;
      const subName = subTeacher?.full_name || "a substitute";
      subject = `Substitute teacher for ${cls.name} on ${dateStr}`;
      body = [
        `Hi${dailyName ? " " + dailyName.split(/\s+/)[0] : ""},`,
        ``,
        `Heads up — ${subName} will be covering our ${cls.name} class on ${dateStr}${timeStr ? ` at ${timeStr}` : ""} in place of the regular teacher.`,
        ``,
        notifyContext.reason ? `Reason: ${notifyContext.reason}` : ``,
        `Please let me know if you have any questions or if there's anyone the front desk should be expecting.`,
        ``,
        `Thanks,`,
        senderFromCfg,
      ].filter((l) => l !== undefined).join("\n");
    } else if (kind === "class_cancelled") {
      subject = `Class cancelled: ${cls.name} on ${dateStr}`;
      body = [
        `Hi${dailyName ? " " + dailyName.split(/\s+/)[0] : ""},`,
        ``,
        `Apologies for the short notice — our ${cls.name} class on ${dateStr}${timeStr ? ` at ${timeStr}` : ""} has been cancelled.`,
        ``,
        notifyContext.reason ? `Reason: ${notifyContext.reason}` : ``,
        `We'll be in touch with families directly. Please let me know if you need anything from us on your end.`,
        ``,
        `Thanks,`,
        senderFromCfg,
      ].filter((l) => l !== undefined).join("\n");
    } else {
      subject = `Update for ${cls.name} on ${dateStr}`;
      body = `(custom message)`;
    }

    $("#nf_kind_label").textContent = kind === "sub_assigned"
      ? "Sub assigned notification"
      : kind === "class_cancelled"
        ? "Class cancellation notification"
        : "Notification";
    $("#nf_to").value = dailyEmail;
    $("#nf_to_name").textContent = dailyName ? `(${dailyName})` : "";
    $("#nf_school").textContent = school ? school.name : (cls.location || "—");
    $("#nf_subject").value = subject;
    $("#nf_body").value = body;
    $("#nf_no_contact_warn").style.display = dailyEmail ? "none" : "";

    $("#notifyModalOverlay").classList.add("open");
    setTimeout(() => $("#nf_subject").focus(), 50);
  }

  function closeNotifyModal() {
    $("#notifyModalOverlay").classList.remove("open");
    notifyContext = null;
  }

  async function copyNotifyEmail() {
    const subject = $("#nf_subject").value;
    const body = $("#nf_body").value;
    const composed = `Subject: ${subject}\n\n${body}`;
    const ok = await copyText(composed);
    if (ok) flashCopied($("#nf_copy_btn"));
    else showToast("Couldn't copy — your browser may need permission", "error");
  }

  function openNotifyMailto() {
    const to = $("#nf_to").value.trim();
    const subject = $("#nf_subject").value;
    const body = $("#nf_body").value;
    if (!to) {
      showToast("No daily-contact email on file for this school. Add one in the Schools tab.", "error");
      return;
    }
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
    // If this notification is tied to a cancellation row, stamp notified_at
    // so the schedule pill can show "Notified ✓".
    if (notifyContext?.cancellationId) {
      sb.rpc("mark_class_cancellation_notified", { p_cancellation_id: notifyContext.cancellationId })
        .then(({ error }) => {
          if (!error) reloadAll().then(renderAll);
        });
    }
  }

  /* ═════════════ EVENTS tab (T9) ═════════════
   *
   * Special events: free classes, trainings, promotional events. Distinct
   * from `classes` (recurring, JR-synced) and `closures` (whole-day). The
   * Events tab is the dedicated CRUD surface; the schedule renders events
   * alongside classes via eventsForDate().
   */

  function renderEventsTab() {
    const panel = document.querySelector('.tab-panel[data-tab="events"]');
    if (!panel) return;
    if (!canSeeTab("events")) return;

    const canEdit = hasPerm("edit_events");
    const filter = state.evState.kindFilter || "all";
    const when = state.evState.when || "upcoming";
    const now = new Date();

    const filtered = state.events
      .filter((ev) => filter === "all" || ev.kind === filter)
      .filter((ev) => {
        const end = new Date(ev.ends_at);
        if (when === "upcoming") return end >= now;
        if (when === "past") return end < now;
        return true;
      })
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

    const kindChips = [{ id: "all", label: "All kinds" }]
      .concat(EVENT_KIND_OPTIONS.map((o) => ({ id: o.value, label: o.label })))
      .map((c) => `<button class="chip${filter === c.id ? " active" : ""}" data-ev-kind="${escapeHtml(c.id)}" type="button">${escapeHtml(c.label)}</button>`)
      .join("");

    const whenChips = [
      { id: "upcoming", label: "Upcoming" },
      { id: "past",     label: "Past" },
      { id: "all",      label: "All time" }
    ].map((c) => `<button class="chip${when === c.id ? " active" : ""}" data-ev-when="${escapeHtml(c.id)}" type="button">${escapeHtml(c.label)}</button>`).join("");

    const cards = filtered.map(renderEventCard).join("");
    const empty = filtered.length === 0
      ? `<div class="sr-empty">${state.events.length === 0
          ? `No events yet.${canEdit ? " Click <b>＋ New event</b> to add one." : ""}`
          : "No events match this filter."}</div>`
      : "";

    panel.innerHTML = `
      <div class="tab-head">
        <div class="results-meta">${state.events.length} event${state.events.length === 1 ? "" : "s"}</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          ${canEdit ? `<button class="btn primary small" id="newEventBtn" type="button">＋ New event</button>` : ""}
        </div>
      </div>
      <div class="ev-filters">
        <div class="ev-chip-row">${whenChips}</div>
        <div class="ev-chip-row">${kindChips}</div>
      </div>
      <div class="ev-grid">${cards}${empty}</div>
    `;

    const nb = panel.querySelector("#newEventBtn");
    if (nb) nb.onclick = () => openEventEditor(null);

    panel.querySelectorAll("[data-ev-kind]").forEach((b) => {
      b.onclick = () => { state.evState.kindFilter = b.dataset.evKind; renderEventsTab(); };
    });
    panel.querySelectorAll("[data-ev-when]").forEach((b) => {
      b.onclick = () => { state.evState.when = b.dataset.evWhen; renderEventsTab(); };
    });
    panel.querySelectorAll("[data-event-edit]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openEventEditor(b.dataset.eventEdit); };
    });
  }

  function renderEventCard(ev) {
    const canEdit = hasPerm("edit_events");
    const hue = eventKindHue(ev.kind);
    const start = new Date(ev.starts_at);
    const end = new Date(ev.ends_at);
    const sameDay = isoDate(start) === isoDate(end);
    const dateStr = sameDay
      ? start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
      : `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    const timeStr = sameDay
      ? `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "";
    const sch = ev.school_id ? state.schools.find((s) => s.id === ev.school_id) : null;
    const loc = sch ? sch.name : (ev.location || "");
    const staff = eventStaffTeachersFor(ev.id);
    const staffRow = staff.length
      ? staff.map((t) => `<span class="ev-staff-chip">${escapeHtml(t.full_name)}</span>`).join("")
      : `<span class="ev-staff-empty">No staff assigned yet</span>`;
    const cancelTag = ev.is_cancelled ? `<span class="ev-cancel-pill">cancelled</span>` : "";
    return `
      <div class="ev-card${ev.is_cancelled ? " cancelled" : ""}" style="border-top:3px solid hsl(${hue},62%,58%)">
        <div class="ev-card-head">
          <div class="ev-card-kind" style="background:hsla(${hue},62%,58%,.18); color:hsl(${hue},62%,72%); border:1px solid hsla(${hue},62%,58%,.35)">★ ${escapeHtml(eventKindLabel(ev.kind))}</div>
          ${canEdit ? `<button class="btn small" data-event-edit="${escapeHtml(ev.id)}" type="button">Edit</button>` : ""}
        </div>
        <div class="ev-card-title">${escapeHtml(ev.title)} ${cancelTag}</div>
        <div class="ev-card-when">${escapeHtml(dateStr)}${timeStr ? ` · ${escapeHtml(timeStr)}` : ""}</div>
        ${loc ? `<div class="ev-card-where">${escapeHtml(loc)}</div>` : ""}
        ${ev.description ? `<div class="ev-card-desc">${escapeHtml(ev.description)}</div>` : ""}
        ${ev.capacity != null ? `<div class="ev-card-capacity">Capacity: ${ev.capacity}</div>` : ""}
        <div class="ev-card-staff">${staffRow}</div>
      </div>
    `;
  }

  /* ─── Event editor modal (T9) ─── */

  let editingEventId = null;
  // Pending staff additions before save when creating a new event (no event
  // id to attach event_staff rows to yet). Saved on the same click as the
  // event row.
  let pendingNewEventStaff = [];

  function openEventEditor(id) {
    const canEdit = hasPerm("edit_events");
    if (!canEdit && id == null) return;
    editingEventId = id || null;
    pendingNewEventStaff = [];
    const ev = id ? state.events.find((x) => x.id === id) : null;

    $("#eventModalTitle").textContent = ev ? "Edit event" : "New event";

    // Kind select
    const kindSel = $("#ev_kind");
    kindSel.innerHTML = EVENT_KIND_OPTIONS.map(
      (o) => `<option value="${escapeHtml(o.value)}"${ev && ev.kind === o.value ? " selected" : ""}>${escapeHtml(o.label)}</option>`
    ).join("");

    $("#ev_title").value = ev ? (ev.title || "") : "";
    $("#ev_description").value = ev ? (ev.description || "") : "";

    // Datetime inputs use <input type="datetime-local"> which expects
    // "YYYY-MM-DDTHH:MM" in local time. Default new events to today 4pm-5pm.
    const defStart = new Date(); defStart.setHours(16, 0, 0, 0);
    const defEnd   = new Date(); defEnd.setHours(17, 0, 0, 0);
    $("#ev_starts_at").value = toDatetimeLocalInput(ev ? new Date(ev.starts_at) : defStart);
    $("#ev_ends_at").value   = toDatetimeLocalInput(ev ? new Date(ev.ends_at)   : defEnd);

    // School dropdown
    const schSel = $("#ev_school_id");
    schSel.innerHTML = `<option value="">— No school —</option>` +
      state.schools
        .filter((s) => s.active !== false)
        .map((s) => `<option value="${escapeHtml(s.id)}"${ev && ev.school_id === s.id ? " selected" : ""}>${escapeHtml(s.name)}</option>`)
        .join("");

    $("#ev_location").value = ev ? (ev.location || "") : "";
    $("#ev_capacity").value = (ev && ev.capacity != null) ? String(ev.capacity) : "";
    $("#ev_notes").value = ev ? (ev.notes || "") : "";
    $("#ev_is_cancelled").checked = !!(ev && ev.is_cancelled);

    $("#deleteEventBtn").style.display = ev ? "" : "none";
    renderEventStaffEditor();
    renderEventInventoryEditor();
    $("#eventModalOverlay").classList.add("open");
    setTimeout(() => $("#ev_title").focus(), 50);
  }

  // T10: render the inventory list inside the event editor for an
  // existing event, plus wire the "+ Assign inventory…" button.
  // Only visible when editing an existing event (we need an event id +
  // resolved time window before we can write inventory_assignments).
  function renderEventInventoryEditor() {
    const section = $("#ev_inventory_section");
    const wrap    = $("#ev_inventory_list");
    const addBtn  = $("#ev_inventory_assign_btn");
    if (!section || !wrap) return;

    if (!editingEventId) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";

    const ev = state.events.find((e) => e.id === editingEventId);
    if (!ev) { wrap.innerHTML = ""; return; }

    const assigns = inventoryAssignmentsForEvent(editingEventId)
      .slice()
      .sort((a, b) => new Date(a.usage_starts_at) - new Date(b.usage_starts_at));

    if (!assigns.length) {
      wrap.innerHTML = `<div class="ev-staff-empty">No inventory assigned.</div>`;
    } else {
      wrap.innerHTML = assigns.map((a) => {
        const it = inventoryItemById(a.item_id);
        const conflicts = conflictsForItemInWindow(a.item_id, new Date(a.usage_starts_at), new Date(a.usage_ends_at), a.id);
        const hasConflict = conflicts.length > 0;
        const status = a.returned_at
          ? `<span class="inv-assign-pill returned">returned</span>`
          : (hasConflict ? `<span class="inv-assign-pill conflict">⚠ conflict</span>` : `<span class="inv-assign-pill active">active</span>`);
        const conflictDetail = hasConflict
          ? `<div class="inv-pick-conflict">⚠ Also assigned: ${escapeHtml(conflicts.map(assignmentTargetLabel).join(", "))}</div>`
          : "";
        return `
          <div class="inv-assign-row${hasConflict ? " has-conflict" : ""}" data-ev-assign-id="${escapeHtml(a.id)}">
            <div class="inv-assign-row-head">
              <div class="inv-assign-row-target">${escapeHtml(it ? it.name : "(deleted item)")}</div>
              ${status}
            </div>
            ${conflictDetail}
            <div class="inv-assign-row-actions">
              <button class="btn ghost small" data-ev-assign-delete="${escapeHtml(a.id)}" type="button">Remove</button>
            </div>
          </div>
        `;
      }).join("");

      wrap.querySelectorAll("[data-ev-assign-delete]").forEach((b) => {
        b.onclick = async () => {
          if (!confirm("Remove this inventory assignment?")) return;
          const { error } = await sb.from("inventory_assignments")
            .delete()
            .eq("id", b.dataset.evAssignDelete);
          if (error) return showToast(error.message, "error");
          await reloadAll();
          renderEventInventoryEditor();
          renderInventoryTab();
        };
      });
    }

    if (addBtn) {
      addBtn.style.display = hasPerm("edit_inventory") ? "" : "none";
      addBtn.onclick = (e) => {
        e.preventDefault();
        // The picker reads the event's starts_at/ends_at directly via
        // inventoryAssignTargetWindow, so it stays in sync if the admin
        // edited the dates in this same session — but only after save.
        openInventoryAssignModal({ kind: "event", eventId: editingEventId });
      };
    }
  }

  function closeEventEditor() {
    $("#eventModalOverlay").classList.remove("open");
    editingEventId = null;
    pendingNewEventStaff = [];
  }

  function toDatetimeLocalInput(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderEventStaffEditor() {
    const wrap = $("#ev_staff_list");
    if (!wrap) return;
    const rows = editingEventId
      ? eventStaffFor(editingEventId).map((es) => {
          const t = state.teachers.find((x) => x.id === es.teacher_id);
          return { staffId: es.id, teacherId: es.teacher_id, teacherName: t ? t.full_name : "(unknown)", role_label: es.role_label || "", notes: es.notes || "" };
        })
      : pendingNewEventStaff.map((p) => {
          const t = state.teachers.find((x) => x.id === p.teacherId);
          return { staffId: null, teacherId: p.teacherId, teacherName: t ? t.full_name : "(unknown)", role_label: p.role_label || "", notes: p.notes || "" };
        });

    if (!rows.length) {
      wrap.innerHTML = `<div class="ev-staff-empty">No staff assigned yet.</div>`;
    } else {
      wrap.innerHTML = rows.map((r) => `
        <div class="ev-staff-row" data-staff-id="${escapeHtml(r.staffId || "")}" data-teacher-id="${escapeHtml(r.teacherId)}">
          <div class="ev-staff-row-name">${escapeHtml(r.teacherName)}</div>
          <input type="text" class="ev-staff-role" placeholder="Role (e.g. Lead)" value="${escapeHtml(r.role_label)}" />
          <button class="btn ghost small" data-staff-remove="${escapeHtml(r.staffId || r.teacherId)}" type="button">Remove</button>
        </div>
      `).join("");
      wrap.querySelectorAll("[data-staff-remove]").forEach((b) => {
        b.onclick = async () => {
          const row = b.closest(".ev-staff-row");
          const staffId = row.dataset.staffId;
          const teacherId = row.dataset.teacherId;
          if (staffId && editingEventId) {
            const { error } = await sb.from("event_staff").delete().eq("id", staffId);
            if (error) return showToast(error.message, "error");
            await reloadAll();
            renderEventStaffEditor();
          } else {
            pendingNewEventStaff = pendingNewEventStaff.filter((p) => p.teacherId !== teacherId);
            renderEventStaffEditor();
          }
        };
      });
      wrap.querySelectorAll(".ev-staff-role").forEach((inp) => {
        inp.onchange = async (e) => {
          const row = inp.closest(".ev-staff-row");
          const staffId = row.dataset.staffId;
          const teacherId = row.dataset.teacherId;
          const val = e.target.value.trim() || null;
          if (staffId && editingEventId) {
            const { error } = await sb.from("event_staff").update({ role_label: val }).eq("id", staffId);
            if (error) return showToast(error.message, "error");
            await reloadAll();
          } else {
            const p = pendingNewEventStaff.find((x) => x.teacherId === teacherId);
            if (p) p.role_label = val;
          }
        };
      });
    }

    // Add-staff dropdown
    const addSel = $("#ev_staff_add");
    if (addSel) {
      const assignedIds = new Set(rows.map((r) => r.teacherId));
      addSel.innerHTML = `<option value="">＋ Add staff…</option>` +
        state.teachers
          .filter((t) => t.active !== false && !assignedIds.has(t.id))
          .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.full_name)}</option>`)
          .join("");
      addSel.onchange = async (e) => {
        const teacherId = e.target.value;
        if (!teacherId) return;
        if (editingEventId) {
          const { error } = await sb.from("event_staff").insert({ event_id: editingEventId, teacher_id: teacherId });
          if (error) { showToast(error.message, "error"); e.target.value = ""; return; }
          await reloadAll();
        } else {
          pendingNewEventStaff.push({ teacherId, role_label: "", notes: "" });
        }
        e.target.value = "";
        renderEventStaffEditor();
      };
    }
  }

  async function saveEvent() {
    const title = $("#ev_title").value.trim();
    if (!title) { showToast("Title is required", "error"); return; }
    const startsAt = $("#ev_starts_at").value;
    const endsAt = $("#ev_ends_at").value;
    if (!startsAt || !endsAt) { showToast("Start and end times are required", "error"); return; }
    if (new Date(endsAt) <= new Date(startsAt)) {
      showToast("End must be after start", "error");
      return;
    }
    const capRaw = $("#ev_capacity").value.trim();
    const capacity = capRaw === "" ? null : parseInt(capRaw, 10);
    if (capRaw !== "" && (isNaN(capacity) || capacity < 0)) {
      showToast("Capacity must be a non-negative number", "error");
      return;
    }

    const payload = {
      kind: $("#ev_kind").value,
      title,
      description: $("#ev_description").value.trim() || null,
      starts_at: new Date(startsAt).toISOString(),
      ends_at:   new Date(endsAt).toISOString(),
      school_id: $("#ev_school_id").value || null,
      location:  $("#ev_location").value.trim() || null,
      capacity,
      notes:     $("#ev_notes").value.trim() || null,
      is_cancelled: $("#ev_is_cancelled").checked
    };

    showLoader(true);
    let resp;
    if (editingEventId) {
      resp = await sb.from("events").update(payload).eq("id", editingEventId).select().single();
    } else {
      payload.created_by = state.session?.user?.id || null;
      resp = await sb.from("events").insert(payload).select().single();
    }
    if (resp.error) {
      showLoader(false);
      showToast(resp.error.message, "error");
      return;
    }
    const savedId = resp.data.id;

    // For new events with pending staff additions, insert event_staff rows.
    if (!editingEventId && pendingNewEventStaff.length) {
      const rows = pendingNewEventStaff.map((p) => ({
        event_id: savedId,
        teacher_id: p.teacherId,
        role_label: p.role_label || null,
        notes: p.notes || null
      }));
      const { error } = await sb.from("event_staff").insert(rows);
      if (error) {
        showLoader(false);
        showToast("Event saved, but staff insert failed: " + error.message, "error");
        await reloadAll(); renderAll();
        closeEventEditor();
        return;
      }
    }

    showLoader(false);
    showToast(editingEventId ? "Event saved" : "Event created", "success");
    await reloadAll(); renderAll();
    closeEventEditor();
  }

  async function deleteEvent() {
    if (!editingEventId) return;
    if (!confirm("Delete this event? Staff assignments will be removed too. This cannot be undone.")) return;
    showLoader(true);
    const { error } = await sb.from("events").delete().eq("id", editingEventId);
    showLoader(false);
    if (error) return showToast(error.message, "error");
    showToast("Event deleted", "success");
    await reloadAll(); renderAll();
    closeEventEditor();
  }

  /* ═════════════ Inventory (Phase T10) ═════════════
   *
   * Items = props/costumes/supplies/equipment. Each item carries a name,
   * description, storage_location, tags, photos (in the public
   * `inventory-photos` bucket), reorder_url, and notes.
   *
   * Assignments = item × (class session OR event). Conflict semantics:
   * an item can only be in one place at a time. We don't hard-prevent
   * overlapping assignments at the DB level (admins occasionally need to
   * override), but we surface conflicts everywhere they matter:
   *   - On the inventory card (red conflict badge if any active overlap)
   *   - In the assign-picker (red "Conflict — already assigned" warning
   *     under any item that overlaps the target's time window)
   *   - In the item editor's "Current & upcoming assignments" list
   *     (highlighted overlap pairs)
   *
   * Assignment time windows materialize from the parent (class session
   * date+times for class assignments; event starts_at..ends_at for event
   * assignments) at write time, so the conflict overlap query is a
   * single column-level comparison and survives a class's time string
   * later being edited (existing assignments retain their snapshotted
   * window — admin can re-assign if needed).
   */

  function inventoryItemById(id) {
    return state.inventoryItems.find((i) => i.id === id) || null;
  }

  // All non-archived items, alphabetical.
  function activeInventoryItems() {
    return state.inventoryItems
      .filter((i) => !i.is_archived)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  // Distinct tags across items (for the tag filter chips).
  function allInventoryTags() {
    const set = new Set();
    state.inventoryItems.forEach((i) => (i.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function inventoryAssignmentsForItem(itemId) {
    return state.inventoryAssignments.filter((a) => a.item_id === itemId);
  }

  function inventoryAssignmentsForClassSession(classId, sessionDate) {
    return state.inventoryAssignments
      .filter((a) => a.class_id === classId && a.session_date === sessionDate);
  }

  function inventoryAssignmentsForEvent(eventId) {
    return state.inventoryAssignments.filter((a) => a.event_id === eventId);
  }

  // Compute the [start, end] time window for a class session in JS time.
  // Returns null if the class's times can't be parsed; caller should default
  // to a 60-minute window starting at noon if needed.
  function classSessionTimeWindow(cls, sessionDateIso) {
    if (!cls || !sessionDateIso) return null;
    const date = new Date(sessionDateIso + "T12:00:00");
    const startTime = classStartTimeOn(cls, date);
    const durMin = parseClassDurationMinutes(cls) || 60;
    if (startTime) {
      const end = new Date(startTime.getTime() + durMin * 60000);
      return { start: startTime, end };
    }
    // Fallback: noon to 1pm of the session date.
    const start = new Date(sessionDateIso + "T12:00:00");
    const end = new Date(start.getTime() + durMin * 60000);
    return { start, end };
  }

  // Returns true if [aStart, aEnd) overlaps [bStart, bEnd). Half-open so
  // back-to-back assignments (one ends exactly when another starts) don't
  // count as a conflict.
  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  // Find conflicting assignments for an item across [start, end). Excludes
  // returned assignments. Optionally excludes a specific assignment id (the
  // one we're about to write).
  function conflictsForItemInWindow(itemId, start, end, excludeAssignmentId) {
    const startMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
    const endMs   = end   instanceof Date ? end.getTime()   : new Date(end).getTime();
    return state.inventoryAssignments.filter((a) => {
      if (a.item_id !== itemId) return false;
      if (a.returned_at) return false;
      if (excludeAssignmentId && a.id === excludeAssignmentId) return false;
      const aStart = new Date(a.usage_starts_at).getTime();
      const aEnd   = new Date(a.usage_ends_at).getTime();
      return rangesOverlap(aStart, aEnd, startMs, endMs);
    });
  }

  // Returns the count of active conflicts an item has *between any pair of
  // its current assignments*. Used to badge an item in the list.
  function itemConflictCount(itemId) {
    const assigns = inventoryAssignmentsForItem(itemId)
      .filter((a) => !a.returned_at)
      .map((a) => ({ id: a.id, s: new Date(a.usage_starts_at).getTime(), e: new Date(a.usage_ends_at).getTime() }))
      .sort((a, b) => a.s - b.s);
    let count = 0;
    for (let i = 0; i < assigns.length; i++) {
      for (let j = i + 1; j < assigns.length; j++) {
        if (assigns[j].s >= assigns[i].e) break; // sorted by start, so no further overlaps
        if (rangesOverlap(assigns[i].s, assigns[i].e, assigns[j].s, assigns[j].e)) count++;
      }
    }
    return count;
  }

  // Human label for an assignment's target ("3rd-grade Drama · 2026-04-30"
  // or "Free demo class — Lambs ES").
  function assignmentTargetLabel(a) {
    if (a.class_id) {
      const cls = state.classes.find((c) => c.id === a.class_id);
      const name = cls ? (cls.name || "Class") : "(deleted class)";
      return `${name} · ${a.session_date || ""}`;
    }
    if (a.event_id) {
      const ev = state.events.find((e) => e.id === a.event_id);
      return ev ? ev.title : "(deleted event)";
    }
    return "—";
  }

  /* ─── Inventory tab render ─── */

  function renderInventoryTab() {
    const panel = document.querySelector('.tab-panel[data-tab="inventory"]');
    if (!panel) return;
    if (!canSeeTab("inventory")) return;

    const canEdit = hasPerm("edit_inventory");
    const q = (state.invState.query || "").trim().toLowerCase();
    const tagFilter = state.invState.tagFilter || "all";
    const showArchived = !!state.invState.showArchived;

    const filtered = state.inventoryItems
      .filter((i) => showArchived || !i.is_archived)
      .filter((i) => tagFilter === "all" || (i.tags || []).includes(tagFilter))
      .filter((i) => {
        if (!q) return true;
        const hay = [
          i.name, i.description, i.storage_location,
          (i.tags || []).join(" "), i.notes
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const allTags = allInventoryTags();
    const tagChips = [{ id: "all", label: "All tags" }]
      .concat(allTags.map((t) => ({ id: t, label: t })))
      .map((c) => `<button class="chip${tagFilter === c.id ? " active" : ""}" data-inv-tag="${escapeHtml(c.id)}" type="button">${escapeHtml(c.label)}</button>`)
      .join("");

    const cards = filtered.map(renderInventoryCard).join("");
    const empty = filtered.length === 0
      ? `<div class="sr-empty">${state.inventoryItems.length === 0
          ? `No inventory yet.${canEdit ? " Click <b>＋ New item</b> to add one." : ""}`
          : "No items match this filter."}</div>`
      : "";

    panel.innerHTML = `
      <div class="tab-head">
        <div class="results-meta">${state.inventoryItems.length} item${state.inventoryItems.length === 1 ? "" : "s"}</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <input type="text" id="invSearch" class="select-inline" placeholder="Search inventory…" value="${escapeHtml(state.invState.query || "")}" />
          <label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-dim); cursor:pointer;">
            <input type="checkbox" id="invShowArchived"${showArchived ? " checked" : ""} /> Show archived
          </label>
          ${canEdit ? `<button class="btn primary small" id="newInventoryBtn" type="button">＋ New item</button>` : ""}
        </div>
      </div>
      <div class="ev-filters">
        <div class="ev-chip-row">${tagChips}</div>
      </div>
      <div class="inv-grid">${cards}${empty}</div>
    `;

    const nb = panel.querySelector("#newInventoryBtn");
    if (nb) nb.onclick = () => openInventoryEditor(null);

    const search = panel.querySelector("#invSearch");
    if (search) {
      search.oninput = (e) => { state.invState.query = e.target.value; renderInventoryTab(); };
    }
    const showArch = panel.querySelector("#invShowArchived");
    if (showArch) {
      showArch.onchange = (e) => { state.invState.showArchived = e.target.checked; renderInventoryTab(); };
    }
    panel.querySelectorAll("[data-inv-tag]").forEach((b) => {
      b.onclick = () => { state.invState.tagFilter = b.dataset.invTag; renderInventoryTab(); };
    });
    panel.querySelectorAll("[data-inv-edit]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openInventoryEditor(b.dataset.invEdit); };
    });
    panel.querySelectorAll("[data-inv-card]").forEach((c) => {
      c.onclick = () => openInventoryEditor(c.dataset.invCard);
    });
  }

  function renderInventoryCard(item) {
    const canEdit = hasPerm("edit_inventory");
    const photo = (item.photo_urls && item.photo_urls[0]) || null;
    const tags = (item.tags || []).slice(0, 4)
      .map((t) => `<span class="inv-tag-chip">${escapeHtml(t)}</span>`)
      .join("");
    const moreTags = (item.tags || []).length > 4 ? `<span class="inv-tag-chip more">+${item.tags.length - 4}</span>` : "";

    const activeAssigns = inventoryAssignmentsForItem(item.id).filter((a) => !a.returned_at);
    const upcoming = activeAssigns
      .filter((a) => new Date(a.usage_ends_at) >= new Date())
      .sort((a, b) => new Date(a.usage_starts_at) - new Date(b.usage_starts_at));
    const nextAssign = upcoming[0];
    const conflictCount = itemConflictCount(item.id);

    const statusRow = nextAssign
      ? `<div class="inv-status assigned">📍 Assigned to <b>${escapeHtml(assignmentTargetLabel(nextAssign))}</b></div>`
      : `<div class="inv-status free">✓ Available</div>`;

    const conflictRow = conflictCount
      ? `<div class="inv-conflict">⚠ ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}</div>`
      : "";

    const reorderRow = item.reorder_url
      ? `<a class="inv-reorder" href="${escapeHtml(item.reorder_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ Re-order</a>`
      : "";

    return `
      <div class="inv-card${item.is_archived ? " archived" : ""}" data-inv-card="${escapeHtml(item.id)}">
        <div class="inv-card-photo">
          ${photo
            ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(item.name)}" loading="lazy" />`
            : `<div class="inv-card-photo-empty">📦</div>`}
        </div>
        <div class="inv-card-body">
          <div class="inv-card-head">
            <div class="inv-card-name">${escapeHtml(item.name)}${item.is_archived ? ` <span class="ev-cancel-pill">archived</span>` : ""}</div>
            ${canEdit ? `<button class="btn small" data-inv-edit="${escapeHtml(item.id)}" type="button">Edit</button>` : ""}
          </div>
          ${item.storage_location ? `<div class="inv-card-where">📍 ${escapeHtml(item.storage_location)}</div>` : ""}
          ${item.description ? `<div class="inv-card-desc">${escapeHtml(item.description)}</div>` : ""}
          ${tags || moreTags ? `<div class="inv-card-tags">${tags}${moreTags}</div>` : ""}
          ${statusRow}
          ${conflictRow}
          ${reorderRow}
        </div>
      </div>
    `;
  }

  /* ─── Inventory item editor modal ─── */

  let editingInventoryId = null;

  function openInventoryEditor(id) {
    const canEdit = hasPerm("edit_inventory");
    if (!canEdit && id == null) return;
    editingInventoryId = id || null;
    state._invPendingPhotos = [];
    state._invPendingTags = [];
    const it = id ? inventoryItemById(id) : null;

    $("#inventoryModalTitle").textContent = it ? "Edit inventory item" : "New inventory item";
    $("#inv_name").value             = it ? (it.name || "") : "";
    $("#inv_description").value      = it ? (it.description || "") : "";
    $("#inv_storage_location").value = it ? (it.storage_location || "") : "";
    $("#inv_tags").value             = it ? (it.tags || []).join(", ") : "";
    $("#inv_reorder_url").value      = it ? (it.reorder_url || "") : "";
    $("#inv_notes").value            = it ? (it.notes || "") : "";
    $("#inv_is_archived").checked    = !!(it && it.is_archived);

    $("#deleteInventoryBtn").style.display = (it && canEdit) ? "" : "none";

    const upload = $("#inv_photo_upload");
    if (upload) {
      upload.value = "";
      upload.disabled = !canEdit;
    }

    renderInventoryEditorPhotos();
    renderInventoryEditorAssignments();

    $("#inventoryModalOverlay").classList.add("open");
    setTimeout(() => $("#inv_name").focus(), 50);
  }

  function closeInventoryEditor() {
    $("#inventoryModalOverlay").classList.remove("open");
    editingInventoryId = null;
    state._invPendingPhotos = [];
    state._invPendingTags = [];
  }

  function renderInventoryEditorPhotos() {
    const wrap = $("#inv_photos_list");
    if (!wrap) return;
    const it = editingInventoryId ? inventoryItemById(editingInventoryId) : null;
    const persisted = it ? (it.photo_urls || []) : [];
    const pending = state._invPendingPhotos.map((p) => p.url);
    const all = persisted.concat(pending);

    if (!all.length) {
      wrap.innerHTML = `<div class="ev-staff-empty">No photos yet.</div>`;
      return;
    }
    wrap.innerHTML = all.map((url, i) => `
      <div class="inv-photo-row" data-photo-idx="${i}" data-photo-url="${escapeHtml(url)}">
        <img src="${escapeHtml(url)}" alt="" loading="lazy" />
        <button class="btn ghost small" data-photo-remove="${i}" type="button">Remove</button>
      </div>
    `).join("");

    wrap.querySelectorAll("[data-photo-remove]").forEach((b) => {
      b.onclick = async () => {
        const idx = parseInt(b.dataset.photoRemove, 10);
        const persistedCount = persisted.length;
        if (idx < persistedCount && editingInventoryId) {
          // Persisted photo — strip from photo_urls and remove from bucket.
          const url = persisted[idx];
          const path = inventoryStoragePathFromUrl(url);
          const newUrls = persisted.filter((_, k) => k !== idx);
          const { error } = await sb.from("inventory_items")
            .update({ photo_urls: newUrls })
            .eq("id", editingInventoryId);
          if (error) return showToast(error.message, "error");
          if (path) await sb.storage.from("inventory-photos").remove([path]).catch(() => {});
          await reloadAll();
          renderInventoryEditorPhotos();
          renderInventoryTab();
        } else {
          // Pending photo — discard the bucket upload too.
          const pendingIdx = idx - persistedCount;
          const removed = state._invPendingPhotos.splice(pendingIdx, 1)[0];
          if (removed && removed.path) {
            await sb.storage.from("inventory-photos").remove([removed.path]).catch(() => {});
          }
          renderInventoryEditorPhotos();
        }
      };
    });
  }

  // Extract the bucket path from a public Supabase URL so we can remove the
  // object on photo-delete. URL shape:
  //   https://<host>/storage/v1/object/public/inventory-photos/<path>
  function inventoryStoragePathFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/object\/public\/inventory-photos\/(.+?)(?:\?|$)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function uploadInventoryPhoto(file) {
    if (!file) return null;
    if (!file.type.startsWith("image/")) {
      showToast("Pick an image file", "error");
      return null;
    }
    const safe = (file.name || "photo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const path = `${editingInventoryId || "_pending"}/${Date.now()}-${safe}`;
    showLoader(true);
    const { error: upErr } = await sb.storage.from("inventory-photos").upload(path, file, {
      cacheControl: "3600",
      upsert: false
    });
    if (upErr) {
      showLoader(false);
      showToast(upErr.message, "error");
      return null;
    }
    const { data } = sb.storage.from("inventory-photos").getPublicUrl(path);
    showLoader(false);
    return { url: data.publicUrl, path };
  }

  function renderInventoryEditorAssignments() {
    const section = $("#inv_assignments_section");
    const wrap = $("#inv_assignments_list");
    if (!wrap || !section) return;
    if (!editingInventoryId) { section.style.display = "none"; return; }
    section.style.display = "";

    const all = inventoryAssignmentsForItem(editingInventoryId)
      .slice()
      .sort((a, b) => new Date(a.usage_starts_at) - new Date(b.usage_starts_at));
    if (!all.length) {
      wrap.innerHTML = `<div class="ev-staff-empty">Not currently assigned.</div>`;
      return;
    }

    // Build a quick conflict-pair lookup so we can red-flag overlapping rows.
    const overlapIds = new Set();
    const active = all.filter((a) => !a.returned_at);
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      const aS = new Date(a.usage_starts_at).getTime();
      const aE = new Date(a.usage_ends_at).getTime();
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        const bS = new Date(b.usage_starts_at).getTime();
        const bE = new Date(b.usage_ends_at).getTime();
        if (rangesOverlap(aS, aE, bS, bE)) {
          overlapIds.add(a.id); overlapIds.add(b.id);
        }
      }
    }

    wrap.innerHTML = all.map((a) => {
      const start = new Date(a.usage_starts_at);
      const end = new Date(a.usage_ends_at);
      const dateStr = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      const timeStr = `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      const status = a.returned_at
        ? `<span class="inv-assign-pill returned">returned</span>`
        : (overlapIds.has(a.id) ? `<span class="inv-assign-pill conflict">⚠ conflict</span>` : `<span class="inv-assign-pill active">active</span>`);
      return `
        <div class="inv-assign-row${overlapIds.has(a.id) ? " has-conflict" : ""}" data-assign-id="${escapeHtml(a.id)}">
          <div class="inv-assign-row-head">
            <div class="inv-assign-row-target">${escapeHtml(assignmentTargetLabel(a))}</div>
            ${status}
          </div>
          <div class="inv-assign-row-when">${escapeHtml(dateStr)} · ${escapeHtml(timeStr)}</div>
          <div class="inv-assign-row-actions">
            ${a.returned_at
              ? `<button class="btn small" data-assign-unreturn="${escapeHtml(a.id)}" type="button">Mark active</button>`
              : `<button class="btn small" data-assign-return="${escapeHtml(a.id)}" type="button">Mark returned</button>`}
            <button class="btn ghost small" data-assign-delete="${escapeHtml(a.id)}" type="button">Remove</button>
          </div>
        </div>
      `;
    }).join("");

    wrap.querySelectorAll("[data-assign-return]").forEach((b) => {
      b.onclick = async () => {
        const { error } = await sb.from("inventory_assignments")
          .update({ returned_at: new Date().toISOString() })
          .eq("id", b.dataset.assignReturn);
        if (error) return showToast(error.message, "error");
        await reloadAll();
        renderInventoryEditorAssignments();
        renderInventoryTab();
      };
    });
    wrap.querySelectorAll("[data-assign-unreturn]").forEach((b) => {
      b.onclick = async () => {
        const { error } = await sb.from("inventory_assignments")
          .update({ returned_at: null })
          .eq("id", b.dataset.assignUnreturn);
        if (error) return showToast(error.message, "error");
        await reloadAll();
        renderInventoryEditorAssignments();
        renderInventoryTab();
      };
    });
    wrap.querySelectorAll("[data-assign-delete]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Remove this assignment?")) return;
        const { error } = await sb.from("inventory_assignments")
          .delete()
          .eq("id", b.dataset.assignDelete);
        if (error) return showToast(error.message, "error");
        await reloadAll();
        renderInventoryEditorAssignments();
        renderInventoryTab();
      };
    });
  }

  async function saveInventoryItem() {
    const name = $("#inv_name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }

    const tagsRaw = $("#inv_tags").value || "";
    const tags = tagsRaw.split(",").map((s) => s.trim()).filter(Boolean);

    const reorderRaw = $("#inv_reorder_url").value.trim();
    if (reorderRaw && !/^https?:\/\//i.test(reorderRaw)) {
      showToast("Re-order link must start with http:// or https://", "error");
      return;
    }

    const payload = {
      name,
      description:      $("#inv_description").value.trim() || null,
      storage_location: $("#inv_storage_location").value.trim() || null,
      tags,
      reorder_url:      reorderRaw || null,
      notes:            $("#inv_notes").value.trim() || null,
      is_archived:      $("#inv_is_archived").checked
    };

    showLoader(true);
    let resp;
    if (editingInventoryId) {
      resp = await sb.from("inventory_items").update(payload).eq("id", editingInventoryId).select().single();
    } else {
      payload.created_by = state.session?.user?.id || null;
      // Pending photos uploaded under "_pending/" — persist their URLs now.
      // (We could move them under the new id, but the public URL is stable
      // either way; not worth the round-trip.)
      payload.photo_urls = state._invPendingPhotos.map((p) => p.url);
      resp = await sb.from("inventory_items").insert(payload).select().single();
    }
    showLoader(false);

    if (resp.error) {
      showToast(resp.error.message, "error");
      return;
    }

    showToast(editingInventoryId ? "Item saved" : "Item created", "success");
    state._invPendingPhotos = [];
    await reloadAll(); renderAll();
    closeInventoryEditor();
  }

  async function deleteInventoryItem() {
    if (!editingInventoryId) return;
    const it = inventoryItemById(editingInventoryId);
    if (!confirm(`Delete "${it?.name || "this item"}"? Existing assignments will be removed too. This cannot be undone.`)) return;

    // Best-effort: remove every photo from the bucket. The DB row's photo
    // URLs are dropped on delete-cascade-of-nothing (no FK), but the bucket
    // objects would leak if we didn't.
    const paths = (it?.photo_urls || [])
      .map(inventoryStoragePathFromUrl)
      .filter(Boolean);
    if (paths.length) await sb.storage.from("inventory-photos").remove(paths).catch(() => {});

    showLoader(true);
    const { error } = await sb.from("inventory_items").delete().eq("id", editingInventoryId);
    showLoader(false);
    if (error) return showToast(error.message, "error");
    showToast("Item deleted", "success");
    await reloadAll(); renderAll();
    closeInventoryEditor();
  }

  /* ─── Assign-inventory modal (opened from class detail panel + event editor) ─── */

  // Open with target = { kind: 'class', classId, sessionDate }
  // or          target = { kind: 'event', eventId }
  function openInventoryAssignModal(target) {
    if (!hasPerm("edit_inventory")) {
      showToast("You don't have permission to assign inventory", "error");
      return;
    }
    state.invAssignState.target = target;
    state.invAssignState.selectedItemIds = new Set();
    state.invAssignState.query = "";
    $("#inv_assign_search").value = "";
    $("#inv_assign_notes").value = "";
    $("#inventoryAssignSave").disabled = true;

    // Banner: what we're assigning to + the time window we'll snapshot.
    const win = inventoryAssignTargetWindow(target);
    const banner = $("#inv_assign_target_banner");
    const targetLabel = inventoryAssignTargetLabel(target);
    if (banner) {
      const dateStr = win
        ? `${win.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${win.start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${win.end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "(no time window)";
      banner.innerHTML = `<b>Assigning to:</b> ${escapeHtml(targetLabel)}<br/><span class="field-sub">${escapeHtml(dateStr)}</span>`;
    }

    renderInventoryAssignPicker();
    $("#inventoryAssignOverlay").classList.add("open");
    setTimeout(() => $("#inv_assign_search").focus(), 50);
  }

  function closeInventoryAssignModal() {
    $("#inventoryAssignOverlay").classList.remove("open");
    state.invAssignState.target = null;
    state.invAssignState.selectedItemIds = new Set();
  }

  function inventoryAssignTargetLabel(target) {
    if (!target) return "—";
    if (target.kind === "class") {
      const cls = state.classes.find((c) => c.id === target.classId);
      return `${cls ? cls.name : "Class"} · ${target.sessionDate}`;
    }
    if (target.kind === "event") {
      const ev = state.events.find((e) => e.id === target.eventId);
      return ev ? ev.title : "Event";
    }
    return "—";
  }

  function inventoryAssignTargetWindow(target) {
    if (!target) return null;
    if (target.kind === "class") {
      const cls = state.classes.find((c) => c.id === target.classId);
      return classSessionTimeWindow(cls, target.sessionDate);
    }
    if (target.kind === "event") {
      const ev = state.events.find((e) => e.id === target.eventId);
      if (!ev) return null;
      return { start: new Date(ev.starts_at), end: new Date(ev.ends_at) };
    }
    return null;
  }

  function renderInventoryAssignPicker() {
    const wrap = $("#inv_assign_picker");
    if (!wrap) return;
    const target = state.invAssignState.target;
    const win = inventoryAssignTargetWindow(target);
    const q = (state.invAssignState.query || "").trim().toLowerCase();
    const items = activeInventoryItems()
      .filter((i) => {
        if (!q) return true;
        const hay = [i.name, i.description, i.storage_location, (i.tags || []).join(" ")].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });

    // Items already assigned to this exact target → skip them (button on
    // the source surface should already reflect this; defensive double).
    const alreadyAssignedItemIds = new Set();
    if (target?.kind === "class") {
      inventoryAssignmentsForClassSession(target.classId, target.sessionDate)
        .filter((a) => !a.returned_at)
        .forEach((a) => alreadyAssignedItemIds.add(a.item_id));
    } else if (target?.kind === "event") {
      inventoryAssignmentsForEvent(target.eventId)
        .filter((a) => !a.returned_at)
        .forEach((a) => alreadyAssignedItemIds.add(a.item_id));
    }

    if (!items.length) {
      wrap.innerHTML = `<div class="ev-staff-empty">No items to pick from.</div>`;
      return;
    }

    wrap.innerHTML = items.map((it) => {
      const conflicts = win
        ? conflictsForItemInWindow(it.id, win.start, win.end, null)
        : [];
      const isConflict = conflicts.length > 0;
      const isAssignedHere = alreadyAssignedItemIds.has(it.id);
      const checked = state.invAssignState.selectedItemIds.has(it.id);
      const conflictNote = isConflict
        ? `<div class="inv-pick-conflict">⚠ Already assigned: ${escapeHtml(conflicts.map(assignmentTargetLabel).join(", "))}</div>`
        : "";
      return `
        <label class="inv-pick-row${isAssignedHere ? " disabled" : ""}${isConflict ? " warn" : ""}">
          <input type="checkbox" data-inv-pick="${escapeHtml(it.id)}"${checked ? " checked" : ""}${isAssignedHere ? " disabled" : ""} />
          <div class="inv-pick-body">
            <div class="inv-pick-name">${escapeHtml(it.name)}${isAssignedHere ? ` <span class="ev-cancel-pill">already assigned</span>` : ""}</div>
            ${it.storage_location ? `<div class="inv-pick-where">📍 ${escapeHtml(it.storage_location)}</div>` : ""}
            ${conflictNote}
          </div>
        </label>
      `;
    }).join("");

    wrap.querySelectorAll("[data-inv-pick]").forEach((cb) => {
      cb.onchange = (e) => {
        const id = cb.dataset.invPick;
        if (e.target.checked) state.invAssignState.selectedItemIds.add(id);
        else state.invAssignState.selectedItemIds.delete(id);
        $("#inventoryAssignSave").disabled = state.invAssignState.selectedItemIds.size === 0;
      };
    });
  }

  async function saveInventoryAssign() {
    const target = state.invAssignState.target;
    if (!target) return;
    const win = inventoryAssignTargetWindow(target);
    if (!win) { showToast("Couldn't determine the time window for this target", "error"); return; }
    const ids = Array.from(state.invAssignState.selectedItemIds);
    if (!ids.length) return;

    const notes = $("#inv_assign_notes").value.trim() || null;

    const rows = ids.map((itemId) => ({
      item_id: itemId,
      class_id: target.kind === "class" ? target.classId : null,
      event_id: target.kind === "event" ? target.eventId : null,
      session_date: target.kind === "class" ? target.sessionDate : null,
      usage_starts_at: win.start.toISOString(),
      usage_ends_at:   win.end.toISOString(),
      notes,
      created_by: state.session?.user?.id || null
    }));

    showLoader(true);
    const { error } = await sb.from("inventory_assignments").insert(rows);
    showLoader(false);

    if (error) {
      // Most likely cause: partial unique violation (this exact item already
      // assigned to this exact class session / event). Surface the message.
      showToast(error.message, "error");
      return;
    }
    showToast(`Assigned ${rows.length} item${rows.length === 1 ? "" : "s"}`, "success");
    await reloadAll(); renderAll();
    closeInventoryAssignModal();
    // If the event editor is open in the background, refresh its inline
    // inventory list so the new assignment shows immediately.
    if (editingEventId) renderEventInventoryEditor();
  }

  /* ─── Inventory modal event wiring (called once from wireEvents) ─── */

  function wireInventoryModals() {
    const ed = $("#inventoryModalOverlay");
    if (!ed) return;
    $("#inventoryModalClose").onclick = closeInventoryEditor;
    $("#inventoryCancel").onclick     = closeInventoryEditor;
    $("#inventorySave").onclick       = saveInventoryItem;
    $("#deleteInventoryBtn").onclick  = deleteInventoryItem;
    ed.addEventListener("click", (e) => { if (e.target === ed) closeInventoryEditor(); });

    const upload = $("#inv_photo_upload");
    if (upload) {
      upload.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const result = await uploadInventoryPhoto(file);
        upload.value = "";
        if (!result) return;
        if (editingInventoryId) {
          // Persist immediately for existing items.
          const it = inventoryItemById(editingInventoryId);
          const newUrls = (it?.photo_urls || []).concat([result.url]);
          const { error } = await sb.from("inventory_items")
            .update({ photo_urls: newUrls })
            .eq("id", editingInventoryId);
          if (error) {
            await sb.storage.from("inventory-photos").remove([result.path]).catch(() => {});
            return showToast(error.message, "error");
          }
          await reloadAll();
          renderInventoryEditorPhotos();
          renderInventoryTab();
        } else {
          // Buffer until save for new items.
          state._invPendingPhotos.push(result);
          renderInventoryEditorPhotos();
        }
      };
    }

    const ad = $("#inventoryAssignOverlay");
    if (ad) {
      $("#inventoryAssignClose").onclick  = closeInventoryAssignModal;
      $("#inventoryAssignCancel").onclick = closeInventoryAssignModal;
      $("#inventoryAssignSave").onclick   = saveInventoryAssign;
      ad.addEventListener("click", (e) => { if (e.target === ad) closeInventoryAssignModal(); });
      const search = $("#inv_assign_search");
      if (search) {
        search.oninput = (e) => { state.invAssignState.query = e.target.value; renderInventoryAssignPicker(); };
      }
    }
  }

  /* ═════════════ Sub requests / shift trades (Phase T4) ═════════════
   *
   * Workflow:
   *   1. Teacher (or admin on a teacher's behalf) opens a sub_request for
   *      a specific class+session_date. Status starts as 'open'.
   *   2. Other teachers with claim_sub_requests see open requests and can
   *      offer to cover via claim_sub_request RPC (creates a sub_claims
   *      row, status 'pending').
   *   3. Admin/manager picks one teacher to fill via fill_sub_request RPC:
   *      sets sub_requests.status = 'filled' + filled_by_teacher_id; flips
   *      the matching pending claim to 'accepted' and any sibling pending
   *      claims to 'declined' in one atomic shot.
   *   4. Original requester or admin can cancel an open request via
   *      cancel_sub_request RPC; pending claims auto-decline.
   *   5. A claimer can withdraw their own pending claim via
   *      withdraw_sub_claim RPC.
   *
   * RLS keeps everything safe — these functions are thin wrappers around
   * the SQL RPCs that surface errors via showToast and trigger a full
   * reloadAll/renderAll on success (realtime would catch up too, but
   * doing it explicitly keeps the UI snappy).
   */

  // Resolve the signed-in user to their teachers row by email match.
  // Returns the teachers row for the signed-in user, or null. Two paths:
  //   1. profiles.teacher_id (T6d) — explicit FK set by an admin via the
  //      Users tab. Source of truth.
  //   2. Fallback: case-insensitive email match against teachers.email,
  //      preserved for unlinked profiles. CLAUDE.md §5 calls this out as
  //      fragile (alternate emails, case mismatch); the FK is the fix.
  function mySignedInTeacher() {
    const linkedId = state.profile?.teacher_id;
    if (linkedId) {
      const t = state.teachers.find((x) => x.id === linkedId);
      if (t) return t;
    }
    const email = (state.session?.user?.email || "").toLowerCase();
    if (!email) return null;
    return state.teachers.find((t) => (t.email || "").toLowerCase() === email) || null;
  }

  // Open requests for a given class+date, or null if none.
  function openSubRequestForSession(classId, sessionDate) {
    return state.subRequests.find(
      (r) => r.class_id === classId && r.session_date === sessionDate && r.status === "open"
    ) || null;
  }

  // Any non-cancelled request for class+date (open or filled).
  function activeSubRequestForSession(classId, sessionDate) {
    return state.subRequests.find(
      (r) => r.class_id === classId && r.session_date === sessionDate && r.status !== "cancelled"
    ) || null;
  }

  // The next class-day on or after fromDate for the given class. Returns
  // null if none in the next 60 days (defensive against malformed time
  // strings or classes outside their start/end window).
  function nextSessionDateForClass(cls, fromDate) {
    const start = fromDate ? new Date(fromDate) : new Date();
    start.setHours(0, 0, 0, 0);
    for (let i = 0; i < 60; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      if (classRunsOnDay(cls, d)) return isoDate(d);
    }
    return null;
  }

  // Pretty-print a session_date for display: "Fri, Apr 25" style.
  function formatSessionDate(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  // Pending/accepted claims for a given request, sorted by creation order.
  function claimsForRequest(reqId) {
    return state.subClaims
      .filter((c) => c.sub_request_id === reqId)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }

  // Filter the visible sub_requests list according to the active filter.
  function filteredSubRequests() {
    const f = state.srState.filter;
    const me = mySignedInTeacher();
    const myId = me?.id || null;

    if (f === "all" && hasPerm("manage_all_sub_requests")) {
      return [...state.subRequests];
    }
    if (f === "mine") {
      return state.subRequests.filter((r) =>
        (myId && (r.requested_by_teacher_id === myId || r.filled_by_teacher_id === myId))
        || r.created_by_user_id === state.session?.user?.id
        || (myId && state.subClaims.some((c) => c.sub_request_id === r.id && c.claimed_by_teacher_id === myId))
      );
    }
    // Default: open
    return state.subRequests.filter((r) => r.status === "open");
  }

  function renderSubRequestsTab() {
    const panel = document.querySelector('.tab-panel[data-tab="subrequests"]');
    if (!panel) return;
    if (!canSeeTab("subrequests")) return;

    const canManage = hasPerm("manage_all_sub_requests");
    const canRequest = hasPerm("request_sub") || canManage;

    // Filter chips. "All" is admin/manager-only; teachers see Open / Mine.
    const filters = [
      { id: "open", label: "Open" },
      { id: "mine", label: "Mine" },
    ];
    if (canManage) filters.push({ id: "all", label: "All" });

    // If the user can't see the active filter (e.g. teacher with "all"),
    // fall back to "open".
    if (!filters.some((f) => f.id === state.srState.filter)) {
      state.srState.filter = "open";
    }

    const filterChips = filters.map((f) => {
      const active = state.srState.filter === f.id;
      return `<button class="sr-filter-chip${active ? " active" : ""}" data-sr-filter="${f.id}" type="button">${escapeHtml(f.label)}</button>`;
    }).join(" ");

    const newBtn = canRequest
      ? `<button class="btn primary small" id="newSubRequestBtn" type="button">＋ Request a sub</button>`
      : "";

    const list = filteredSubRequests();
    const sorted = [...list].sort((a, b) => {
      // Open first, then filled, then cancelled. Within a status, by session_date asc.
      const statusOrder = { open: 0, filled: 1, cancelled: 2 };
      const sa = statusOrder[a.status] ?? 3;
      const sb_ = statusOrder[b.status] ?? 3;
      if (sa !== sb_) return sa - sb_;
      if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
      return a.created_at < b.created_at ? -1 : 1;
    });

    const cards = sorted.map(renderSubRequestCard).join("");
    const empty = sorted.length === 0
      ? `<div class="sr-empty">No sub requests match this filter.</div>`
      : "";

    panel.innerHTML = `
      <div class="tab-head">
        <div class="results-meta">Sub requests &middot; <span style="color:var(--ink-dim);font-weight:400">${state.subRequests.filter(r => r.status === "open").length} open</span></div>
        <div style="display:flex;gap:8px;align-items:center">${newBtn}</div>
      </div>
      <div class="sr-filter-row">${filterChips}</div>
      <div class="sr-list">${cards}${empty}</div>
    `;

    // Wire filter chips
    panel.querySelectorAll("[data-sr-filter]").forEach((b) => {
      b.onclick = () => {
        state.srState.filter = b.dataset.srFilter;
        renderSubRequestsTab();
      };
    });

    // Wire "+ Request a sub" button
    const newSr = panel.querySelector("#newSubRequestBtn");
    if (newSr) newSr.onclick = () => openSubRequestModal({});

    // Wire per-card actions
    wireSubRequestCardEvents(panel);
  }

  function renderSubRequestCard(req) {
    const cls = state.classes.find((c) => c.id === req.class_id);
    const requester = req.requested_by_teacher_id
      ? state.teachers.find((t) => t.id === req.requested_by_teacher_id)
      : null;
    const filler = req.filled_by_teacher_id
      ? state.teachers.find((t) => t.id === req.filled_by_teacher_id)
      : null;
    const me = mySignedInTeacher();
    const claims = claimsForRequest(req.id);
    const myClaim = me ? claims.find((c) => c.claimed_by_teacher_id === me.id) : null;
    const canManage = hasPerm("manage_all_sub_requests");
    const canClaim  = hasPerm("claim_sub_requests")
      && me
      && req.status === "open"
      && req.requested_by_teacher_id !== me.id;
    const isMyRequest = me && req.requested_by_teacher_id === me.id;
    const canCancel = req.status === "open" && (canManage || isMyRequest);

    const hue = (cls && primaryTeacherObj(cls.id)) ? teacherHue(primaryTeacherObj(cls.id).id) : 210;
    const statusPill = `<span class="sr-status sr-status-${req.status}">${escapeHtml(req.status)}</span>`;

    // Claims block (visible if there are any visible claims AND the request is open).
    let claimsHtml = "";
    if (claims.length > 0) {
      const claimRows = claims.map((c) => {
        const t = state.teachers.find((x) => x.id === c.claimed_by_teacher_id);
        const name = t ? t.full_name : "(unknown teacher)";
        const isMine = me && c.claimed_by_teacher_id === me.id;
        const note = c.note ? ` <span class="sr-claim-note">— ${escapeHtml(c.note)}</span>` : "";
        const fillBtn = (canManage && req.status === "open" && c.status === "pending")
          ? `<button class="btn primary small" data-sr-fill data-req="${escapeHtml(req.id)}" data-tch="${escapeHtml(c.claimed_by_teacher_id)}" type="button">Pick this teacher</button>`
          : "";
        const withdrawBtn = (isMine && c.status === "pending")
          ? `<button class="btn small ghost" data-sr-withdraw data-claim="${escapeHtml(c.id)}" type="button">Withdraw</button>`
          : "";
        return `
          <div class="sr-claim-row">
            <span class="sr-claim-name">${escapeHtml(name)}${note}</span>
            <span class="sr-claim-status sr-claim-status-${c.status}">${escapeHtml(c.status)}</span>
            ${fillBtn}
            ${withdrawBtn}
          </div>
        `;
      }).join("");
      claimsHtml = `
        <div class="sr-claims">
          <div class="sr-claims-label">Offers (${claims.length})</div>
          ${claimRows}
        </div>
      `;
    }

    // Action row at bottom of card.
    const actions = [];
    if (canClaim && !myClaim) {
      actions.push(`<button class="btn primary small" data-sr-claim data-req="${escapeHtml(req.id)}" type="button">Offer to cover</button>`);
    } else if (canClaim && myClaim && myClaim.status !== "pending") {
      actions.push(`<button class="btn primary small" data-sr-claim data-req="${escapeHtml(req.id)}" type="button">Re-offer to cover</button>`);
    }
    if (canManage && req.status === "open") {
      // Direct-fill picker: any active teacher can be assigned even without a claim.
      const teacherOpts = state.teachers
        .filter((t) => t.status !== "inactive")
        .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.full_name)}</option>`)
        .join("");
      actions.push(`
        <div class="sr-direct-fill">
          <select data-sr-direct-fill data-req="${escapeHtml(req.id)}">
            <option value="">Assign teacher directly…</option>
            ${teacherOpts}
          </select>
        </div>
      `);
    }
    if (canCancel) {
      actions.push(`<button class="btn small ghost" data-sr-cancel data-req="${escapeHtml(req.id)}" type="button">Cancel request</button>`);
    }
    const actionsHtml = actions.length
      ? `<div class="sr-actions">${actions.join("")}</div>`
      : "";

    const reasonHtml = req.reason
      ? `<div class="sr-reason">${escapeHtml(req.reason)}</div>`
      : "";

    const filledLine = (req.status === "filled" && filler)
      ? `<div class="sr-filled-line">Filled by <b>${escapeHtml(filler.full_name)}</b>${req.filled_at ? ` · ${formatRelativePast(new Date(req.filled_at))}` : ""}</div>`
      : "";
    const cancelledLine = (req.status === "cancelled")
      ? `<div class="sr-cancelled-line">Cancelled${req.cancellation_reason ? ` — ${escapeHtml(req.cancellation_reason)}` : ""}</div>`
      : "";

    return `
      <div class="sr-card sr-status-card-${req.status}" style="border-left:4px solid hsl(${hue},62%,58%)">
        <div class="sr-card-head">
          <div class="sr-card-title">
            <span class="sr-class-name">${escapeHtml(cls ? cls.name : "(deleted class)")}</span>
            <span class="sr-session-date">${escapeHtml(formatSessionDate(req.session_date))}</span>
          </div>
          ${statusPill}
        </div>
        <div class="sr-card-meta">
          <span>Requested by <b>${escapeHtml(requester ? requester.full_name : "(admin)")}</b></span>
          <span class="sr-meta-dot">·</span>
          <span title="${escapeHtml(new Date(req.created_at).toLocaleString())}">${escapeHtml(formatRelativePast(new Date(req.created_at)))}</span>
        </div>
        ${reasonHtml}
        ${filledLine}
        ${cancelledLine}
        ${claimsHtml}
        ${actionsHtml}
      </div>
    `;
  }

  function wireSubRequestCardEvents(root) {
    root.querySelectorAll("[data-sr-claim]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); doClaimSubRequest(b.dataset.req); };
    });
    root.querySelectorAll("[data-sr-withdraw]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); doWithdrawSubClaim(b.dataset.claim); };
    });
    root.querySelectorAll("[data-sr-fill]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); doFillSubRequest(b.dataset.req, b.dataset.tch); };
    });
    root.querySelectorAll("[data-sr-cancel]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); doCancelSubRequest(b.dataset.req); };
    });
    root.querySelectorAll("[data-sr-direct-fill]").forEach((sel) => {
      sel.onchange = (e) => {
        const tch = sel.value;
        if (!tch) return;
        doFillSubRequest(sel.dataset.req, tch);
      };
    });
  }

  /* ─── Sub-request: create modal ─── */

  let subRequestModalContext = null; // { presetClassId, presetSessionDate }

  function openSubRequestModal(opts) {
    subRequestModalContext = opts || {};
    const overlay = $("#subRequestModalOverlay");
    if (!overlay) return;

    // Class picker — teachers see only their assigned classes; admins see all active.
    const sel = $("#sr_class_id");
    sel.innerHTML = "";
    const me = mySignedInTeacher();
    const canManage = hasPerm("manage_all_sub_requests");
    const myAssignedIds = me
      ? new Set(state.classTeachers.filter((ct) => ct.teacher_id === me.id).map((ct) => ct.class_id))
      : new Set();
    const visible = state.classes
      .filter((c) => includeTestClass(c) && c.active !== false)
      .filter((c) => canManage || myAssignedIds.has(c.id))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (visible.length === 0) {
      sel.innerHTML = `<option value="">(no classes available)</option>`;
    } else {
      sel.innerHTML = `<option value="">Pick a class…</option>` + visible.map((c) =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`
      ).join("");
    }
    if (subRequestModalContext.presetClassId) sel.value = subRequestModalContext.presetClassId;

    // Date picker — default to next session of selected class, else today.
    const dateInp = $("#sr_session_date");
    const updateDateDefault = () => {
      const cls = state.classes.find((c) => c.id === sel.value);
      const next = cls ? nextSessionDateForClass(cls, new Date()) : null;
      dateInp.value = subRequestModalContext.presetSessionDate
        || (subRequestModalContext.presetClassId === sel.value && subRequestModalContext.presetSessionDate)
        || next
        || isoDate(new Date());
      // Hint about the next class day.
      const hint = $("#sr_date_hint");
      if (hint) {
        if (cls && next) {
          hint.textContent = `Next session: ${formatSessionDate(next)}.`;
        } else if (cls) {
          hint.textContent = "Couldn't auto-detect this class's next session — pick a date manually.";
        } else {
          hint.textContent = "";
        }
      }
    };
    sel.onchange = () => { subRequestModalContext.presetSessionDate = null; updateDateDefault(); };
    updateDateDefault();

    $("#sr_reason").value = "";

    // Show admin-only "request on behalf of" row only for admins/managers.
    const onBehalfWrap = $("#sr_on_behalf_wrap");
    const onBehalfSel  = $("#sr_on_behalf_teacher");
    if (onBehalfWrap && onBehalfSel) {
      if (canManage) {
        onBehalfWrap.style.display = "";
        onBehalfSel.innerHTML = `<option value="">(myself / unspecified)</option>` +
          state.teachers
            .filter((t) => t.status !== "inactive")
            .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.full_name)}</option>`)
            .join("");
        onBehalfSel.value = "";
      } else {
        onBehalfWrap.style.display = "none";
      }
    }

    overlay.classList.add("open");
    setTimeout(() => sel.focus(), 50);
  }

  function closeSubRequestModal() {
    const overlay = $("#subRequestModalOverlay");
    if (overlay) overlay.classList.remove("open");
    subRequestModalContext = null;
  }

  async function submitSubRequestModal() {
    const classId = $("#sr_class_id").value;
    const sessionDate = $("#sr_session_date").value;
    const reason = $("#sr_reason").value.trim();
    const onBehalfId = $("#sr_on_behalf_teacher")?.value || "";

    if (!classId) { showToast("Pick a class", "error"); return; }
    if (!sessionDate) { showToast("Pick a session date", "error"); return; }

    // Refuse to open a duplicate request for the same session — surface
    // the existing one instead of stacking another row (which would error
    // anyway via the partial unique index).
    const existing = activeSubRequestForSession(classId, sessionDate);
    if (existing) {
      showToast(`There's already an ${existing.status} request for that session`, "error");
      return;
    }

    showLoader(true);
    let resp;
    if (onBehalfId && hasPerm("manage_all_sub_requests")) {
      resp = await sb.rpc("create_sub_request_for", {
        p_class_id: classId,
        p_session_date: sessionDate,
        p_teacher_id: onBehalfId,
        p_reason: reason || null,
      });
    } else {
      resp = await sb.rpc("create_sub_request", {
        p_class_id: classId,
        p_session_date: sessionDate,
        p_reason: reason || null,
      });
    }
    showLoader(false);
    if (resp.error) { showToast("Couldn't open request: " + resp.error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeSubRequestModal();
    showToast("Sub request opened", "success");
  }

  /* ─── Sub-request: RPC wrappers ─── */

  async function doClaimSubRequest(reqId, prefilledNote) {
    if (!reqId) return;
    let note = prefilledNote;
    if (note === undefined) {
      note = prompt("Add a note for the requester / admin (optional):", "") || "";
    }
    showLoader(true);
    const { error } = await sb.rpc("claim_sub_request", {
      p_sub_request_id: reqId,
      p_note: note || null,
    });
    showLoader(false);
    if (error) { showToast("Claim failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Offer sent — admin will review", "success");
  }

  async function doWithdrawSubClaim(claimId) {
    if (!claimId) return;
    if (!confirm("Withdraw your offer to cover this class?")) return;
    showLoader(true);
    const { error } = await sb.rpc("withdraw_sub_claim", { p_claim_id: claimId });
    showLoader(false);
    if (error) { showToast("Withdraw failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Offer withdrawn", "success");
  }

  async function doFillSubRequest(reqId, teacherId) {
    if (!reqId || !teacherId) return;
    const t = state.teachers.find((x) => x.id === teacherId);
    if (!confirm(`Assign ${t ? t.full_name : "this teacher"} to cover the class?`)) return;
    showLoader(true);
    const { error } = await sb.rpc("fill_sub_request", {
      p_sub_request_id: reqId,
      p_teacher_id: teacherId,
    });
    showLoader(false);
    if (error) { showToast("Fill failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Sub request filled", "success");
    // Phase T8 hook: offer to notify the school's daily contact about the
    // assigned sub. Skip silently if the class isn't linked to a school
    // with a daily contact — admin can still notify manually if needed.
    const req = state.subRequests.find((r) => r.id === reqId);
    const cls = req ? state.classes.find((c) => c.id === req.class_id) : null;
    const school = cls ? schoolForClass(cls) : null;
    if (cls && school && school.daily_contact_email) {
      // Slight delay so the success toast lands first.
      setTimeout(() => {
        openNotifyModal({
          kind: "sub_assigned",
          cls,
          sessionDate: req.session_date,
          subTeacher: t || null,
          reason: req.reason || "",
        });
      }, 350);
    }
  }

  async function doCancelSubRequest(reqId) {
    if (!reqId) return;
    const reason = prompt("Reason for cancelling (optional):", "") || "";
    showLoader(true);
    const { error } = await sb.rpc("cancel_sub_request", {
      p_sub_request_id: reqId,
      p_reason: reason || null,
    });
    showLoader(false);
    if (error) { showToast("Cancel failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Sub request cancelled", "success");
  }

  /* ═════════════ Curriculum tab (T5a) ═════════════
   *
   * Admin/manager library of DK lesson assets — PDFs, videos, images, scripts,
   * external links. T5a ships the library + CRUD only. Assignments
   * (per-teacher per-class) and the watermarked teacher viewer land in T5b
   * + T5c respectively.
   *
   * Storage: private `curriculum-assets` bucket. Direct browser reads are
   * blocked at the storage RLS layer. T5a uploads write directly because
   * `edit_curriculum` users can write the bucket. T5c will gate reads
   * through an Edge Function that mints short-TTL signed URLs after
   * checking assignment + lead-window.
   */

  const CURRICULUM_TYPE_META = {
    pdf:    { label: "PDF",    ico: "📄", accept: ".pdf,application/pdf",  uploadHint: "(PDF, max 25 MB)",            file: true },
    video:  { label: "Video",  ico: "🎬", accept: "video/mp4,video/webm,video/quicktime", uploadHint: "(MP4 / WebM / MOV, max 200 MB)", file: true },
    image:  { label: "Image",  ico: "🖼", accept: "image/png,image/jpeg,image/webp",      uploadHint: "(PNG / JPG / WebP, max 10 MB)",   file: true },
    script: { label: "Script", ico: "📜", accept: "",                                       uploadHint: "",                              file: false },
    link:   { label: "Link",   ico: "🔗", accept: "",                                       uploadHint: "",                              file: false },
  };
  const CURRICULUM_MAX_BYTES = {
    pdf: 25 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    image: 10 * 1024 * 1024,
  };

  function renderCurriculumTab() {
    const panel = document.querySelector('.tab-panel[data-tab="curriculum"]');
    if (!panel) return;
    if (!canSeeTab("curriculum")) return;

    const items = (state.curriculumItems || [])
      .filter((it) => state.curState.showArchived || !it.is_archived)
      .filter((it) => state.curState.typeFilter === "all" || it.asset_type === state.curState.typeFilter);

    const meta = $("#curriculumMeta");
    if (meta) {
      const total = (state.curriculumItems || []).length;
      const shown = items.length;
      meta.innerHTML = total === 0
        ? "Curate the franchise's lesson library here. Items live in a private bucket; teachers see them through assigned classes (T5b)."
        : `${shown} of ${total} item${total === 1 ? "" : "s"}`;
    }

    const tbl = $("#curriculumTable");
    if (!tbl) return;

    if (items.length === 0) {
      tbl.innerHTML = `<div class="empty-state" style="padding:32px;text-align:center;color:var(--ink-dim)">
        ${(state.curriculumItems || []).length === 0
          ? "No curriculum items yet. Click <b>＋ New curriculum item</b> to add one."
          : "No items match the current filter."}
      </div>`;
      return;
    }

    tbl.innerHTML = items.map((it) => {
      const meta = CURRICULUM_TYPE_META[it.asset_type] || { label: it.asset_type, ico: "📦" };
      const approved = it.dk_approved
        ? `<span class="cur-badge cur-badge-approved" title="DK Corporate approved">✓ DK approved</span>` : "";
      const archived = it.is_archived
        ? `<span class="cur-badge cur-badge-archived">Archived</span>` : "";
      const assetLabel = it.asset_type === "link"
        ? (it.external_url ? `<span class="cur-asset-meta">${escapeHtml(truncateUrl(it.external_url, 48))}</span>` : "")
        : it.storage_path
          ? `<span class="cur-asset-meta">${escapeHtml(it.storage_path.split("/").pop() || "")}</span>`
          : "";
      const desc = it.description
        ? `<div class="cur-desc">${escapeHtml(it.description)}</div>` : "";
      const canEdit   = hasPerm("edit_curriculum");
      const canAssign = hasPerm("assign_curriculum");
      const assignCount = (state.curriculumAssignments || []).filter((a) => a.curriculum_item_id === it.id).length;
      const assignChip = canAssign
        ? `<span class="cur-assign-chip" title="Assignments to teacher+class pairs">👥 ${assignCount} assigned</span>`
        : "";
      return `
        <div class="cur-row" data-cur-id="${escapeHtml(it.id)}">
          <div class="cur-row-ico" aria-hidden="true">${meta.ico}</div>
          <div class="cur-row-main">
            <div class="cur-row-head">
              <span class="cur-row-title">${escapeHtml(it.title)}</span>
              <span class="cur-pill">${escapeHtml(meta.label)}</span>
              ${approved}
              ${archived}
            </div>
            ${desc}
            <div class="cur-row-meta">
              <span title="Default lead time">⏱ ${it.default_lead_days}d default</span>
              ${assetLabel}
              ${assignChip}
            </div>
          </div>
          <div class="cur-row-actions">
            ${canAssign && !it.is_archived ? `<button class="btn ghost small" data-cur-assign="${escapeHtml(it.id)}">Assign…</button>` : ""}
            ${canEdit ? `<button class="btn ghost small" data-cur-edit="${escapeHtml(it.id)}">Edit</button>` : ""}
          </div>
        </div>`;
    }).join("");

    tbl.querySelectorAll("[data-cur-edit]").forEach((b) => {
      b.onclick = () => openCurriculumEditor(b.getAttribute("data-cur-edit"));
    });
    tbl.querySelectorAll("[data-cur-assign]").forEach((b) => {
      b.onclick = () => openAssignCurriculumModal(b.getAttribute("data-cur-assign"));
    });
  }

  function truncateUrl(s, n) {
    if (!s) return "";
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }

  function openCurriculumEditor(itemId) {
    if (!hasPerm("edit_curriculum")) return;
    const it = itemId ? (state.curriculumItems || []).find((x) => x.id === itemId) : null;
    state.curState.editingId = itemId || null;

    $("#curriculumModalTitle").textContent = it ? "Edit curriculum item" : "New curriculum item";
    $("#cu_title").value             = it?.title || "";
    $("#cu_description").value       = it?.description || "";
    $("#cu_asset_type").value        = it?.asset_type || "pdf";
    $("#cu_default_lead_days").value = it?.default_lead_days ?? 7;
    $("#cu_external_url").value      = it?.external_url || "";
    $("#cu_script_content").value    = it?.script_content || "";
    $("#cu_dk_approved").checked     = !!it?.dk_approved;
    $("#cu_file").value              = "";
    const cur = $("#cu_currentFileLabel");
    const replaceHint = $("#cu_replaceHint");
    if (cur) {
      if (it && it.storage_path) {
        const meta = CURRICULUM_TYPE_META[it.asset_type] || { ico: "📦" };
        const fname = it.storage_path.split("/").pop() || it.storage_path;
        cur.innerHTML = `
          <span class="cu-current-file-ico" aria-hidden="true">${meta.ico}</span>
          <span class="cu-current-file-meta">
            <span class="cu-current-file-label">Current file</span>
            <span class="cu-current-file-name" title="${escapeHtml(it.storage_path)}">${escapeHtml(fname)}</span>
          </span>`;
        cur.style.display = "";
        if (replaceHint) replaceHint.style.display = "";
      } else {
        cur.innerHTML = "";
        cur.style.display = "none";
        if (replaceHint) replaceHint.style.display = "none";
      }
    }
    const archiveBtn = $("#cu_archiveBtn");
    if (archiveBtn) {
      archiveBtn.style.display = it ? "" : "none";
      archiveBtn.textContent = it && it.is_archived ? "Restore" : "Archive";
    }

    // T5c: Preview is only meaningful for saved bucket-stored items.
    // Hide for new items (no storage_path yet), link, and script types.
    const previewBtn = $("#cu_previewBtn");
    if (previewBtn) {
      const showPreview = !!(it && it.storage_path && ["pdf","video","image"].includes(it.asset_type));
      previewBtn.style.display = showPreview ? "" : "none";
    }

    syncCurriculumTypeFields();
    $("#curriculumModalOverlay").classList.add("open");
  }

  function closeCurriculumEditor() {
    $("#curriculumModalOverlay").classList.remove("open");
    state.curState.editingId = null;
  }

  function syncCurriculumTypeFields() {
    const type = $("#cu_asset_type").value;
    const meta = CURRICULUM_TYPE_META[type] || {};
    const uploadField   = $("#cu_uploadField");
    const externalField = $("#cu_externalField");
    const scriptField   = $("#cu_scriptField");
    const fileInput     = $("#cu_file");
    const uploadHint    = $("#cu_uploadHint");

    if (uploadField)   uploadField.style.display   = meta.file ? "" : "none";
    if (externalField) externalField.style.display = (type === "link" || type === "video") ? "" : "none";
    if (scriptField)   scriptField.style.display   = type === "script" ? "" : "none";
    if (fileInput && meta.accept) fileInput.setAttribute("accept", meta.accept);
    if (uploadHint && meta.uploadHint) uploadHint.textContent = meta.uploadHint;
  }

  async function saveCurriculumItem() {
    if (!hasPerm("edit_curriculum")) return;
    const editingId = state.curState.editingId;
    const existing  = editingId ? (state.curriculumItems || []).find((x) => x.id === editingId) : null;

    const title = $("#cu_title").value.trim();
    if (!title) { showToast("Title is required", "error"); return; }

    const asset_type        = $("#cu_asset_type").value;
    const description       = $("#cu_description").value.trim() || null;
    const default_lead_days = parseInt($("#cu_default_lead_days").value, 10) || 0;
    const external_url      = $("#cu_external_url").value.trim() || null;
    const script_content    = $("#cu_script_content").value || null;
    const dk_approved       = $("#cu_dk_approved").checked;

    if (asset_type === "link" && !external_url) {
      showToast("Link items need a URL", "error"); return;
    }
    if (asset_type === "script" && !(script_content || "").trim()) {
      showToast("Script items need content", "error"); return;
    }

    const fileEl = $("#cu_file");
    const file   = fileEl && fileEl.files && fileEl.files[0];
    const meta   = CURRICULUM_TYPE_META[asset_type] || {};
    if (meta.file && !existing && !file && asset_type !== "video") {
      showToast(`${meta.label} items need a file`, "error"); return;
    }
    const cap = CURRICULUM_MAX_BYTES[asset_type];
    if (file && cap && file.size > cap) {
      showToast(`File too large (max ${Math.round(cap / 1024 / 1024)} MB)`, "error"); return;
    }

    showLoader(true);
    try {
      let storage_path = existing?.storage_path || null;

      if (file) {
        const ext  = (file.name.split(".").pop() || "bin").toLowerCase();
        const uid  = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const path = `${asset_type}/${uid}.${ext}`;
        const up = await sb.storage.from("curriculum-assets").upload(path, file, {
          contentType: file.type || undefined,
          upsert: false,
        });
        if (up.error) throw up.error;
        // Best-effort cleanup of the prior file when replacing.
        if (existing?.storage_path && existing.storage_path !== path) {
          sb.storage.from("curriculum-assets").remove([existing.storage_path]).catch(() => {});
        }
        storage_path = path;
      }

      const row = {
        title,
        description,
        asset_type,
        default_lead_days,
        dk_approved,
        external_url: (asset_type === "link" || asset_type === "video") ? external_url : null,
        script_content: asset_type === "script" ? script_content : null,
        storage_path: meta.file ? storage_path : null,
      };

      if (existing) {
        const { error } = await sb.from("curriculum_items").update(row).eq("id", existing.id);
        if (error) throw error;
      } else {
        row.created_by = state.profile?.id || null;
        const { error } = await sb.from("curriculum_items").insert(row);
        if (error) throw error;
      }

      await reloadAll(); renderAll();
      closeCurriculumEditor();
      showToast(existing ? "Curriculum item updated" : "Curriculum item added", "success");
    } catch (e) {
      console.error(e);
      showToast("Save failed: " + (e.message || e), "error");
    }
    showLoader(false);
  }

  async function toggleCurriculumArchive() {
    if (!hasPerm("edit_curriculum")) return;
    const editingId = state.curState.editingId;
    if (!editingId) return;
    const it = (state.curriculumItems || []).find((x) => x.id === editingId);
    if (!it) return;
    const next = !it.is_archived;
    showLoader(true);
    const { error } = await sb.from("curriculum_items").update({ is_archived: next }).eq("id", editingId);
    showLoader(false);
    if (error) { showToast("Failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeCurriculumEditor();
    showToast(next ? "Archived" : "Restored", "success");
  }

  /* ═════════════ Curriculum assignments (T5b) ═════════════
   *
   * Each curriculum item can be assigned to many (class, teacher) pairs.
   * The "Assign…" button on each curriculum row opens this modal, which
   * shows current assignments + an inline form to add another.
   *
   * Lead-window math is client-side per CLAUDE.md §4.22: RLS only
   * verifies the assignment exists; the rolling per-session unlock
   * countdown is computed by `curriculumLeadWindowState()` against
   * `nextSessionDateForClass()`. T5c will re-verify in an Edge Function
   * before minting signed URLs and append to curriculum_access_log.
   */

  // Effective lead days for an assignment. Override wins; otherwise
  // fall back to the parent item's default.
  function effectiveLeadDays(assignment, item) {
    if (assignment && assignment.lead_days_override != null) return assignment.lead_days_override;
    return item ? (item.default_lead_days ?? 7) : 7;
  }

  // Returns { unlocked, nextSessionIso, daysUntilUnlock }.
  // unlocked = true when now is past (nextSession - leadDays).
  // nextSessionIso = ISO date of the next session (or null if none in 60d).
  // daysUntilUnlock = whole days from today to the unlock moment (>= 0 only
  // meaningful when locked).
  function curriculumLeadWindowState(assignment, item, cls, now) {
    const lead = effectiveLeadDays(assignment, item);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const nextIso = nextSessionDateForClass(cls, today);
    if (!nextIso) {
      return { unlocked: false, nextSessionIso: null, daysUntilUnlock: null, leadDays: lead };
    }
    const next = new Date(nextIso + "T00:00:00");
    const unlockAt = new Date(next); unlockAt.setDate(unlockAt.getDate() - lead);
    const unlocked = today >= unlockAt;
    const days = Math.max(0, Math.round((unlockAt - today) / 86400000));
    return { unlocked, nextSessionIso: nextIso, daysUntilUnlock: days, leadDays: lead };
  }

  function openAssignCurriculumModal(itemId) {
    if (!hasPerm("assign_curriculum")) return;
    const item = (state.curriculumItems || []).find((x) => x.id === itemId);
    if (!item) { showToast("Item not found", "error"); return; }

    state.assignCurState = {
      itemId,
      formClassId: "",
      formTeacherId: "",
      formLeadOverride: "",
      formNotes: ""
    };

    $("#assignCurModalTitle").textContent = `Assign · ${item.title}`;
    $("#assignCurDefaultLead").textContent = `${item.default_lead_days}d`;
    renderAssignCurriculumModal();
    $("#assignCurModalOverlay").classList.add("open");
  }

  function closeAssignCurriculumModal() {
    $("#assignCurModalOverlay").classList.remove("open");
    state.assignCurState.itemId = null;
  }

  function renderAssignCurriculumModal() {
    const itemId = state.assignCurState.itemId;
    if (!itemId) return;

    const rows = (state.curriculumAssignments || []).filter((a) => a.curriculum_item_id === itemId);
    const list = $("#assignCurList");
    if (list) {
      if (rows.length === 0) {
        list.innerHTML = `<div style="padding:16px;text-align:center;color:var(--ink-dim);font-size:12.5px">No assignments yet. Use the form below to add one.</div>`;
      } else {
        list.innerHTML = rows.map((a) => {
          const cls = state.classes.find((c) => c.id === a.class_id);
          const tch = state.teachers.find((t) => t.id === a.teacher_id);
          const item = state.curriculumItems.find((x) => x.id === a.curriculum_item_id);
          const leadStr = a.lead_days_override != null
            ? `${a.lead_days_override}d (override)`
            : `${item?.default_lead_days ?? 7}d (default)`;
          const adminNote = a.notes
            ? `<div style="font-size:11.5px;color:var(--ink-dim);margin-top:3px">${escapeHtml(a.notes)}</div>` : "";
          return `
            <div class="assign-cur-row">
              <div class="assign-cur-row-main">
                <div class="assign-cur-row-head">
                  <span class="assign-cur-class">${escapeHtml(cls?.name || "(deleted class)")}</span>
                  <span class="assign-cur-sep">→</span>
                  <span class="assign-cur-teacher">${escapeHtml(tch?.full_name || "(deleted teacher)")}</span>
                </div>
                <div class="assign-cur-row-meta">⏱ ${escapeHtml(leadStr)}</div>
                ${adminNote}
              </div>
              <button class="btn ghost small" data-assign-remove="${escapeHtml(a.id)}">Remove</button>
            </div>`;
        }).join("");
      }
      list.querySelectorAll("[data-assign-remove]").forEach((b) => {
        b.onclick = () => removeCurriculumAssignment(b.getAttribute("data-assign-remove"));
      });
    }

    // Class dropdown — every active class.
    const classSel = $("#assignCurClass");
    if (classSel) {
      const cur = state.assignCurState.formClassId;
      const opts = state.classes
        .filter((c) => includeTestClass(c) && c.active !== false)
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
        .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.location ? " · " + escapeHtml(c.location) : ""}</option>`)
        .join("");
      classSel.innerHTML = `<option value="">— pick a class —</option>${opts}`;
      classSel.value = cur;
    }

    // Teacher dropdown — narrow to teachers actually assigned to the chosen
    // class via class_teachers (so admins don't accidentally hand out
    // curriculum to a teacher who isn't on that class). If no class chosen
    // yet, show all active teachers.
    const teacherSel = $("#assignCurTeacher");
    if (teacherSel) {
      const cls = state.assignCurState.formClassId;
      const linkedIds = cls
        ? new Set(state.classTeachers.filter((ct) => ct.class_id === cls).map((ct) => ct.teacher_id))
        : null;
      const teacherList = state.teachers
        .filter((t) => t.status === "active")
        .filter((t) => !linkedIds || linkedIds.has(t.id))
        .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
      const cur = state.assignCurState.formTeacherId;
      const opts = teacherList
        .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.full_name)}${t.email ? " · " + escapeHtml(t.email) : ""}</option>`)
        .join("");
      const hint = cls && teacherList.length === 0
        ? `<option value="" disabled>No teachers linked to this class — assign one in the Classes tab first.</option>`
        : `<option value="">— pick a teacher —</option>`;
      teacherSel.innerHTML = `${hint}${opts}`;
      teacherSel.value = cur;
    }

    const leadInp = $("#assignCurLeadOverride");
    if (leadInp) leadInp.value = state.assignCurState.formLeadOverride;
    const notesInp = $("#assignCurNotes");
    if (notesInp) notesInp.value = state.assignCurState.formNotes;

    // Disable Add button until both class+teacher chosen.
    const addBtn = $("#assignCurAddBtn");
    if (addBtn) {
      addBtn.disabled = !(state.assignCurState.formClassId && state.assignCurState.formTeacherId);
    }
  }

  async function addCurriculumAssignment() {
    if (!hasPerm("assign_curriculum")) return;
    const { itemId, formClassId, formTeacherId, formLeadOverride, formNotes } = state.assignCurState;
    if (!itemId || !formClassId || !formTeacherId) return;

    const dup = (state.curriculumAssignments || []).find((a) =>
      a.curriculum_item_id === itemId && a.class_id === formClassId && a.teacher_id === formTeacherId);
    if (dup) { showToast("Already assigned to that class+teacher", "error"); return; }

    const lead = formLeadOverride === "" ? null : parseInt(formLeadOverride, 10);
    if (lead !== null && (Number.isNaN(lead) || lead < 0 || lead > 60)) {
      showToast("Lead override must be 0–60 days (or blank)", "error"); return;
    }

    showLoader(true);
    const { error } = await sb.from("curriculum_assignments").insert({
      curriculum_item_id: itemId,
      class_id:           formClassId,
      teacher_id:         formTeacherId,
      lead_days_override: lead,
      notes:              (formNotes || "").trim() || null,
      assigned_by:        state.profile?.id || null
    });
    showLoader(false);
    if (error) { showToast("Assign failed: " + error.message, "error"); return; }

    state.assignCurState.formClassId = "";
    state.assignCurState.formTeacherId = "";
    state.assignCurState.formLeadOverride = "";
    state.assignCurState.formNotes = "";

    await reloadAll(); renderAll();
    renderAssignCurriculumModal();
    showToast("Assignment added", "success");
  }

  async function removeCurriculumAssignment(assignmentId) {
    if (!hasPerm("assign_curriculum")) return;
    if (!confirm("Remove this assignment? The teacher will lose access to this item for that class.")) return;
    showLoader(true);
    const { error } = await sb.from("curriculum_assignments").delete().eq("id", assignmentId);
    showLoader(false);
    if (error) { showToast("Remove failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    renderAssignCurriculumModal();
    showToast("Assignment removed", "success");
  }

  /* ═════════════ USERS (T6d — role management) ═════════════
   *
   * Admin-only tab that lists every profile and lets super_admin / admin:
   *   • Change a user's role
   *   • Edit per-user grant/revoke permission lists
   *   • Link a profile to a teachers row (supersedes the email-match path
   *     used by the teacher bento + clock-in helpers)
   *   • Redeem a pending teacher_invitations row against an existing
   *     profile (the case handle_new_user can't catch — the user already
   *     existed when the invitation was created, so the trigger never
   *     re-fires)
   *
   * RPCs called: set_profile_role, set_profile_permissions,
   *   link_profile_to_teacher, redeem_invitation_for. All gate
   *   server-side; this UI is the convenience layer.
   */

  function profileEmailFor(p) {
    if (!p) return "";
    // Profile rows don't carry email directly — auth.users does. The signed-in
    // user's email lives on state.session; for everyone else we fall back to
    // the linked teachers row, then to par_primary_email if cached.
    if (state.session && p.id === state.session.user.id) {
      return state.session.user.email || "";
    }
    if (p.teacher_id) {
      const t = state.teachers.find((x) => x.id === p.teacher_id);
      if (t && t.email) return t.email;
    }
    return p.par_primary_email || "";
  }

  function pendingInvitationFor(email) {
    if (!email) return null;
    const lc = email.toLowerCase();
    return state.teacherInvitations.find((inv) =>
      (inv.email || "").toLowerCase() === lc &&
      !inv.accepted_at &&
      (!inv.expires_at || new Date(inv.expires_at) > new Date())
    ) || null;
  }

  function renderUsersTab() {
    const panel = document.querySelector('.tab-panel[data-tab="users"]');
    if (!panel) return;
    if (!canSeeTab("users")) { panel.innerHTML = ""; return; }

    const q = (state.usersState.query || "").toLowerCase();
    const showNoRole = !!state.usersState.showNoRole;

    const rows = state.profiles
      .filter((p) => showNoRole || p.role)
      .filter((p) => {
        if (!q) return true;
        const name = (p.full_name || "").toLowerCase();
        const email = profileEmailFor(p).toLowerCase();
        const par = (p.par_display_name || "").toLowerCase();
        return name.includes(q) || email.includes(q) || par.includes(q);
      })
      .sort((a, b) => {
        const ar = a.role || "zzz", br = b.role || "zzz";
        if (ar !== br) return ar.localeCompare(br);
        return (a.full_name || "").localeCompare(b.full_name || "");
      });

    const meSuper = isSuperAdmin();

    panel.innerHTML = `
      <div class="tab-head" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div class="results-meta">${state.profiles.length} ${state.profiles.length === 1 ? "user" : "users"}</div>
        <div style="flex:1"></div>
        <input id="usersSearch" class="search" type="search"
               placeholder="Search name, email…" value="${escapeHtml(state.usersState.query)}"
               style="max-width:260px" />
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-dim);cursor:pointer">
          <input type="checkbox" id="usersShowNoRole" ${showNoRole ? "checked" : ""} />
          Show no-role users
        </label>
      </div>
      <div class="data-table">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Linked teacher</th>
              <th>PAR</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `
              <tr><td colspan="6" style="text-align:center;color:var(--ink-dim);padding:24px">
                No users match.
              </td></tr>` : rows.map((p) => {
                const email = profileEmailFor(p);
                const teacher = p.teacher_id
                  ? state.teachers.find((t) => t.id === p.teacher_id)
                  : null;
                const pending = pendingInvitationFor(email);
                const canEditThis = meSuper || p.role !== "super_admin";
                const isMe = state.session && p.id === state.session.user.id;
                const grantedCount = (p.granted_permissions || []).length;
                const revokedCount = (p.revoked_permissions || []).length;
                const permsBadge = (grantedCount || revokedCount)
                  ? ` <span class="par-pending-badge" title="Per-user grants/revokes apply on top of the role bundle">+${grantedCount}/-${revokedCount}</span>`
                  : "";
                return `
                  <tr>
                    <td>
                      <b>${escapeHtml(p.full_name || p.par_display_name || "(no name)")}</b>${isMe ? ` <span class="par-pending-badge">you</span>` : ""}
                    </td>
                    <td style="color:var(--ink-dim);font-size:12px">${escapeHtml(email || "—")}</td>
                    <td>${escapeHtml(roleLabel(p.role))}${permsBadge}</td>
                    <td>${teacher ? escapeHtml(teacher.full_name) : `<span style="color:var(--ink-dim)">—</span>`}</td>
                    <td>${p.par_person_id
                      ? `<span class="par-linked-badge" title="${escapeHtml(p.par_primary_email || "")}">PAR ✓</span>`
                      : `<span style="color:var(--ink-dim)">—</span>`}</td>
                    <td style="text-align:right">
                      ${pending ? `<button class="btn small" data-act="redeem-invite" data-id="${escapeHtml(p.id)}">Redeem ${escapeHtml(pending.dk_role)} invite</button>` : ""}
                      <button class="btn small ${canEditThis ? "primary" : ""}" data-act="edit-user" data-id="${escapeHtml(p.id)}" ${canEditThis ? "" : "disabled title=\"Only super_admin can edit super_admin\""}>Edit</button>
                    </td>
                  </tr>
                `;
              }).join("")}
          </tbody>
        </table>
      </div>
    `;

    const search = panel.querySelector("#usersSearch");
    if (search) search.oninput = (e) => { state.usersState.query = e.target.value; renderUsersTab(); };
    const noRoleToggle = panel.querySelector("#usersShowNoRole");
    if (noRoleToggle) noRoleToggle.onchange = (e) => { state.usersState.showNoRole = !!e.target.checked; renderUsersTab(); };

    panel.querySelectorAll("button[data-act='edit-user']").forEach((b) => {
      b.onclick = () => openUserRoleModal(b.dataset.id);
    });
    panel.querySelectorAll("button[data-act='redeem-invite']").forEach((b) => {
      b.onclick = () => redeemInvitationForProfile(b.dataset.id);
    });
  }

  function openUserRoleModal(profileId) {
    const p = state.profiles.find((x) => x.id === profileId);
    if (!p) { showToast("Profile not found", "error"); return; }
    state.usersState.editingId = profileId;

    const meSuper = isSuperAdmin();
    const isProtected = p.role === "super_admin" && !meSuper;
    if (isProtected) {
      showToast("Only super_admin can edit a super_admin profile", "error");
      return;
    }

    $("#userRoleTitle").textContent = "Edit " + (p.full_name || profileEmailFor(p) || "user");
    $("#userRoleName").textContent  = p.full_name || p.par_display_name || "(no name)";
    $("#userRoleEmail").textContent = profileEmailFor(p) || "(no email cached)";

    const roleSel = $("#userRoleSelect");
    roleSel.value = p.role || "";
    // Disable super_admin option for non-super_admin actors.
    Array.from(roleSel.options).forEach((opt) => {
      if (opt.value === "super_admin" && !meSuper) {
        opt.disabled = true;
        opt.textContent = "Super admin (super_admin only)";
      } else if (opt.value === "super_admin") {
        opt.disabled = false;
        opt.textContent = "Super admin";
      }
    });

    const teacherSel = $("#userRoleTeacher");
    teacherSel.innerHTML = `<option value="">— Not linked —</option>` +
      state.teachers
        .filter((t) => t.status !== "inactive" || t.id === p.teacher_id)
        .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.full_name)}${t.email ? ` · ${escapeHtml(t.email)}` : ""}</option>`)
        .join("");
    teacherSel.value = p.teacher_id || "";

    $("#userRoleGranted").value = (p.granted_permissions || []).join(", ");
    $("#userRoleRevoked").value = (p.revoked_permissions || []).join(", ");
    $("#userRoleReason").value  = "";
    $("#userRoleError").style.display = "none";
    $("#userRoleError").textContent = "";

    $("#userRoleOverlay").classList.add("open");
  }

  function closeUserRoleModal() {
    $("#userRoleOverlay").classList.remove("open");
    state.usersState.editingId = null;
  }

  function parsePermsList(s) {
    return (s || "")
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function saveUserRoleModal() {
    const profileId = state.usersState.editingId;
    if (!profileId) return;
    const p = state.profiles.find((x) => x.id === profileId);
    if (!p) { showToast("Profile not found", "error"); return; }

    const newRole = $("#userRoleSelect").value || null;
    const newTeacher = $("#userRoleTeacher").value || null;
    const granted = parsePermsList($("#userRoleGranted").value);
    const revoked = parsePermsList($("#userRoleRevoked").value);
    const reason = $("#userRoleReason").value.trim() || null;

    const errEl = $("#userRoleError");
    errEl.style.display = "none";
    errEl.textContent = "";

    showLoader(true);
    try {
      // Role change first — fails fast on lockout / super_admin protection.
      if ((p.role || null) !== newRole) {
        const { error } = await sb.rpc("set_profile_role", {
          p_profile_id: profileId,
          p_new_role: newRole,
          p_reason: reason
        });
        if (error) throw error;
      }
      // Permissions
      const oldGranted = JSON.stringify(p.granted_permissions || []);
      const oldRevoked = JSON.stringify(p.revoked_permissions || []);
      if (oldGranted !== JSON.stringify(granted) || oldRevoked !== JSON.stringify(revoked)) {
        const { error } = await sb.rpc("set_profile_permissions", {
          p_profile_id: profileId,
          p_granted: granted,
          p_revoked: revoked
        });
        if (error) throw error;
      }
      // Teacher link
      if ((p.teacher_id || null) !== newTeacher) {
        const { error } = await sb.rpc("link_profile_to_teacher", {
          p_profile_id: profileId,
          p_teacher_id: newTeacher
        });
        if (error) throw error;
      }
    } catch (e) {
      errEl.textContent = e.message || "Save failed";
      errEl.style.display = "";
      showLoader(false);
      return;
    }
    showLoader(false);
    closeUserRoleModal();
    await reloadAll();
    renderAll();
    showToast("User updated", "success");
  }

  async function redeemInvitationForProfile(profileId) {
    const p = state.profiles.find((x) => x.id === profileId);
    if (!p) return;
    const email = profileEmailFor(p);
    const pending = pendingInvitationFor(email);
    if (!pending) { showToast("No pending invitation for this user", "error"); return; }
    if (!confirm(`Redeem the pending ${pending.dk_role} invitation for ${email}? This promotes their role and links any attached teacher record.`)) return;

    showLoader(true);
    const { error } = await sb.rpc("redeem_invitation_for", { p_profile_id: profileId });
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    showToast("Invitation redeemed", "success");
  }

  /* ═════════════ Reports tab ═════════════
   * Admin-only aggregation views that sit alongside the operational tabs.
   * Registered reports:
   *   - attendance: overall summary + per-class breakdown + late-pickup log
   * Adding a new report:
   *   1. Add to REPORTS list (id, label, render fn)
   *   2. Implement the render fn — it receives state.rptState and the
   *      #reportContent DOM node.
   */
  const REPORTS = [
    { id: "attendance", label: "Attendance", render: renderAttendanceReport },
    { id: "teacher_hours", label: "Teacher hours", render: renderTeacherHoursReport },
  ];

  function ensureReportDateDefaults() {
    if (state.rptState.start && state.rptState.end) return;
    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 29);
    state.rptState.start = isoDate(start);
    state.rptState.end   = isoDate(today);
  }

  function renderReportsTab() {
    const panel = document.querySelector('.tab-panel[data-tab="reports"]');
    if (!panel) return;
    // Gate: only render when the user is allowed on this tab.
    if (!canSeeTab("reports")) return;
    ensureReportDateDefaults();

    // Sub-nav
    const subNav = $("#reportSubNav");
    if (subNav) {
      subNav.innerHTML = REPORTS.map((r) => {
        const active = r.id === state.rptState.active;
        return `<button data-report="${escapeHtml(r.id)}" class="btn small"
          style="${active ? "background:var(--accent,#2d2d2d);color:#fff;border-color:var(--accent,#2d2d2d)" : ""}">${escapeHtml(r.label)}</button>`;
      }).join(" ");
      subNav.querySelectorAll("[data-report]").forEach((b) => {
        b.onclick = () => {
          state.rptState.active = b.dataset.report;
          renderReportsTab();
        };
      });
    }

    const content = $("#reportContent");
    if (!content) return;
    const active = REPORTS.find((r) => r.id === state.rptState.active) || REPORTS[0];
    active.render(content);
  }

  // Filter state.attendance by [start, end] inclusive (ISO dates).
  function attendanceInRange(start, end) {
    return state.attendance.filter((a) => a.session_date >= start && a.session_date <= end);
  }

  function renderAttendanceReport(host) {
    const s = state.rptState;
    const rows = attendanceInRange(s.start, s.end);

    // Aggregate: total sessions = distinct (class_id, session_date) pairs.
    const sessionKeys = new Set();
    let totPresent = 0, totAbsent = 0, totLate = 0, totMin = 0;
    for (const a of rows) {
      const enr = state.enrollments.find((e) => e.id === a.enrollment_id);
      if (!enr) continue;
      sessionKeys.add(enr.class_id + "|" + a.session_date);
      if (a.status === "present" || a.status === "late") totPresent++;
      else if (a.status === "absent" || a.status === "excused") totAbsent++;
      if (a.late_pickup_minutes && a.late_pickup_minutes > 0) {
        totLate++;
        totMin += a.late_pickup_minutes;
      }
    }

    // Per-class stats
    const byClass = new Map(); // class_id -> {sessions:Set, present, absent, late, minutes}
    for (const a of rows) {
      const enr = state.enrollments.find((e) => e.id === a.enrollment_id);
      if (!enr) continue;
      let s2 = byClass.get(enr.class_id);
      if (!s2) { s2 = { sessions: new Set(), present: 0, absent: 0, late: 0, minutes: 0 }; byClass.set(enr.class_id, s2); }
      s2.sessions.add(a.session_date);
      if (a.status === "present" || a.status === "late") s2.present++;
      else if (a.status === "absent" || a.status === "excused") s2.absent++;
      if (a.late_pickup_minutes && a.late_pickup_minutes > 0) {
        s2.late++;
        s2.minutes += a.late_pickup_minutes;
      }
    }
    const classRows = [...byClass.entries()]
      .map(([cid, st]) => {
        const cls = state.classes.find((c) => c.id === cid);
        return {
          className: cls ? (cls.name || "—") : "(unknown class)",
          sessions: st.sessions.size,
          present: st.present,
          absent: st.absent,
          late: st.late,
          minutes: st.minutes,
        };
      })
      .sort((a, b) => a.className.localeCompare(b.className));

    // Late-pickup itemized list
    const latePickups = rows
      .filter((a) => a.late_pickup_minutes && a.late_pickup_minutes > 0)
      .map((a) => {
        const enr = state.enrollments.find((e) => e.id === a.enrollment_id);
        const stu = enr ? state.students.find((st) => st.id === enr.student_id) : null;
        const cls = enr ? state.classes.find((c) => c.id === enr.class_id) : null;
        return {
          date: a.session_date,
          student: stu ? `${stu.first_name || ""} ${stu.last_name || ""}`.trim() : "(unknown)",
          className: cls ? (cls.name || "—") : "(unknown)",
          minutes: a.late_pickup_minutes,
          notes: a.notes || "",
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const presetBtn = (label, days) =>
      `<button data-rpt-preset="${days}" class="btn small">${escapeHtml(label)}</button>`;

    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:12px 0 16px;border-bottom:1px solid var(--border-subtle,#eee)">
        <div class="field" style="flex:0 0 160px">
          <label>From</label>
          <input type="date" id="rpt_start" value="${escapeHtml(s.start)}" />
        </div>
        <div class="field" style="flex:0 0 160px">
          <label>To</label>
          <input type="date" id="rpt_end" value="${escapeHtml(s.end)}" />
        </div>
        <div style="display:flex;gap:4px">
          ${presetBtn("Last 7d", 7)}
          ${presetBtn("Last 30d", 30)}
          ${presetBtn("Last 90d", 90)}
        </div>
        <div style="flex:1"></div>
        <button class="btn small" id="rpt_export_csv">Export CSV (late pickups)</button>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Summary</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:12px 0">
          ${[
            ["Sessions", sessionKeys.size, ""],
            ["Present", totPresent, ""],
            ["Absent", totAbsent, ""],
            ["Late pickups", totLate, totLate > 0 ? "#a36a00" : ""],
            ["Late minutes", totMin, totMin > 0 ? "#a36a00" : ""],
          ].map(([k, v, col]) => `
            <div style="padding:10px 12px;background:var(--surface-alt,#f5f4ef);border-radius:8px">
              <div style="font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.5px">${escapeHtml(k)}</div>
              <div style="font-size:22px;font-weight:600;margin-top:2px;${col ? `color:${col}` : ""}">${v}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">By class</div>
        ${classRows.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No attendance recorded in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Sessions</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Present</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Absent</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Late pickups</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Late min</th>
              </tr>
            </thead>
            <tbody>
              ${classRows.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px">${escapeHtml(r.className)}</td>
                  <td style="padding:6px 8px;text-align:right">${r.sessions}</td>
                  <td style="padding:6px 8px;text-align:right">${r.present}</td>
                  <td style="padding:6px 8px;text-align:right">${r.absent}</td>
                  <td style="padding:6px 8px;text-align:right${r.late > 0 ? ';color:#a36a00;font-weight:600' : ''}">${r.late}</td>
                  <td style="padding:6px 8px;text-align:right${r.minutes > 0 ? ';color:#a36a00;font-weight:600' : ''}">${r.minutes}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Late pickups <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(billing candidates)</span></div>
        ${latePickups.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No late pickups in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Date</th>
                <th style="padding:6px 8px;font-weight:600">Student</th>
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Minutes</th>
                <th style="padding:6px 8px;font-weight:600">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${latePickups.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.student)}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.className)}</td>
                  <td style="padding:6px 8px;text-align:right;color:#a36a00;font-weight:600">${r.minutes}</td>
                  <td style="padding:6px 8px;color:var(--ink-dim)">${escapeHtml(r.notes)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>
    `;

    // Wire controls
    $("#rpt_start").onchange = (e) => { state.rptState.start = e.target.value; renderReportsTab(); };
    $("#rpt_end").onchange   = (e) => { state.rptState.end   = e.target.value; renderReportsTab(); };
    host.querySelectorAll("[data-rpt-preset]").forEach((b) => {
      b.onclick = () => {
        const days = parseInt(b.dataset.rptPreset, 10);
        const today = new Date();
        const start = new Date(today); start.setDate(start.getDate() - (days - 1));
        state.rptState.start = isoDate(start);
        state.rptState.end   = isoDate(today);
        renderReportsTab();
      };
    });
    $("#rpt_export_csv").onclick = () => downloadLatePickupCsv(latePickups, s.start, s.end);
  }

  // T3d: Teacher hours report — per-teacher payroll roll-up + itemized log.
  // Aggregates state.clockIns in [start, end]. Shifts without clocked_out_at
  // are shown but excluded from totals (open shifts — not yet billable).
  function renderTeacherHoursReport(host) {
    const s = state.rptState;
    const rows = state.clockIns.filter((c) => c.session_date >= s.start && c.session_date <= s.end);

    const byTeacher = new Map(); // teacher_id -> { shifts, minutes, openShifts }
    const byClass = new Map();
    let totalShifts = 0, totalMinutes = 0, openShifts = 0;

    for (const c of rows) {
      totalShifts++;
      if (!c.clocked_out_at) { openShifts++; continue; }
      const mins = Math.max(0, Math.round((new Date(c.clocked_out_at) - new Date(c.clocked_in_at)) / 60000));
      totalMinutes += mins;
      let t = byTeacher.get(c.teacher_id);
      if (!t) { t = { shifts: 0, minutes: 0 }; byTeacher.set(c.teacher_id, t); }
      t.shifts++; t.minutes += mins;
      if (c.class_id) {
        let k = byClass.get(c.class_id);
        if (!k) { k = { shifts: 0, minutes: 0 }; byClass.set(c.class_id, k); }
        k.shifts++; k.minutes += mins;
      }
    }

    const fmtHours = (mins) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const teacherRows = [...byTeacher.entries()]
      .map(([tid, st]) => {
        const t = state.teachers.find((x) => x.id === tid);
        return { name: t ? t.full_name : "(unknown)", shifts: st.shifts, minutes: st.minutes };
      })
      .sort((a, b) => b.minutes - a.minutes);

    const classRows = [...byClass.entries()]
      .map(([cid, st]) => {
        const c = state.classes.find((x) => x.id === cid);
        return { name: c ? c.name : "(unknown class)", shifts: st.shifts, minutes: st.minutes };
      })
      .sort((a, b) => b.minutes - a.minutes);

    // Itemized log (desc by date, then teacher)
    const log = rows.map((c) => {
      const t = state.teachers.find((x) => x.id === c.teacher_id);
      const cls = c.class_id ? state.classes.find((x) => x.id === c.class_id) : null;
      const dur = c.clocked_out_at
        ? Math.max(0, Math.round((new Date(c.clocked_out_at) - new Date(c.clocked_in_at)) / 60000))
        : null;
      return {
        date: c.session_date,
        teacher: t ? t.full_name : "(unknown)",
        className: cls ? cls.name : "(no class)",
        clockedInAt: c.clocked_in_at,
        clockedOutAt: c.clocked_out_at,
        minutes: dur,
      };
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.teacher.localeCompare(b.teacher)));

    const presetBtn = (label, days) =>
      `<button data-rpt-preset="${days}" class="btn small">${escapeHtml(label)}</button>`;

    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:12px 0 16px;border-bottom:1px solid var(--border-subtle,#eee)">
        <div class="field" style="flex:0 0 160px">
          <label>From</label>
          <input type="date" id="rpt_start" value="${escapeHtml(s.start)}" />
        </div>
        <div class="field" style="flex:0 0 160px">
          <label>To</label>
          <input type="date" id="rpt_end" value="${escapeHtml(s.end)}" />
        </div>
        <div style="display:flex;gap:4px">
          ${presetBtn("Last 7d", 7)}
          ${presetBtn("Last 30d", 30)}
          ${presetBtn("Last 90d", 90)}
        </div>
        <div style="flex:1"></div>
        <button class="btn small" id="rpt_export_hours_csv">Export CSV (itemized)</button>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Summary</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:12px 0">
          ${[
            ["Shifts", totalShifts, ""],
            ["Total hours", fmtHours(totalMinutes), ""],
            ["Teachers", teacherRows.length, ""],
            ["Open shifts", openShifts, openShifts > 0 ? "#a36a00" : ""],
          ].map(([k, v, col]) => `
            <div style="padding:10px 12px;background:var(--surface-alt,#f5f4ef);border-radius:8px">
              <div style="font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.5px">${escapeHtml(k)}</div>
              <div style="font-size:22px;font-weight:600;margin-top:2px;${col ? `color:${col}` : ""}">${v}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">By teacher <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(payroll roll-up)</span></div>
        ${teacherRows.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No completed shifts in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Teacher</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Shifts</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Hours</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Minutes</th>
              </tr>
            </thead>
            <tbody>
              ${teacherRows.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px">${escapeHtml(r.name)}</td>
                  <td style="padding:6px 8px;text-align:right">${r.shifts}</td>
                  <td style="padding:6px 8px;text-align:right">${escapeHtml(fmtHours(r.minutes))}</td>
                  <td style="padding:6px 8px;text-align:right">${r.minutes}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div style="margin-top:16px">
        <div class="section-title">By class</div>
        ${classRows.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No completed shifts tied to a class.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Shifts</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Hours</th>
              </tr>
            </thead>
            <tbody>
              ${classRows.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px">${escapeHtml(r.name)}</td>
                  <td style="padding:6px 8px;text-align:right">${r.shifts}</td>
                  <td style="padding:6px 8px;text-align:right">${escapeHtml(fmtHours(r.minutes))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Shift log <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(${log.length} shifts)</span></div>
        ${log.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No shifts in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Date</th>
                <th style="padding:6px 8px;font-weight:600">Teacher</th>
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600">In</th>
                <th style="padding:6px 8px;font-weight:600">Out</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Duration</th>
              </tr>
            </thead>
            <tbody>
              ${log.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.teacher)}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.className)}</td>
                  <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(new Date(r.clockedInAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</td>
                  <td style="padding:6px 8px;white-space:nowrap">${r.clockedOutAt ? escapeHtml(new Date(r.clockedOutAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : '<span style="color:#a36a00">open</span>'}</td>
                  <td style="padding:6px 8px;text-align:right;${r.minutes == null ? 'color:#a36a00' : ''}">${r.minutes == null ? "—" : escapeHtml(fmtHours(r.minutes))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>
    `;

    $("#rpt_start").onchange = (e) => { state.rptState.start = e.target.value; renderReportsTab(); };
    $("#rpt_end").onchange   = (e) => { state.rptState.end   = e.target.value; renderReportsTab(); };
    host.querySelectorAll("[data-rpt-preset]").forEach((b) => {
      b.onclick = () => {
        const days = parseInt(b.dataset.rptPreset, 10);
        const today = new Date();
        const start = new Date(today); start.setDate(start.getDate() - (days - 1));
        state.rptState.start = isoDate(start);
        state.rptState.end   = isoDate(today);
        renderReportsTab();
      };
    });
    $("#rpt_export_hours_csv").onclick = () => downloadTeacherHoursCsv(log, s.start, s.end);
  }

  function downloadTeacherHoursCsv(rows, start, end) {
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Date","Teacher","Class","ClockedInAt","ClockedOutAt","Minutes"].join(",");
    const body = rows.map((r) => [
      r.date, r.teacher, r.className, r.clockedInAt, r.clockedOutAt || "", r.minutes == null ? "" : r.minutes
    ].map(esc).join(",")).join("\n");
    const csv = header + "\n" + body + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teacher-hours-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadLatePickupCsv(rows, start, end) {
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Date","Student","Class","Minutes","Notes"].join(",");
    const body = rows.map((r) => [r.date, r.student, r.className, r.minutes, r.notes].map(esc).join(",")).join("\n");
    const csv = header + "\n" + body + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `late-pickups-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Permission helper: can THIS user take attendance for THIS class on this date?
  function canTakeAttendanceFor(cls, dateIso) {
    if (isAdminOrAbove()) return true;
    if (!hasPerm("take_own_attendance")) return false;
    // Teacher must be assigned to the class
    const me = mySignedInTeacher();
    if (!me) return false;
    const assigned = state.classTeachers.some((ct) => ct.class_id === cls.id && ct.teacher_id === me.id);
    if (!assigned) return false;
    // Date must be in the 2-day grace window
    const today = isoDate(new Date());
    const d = new Date(dateIso + "T00:00:00");
    const t = new Date(today + "T00:00:00");
    const diffDays = Math.round((t - d) / (1000 * 60 * 60 * 24));
    return diffDays >= 0 && diffDays <= 2;
  }

  function renderSyncStatus() {
    const el = $("#syncStatus");
    const log = state.latestSyncLog;
    if (!log) {
      el.className = "sync-status";
      el.innerHTML = "";
      return;
    }
    const when = new Date(log.created_at);
    const statusClass = log.status === "ok" ? "ok" : (log.status === "partial" ? "partial" : log.status === "error" ? "error" : "");
    el.className = "sync-status visible " + statusClass;
    el.innerHTML = `
      <div><b>Last Jackrabbit sync:</b> ${escapeHtml(log.message || "")}</div>
      <div class="timestamp">${escapeHtml(when.toLocaleString())}</div>
    `;
  }

  async function syncJackrabbit() {
    showLoader(true);
    const t0 = Date.now();
    try {
      const { data, error } = await sb.functions.invoke("jackrabbit-sync", { body: {} });
      if (error) throw error;
      const ms = Date.now() - t0;
      if (data && data.status === "skipped") {
        showToast(`Sync skipped — ${data.reason || "not configured"}`, "error");
      } else if (data && data.status === "ok") {
        showToast(`Sync complete in ${ms}ms · pulled ${data.pulled} (+${data.inserted} new, ${data.updated} updated)`, "success");
      } else if (data && data.status === "partial") {
        showToast(`Sync partial — some errors. See sync log.`, "error");
      } else {
        showToast(`Sync returned: ${JSON.stringify(data).slice(0, 100)}`);
      }
    } catch (e) {
      showToast("Sync failed: " + e.message, "error");
    }
    await reloadAll();
    renderAll();
    showLoader(false);
  }

  function openClassEditor(id) {
    editingClassId = id || null;
    const c = id ? state.classes.find((x) => x.id === id) : null;
    $("#classModalTitle").textContent = c ? "Edit class" : "New class";
    $("#c_name").value              = c ? c.name : "";
    $("#c_day_time").value          = c ? (c.day_time || "") : "";
    // Populate the school dropdown — every active school plus an explicit
    // "(unset)" option that lets admins clear the link and fall back to
    // the free-form `location` string. The legacy text input lives below
    // the dropdown for cases where the school isn't in the list yet
    // (Jackrabbit-synced classes, manual one-offs).
    const schoolSel = $("#c_school_id");
    if (schoolSel) {
      schoolSel.innerHTML = `<option value="">(unset — use free-form location below)</option>` +
        state.schools
          .filter((s) => s.active !== false || (c && c.school_id === s.id))
          .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
          .join("");
      schoolSel.value = c?.school_id || "";
    }
    $("#c_location").value          = c ? (c.location || "") : "";
    $("#c_registration_link").value = c ? (c.registration_link || "") : "";
    $("#c_age_range").value         = c ? (c.age_range || "") : "";
    $("#c_type").value              = c ? (c.type || "weekly") : "weekly";
    $("#c_start_date").value        = c ? (c.start_date || "") : "";
    $("#c_end_date").value          = c ? (c.end_date || "") : "";
    $("#c_active").value            = (c && c.active === false) ? "false" : "true";
    $("#c_notes").value             = c ? (c.notes || "") : "";
    $("#deleteClassBtn").style.display = c ? "" : "none";
    $("#classModalOverlay").classList.add("open");
    setTimeout(() => $("#c_name").focus(), 50);
  }
  function closeClassEditor() { $("#classModalOverlay").classList.remove("open"); editingClassId = null; }

  async function saveClass() {
    const name = $("#c_name").value.trim();
    if (!name) { showToast("Class name is required", "error"); return; }
    const schoolSel = $("#c_school_id");
    const payload = {
      name,
      day_time: $("#c_day_time").value.trim() || null,
      school_id: (schoolSel && schoolSel.value) ? schoolSel.value : null,
      location: $("#c_location").value.trim() || null,
      registration_link: $("#c_registration_link").value.trim() || null,
      age_range: $("#c_age_range").value.trim() || null,
      type: $("#c_type").value,
      active: $("#c_active").value !== "false",
      start_date: $("#c_start_date").value || null,
      end_date: $("#c_end_date").value || null,
      notes: $("#c_notes").value || null
    };
    showLoader(true);
    let resp;
    if (editingClassId) {
      resp = await sb.from("classes").update(payload).eq("id", editingClassId).select().single();
    } else {
      const slugs = new Set(state.classes.map((c) => c.slug));
      payload.slug = uniqueSlug(slugify(name), slugs);
      resp = await sb.from("classes").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeClassEditor();
    showToast(editingClassId ? "Class updated" : "Class added", "success");
  }

  async function deleteClass() {
    if (!editingClassId) return;
    if (!confirm("Delete this class?")) return;
    showLoader(true);
    const { error } = await sb.from("classes").delete().eq("id", editingClassId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeClassEditor();
    showToast("Class deleted", "success");
  }

  /* ═════════════ TEACHERS ═════════════ */

  let editingTeacherId = null;
  let inviteEditorTeacherId = null;

  function renderTeachersTab() {
    const el = $("#teacherTable");
    const active = state.teachers.filter((t) => t.status === 'active').length;
    const parLinked = state.teachers.filter((t) => t.par_person_id).length;
    const resolvable = state.teachers.filter((t) => t.email && !t.par_person_id).length;
    $("#teacherMeta").innerHTML = state.teachers.length + (state.teachers.length === 1 ? " teacher" : " teachers") +
      (state.teachers.length ? ` <span style="color:var(--ink-dim)">· ${active} active${parLinked ? ` · ${parLinked} PAR-linked` : ""}${resolvable ? ` · ${resolvable} pending PAR check` : ""}</span>` : "");

    const showPay    = hasPerm("view_pay_rates");
    const showEdit   = hasPerm("edit_teachers");
    const showInvite = isAdminOrAbove();
    const rowClickEdit = isAdminOrAbove();
    const colCount = 4 + (showPay ? 1 : 0) + (showEdit || showInvite ? 1 : 0);

    const rows = state.teachers.map((t) => {
      const classCount = state.classTeachers.filter((ct) => ct.teacher_id === t.id).length;
      const statusLabel = { active: "Active", on_leave: "On leave", inactive: "Inactive" };
      const parBadge = t.par_person_id
        ? ` <span class="par-linked-badge" title="Linked to PAR person ${escapeHtml(t.par_person_id)}">PAR \u2713</span>`
        : (t.email ? ` <span class="par-pending-badge" title="Email on file but not yet resolved against PAR">unresolved</span>` : "");

      // Most-recent invitation for this teacher's email (if any)
      const myEmail = (t.email || "").toLowerCase();
      const latestInvite = myEmail
        ? state.teacherInvitations.find((inv) => (inv.email || "").toLowerCase() === myEmail)
        : null;
      const inviteBadge = renderInviteBadge(latestInvite);

      // Action cell — Invite + Edit depending on state
      const actions = [];
      if (showInvite && t.email && !t.par_person_id) {
        const label = latestInvite && !latestInvite.accepted_at && isInviteExpired(latestInvite) ? "Re-invite"
                     : latestInvite && !latestInvite.accepted_at ? "Copy link"
                     : "Invite";
        actions.push(`<button class="btn small ${label === "Invite" || label === "Re-invite" ? "primary" : ""}" data-act="invite-teacher" data-id="${escapeHtml(t.id)}" data-email="${escapeHtml(t.email)}">${label}</button>`);
      }
      if (showEdit) {
        actions.push(`<button class="btn small ghost" data-act="edit-teacher" data-id="${escapeHtml(t.id)}">Edit</button>`);
      }
      const actionCell = (showEdit || showInvite) ? `<td class="row-actions" style="white-space:nowrap">${actions.join(" ")}</td>` : "";

      const rowAttrs = rowClickEdit
        ? ` data-act="row-edit-teacher" data-id="${escapeHtml(t.id)}" style="cursor:pointer" title="Edit teacher"`
        : "";

      return `
        <tr${rowAttrs}>
          <td><b>${escapeHtml(t.full_name)}</b>${parBadge}${inviteBadge}${t.email ? `<div style="font-size:11.5px;color:var(--ink-dim)">${escapeHtml(t.email)}</div>` : `<div style="font-size:11.5px;color:var(--ink-mute);font-style:italic">no email \u2014 can't resolve PAR</div>`}</td>
          <td>${escapeHtml(t.phone || "")}</td>
          ${showPay  ? `<td>${escapeHtml(t.pay_rate || "")}</td>` : ""}
          <td><span class="type-badge status-badge-${escapeHtml(t.status)}">${statusLabel[t.status] || t.status}</span></td>
          <td style="font-size:12px">${classCount} class${classCount === 1 ? "" : "es"}</td>
          ${actionCell}
        </tr>
      `;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Phone</th>${showPay ? "<th>Pay rate</th>" : ""}<th>Status</th><th>Assigned</th>${showEdit || showInvite ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;color:var(--ink-dim);padding:24px">No teachers yet${showEdit ? " — click <b>＋ New teacher</b>." : "."}</td></tr>`}</tbody>
      </table>
    `;
    if (showEdit) {
      $$('[data-act="edit-teacher"]', el).forEach((btn) => btn.onclick = (e) => { e.stopPropagation(); openTeacherEditor(btn.dataset.id); });
    }
    if (showInvite) {
      $$('[data-act="invite-teacher"]', el).forEach((btn) => btn.onclick = (e) => { e.stopPropagation(); onInviteTeacherClick(btn.dataset.id, btn.dataset.email); });
    }
    if (rowClickEdit) {
      $$('[data-act="row-edit-teacher"]', el).forEach((tr) => tr.onclick = () => openTeacherEditor(tr.dataset.id));
    }
  }

  /* Invitation status badge + helpers */
  function isInviteExpired(inv) {
    return !!(inv && inv.expires_at && new Date(inv.expires_at) < new Date());
  }
  function renderInviteBadge(inv) {
    if (!inv) return "";
    if (inv.accepted_at) {
      return ` <span class="invite-badge accepted" title="Accepted ${new Date(inv.accepted_at).toLocaleDateString()}">accepted</span>`;
    }
    if (isInviteExpired(inv)) {
      return ` <span class="invite-badge expired" title="Expired on ${new Date(inv.expires_at).toLocaleDateString()} — re-send">expired</span>`;
    }
    const label = inv.email_status === "sent" ? "invited"
                 : inv.email_status === "failed" ? "link ready"
                 : inv.email_status === "skipped" ? "link ready"
                 : "invited";
    return ` <span class="invite-badge pending" title="Invitation sent ${new Date(inv.sent_at).toLocaleDateString()}${inv.expires_at ? " · expires " + new Date(inv.expires_at).toLocaleDateString() : ""}">${label}</span>`;
  }

  /* On-click handler for a per-row Invite button: either re-show an
   * existing pending invite's result modal, or open the editor pre-filled
   * with the teacher's email + role=teacher. */
  function onInviteTeacherClick(teacherId, email) {
    if (!email) { showToast("Teacher has no email to invite", "error"); return; }
    const existing = state.teacherInvitations.find(
      (inv) => (inv.email || "").toLowerCase() === email.toLowerCase()
               && !inv.accepted_at
               && !isInviteExpired(inv)
    );
    if (existing) {
      openInviteResultModal({
        accept_url: existing.par_accept_url,
        expires_at: existing.expires_at,
        email_sent: existing.email_status === "sent",
        email_error: existing.email_error,
        email,
        reused: true,
      });
      return;
    }
    openInviteEditor({ email, teacher_id: teacherId, dk_role: "teacher" });
  }

  /* Open the invite editor, optionally with prefilled fields. */
  function openInviteEditor(prefill) {
    const p = prefill || {};
    inviteEditorTeacherId = p.teacher_id || null;
    $("#invEmail").value = p.email || "";
    $("#invRole").value  = p.dk_role || "teacher";
    $("#invNotes").value = p.notes || "";
    $("#invEmailHint").textContent = p.teacher_id
      ? "Inviting this existing teacher — they'll be linked to their teacher row on acceptance."
      : "This email will be invited as a standalone DK user. If you also want them in the teachers list, add them first via + New teacher.";
    updateInviteRoleMapHint();
    $("#inviteEditorOverlay").classList.add("open");
    setTimeout(() => $("#invEmail").focus(), 40);
  }

  function closeInviteEditor() {
    $("#inviteEditorOverlay").classList.remove("open");
    inviteEditorTeacherId = null;
  }

  /* Updates the "PAR-side role" hint below the role select so it's clear
   * what happens in PAR when this invitation is created. */
  function updateInviteRoleMapHint() {
    const dkRole = $("#invRole").value;
    const parMap = {
      super_admin: "owner", admin: "admin", manager: "member",
      teacher: "member", viewer: "member"
    };
    const parRole = parMap[dkRole] || "member";
    $("#invRoleMapHint").innerHTML =
      `In PAR they'll be an <b>${escapeHtml(parRole)}</b> of the franchise org. ` +
      (dkRole === "super_admin"
        ? "Use this for the franchise owner."
        : dkRole === "admin"
          ? "Full console access; can invite teachers and managers but not other admins."
          : dkRole === "manager"
            ? "Can respond to leads and edit templates; read-only on structural data."
            : dkRole === "teacher"
              ? "Sees only their own schedule and home bento. Full teacher features land in Phase T3."
              : "Read-only across every tab.");
  }

  /* Send the invitation from the editor form. */
  async function submitInviteEditor() {
    const email = $("#invEmail").value.trim().toLowerCase();
    const dkRole = $("#invRole").value;
    const notes = $("#invNotes").value.trim() || null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast("Enter a valid email address", "error"); return;
    }
    // Reuse existing pending invitation if one exists for this email
    const existing = state.teacherInvitations.find(
      (inv) => (inv.email || "").toLowerCase() === email
               && !inv.accepted_at
               && !isInviteExpired(inv)
    );
    if (existing) {
      closeInviteEditor();
      openInviteResultModal({
        accept_url: existing.par_accept_url,
        expires_at: existing.expires_at,
        email_sent: existing.email_status === "sent",
        email_error: existing.email_error,
        email,
        reused: true,
      });
      return;
    }
    const payload = {
      email,
      dk_role: dkRole,
      teacher_id: inviteEditorTeacherId || undefined,
      notes,
    };
    closeInviteEditor();
    await fireInvite(payload);
  }

  async function fireInvite(payload) {
    showLoader(true);
    try {
      const { data, error } = await sb.functions.invoke("dk-invite-teacher", { body: payload });
      if (error) {
        showToast(`Invite failed: ${error.message || String(error)}`, "error");
        return;
      }
      if (data?.error) {
        showToast(`Invite failed: ${data.error}`, "error");
        return;
      }
      await reloadAll();
      renderAll();
      openInviteResultModal({ ...data, email: payload.email, reused: false });
    } finally {
      showLoader(false);
    }
  }

  function openInviteResultModal(result) {
    const overlay = $("#inviteResultOverlay");
    if (!overlay) return;
    const { accept_url, expires_at, email_sent, email_error, email, reused } = result;
    $("#inviteResultSub").innerHTML = reused
      ? `Pending invitation for <b>${escapeHtml(email)}</b> — reusing the existing link.`
      : `Invitation created for <b>${escapeHtml(email)}</b>.`;
    $("#inviteResultEmailStatus").innerHTML = email_sent
      ? `<span class="invite-badge accepted">Email sent via Resend</span>`
      : `<span class="invite-badge pending">Email not sent (${escapeHtml(email_error || "—")})</span> &middot; copy the link below and send it manually.`;
    $("#inviteResultUrl").value = accept_url || "";
    $("#inviteResultExpires").textContent = expires_at
      ? `Expires ${new Date(expires_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
      : "";
    overlay.classList.add("open");
  }
  function closeInviteResultModal() {
    $("#inviteResultOverlay").classList.remove("open");
  }

  function openTeacherEditor(id) {
    editingTeacherId = id || null;
    const t = id ? state.teachers.find((x) => x.id === id) : null;
    $("#teacherModalTitle").textContent = t ? "Edit teacher" : "New teacher";

    // Role gating: PII / address / emergency contact / employment
    // classification / DOB / background+compliance are admin-only.
    // Payroll (pay_rate, pay_type, payment method, W-9) is gated on
    // view_pay_rates so the per-user grant story still works.
    const showPersonnel = isAdminOrAbove();
    const showPayroll   = hasPerm("view_pay_rates");
    const showPayments  = hasPerm("manage_teacher_payments");
    const showCompliance = hasPerm("manage_teacher_compliance");
    $$('#teacherModalOverlay .personnel-only').forEach((el) => el.style.display = showPersonnel ? "" : "none");
    $$('#teacherModalOverlay .payroll-only').forEach((el) => el.style.display = showPayroll ? "" : "none");
    $$('#teacherModalOverlay .payments-only').forEach((el) => el.style.display = showPayments ? "" : "none");
    $$('#teacherModalOverlay .compliance-only').forEach((el) => el.style.display = showCompliance ? "" : "none");

    // Always-visible fields
    $("#t_name").value           = t ? (t.full_name || "") : "";
    $("#t_preferred_name").value = t ? (t.preferred_name || "") : "";
    $("#t_email").value          = t ? (t.email || "") : "";
    $("#t_phone").value          = t ? (t.phone || "") : "";
    $("#t_title").value          = t ? (t.title || "") : "";
    $("#t_status").value         = t ? (t.status || "active") : "active";
    $("#t_hire_date").value      = t ? (t.hire_date || "") : "";
    $("#t_notes").value          = t ? (t.notes || "") : "";

    // Personnel section (admin/super_admin)
    $("#t_dob").value                = t ? (t.date_of_birth || "") : "";
    $("#t_address1").value           = t ? (t.address_line1 || "") : "";
    $("#t_address2").value           = t ? (t.address_line2 || "") : "";
    $("#t_city").value               = t ? (t.city || "") : "";
    $("#t_state").value              = t ? (t.state || "") : "";
    $("#t_postal").value             = t ? (t.postal_code || "") : "";
    $("#t_ec_name").value            = t ? (t.emergency_contact_name || "") : "";
    $("#t_ec_phone").value           = t ? (t.emergency_contact_phone || "") : "";
    $("#t_ec_relationship").value    = t ? (t.emergency_contact_relationship || "") : "";
    $("#t_term_date").value          = t ? (t.termination_date || "") : "";
    $("#t_employment_type").value    = t ? (t.employment_type || "") : "";
    $("#t_bg_status").value          = t ? (t.background_check_status || "") : "";
    $("#t_bg_provider").value        = t ? (t.background_check_provider || "") : "";
    $("#t_bg_date").value            = t ? (t.background_check_date || "") : "";
    $("#t_bg_expires").value         = t ? (t.background_check_expires_date || "") : "";
    $("#t_cpr").checked              = t ? !!t.cpr_certified : false;
    $("#t_cpr_expires").value        = t ? (t.cpr_expires_date || "") : "";
    $("#t_first_aid").checked        = t ? !!t.first_aid_certified : false;
    $("#t_first_aid_expires").value  = t ? (t.first_aid_expires_date || "") : "";

    // Payroll section (view_pay_rates)
    $("#t_pay_type").value        = t ? (t.pay_type || "") : "";
    $("#t_pay_rate").value        = t ? (t.pay_rate || "") : "";
    // T6c: dropdown options come from state.paymentMethods, not hardcoded.
    populatePaymentMethodSelect(t ? (t.payment_method || "") : "");
    $("#t_w9_date").value         = t ? (t.w9_received_date || "") : "";
    $("#t_w9_on_file").checked    = t ? !!t.w9_on_file : false;
    // Edit-options gear is super_admin-only (RLS would also block writes,
    // but hiding the button avoids the surprise of a 42501 toast).
    const pmEditBtn = $("#t_payment_method_edit");
    if (pmEditBtn) pmEditBtn.style.display = isSuperAdmin() ? "" : "none";

    // T6b: payment details (super_admin/admin only). Only populated if the
    // caller has SELECT — non-perm callers won't see the section anyway.
    if (showPayments) {
      const tpd = t ? state.teacherPaymentDetails.find((p) => p.teacher_id === t.id) : null;
      $("#t_pay_bank_name").value     = tpd?.bank_name || "";
      $("#t_pay_account_type").value  = tpd?.account_type || "";
      $("#t_pay_routing").value       = tpd?.routing_number || "";
      $("#t_pay_account").value       = tpd?.account_number || "";
      $("#t_pay_handle").value        = tpd?.payment_handle || "";
      $("#t_pay_notes").value         = tpd?.notes || "";
      // Sub-row visibility tracks the payroll-section's payment_method —
      // direct_deposit gets bank/routing/account, the digital wallets get
      // a handle, check shows neither (falls back to mailing address).
      applyPaymentMethodVisibility($("#t_payment_method").value);
    }

    // T6b: documents list + waiver status. Only populated if the caller
    // holds manage_teacher_compliance.
    if (showCompliance) {
      renderTeacherDocList(t);
      renderWaiverStatus(t);
      // New teachers can't have docs uploaded yet (no teacher_id to FK to).
      // Disable the upload button until the row is saved.
      const newTeacher = !t;
      $("#t_doc_upload_btn").disabled = newTeacher;
      $("#t_doc_file").disabled = newTeacher;
      $("#t_waiver_open_btn").disabled = newTeacher;
    }

    $("#deleteTeacherBtn").style.display = t ? "" : "none";
    $("#teacherModalOverlay").classList.add("open");
    setTimeout(() => $("#t_name").focus(), 50);
  }

  function paymentMethodKind(slug) {
    if (!slug) return null;
    const row = state.paymentMethods.find((p) => p.slug === slug);
    return row ? row.kind : null;
  }

  function applyPaymentMethodVisibility(method) {
    const kind = paymentMethodKind(method);
    const dd1 = $("#t_pay_dd_block");
    const dd2 = $("#t_pay_dd_block2");
    const handle = $("#t_pay_handle_block");
    if (dd1) dd1.style.display = kind === "bank" ? "" : "none";
    if (dd2) dd2.style.display = kind === "bank" ? "" : "none";
    if (handle) handle.style.display = kind === "handle" ? "" : "none";
  }

  /* T6c: build the payment-method <select> from state.paymentMethods.
     Inactive methods still appear if currentSlug matches one (so legacy
     teacher rows don't lose their value silently); fresh choices only
     show active ones. */
  function populatePaymentMethodSelect(currentSlug) {
    const sel = $("#t_payment_method");
    if (!sel) return;
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "—";
    sel.appendChild(blank);
    const methods = [...state.paymentMethods];
    // If currentSlug points at an inactive/missing row, surface it as a
    // disabled option so the admin sees what was previously set.
    const matchActive = methods.find((m) => m.slug === currentSlug);
    methods
      .filter((m) => m.is_active || m.slug === currentSlug)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.slug;
        opt.textContent = m.label + (m.is_active ? "" : " (inactive)");
        sel.appendChild(opt);
      });
    if (currentSlug && !matchActive && !methods.find((m) => m.slug === currentSlug)) {
      // The slug isn't in the list at all (deleted method). Show it as
      // a disabled "missing" option so the admin can still see the
      // teacher's previous value before reassigning.
      const opt = document.createElement("option");
      opt.value = currentSlug;
      opt.textContent = currentSlug + " (removed)";
      opt.disabled = true;
      sel.appendChild(opt);
    }
    sel.value = currentSlug || "";
    applyPaymentMethodVisibility(sel.value);
  }
  function closeTeacherEditor() { $("#teacherModalOverlay").classList.remove("open"); editingTeacherId = null; }

  /* ═════════════ T6b: documents + waiver helpers ═════════════ */

  const DOC_KIND_LABEL = {
    tax_w9: "W-9",
    tax_w4: "W-4",
    tax_1099: "1099",
    certification_cpr: "CPR cert",
    certification_first_aid: "First-aid cert",
    certification_background: "Background check",
    certification_other: "Certification",
    other: "Document",
  };

  function renderTeacherDocList(t) {
    const wrap = $("#t_doc_list");
    if (!wrap) return;
    if (!t) {
      wrap.innerHTML = `<div class="muted small">Save the teacher first, then upload documents.</div>`;
      return;
    }
    const docs = state.teacherDocuments.filter((d) => d.teacher_id === t.id);
    if (!docs.length) {
      wrap.innerHTML = `<div class="muted small">No documents on file.</div>`;
      return;
    }
    const today = isoDate(new Date());
    wrap.innerHTML = docs.map((d) => {
      const expires = d.expires_on ? new Date(d.expires_on) : null;
      let expBadge = "";
      if (expires) {
        const expIso = d.expires_on;
        if (expIso < today) expBadge = `<span class="doc-badge expired">Expired</span>`;
        else {
          const dt = new Date(expIso); const now = new Date();
          const days = Math.round((dt - now) / 86400000);
          if (days <= 30) expBadge = `<span class="doc-badge soon">Expires ${expIso}</span>`;
          else expBadge = `<span class="doc-badge ok">Expires ${expIso}</span>`;
        }
      }
      const fileName = (d.storage_path || "").split("/").pop();
      return `
        <div class="doc-row" data-doc-id="${d.id}">
          <div class="doc-row-main">
            <div class="doc-row-title">
              <span class="doc-kind">${escapeHtml(DOC_KIND_LABEL[d.kind] || d.kind)}</span>
              ${escapeHtml(d.label || fileName || "")}
              ${expBadge}
            </div>
            <div class="doc-row-meta">
              ${escapeHtml(fileName || "")} · uploaded ${new Date(d.uploaded_at).toLocaleDateString()}
            </div>
          </div>
          <div class="doc-row-actions">
            <button type="button" class="btn ghost small" data-doc-action="open" data-doc-id="${d.id}">Open</button>
            <button type="button" class="btn danger ghost small" data-doc-action="delete" data-doc-id="${d.id}">Delete</button>
          </div>
        </div>`;
    }).join("");
    // Wire actions inline (re-rendered each time).
    $$('#t_doc_list [data-doc-action="open"]').forEach((btn) => {
      btn.onclick = () => openTeacherDocument(btn.dataset.docId);
    });
    $$('#t_doc_list [data-doc-action="delete"]').forEach((btn) => {
      btn.onclick = () => deleteTeacherDocument(btn.dataset.docId);
    });
  }

  async function uploadTeacherDocument() {
    if (!editingTeacherId) { showToast("Save the teacher first", "error"); return; }
    const fileInput = $("#t_doc_file");
    const file = fileInput?.files?.[0];
    if (!file) { showToast("Pick a file to upload", "error"); return; }
    const kind = $("#t_doc_kind").value;
    const label = $("#t_doc_label").value.trim() || null;
    const expires = $("#t_doc_expires").value || null;
    const ts = Date.now();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
    const path = `${editingTeacherId}/${kind}-${ts}-${safeName}`;

    showLoader(true);
    const up = await sb.storage.from("teacher-documents").upload(path, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (up.error) {
      showLoader(false);
      showToast("Upload failed: " + up.error.message, "error");
      return;
    }
    const meta = await sb.from("teacher_documents").insert({
      teacher_id:   editingTeacherId,
      kind,
      label,
      storage_path: path,
      mime_type:    file.type || null,
      size_bytes:   file.size,
      expires_on:   expires,
    });
    showLoader(false);
    if (meta.error) {
      // Try to clean up the orphaned object — best-effort.
      sb.storage.from("teacher-documents").remove([path]).catch(() => {});
      showToast("Metadata save failed: " + meta.error.message, "error");
      return;
    }
    fileInput.value = "";
    $("#t_doc_label").value = "";
    $("#t_doc_expires").value = "";
    await reloadAll();
    const t = state.teachers.find((x) => x.id === editingTeacherId);
    renderTeacherDocList(t);
    showToast("Document uploaded", "success");
  }

  async function openTeacherDocument(docId) {
    const d = state.teacherDocuments.find((x) => x.id === docId);
    if (!d) return;
    const signed = await sb.storage.from("teacher-documents")
      .createSignedUrl(d.storage_path, 600);  // 10 min
    if (signed.error) { showToast(signed.error.message, "error"); return; }
    window.open(signed.data.signedUrl, "_blank", "noopener");
  }

  async function deleteTeacherDocument(docId) {
    const d = state.teacherDocuments.find((x) => x.id === docId);
    if (!d) return;
    if (!confirm(`Delete "${d.label || d.storage_path.split("/").pop()}"? This cannot be undone.`)) return;
    showLoader(true);
    const objResp = await sb.storage.from("teacher-documents").remove([d.storage_path]);
    if (objResp.error) {
      showLoader(false);
      showToast("Storage delete failed: " + objResp.error.message, "error");
      return;
    }
    const metaResp = await sb.from("teacher_documents").delete().eq("id", docId);
    showLoader(false);
    if (metaResp.error) { showToast(metaResp.error.message, "error"); return; }
    await reloadAll();
    const t = state.teachers.find((x) => x.id === editingTeacherId);
    renderTeacherDocList(t);
    showToast("Document deleted", "success");
  }

  function activeWaiver() {
    return state.liabilityWaivers.find((w) => w.is_active) || null;
  }

  function latestSignatureForTeacher(teacherId) {
    return state.waiverSignatures
      .filter((s) => s.teacher_id === teacherId)
      .sort((a, b) => (b.signed_at || "").localeCompare(a.signed_at || ""))[0] || null;
  }

  function renderWaiverStatus(t) {
    const node = $("#t_waiver_status");
    if (!node) return;
    if (!t) { node.innerHTML = `<span class="muted">Save the teacher first to record a signature.</span>`; return; }
    const sig = latestSignatureForTeacher(t.id);
    const w = activeWaiver();
    if (!sig) {
      node.innerHTML = `<span class="muted">No signature on file.</span>` +
        (w ? ` <span class="muted small">Active waiver: v${w.version} · ${escapeHtml(w.title)}</span>` : "");
      return;
    }
    const matchesActive = w && sig.waiver_id === w.id;
    const dt = new Date(sig.signed_at);
    node.innerHTML = `
      <div>
        <span class="waiver-signed-pill ${matchesActive ? "ok" : "stale"}">
          ${matchesActive ? "Signed" : "Signed (older version)"}
        </span>
        ${escapeHtml(sig.typed_name)} · ${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}
        ${sig.signed_by_self ? "" : `<span class="muted small">(recorded by admin)</span>`}
      </div>
      ${matchesActive ? "" : `<div class="muted small" style="margin-top:4px">Active waiver has been updated since this signature — re-signing recommended.</div>`}
    `;
  }

  /* Open the read-and-sign modal. context is one of:
       { mode: "admin",  teacher } — admin recording on a teacher's behalf
       { mode: "self",   teacher } — teacher signing their own
  */
  let waiverSignContext = null;
  function openSignWaiverModal(ctx) {
    const w = activeWaiver();
    if (!w) { showToast("No active waiver configured", "error"); return; }
    if (!ctx?.teacher) { showToast("No teacher record", "error"); return; }
    waiverSignContext = { ...ctx, waiver: w };
    $("#waiverSignTitle").textContent = `${w.title} (v${w.version})`;
    const ctxLabel = ctx.mode === "self"
      ? `Signing as ${escapeHtml(ctx.teacher.full_name || ctx.teacher.email || "")}`
      : `Recording signature for ${escapeHtml(ctx.teacher.full_name || ctx.teacher.email || "")}`;
    $("#waiverSignContext").innerHTML = ctxLabel;
    $("#waiverSignBody").innerHTML = w.body_html || "";
    $("#waiverSignAgree").checked = false;
    $("#waiverSignTypedName").value = "";
    $("#waiverSignError").style.display = "none";
    $("#waiverSignSubmit").disabled = true;
    $("#waiverSignOverlay").classList.add("open");
    setTimeout(() => $("#waiverSignTypedName").focus(), 50);
  }
  function closeSignWaiverModal() {
    $("#waiverSignOverlay").classList.remove("open");
    waiverSignContext = null;
  }
  function refreshWaiverSubmitState() {
    const agreed = $("#waiverSignAgree").checked;
    const typed  = ($("#waiverSignTypedName").value || "").trim();
    $("#waiverSignSubmit").disabled = !(agreed && typed.length >= 2);
  }
  async function submitWaiverSignature() {
    if (!waiverSignContext) return;
    const agreed = $("#waiverSignAgree").checked;
    const typed  = ($("#waiverSignTypedName").value || "").trim();
    if (!agreed) { showWaiverError("You must check the box to agree."); return; }
    if (!typed)  { showWaiverError("Type your full name to sign."); return; }
    showLoader(true);
    const resp = await sb.rpc("record_waiver_signature", {
      p_teacher_id: waiverSignContext.teacher.id,
      p_waiver_id:  waiverSignContext.waiver.id,
      p_typed_name: typed,
      p_signer_ip:  null,                    // browsers can't read their own IP
      p_user_agent: navigator.userAgent || null,
    });
    showLoader(false);
    if (resp.error) { showWaiverError(resp.error.message); return; }
    closeSignWaiverModal();
    await reloadAll();
    // If the teacher modal is open for this teacher, refresh its status.
    if (editingTeacherId === waiverSignContext?.teacher?.id) {
      const t = state.teachers.find((x) => x.id === editingTeacherId);
      renderWaiverStatus(t);
    }
    renderHomeTab();   // self-sign banner clears
    showToast("Waiver signed", "success");
  }
  function showWaiverError(msg) {
    const el = $("#waiverSignError");
    el.textContent = msg;
    el.style.display = "";
  }

  /* Resolve the teachers row for the signed-in user. Thin alias around
     mySignedInTeacher() (T6d-aware: prefers profiles.teacher_id, falls
     back to email match). Used by the self-sign waiver banner. */
  function selfTeacherRow() {
    return mySignedInTeacher();
  }

  async function saveTeacher() {
    const name = $("#t_name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }
    const showPersonnel = isAdminOrAbove();
    const showPayroll   = hasPerm("view_pay_rates");
    const showPayments  = hasPerm("manage_teacher_payments");

    // Always-saved fields. Managers using the Edit button save just these
    // — admin-only fields aren't included so a manager save can't null
    // out personnel data they couldn't see.
    const payload = {
      full_name: name,
      preferred_name: $("#t_preferred_name").value.trim() || null,
      email: $("#t_email").value.trim() || null,
      phone: $("#t_phone").value.trim() || null,
      title: $("#t_title").value.trim() || null,
      status: $("#t_status").value,
      hire_date: $("#t_hire_date").value || null,
      notes: $("#t_notes").value || null,
    };
    if (showPersonnel) {
      Object.assign(payload, {
        date_of_birth: $("#t_dob").value || null,
        address_line1: $("#t_address1").value.trim() || null,
        address_line2: $("#t_address2").value.trim() || null,
        city: $("#t_city").value.trim() || null,
        state: $("#t_state").value.trim() || null,
        postal_code: $("#t_postal").value.trim() || null,
        emergency_contact_name: $("#t_ec_name").value.trim() || null,
        emergency_contact_phone: $("#t_ec_phone").value.trim() || null,
        emergency_contact_relationship: $("#t_ec_relationship").value.trim() || null,
        termination_date: $("#t_term_date").value || null,
        employment_type: $("#t_employment_type").value || null,
        background_check_status: $("#t_bg_status").value || null,
        background_check_provider: $("#t_bg_provider").value.trim() || null,
        background_check_date: $("#t_bg_date").value || null,
        background_check_expires_date: $("#t_bg_expires").value || null,
        cpr_certified: $("#t_cpr").checked,
        cpr_expires_date: $("#t_cpr_expires").value || null,
        first_aid_certified: $("#t_first_aid").checked,
        first_aid_expires_date: $("#t_first_aid_expires").value || null,
        // liability_waiver_signed / liability_waiver_date are now stamped
        // by record_waiver_signature() RPC; not editable from this modal.
      });
    }
    if (showPayroll) {
      Object.assign(payload, {
        pay_type: $("#t_pay_type").value || null,
        pay_rate: $("#t_pay_rate").value.trim() || null,
        payment_method: $("#t_payment_method").value || null,
        w9_on_file: $("#t_w9_on_file").checked,
        w9_received_date: $("#t_w9_date").value || null,
      });
    }

    showLoader(true);
    let resp;
    if (editingTeacherId) {
      resp = await sb.from("teachers").update(payload).eq("id", editingTeacherId).select().single();
    } else {
      const slugs = new Set(state.teachers.map((t) => t.slug));
      payload.slug = uniqueSlug(slugify(name), slugs);
      resp = await sb.from("teachers").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    const savedTeacher = resp.data;

    // T6b: upsert payment details if the caller can edit them. We always
    // upsert the row (even if every input is empty) so the bookkeeper's
    // touch_updated_by trigger fires. Empty strings → null. Storing nothing
    // when nothing was entered is fine — the row just has all-null fields.
    if (showPayments && savedTeacher) {
      const tpdPayload = {
        teacher_id:     savedTeacher.id,
        bank_name:      $("#t_pay_bank_name").value.trim() || null,
        account_type:   $("#t_pay_account_type").value || null,
        routing_number: $("#t_pay_routing").value.trim() || null,
        account_number: $("#t_pay_account").value.trim() || null,
        payment_handle: $("#t_pay_handle").value.trim() || null,
        notes:          $("#t_pay_notes").value.trim() || null,
      };
      const allEmpty = !tpdPayload.bank_name && !tpdPayload.account_type
        && !tpdPayload.routing_number && !tpdPayload.account_number
        && !tpdPayload.payment_handle && !tpdPayload.notes;
      const existing = state.teacherPaymentDetails.find((p) => p.teacher_id === savedTeacher.id);
      if (allEmpty && !existing) {
        // No-op — never inserted, nothing to clean up.
      } else {
        const tpdResp = await sb.from("teacher_payment_details").upsert(tpdPayload, { onConflict: "teacher_id" });
        if (tpdResp.error) {
          showToast("Teacher saved, but payment details failed: " + tpdResp.error.message, "error");
          // Don't bail — the teacher row is good; just warn.
        }
      }
    }

    // Phase 3 — try to resolve this teacher's PAR identity if they have an email
    if (savedTeacher?.email) {
      resolveTeacherParIdentity(savedTeacher).catch((e) => console.warn("PAR teacher resolve:", e));
    }

    await reloadAll();
    renderAll();
    closeTeacherEditor();
    showToast(editingTeacherId ? "Teacher updated" : "Teacher added", "success");
  }

  /* Resolve a single teacher's PAR identity via par-identity-proxy; cache on the teacher row. */
  async function resolveTeacherParIdentity(teacher) {
    if (!teacher?.email) return { resolved: false, reason: "no_email" };
    try {
      const { data, error } = await sb.functions.invoke("par-identity-proxy", {
        body: { email: teacher.email },
      });
      if (error) return { resolved: false, reason: error.message };
      if (!data || data.found !== true) return { resolved: false, reason: "not_found" };

      const patch = {
        par_person_id: data.person_id ?? null,
      };
      // Only update if it changed
      if (patch.par_person_id && patch.par_person_id !== teacher.par_person_id) {
        const { error: upErr } = await sb.from("teachers").update(patch).eq("id", teacher.id);
        if (upErr) return { resolved: false, reason: upErr.message };
        // Silently refresh state so the badge appears
        await reloadAll();
        renderAll();
      }
      return { resolved: true, person_id: data.person_id, display_name: data.display_name };
    } catch (e) {
      return { resolved: false, reason: (e instanceof Error ? e.message : String(e)) };
    }
  }

  /* Bulk resolver — walks all teachers with an email and no par_person_id yet. */
  async function refreshAllTeacherParLinks() {
    const candidates = state.teachers.filter((t) => t.email && !t.par_person_id);
    if (candidates.length === 0) {
      showToast("All teachers with emails are already PAR-linked", "success");
      return;
    }
    showLoader(true);
    let linked = 0, not_found = 0, errors = 0;
    for (const t of candidates) {
      const r = await resolveTeacherParIdentity(t);
      if (r.resolved) linked++;
      else if (r.reason === "not_found") not_found++;
      else errors++;
    }
    showLoader(false);
    await reloadAll();
    renderAll();
    showToast(`PAR links: ${linked} linked · ${not_found} not on PAR${errors ? ` · ${errors} errors` : ""}`, linked > 0 ? "success" : "");
  }

  async function deleteTeacher() {
    if (!editingTeacherId) return;
    const t = state.teachers.find((x) => x.id === editingTeacherId);
    const assignments = state.classTeachers.filter((ct) => ct.teacher_id === editingTeacherId).length;
    const confirmMsg = assignments > 0
      ? `${t?.full_name || "This teacher"} is assigned to ${assignments} class${assignments === 1 ? "" : "es"}. Deleting will remove those assignments. Continue?`
      : "Delete this teacher?";
    if (!confirm(confirmMsg)) return;
    showLoader(true);
    const { error } = await sb.from("teachers").delete().eq("id", editingTeacherId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeTeacherEditor();
    showToast("Teacher deleted", "success");
  }

  /* ═════════════ CATEGORIES ═════════════ */

  function renderCategoriesTab() {
    const wrap = $("#categoryList");
    wrap.innerHTML = "";
    const showEdit = hasPerm("edit_categories");
    state.categories.forEach((cat) => {
      const used = state.templates.filter((t) => t.category_id === cat.id).length;
      const row = document.createElement("div");
      row.className = "category-item";
      row.innerHTML = `
        <input class="label-input" type="text" value="${escapeHtml(cat.label)}" ${showEdit ? "" : "readonly"} />
        <span class="cat-id">${escapeHtml(cat.slug)}</span>
        <span class="use-count">${used} used</span>
        ${showEdit ? `<button class="btn small danger" ${used > 0 ? "disabled title=\"In use — reassign templates first\"" : ""}>Delete</button>` : ""}
      `;
      const input = row.querySelector(".label-input");
      const del   = row.querySelector("button");
      if (showEdit) {
        input.onchange = async () => {
          const newLabel = input.value.trim();
          if (!newLabel || newLabel === cat.label) return;
          const { error } = await sb.from("categories").update({ label: newLabel }).eq("id", cat.id);
          if (error) { showToast(error.message, "error"); return; }
          await reloadAll(); renderAll();
          showToast("Category renamed", "success");
        };
        if (del) del.onclick = async () => {
          if (used > 0) return;
          if (!confirm("Delete this category?")) return;
          const { error } = await sb.from("categories").delete().eq("id", cat.id);
          if (error) { showToast(error.message, "error"); return; }
          await reloadAll(); renderAll();
          showToast("Category deleted", "success");
        };
      }
      wrap.appendChild(row);
    });
  }

  function openCategoriesModal() {
    renderCategoriesTab();
    $("#categoriesOverlay").classList.add("open");
  }
  function closeCategoriesModal() {
    $("#categoriesOverlay").classList.remove("open");
  }

  function openInfographicsModal() {
    renderInfographicsTab();
    $("#infographicsOverlay").classList.add("open");
  }
  function closeInfographicsModal() {
    $("#infographicsOverlay").classList.remove("open");
  }

  /* ═════════════ T6c: Payment methods manage-list modal ═════════════ */

  function openPaymentMethodsModal() {
    if (!isSuperAdmin()) { showToast("Super_admins only", "error"); return; }
    renderPaymentMethodsList();
    $("#paymentMethodsOverlay").classList.add("open");
  }
  function closePaymentMethodsModal() {
    $("#paymentMethodsOverlay").classList.remove("open");
    // Re-populate the personnel-modal's dropdown so any edits take effect
    // immediately if it's still open.
    const t = state.teachers.find((x) => x.id === editingTeacherId);
    if (t) populatePaymentMethodSelect(t.payment_method || $("#t_payment_method").value);
  }

  function renderPaymentMethodsList() {
    const wrap = $("#paymentMethodsList");
    if (!wrap) return;
    const rows = [...state.paymentMethods].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (!rows.length) { wrap.innerHTML = `<div class="muted">No payment methods configured.</div>`; return; }
    wrap.innerHTML = rows.map((m) => {
      const inUse = state.teachers.filter((t) => t.payment_method === m.slug).length;
      return `
        <div class="pm-row" data-pm-id="${m.id}">
          <input class="pm-label" type="text" value="${escapeHtml(m.label)}" />
          <select class="pm-kind">
            <option value="bank"   ${m.kind === "bank"   ? "selected" : ""}>Bank account</option>
            <option value="handle" ${m.kind === "handle" ? "selected" : ""}>Handle</option>
            <option value="none"   ${m.kind === "none"   ? "selected" : ""}>Neither</option>
          </select>
          <label class="pm-active">
            <input type="checkbox" class="pm-active-cb" ${m.is_active ? "checked" : ""} />
            Active
          </label>
          <span class="pm-use-count">${inUse} in use</span>
          <button type="button" class="btn danger ghost small pm-del" ${inUse > 0 ? `disabled title="In use — reassign teachers first"` : ""}>Delete</button>
        </div>`;
    }).join("");
    // Wire per-row handlers.
    $$('#paymentMethodsList .pm-row').forEach((row) => {
      const id = row.dataset.pmId;
      const labelInp = row.querySelector(".pm-label");
      const kindSel  = row.querySelector(".pm-kind");
      const activeCb = row.querySelector(".pm-active-cb");
      const delBtn   = row.querySelector(".pm-del");
      const save = async (patch) => {
        const resp = await sb.from("payment_methods").update(patch).eq("id", id);
        if (resp.error) { showToast(resp.error.message, "error"); return; }
        await reloadAll();
        renderPaymentMethodsList();
      };
      labelInp.onchange = () => {
        const v = labelInp.value.trim();
        if (!v) { showToast("Label can't be empty", "error"); return; }
        save({ label: v });
      };
      kindSel.onchange = () => save({ kind: kindSel.value });
      activeCb.onchange = () => save({ is_active: activeCb.checked });
      if (delBtn && !delBtn.disabled) {
        delBtn.onclick = async () => {
          if (!confirm(`Delete payment method "${labelInp.value}"? This cannot be undone.`)) return;
          const resp = await sb.from("payment_methods").delete().eq("id", id);
          if (resp.error) { showToast(resp.error.message, "error"); return; }
          await reloadAll();
          renderPaymentMethodsList();
          showToast("Payment method deleted", "success");
        };
      }
    });
  }

  async function addPaymentMethod() {
    const label = $("#pm_new_label").value.trim();
    const kind  = $("#pm_new_kind").value;
    if (!label) { showToast("Label is required", "error"); return; }
    const slugs = new Set(state.paymentMethods.map((m) => m.slug));
    const slug = uniqueSlug(slugify(label), slugs);
    const maxSort = state.paymentMethods.reduce((mx, m) => Math.max(mx, m.sort_order || 0), 0);
    const resp = await sb.from("payment_methods").insert({
      slug, label, kind, sort_order: maxSort + 10, is_active: true
    });
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    $("#pm_new_label").value = "";
    await reloadAll();
    renderPaymentMethodsList();
    showToast("Payment method added", "success");
  }

  async function newCategory() {
    const label = prompt("New category label:");
    if (!label) return;
    const slugs = new Set(state.categories.map((c) => c.slug));
    const slug = uniqueSlug(slugify(label), slugs);
    const maxSort = state.categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0);
    const { error } = await sb.from("categories").insert({ slug, label: label.trim(), sort_order: maxSort + 1 });
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Category added", "success");
  }

  /* ═════════════ INFOGRAPHICS sidebar ═════════════ */

  function renderInfographicsSidebar() {
    $("#igCount").textContent = state.infographics.length;

    const allTags = new Set();
    state.infographics.forEach((i) => (i.tags || []).forEach((t) => allTags.add(t)));
    const tagRow = $("#igTagRow");
    tagRow.innerHTML = "";
    [{ k: "all", label: "All" }].concat([...allTags].sort().map((t) => ({ k: t, label: "#" + t }))).forEach((t) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (state.igState.tag === t.k ? " active" : "");
      chip.textContent = t.label;
      chip.onclick = () => { state.igState.tag = t.k; renderInfographicsSidebar(); };
      tagRow.appendChild(chip);
    });

    const q = state.igState.query.toLowerCase();
    const filtered = state.infographics.filter((i) => {
      if (state.igState.tag !== "all" && !(i.tags || []).includes(state.igState.tag)) return false;
      if (!q) return true;
      return (i.name || "").toLowerCase().includes(q) || (i.tags || []).some((t) => t.toLowerCase().includes(q));
    });

    const grid = $("#igGrid");
    grid.innerHTML = "";
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:20px 8px">No images. Go to the <b>Infographics</b> tab and click <b>＋ Upload / add image</b>.</div>';
      return;
    }
    filtered.forEach((i) => grid.appendChild(renderInfographicCard(i)));
  }

  function renderInfographicCard(ig) {
    const el = document.createElement("div");
    el.className = "infographic";
    const isExternal = !ig.storage_path && !!ig.external_url;
    const src = ig.storage_path ? publicUrlFor(ig.storage_path) : ig.external_url;
    el.title = isExternal
      ? "Click to copy URL and open image"
      : (ig.storage_path ? "Click to copy image to clipboard" : "No image set");
    el.innerHTML = `
      <div class="thumb ${isExternal ? "external" : ""}">
        ${src ? `<img src="${escapeHtml(src)}" onerror="this.remove()" alt="" />` : "🖼"}
      </div>
      <div class="meta">
        <div class="name">${escapeHtml(ig.name)}</div>
        <div class="tag-list">${(ig.tags || []).map((t) => "#" + t).join(" ")}</div>
      </div>
    `;
    el.onclick = () => handleInfographicClick(ig, el);
    return el;
  }

  async function handleInfographicClick(ig, el) {
    if (ig.storage_path) {
      const url = publicUrlFor(ig.storage_path);
      const r = await copyImageBytes(url);
      if (r.ok) {
        el.classList.add("copied");
        setTimeout(() => el.classList.remove("copied"), 1500);
        showToast("Image copied — paste into your message", "success");
      } else {
        showToast("Couldn't copy image bytes — opening in new tab instead.", "error");
        window.open(url, "_blank", "noopener");
      }
    } else if (ig.external_url) {
      await copyText(ig.external_url);
      window.open(ig.external_url, "_blank", "noopener");
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 1500);
      showToast("URL copied · image opened in new tab", "success");
    } else {
      showToast("No image source set. Edit it in the Infographics tab.", "error");
    }
  }

  /* ═════════════ INFOGRAPHICS tab (admin) ═════════════ */

  let editingIgId = null;
  let igSourceMode = "upload"; // or "external"
  let pendingUploadFile = null;

  function renderInfographicsTab() {
    const el = $("#infographicsTable");
    $("#igManageMeta").textContent = state.infographics.length + " image" + (state.infographics.length === 1 ? "" : "s");
    const showEdit = hasPerm("edit_infographics");
    const colCount = 4 + (showEdit ? 1 : 0);
    const rows = state.infographics.map((i) => {
      const src = i.storage_path ? publicUrlFor(i.storage_path) : i.external_url;
      const srcType = i.storage_path ? "Uploaded" : (i.external_url ? "External" : "—");
      return `
        <tr>
          <td class="thumb-cell">${src ? `<img src="${escapeHtml(src)}" alt="" />` : '<div class="no-thumb">🖼</div>'}</td>
          <td><b>${escapeHtml(i.name)}</b>${i.notes ? `<div style="font-size:11.5px;color:var(--ink-dim)">${escapeHtml(i.notes)}</div>` : ""}</td>
          <td>${(i.tags || []).map((t) => `<span class="type-badge type-workshop">#${escapeHtml(t)}</span>`).join(" ")}</td>
          <td>${srcType}</td>
          ${showEdit ? `<td class="row-actions"><button class="btn small ghost" data-act="edit-ig" data-id="${escapeHtml(i.id)}">Edit</button></td>` : ""}
        </tr>
      `;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Preview</th><th>Name</th><th>Tags</th><th>Source</th>${showEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;color:var(--ink-dim);padding:24px">No images yet${showEdit ? " — click <b>＋ Upload / add image</b>." : "."}</td></tr>`}</tbody>
      </table>
    `;
    if (showEdit) {
      $$('[data-act="edit-ig"]', el).forEach((btn) => btn.onclick = () => openIgEditor(btn.dataset.id));
    }
  }

  function openIgEditor(id) {
    editingIgId = id || null;
    const ig = id ? state.infographics.find((x) => x.id === id) : null;
    $("#igModalTitle").textContent = ig ? "Edit image" : "Upload / add image";
    $("#i_name").value  = ig ? ig.name : "";
    $("#i_tags").value  = ig ? (ig.tags || []).join(", ") : "";
    $("#i_url").value   = ig ? (ig.external_url || "") : "";
    $("#i_notes").value = ig ? (ig.notes || "") : "";
    $("#i_file").value  = "";
    pendingUploadFile = null;
    $("#currentFileLabel").textContent = ig && ig.storage_path ? "Current uploaded file: " + ig.storage_path : "";
    $("#imagePreview").style.display = "none";
    $("#deleteIgBtn").style.display = ig ? "" : "none";
    // Choose initial source mode
    igSourceMode = (ig && ig.external_url && !ig.storage_path) ? "external" : "upload";
    updateIgSourceToggle();
    $("#igModalOverlay").classList.add("open");
    setTimeout(() => $("#i_name").focus(), 50);
  }
  function closeIgEditor() { $("#igModalOverlay").classList.remove("open"); editingIgId = null; }

  function updateIgSourceToggle() {
    $$(".toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.src === igSourceMode));
    $("#uploadField").style.display   = igSourceMode === "upload" ? "" : "none";
    $("#externalField").style.display = igSourceMode === "external" ? "" : "none";
  }

  async function saveInfographic() {
    const name = $("#i_name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }
    const tags = $("#i_tags").value.split(",").map((s) => s.trim()).filter(Boolean);
    const notes = $("#i_notes").value || null;

    let payload = { name, tags, notes };

    if (igSourceMode === "upload") {
      if (pendingUploadFile) {
        // Upload file
        const ext = pendingUploadFile.name.split(".").pop();
        const slugBase = slugify(name);
        const existingSlugs = new Set(state.infographics.map((i) => i.slug));
        const slug = editingIgId
          ? (state.infographics.find((i) => i.id === editingIgId)?.slug || uniqueSlug(slugBase, existingSlugs))
          : uniqueSlug(slugBase, existingSlugs);
        const path = slug + "-" + Date.now() + "." + ext;
        showLoader(true);
        const { error: upErr } = await sb.storage.from("infographics").upload(path, pendingUploadFile, {
          contentType: pendingUploadFile.type,
          upsert: false
        });
        showLoader(false);
        if (upErr) { showToast("Upload failed: " + upErr.message, "error"); return; }
        payload.storage_path = path;
        payload.external_url = null;
        if (!editingIgId) payload.slug = slug;
      } else if (!editingIgId) {
        showToast("Pick a file to upload", "error"); return;
      }
      // If editing and no new file chosen, leave storage_path as-is (don't touch it)
    } else {
      // external URL mode
      const url = $("#i_url").value.trim();
      if (!url) { showToast("URL is required for external images", "error"); return; }
      payload.external_url = url;
      payload.storage_path = null;
      if (!editingIgId) {
        const existingSlugs = new Set(state.infographics.map((i) => i.slug));
        payload.slug = uniqueSlug(slugify(name), existingSlugs);
      }
    }

    showLoader(true);
    let resp;
    if (editingIgId) {
      resp = await sb.from("infographics").update(payload).eq("id", editingIgId).select().single();
    } else {
      resp = await sb.from("infographics").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeIgEditor();
    showToast(editingIgId ? "Image updated" : "Image added", "success");
  }

  async function deleteInfographic() {
    if (!editingIgId) return;
    if (!confirm("Delete this image? (The uploaded file will also be removed from storage.)")) return;
    const ig = state.infographics.find((i) => i.id === editingIgId);
    showLoader(true);
    if (ig && ig.storage_path) {
      await sb.storage.from("infographics").remove([ig.storage_path]);
    }
    const { error } = await sb.from("infographics").delete().eq("id", editingIgId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeIgEditor();
    showToast("Image deleted", "success");
  }

  /* ═════════════ Event wiring ═════════════ */

  function wireEvents() {
    // Tabs
    $$(".tab").forEach((t) => t.onclick = () => go(t.dataset.tab));

    // Mobile bottom nav — route tabs that carry data-tab directly.
    $$(".mtab[data-tab]").forEach((t) => t.onclick = () => go(t.dataset.tab));

    // Mobile Tools sheet — open, close (backdrop / ✕), and route on item tap.
    const toolsOverlay = $("#mobileToolsOverlay");
    const toolsBtn     = $("#mobileToolsBtn");
    const toolsClose   = $("#mobileToolsClose");
    if (toolsBtn && toolsOverlay) {
      toolsBtn.onclick = () => toolsOverlay.classList.add("show");
      toolsOverlay.addEventListener("click", (e) => {
        if (e.target === toolsOverlay) toolsOverlay.classList.remove("show");
      });
      if (toolsClose) toolsClose.onclick = () => toolsOverlay.classList.remove("show");
      $$(".mobile-tools-item").forEach((b) => b.onclick = () => {
        toolsOverlay.classList.remove("show");
        go(b.dataset.tab);
      });
    }

    // Search
    $("#search").addEventListener("input", (e) => { state.tState.query = e.target.value.trim(); renderTemplates(); });
    $("#igSearch").addEventListener("input", (e) => { state.igState.query = e.target.value.trim(); renderInfographicsSidebar(); });

    // Sign out — both the desktop button and the in-menu item run the same
    // teardown. (At ≤720px, signOutBtn is hidden by CSS — the menu is the
    // only entry point.)
    const handleSignOut = async () => {
      if (realtimeChannel) {
        try { await sb.removeChannel(realtimeChannel); } catch (_) { /* ignore */ }
        realtimeChannel = null;
      }
      await sb.auth.signOut();
      state.session = null; state.profile = null;
      toggleUserMenu(false);
      showLogin();
    };
    $("#signOutBtn").onclick = handleSignOut;
    $("#userMenuSignOut").onclick = handleSignOut;

    // Phase D: chip is a tap-to-open menu trigger. Click toggles, outside
    // click and Esc close it.
    $("#userChip").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleUserMenu();
    });
    document.addEventListener("click", (e) => {
      const menu = $("#userMenu");
      if (!menu || !menu.classList.contains("open")) return;
      if (menu.contains(e.target) || $("#userChip").contains(e.target)) return;
      toggleUserMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") toggleUserMenu(false);
    });

    // New buttons
    $("#newTemplateBtn").onclick   = () => openTemplateEditor(null);
    $("#newClassBtn").onclick      = () => openClassEditor(null);
    $("#newCategoryBtn").onclick   = newCategory;
    // Categories modal (replaces the standalone Categories tab)
    const manageCatBtn = $("#manageCategoriesBtn");
    if (manageCatBtn) manageCatBtn.onclick = openCategoriesModal;
    $("#categoriesModalClose").onclick = closeCategoriesModal;
    $("#categoriesModalDone").onclick  = closeCategoriesModal;
    $("#categoriesOverlay").onclick    = (e) => { if (e.target.id === "categoriesOverlay") closeCategoriesModal(); };

    // Infographics modal (replaces the standalone Infographics tab)
    const manageIgBtn = $("#manageInfographicsBtn");
    if (manageIgBtn) manageIgBtn.onclick = openInfographicsModal;
    $("#infographicsModalClose").onclick = closeInfographicsModal;
    $("#infographicsModalDone").onclick  = closeInfographicsModal;
    $("#infographicsOverlay").onclick    = (e) => { if (e.target.id === "infographicsOverlay") closeInfographicsModal(); };

    // T6c: payment-methods manage modal
    const pmEditBtn = $("#t_payment_method_edit");
    if (pmEditBtn) pmEditBtn.onclick = (e) => { e.preventDefault(); openPaymentMethodsModal(); };
    $("#paymentMethodsClose").onclick = closePaymentMethodsModal;
    $("#paymentMethodsDone").onclick  = closePaymentMethodsModal;
    $("#paymentMethodsOverlay").onclick = (e) => { if (e.target.id === "paymentMethodsOverlay") closePaymentMethodsModal(); };
    $("#pm_add_btn").onclick = addPaymentMethod;
    $("#newInfographicBtn").onclick = () => openIgEditor(null);
    $("#newTeacherBtn").onclick    = () => openTeacherEditor(null);
    const refreshParBtn = $("#refreshParLinksBtn");
    if (refreshParBtn) refreshParBtn.onclick = refreshAllTeacherParLinks;

    // Teacher modal
    $("#teacherCancel").onclick    = closeTeacherEditor;
    $("#teacherModalClose").onclick = closeTeacherEditor;
    $("#teacherModalOverlay").onclick = (e) => { if (e.target.id === "teacherModalOverlay") closeTeacherEditor(); };
    $("#teacherSave").onclick      = saveTeacher;
    $("#deleteTeacherBtn").onclick = deleteTeacher;

    // T6b: payment-method drives bank/handle sub-row visibility
    const pmSel = $("#t_payment_method");
    if (pmSel) pmSel.addEventListener("change", (e) => applyPaymentMethodVisibility(e.target.value));

    // T6b: document upload + waiver sign-modal triggers
    const docUploadBtn = $("#t_doc_upload_btn");
    if (docUploadBtn) docUploadBtn.onclick = uploadTeacherDocument;
    const waiverOpenBtn = $("#t_waiver_open_btn");
    if (waiverOpenBtn) waiverOpenBtn.onclick = () => {
      const t = state.teachers.find((x) => x.id === editingTeacherId);
      if (!t) { showToast("Save the teacher first", "error"); return; }
      openSignWaiverModal({ mode: "admin", teacher: t });
    };

    // T6b: waiver sign modal
    $("#waiverSignClose").onclick  = closeSignWaiverModal;
    $("#waiverSignCancel").onclick = closeSignWaiverModal;
    $("#waiverSignOverlay").onclick = (e) => { if (e.target.id === "waiverSignOverlay") closeSignWaiverModal(); };
    $("#waiverSignAgree").addEventListener("change", refreshWaiverSubmitState);
    $("#waiverSignTypedName").addEventListener("input", refreshWaiverSubmitState);
    $("#waiverSignSubmit").onclick = submitWaiverSignature;

    // Jackrabbit sync + test toggle
    const syncBtn = $("#syncJackrabbitBtn");
    if (syncBtn) syncBtn.onclick = syncJackrabbit;
    const testToggle = $("#showTestClasses");
    if (testToggle) testToggle.onchange = (e) => { state.cState.showTest = e.target.checked; renderAll(); };

    // Template modal
    $("#addImageRow").onclick      = () => addImageRow("", "");
    $("#f_body").addEventListener("input", updateDetectedVars);
    $("#templateCancel").onclick   = closeTemplateEditor;
    $("#templateModalClose").onclick = closeTemplateEditor;
    $("#templateModalOverlay").onclick = (e) => { if (e.target.id === "templateModalOverlay") closeTemplateEditor(); };
    $("#templateSave").onclick     = saveTemplate;
    $("#deleteTemplateBtn").onclick = deleteTemplate;

    // Class modal
    $("#classCancel").onclick      = closeClassEditor;
    $("#classModalClose").onclick  = closeClassEditor;
    $("#classModalOverlay").onclick = (e) => { if (e.target.id === "classModalOverlay") closeClassEditor(); };
    $("#classSave").onclick        = saveClass;
    $("#deleteClassBtn").onclick   = deleteClass;

    // Curriculum modal (T5a)
    const newCurBtn   = $("#newCurriculumBtn");
    if (newCurBtn) newCurBtn.onclick = () => openCurriculumEditor(null);
    const curTypeFilter = $("#curriculumTypeFilter");
    if (curTypeFilter) curTypeFilter.onchange = (e) => {
      state.curState.typeFilter = e.target.value || "all"; renderCurriculumTab();
    };
    const curShowArchived = $("#curriculumShowArchived");
    if (curShowArchived) curShowArchived.onchange = (e) => {
      state.curState.showArchived = !!e.target.checked; renderCurriculumTab();
    };
    const cuTypeSel = $("#cu_asset_type");
    if (cuTypeSel) cuTypeSel.onchange = syncCurriculumTypeFields;
    const cuCancel  = $("#curriculumCancel");
    const cuClose   = $("#curriculumModalClose");
    const cuOverlay = $("#curriculumModalOverlay");
    const cuSave    = $("#curriculumSave");
    const cuArchive = $("#cu_archiveBtn");
    if (cuCancel)  cuCancel.onclick  = closeCurriculumEditor;
    if (cuClose)   cuClose.onclick   = closeCurriculumEditor;
    if (cuOverlay) cuOverlay.onclick = (e) => { if (e.target.id === "curriculumModalOverlay") closeCurriculumEditor(); };
    if (cuSave)    cuSave.onclick    = saveCurriculumItem;
    if (cuArchive) cuArchive.onclick = toggleCurriculumArchive;
    const cuPreview = $("#cu_previewBtn");
    if (cuPreview) cuPreview.onclick = openCurriculumPreview;

    // Curriculum assign modal (T5b)
    const acClose   = $("#assignCurModalClose");
    const acDone    = $("#assignCurDone");
    const acOverlay = $("#assignCurModalOverlay");
    const acClass   = $("#assignCurClass");
    const acTeacher = $("#assignCurTeacher");
    const acLead    = $("#assignCurLeadOverride");
    const acNotes   = $("#assignCurNotes");
    const acAdd     = $("#assignCurAddBtn");
    if (acClose)   acClose.onclick   = closeAssignCurriculumModal;
    if (acDone)    acDone.onclick    = closeAssignCurriculumModal;
    if (acOverlay) acOverlay.onclick = (e) => { if (e.target.id === "assignCurModalOverlay") closeAssignCurriculumModal(); };
    if (acClass)   acClass.onchange  = (e) => {
      state.assignCurState.formClassId = e.target.value;
      // Reset teacher when class changes — the dropdown narrows to that class's teachers.
      state.assignCurState.formTeacherId = "";
      renderAssignCurriculumModal();
    };
    if (acTeacher) acTeacher.onchange = (e) => {
      state.assignCurState.formTeacherId = e.target.value;
      renderAssignCurriculumModal();
    };
    if (acLead)    acLead.oninput    = (e) => { state.assignCurState.formLeadOverride = e.target.value; };
    if (acNotes)   acNotes.oninput   = (e) => { state.assignCurState.formNotes = e.target.value; };
    if (acAdd)     acAdd.onclick     = addCurriculumAssignment;

    // Curriculum script-viewer modal (T5b — script & link types only)
    const cvClose = $("#curViewerModalClose");
    const cvDone  = $("#curViewerDone");
    const cvOver  = $("#curViewerModalOverlay");
    if (cvClose) cvClose.onclick = closeCurriculumViewer;
    if (cvDone)  cvDone.onclick  = closeCurriculumViewer;
    if (cvOver)  cvOver.onclick  = (e) => { if (e.target.id === "curViewerModalOverlay") closeCurriculumViewer(); };

    // T6d: Users tab — role-management modal
    const urClose  = $("#userRoleClose");
    const urCancel = $("#userRoleCancel");
    const urSave   = $("#userRoleSave");
    const urOver   = $("#userRoleOverlay");
    if (urClose)  urClose.onclick  = closeUserRoleModal;
    if (urCancel) urCancel.onclick = closeUserRoleModal;
    if (urSave)   urSave.onclick   = saveUserRoleModal;
    if (urOver)   urOver.onclick   = (e) => { if (e.target.id === "userRoleOverlay") closeUserRoleModal(); };

    // Schedule toolbar
    $$(".sched-mode").forEach((b) => {
      b.onclick = () => {
        state.sState.mode = b.dataset.schedMode;
        renderScheduleTab();
      };
    });
    const schedPrev = $("#schedPrev");
    const schedNext = $("#schedNext");
    const schedToday = $("#schedToday");
    const schedOnlyMine = $("#schedOnlyMine");
    const schedManageClosures = $("#schedManageClosures");
    if (schedPrev)  schedPrev.onclick  = () => schedNav(-1);
    if (schedNext)  schedNext.onclick  = () => schedNav(+1);
    if (schedToday) schedToday.onclick = () => { state.sState.anchor = isoDate(new Date()); renderScheduleTab(); };
    if (schedOnlyMine) schedOnlyMine.onchange = (e) => { state.sState.onlyMine = !!e.target.checked; renderScheduleTab(); };
    if (schedManageClosures) schedManageClosures.onclick = openClosuresModal;

    // Closures modal
    const cloClose = $("#closuresClose");
    const cloAdd   = $("#closureAdd");
    const cloOverlay = $("#closuresOverlay");
    if (cloClose) cloClose.onclick = closeClosuresModal;
    if (cloAdd)   cloAdd.onclick   = addClosure;
    if (cloOverlay) cloOverlay.onclick = (e) => { if (e.target.id === "closuresOverlay") closeClosuresModal(); };

    // Invitation editor modal
    const inviteUserBtn = $("#inviteUserBtn");
    if (inviteUserBtn) inviteUserBtn.onclick = () => openInviteEditor({});
    $("#invCancel").onclick         = closeInviteEditor;
    $("#inviteEditorClose").onclick = closeInviteEditor;
    $("#inviteEditorOverlay").onclick = (e) => { if (e.target.id === "inviteEditorOverlay") closeInviteEditor(); };
    $("#invRole").addEventListener("change", updateInviteRoleMapHint);
    $("#invSend").onclick           = submitInviteEditor;

    // Add-student modal (teacher/admin adds a DK-local student to a class)
    $("#addStudentCancel").onclick     = closeAddStudentModal;
    $("#addStudentModalClose").onclick = closeAddStudentModal;
    $("#addStudentModalOverlay").onclick = (e) => { if (e.target.id === "addStudentModalOverlay") closeAddStudentModal(); };
    $("#addStudentSave").onclick       = saveAddStudent;

    // Attendance modal (T3b: take or edit a session's attendance)
    $("#attendanceCancel").onclick       = closeAttendanceModal;
    $("#attendanceModalClose").onclick   = closeAttendanceModal;
    $("#attendanceModalOverlay").onclick = (e) => { if (e.target.id === "attendanceModalOverlay") closeAttendanceModal(); };
    $("#attendanceSave").onclick         = saveAttendance;
    $("#att_mark_all_present").onclick   = markAllPresent;

    // School editor modal (Phase T8)
    const schCancel  = $("#schoolCancel");
    const schClose   = $("#schoolModalClose");
    const schOver    = $("#schoolModalOverlay");
    const schSave    = $("#schoolSave");
    const schDel     = $("#deleteSchoolBtn");
    const schCopy    = $("#schoolCopyContact");
    if (schCancel) schCancel.onclick = closeSchoolEditor;
    if (schClose)  schClose.onclick  = closeSchoolEditor;
    if (schOver)   schOver.onclick   = (e) => { if (e.target.id === "schoolModalOverlay") closeSchoolEditor(); };
    if (schSave)   schSave.onclick   = saveSchool;
    if (schDel)    schDel.onclick    = deleteSchool;
    if (schCopy)   schCopy.onclick   = copyPrimaryToDailyContact;

    // Event editor modal (Phase T9)
    const evCancel = $("#eventCancel");
    const evClose  = $("#eventModalClose");
    const evOver   = $("#eventModalOverlay");
    const evSave   = $("#eventSave");
    const evDel    = $("#deleteEventBtn");
    if (evCancel) evCancel.onclick = closeEventEditor;
    if (evClose)  evClose.onclick  = closeEventEditor;
    if (evOver)   evOver.onclick   = (e) => { if (e.target.id === "eventModalOverlay") closeEventEditor(); };
    if (evSave)   evSave.onclick   = saveEvent;
    if (evDel)    evDel.onclick    = deleteEvent;

    // Inventory modals (Phase T10) — both editor + assign-picker.
    wireInventoryModals();

    // Class-cancellation modal (Phase T8)
    const ccCancel = $("#classCancelClose");
    const ccBack   = $("#ccBack");
    const ccOver   = $("#classCancelOverlay");
    const ccSave   = $("#ccSubmit");
    if (ccCancel) ccCancel.onclick = closeClassCancelModal;
    if (ccBack)   ccBack.onclick   = closeClassCancelModal;
    if (ccOver)   ccOver.onclick   = (e) => { if (e.target.id === "classCancelOverlay") closeClassCancelModal(); };
    if (ccSave)   ccSave.onclick   = submitClassCancel;

    // Notify daily contact modal (Phase T8)
    const nfClose = $("#notifyModalClose");
    const nfDone  = $("#nf_done");
    const nfOver  = $("#notifyModalOverlay");
    const nfCopy  = $("#nf_copy_btn");
    const nfMail  = $("#nf_mailto_btn");
    if (nfClose) nfClose.onclick = closeNotifyModal;
    if (nfDone)  nfDone.onclick  = closeNotifyModal;
    if (nfOver)  nfOver.onclick  = (e) => { if (e.target.id === "notifyModalOverlay") closeNotifyModal(); };
    if (nfCopy)  nfCopy.onclick  = copyNotifyEmail;
    if (nfMail)  nfMail.onclick  = openNotifyMailto;

    // Sub-request create modal (Phase T4)
    const srCancel = $("#subRequestCancel");
    const srClose  = $("#subRequestModalClose");
    const srOver   = $("#subRequestModalOverlay");
    const srSave   = $("#subRequestSave");
    if (srCancel) srCancel.onclick = closeSubRequestModal;
    if (srClose)  srClose.onclick  = closeSubRequestModal;
    if (srOver)   srOver.onclick   = (e) => { if (e.target.id === "subRequestModalOverlay") closeSubRequestModal(); };
    if (srSave)   srSave.onclick   = submitSubRequestModal;

    // Reconcile modal (admin resolves a student_match_candidate)
    $("#reconcileModalClose").onclick = closeReconcileModal;
    $("#reconcileModalOverlay").onclick = (e) => { if (e.target.id === "reconcileModalOverlay") closeReconcileModal(); };
    $("#reconcileLink").onclick       = () => resolveReconcile("link");
    $("#reconcileKeep").onclick       = () => resolveReconcile("keep");
    $("#reconcileDelete").onclick     = () => resolveReconcile("delete");

    // Invitation result modal
    $("#inviteResultClose").onclick = closeInviteResultModal;
    $("#inviteResultDone").onclick  = closeInviteResultModal;
    $("#inviteResultOverlay").onclick = (e) => { if (e.target.id === "inviteResultOverlay") closeInviteResultModal(); };
    $("#inviteResultCopy").onclick  = async () => {
      const url = $("#inviteResultUrl").value;
      if (!url) return;
      const ok = await copyText(url);
      if (ok) flashCopied($("#inviteResultCopy"));
    };

    // Infographic modal
    $("#igCancel").onclick         = closeIgEditor;
    $("#igModalClose").onclick     = closeIgEditor;
    $("#igModalOverlay").onclick   = (e) => { if (e.target.id === "igModalOverlay") closeIgEditor(); };
    $("#igSave").onclick           = saveInfographic;
    $("#deleteIgBtn").onclick      = deleteInfographic;
    $$(".toggle-btn").forEach((b) => b.onclick = () => { igSourceMode = b.dataset.src; updateIgSourceToggle(); });
    $("#i_file").addEventListener("change", (e) => {
      const f = e.target.files[0];
      pendingUploadFile = f || null;
      const preview = $("#imagePreview");
      if (f) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          preview.innerHTML = `<img src="${ev.target.result}" alt="" />`;
          preview.style.display = "";
        };
        reader.readAsDataURL(f);
      } else {
        preview.style.display = "none";
        preview.innerHTML = "";
      }
    });
  }

  /* ═════════════ Boot ═════════════ */
  initAuth();
})();
