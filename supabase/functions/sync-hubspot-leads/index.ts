// Supabase Edge Function: sync-hubspot-leads
// Triggered by the "↻ Refresh HubSpot leads" button on the dashboard (Budget & Close-out tab).
// Pulls every record from the HubSpot Leads object (0-136), matches leads to events by the
// lead-name suffix stored as each event's `hubspotTag` ("Jane Doe - TOKEN2049 SG 2026"),
// and writes the stage funnel back onto the event. Qualified leads = SQL + SAO.
//
// Secrets: HUBSPOT_TOKEN — a HubSpot private-app token with the `crm.objects.leads.read` scope.
// SUPABASE_URL / SUPABASE_ANON_KEY are provided by Supabase automatically. The caller's own
// login (JWT) is used for the database write, so only signed-in @reap.hk users can run it.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json" } });

// HubSpot lead pipeline stage ids → funnel buckets
const STAGE: Record<string, "new" | "mql" | "sql" | "sao" | "dq"> = {
  "new-stage-id": "new",
  "attempting-stage-id": "mql",
  "connected-stage-id": "sql",
  "qualified-stage-id": "sao",
  "unqualified-stage-id": "dq",
};
const norm = (s: string | null | undefined) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = Deno.env.get("HUBSPOT_TOKEN");
    if (!token) throw new Error("HUBSPOT_TOKEN secret is not set in Supabase");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    // 1. Pull all leads (paged)
    const leads: { id: string; properties: { hs_lead_name?: string; hs_pipeline_stage?: string } }[] = [];
    let after: string | undefined;
    do {
      const url = new URL("https://api.hubapi.com/crm/v3/objects/0-136");
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", "hs_lead_name,hs_pipeline_stage");
      if (after) url.searchParams.set("after", after);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HubSpot ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      leads.push(...j.results);
      after = j.paging?.next?.after;
    } while (after);

    // 2. Count stages for every event that has a HubSpot lead tag
    const { data: rows, error } = await sb.from("events").select("id,name,data");
    if (error) throw error;
    const now = new Date().toISOString();
    const matched = new Set<string>();
    const events = [];
    for (const ev of (rows || []).filter((r) => r.data?.hubspotTag)) {
      const tag = norm(ev.data.hubspotTag);
      const c = { new: 0, mql: 0, sql: 0, sao: 0, dq: 0 };
      for (const l of leads) {
        if (norm(l.properties.hs_lead_name).includes("- " + tag)) {
          const k = STAGE[l.properties.hs_pipeline_stage || ""];
          if (k) c[k]++;
          matched.add(l.id);
        }
      }
      const d = ev.data;
      const qualified = c.sql + c.sao;
      const data = {
        ...d,
        hs_leads_total: c.new + c.mql + c.sql + c.sao + c.dq,
        hs_new: c.new, hs_mql: c.mql, hs_sql: c.sql, hs_sao: c.sao, hs_dq: c.dq,
        hs_synced_at: now,
        // keep the pre-HubSpot manual count for audit the first time an event switches over
        opps_actual_manual: d.opps_source === "hubspot" ? (d.opps_actual_manual ?? null) : (d.opps_actual ?? null),
        opps_actual: qualified,
        opps_source: "hubspot",
      };
      const { error: ue } = await sb.from("events").update({ data }).eq("id", ev.id);
      if (ue) throw ue;
      events.push({ name: ev.name, tag: d.hubspotTag, qualified, ...c });
    }

    // 3. Event-style tags in HubSpot ("… - SOMETHING 2027") that no event claims yet
    const counts: Record<string, number> = {};
    for (const l of leads) {
      if (matched.has(l.id)) continue;
      const m = (l.properties.hs_lead_name || "").match(/ - (.*\b20\d{2})\s*$/);
      if (m) counts[m[1].trim()] = (counts[m[1].trim()] || 0) + 1;
    }
    const unmatchedTags = Object.entries(counts).map(([tag, count]) => ({ tag, count }));

    return json({ leadsScanned: leads.length, events, unmatchedTags });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) });
  }
});
