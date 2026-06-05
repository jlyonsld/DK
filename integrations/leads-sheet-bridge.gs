/**
 * DK Leads — live Meta Google Sheet -> DK console sync
 * ----------------------------------------------------
 * Watches EVERY tab in this spreadsheet (so new campaigns are picked up
 * automatically) and forwards each new lead row to the DK dk-lead-intake
 * endpoint, which files it in the Leads inbox and pushes it to Mailchimp
 * (tag dk-lead) for nurture. Runs every 5 minutes. Idempotent: each row it
 * sends gets a timestamp in that tab's "DK Synced" column and is never sent
 * twice; the endpoint also dedups on the Meta lead id, so nothing duplicates.
 *
 * SETUP (one time, ~3 min):
 *   1. Open the "2026 Leads Campaign Sheet" in Google Sheets.
 *   2. Extensions -> Apps Script. Delete any starter code, paste this whole file.
 *   3. Run -> run `installTrigger` once. Approve the permission prompt
 *      (Google will warn it's an unverified script you wrote — that's expected).
 *   4. Run `syncNow` once to send the current backlog.
 *   Done. New leads now flow to the console within ~5 minutes, forever.
 *
 * SCOPE: by default this syncs the CURRENT + any FUTURE campaign tabs, and
 * SKIPS the older tabs listed in SKIP_TABS (so we don't backfill years of old
 * leads before you're ready). To backfill an old tab later, delete its name
 * from SKIP_TABS and run `syncNow`.
 */

const CONFIG = {
  ENDPOINT: "https://ybolygqdbjqowfoqvnsz.supabase.co/functions/v1/dk-lead-intake",
  // Shared X-Lead-Secret — must match the `lead_intake_secret` value in the
  // DK Supabase vault. Keep the real value ONLY in the deployed Apps Script
  // (this committed copy is redacted so the secret isn't stored in git).
  SECRET: "REPLACE_WITH_LEAD_INTAKE_SECRET",

  // Tabs to NOT sync yet (older campaigns). Everything else — including any new
  // campaign tab Meta creates — IS synced. Remove a name here to backfill it.
  SKIP_TABS: [
    "Sheet1",
    "Drama Kids of Charleston East and Summerville 's Summer Camp Form2026",
    "Drama Kids Summer Camp Info",
    "Drama Kids Summer Camp Info-copy",
    "Drama Kids of Charleston East and Summerville 's form created on Wed Feb 18, 2026 11:54am-copy",
  ],

  SYNCED_COL_HEADER: "DK Synced",

  // Column headers are matched case-insensitively. All but `area` match the
  // header EXACTLY (so "id" doesn't collide with ad_id/form_id, and "name"
  // doesn't collide with ad_name/form_name). `area` matches as a substring.
  EXACT: {
    dedupe_key: ["id"],
    created_time: ["created_time"],
    platform: ["platform"],
    form_name: ["form_name"],
    campaign_name: ["ad_name", "campaign_name"],
    parent_name: ["full name", "full_name", "name"],
    parent_email: ["email"],
    parent_phone: ["phone_number", "phone"],
  },
  SUBSTR: {
    area: ["what_area", "area"],
  },
};

function syncNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let totalSent = 0, totalSkipped = 0, totalFailed = 0;

  ss.getSheets().forEach(function (sheet) {
    const tab = sheet.getName();
    if (CONFIG.SKIP_TABS.indexOf(tab) !== -1) return;

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length < 2) return;

    const headers = values[0].map(function (h) { return String(h).trim(); });
    const col = resolveColumns_(headers);
    if (col.parent_email < 0 && col.parent_phone < 0) return; // not a leads tab

    // Ensure a "DK Synced" column exists on this tab.
    let syncedCol = headers.findIndex(function (h) {
      return h.toLowerCase() === CONFIG.SYNCED_COL_HEADER.toLowerCase();
    });
    if (syncedCol === -1) {
      syncedCol = headers.length;
      sheet.getRange(1, syncedCol + 1).setValue(CONFIG.SYNCED_COL_HEADER);
    }

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (row[syncedCol]) { totalSkipped++; continue; }
      if (row.every(function (c) { return c === "" || c === null; })) continue;

      const payload = buildPayload_(row, col, tab);
      if (isHeaderRow_(payload)) { sheet.getRange(r + 1, syncedCol + 1).setValue("skipped: header"); totalSkipped++; continue; }
      if (isTestRow_(payload)) { sheet.getRange(r + 1, syncedCol + 1).setValue("skipped: test"); totalSkipped++; continue; }
      if (!payload.email && !payload.phone) { sheet.getRange(r + 1, syncedCol + 1).setValue("skipped: no contact"); totalSkipped++; continue; }

      try {
        const resp = UrlFetchApp.fetch(CONFIG.ENDPOINT, {
          method: "post",
          contentType: "application/json",
          headers: { "X-Lead-Secret": CONFIG.SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        const code = resp.getResponseCode();
        if (code >= 200 && code < 300) {
          sheet.getRange(r + 1, syncedCol + 1).setValue(new Date());
          totalSent++;
        } else {
          sheet.getRange(r + 1, syncedCol + 1).setValue("ERR " + code);
          totalFailed++;
        }
        Utilities.sleep(150); // gentle pacing; endpoint handles MC rate limits
      } catch (e) {
        sheet.getRange(r + 1, syncedCol + 1).setValue("ERR " + String(e).slice(0, 40));
        totalFailed++;
      }
    }
  });

  Logger.log("DK leads sync — sent %s, skipped %s, failed %s", totalSent, totalSkipped, totalFailed);
}

function buildPayload_(row, col, tab) {
  function val(field) {
    const i = col[field];
    return i === undefined || i < 0 ? "" : String(row[i] == null ? "" : row[i]).trim();
  }
  const payload = {
    dedupe_key: val("dedupe_key"),         // Meta lead id "l:..."; endpoint strips the prefix
    full_name: val("parent_name"),
    email: val("parent_email"),
    phone: val("parent_phone"),            // "p:+1..."; endpoint strips the prefix
    platform: val("platform"),
    form_name: val("form_name"),
    campaign_name: val("campaign_name"),
    created_time: val("created_time"),
    school_of_interest: val("area"),       // the free-trial area question, when present
    inquiry_note: "Tab: " + tab,
  };
  if (!payload.dedupe_key) payload.dedupe_key = "sheet:" + tab + ":row" + (row.__rownum || "");
  return payload;
}

// These tabs repeat their column-header row partway down (the form was
// recreated several times). A header row has the literal column names as its
// values, so skip any row whose id cell is "id" or email cell is "email", etc.
function isHeaderRow_(p) {
  const id = (p.dedupe_key || "").toLowerCase();
  const email = (p.email || "").toLowerCase();
  const name = (p.full_name || "").toLowerCase();
  const phone = (p.phone || "").toLowerCase();
  return id === "id" || email === "email" ||
    name === "full_name" || name === "full name" || name === "name" ||
    phone === "phone" || phone === "phone_number";
}

function isTestRow_(p) {
  const blob = (p.full_name + " " + p.email + " " + p.dedupe_key).toLowerCase();
  return blob.indexOf("test@fb.com") !== -1 || blob.indexOf("test lead") !== -1 || blob.indexOf("dummy data") !== -1;
}

function resolveColumns_(headers) {
  const lower = headers.map(function (h) { return h.toLowerCase(); });
  const out = {};
  Object.keys(CONFIG.EXACT).forEach(function (field) {
    out[field] = -1;
    const matchers = CONFIG.EXACT[field];
    for (let i = 0; i < lower.length && out[field] === -1; i++) {
      if (matchers.indexOf(lower[i]) !== -1) out[field] = i;
    }
  });
  Object.keys(CONFIG.SUBSTR).forEach(function (field) {
    out[field] = -1;
    const matchers = CONFIG.SUBSTR[field];
    for (let i = 0; i < lower.length && out[field] === -1; i++) {
      for (let m = 0; m < matchers.length; m++) {
        if (lower[i].indexOf(matchers[m]) !== -1) { out[field] = i; break; }
      }
    }
  });
  return out;
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncNow") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(5).create();
  Logger.log("Installed 5-minute trigger for syncNow.");
}
