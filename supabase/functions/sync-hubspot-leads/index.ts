// Supabase Edge Function: sync-hubspot-leads
// Triggered by the "↻ Refresh HubSpot leads" button on the dashboard (Budget & Close-out tab).
// Pulls every record from the HubSpot Leads object (0-136) and matches leads to events either by
// the lead-name suffix stored as `hubspotTag` ("Jane Doe - TOKEN2049 SG 2026") or, for events tagged
// on the contact instead, by the contacts' "Event Name" property stored as `hubspotEventName`,
// and writes the stage funnel back onto the event. The post-event lead count (opps_actual)
// is the ROI baseline and is left untouched.
//
// Secrets: HUBSPOT_TOKEN — a HubSpot private-app token with the `crm.objects.leads.read` and
// `crm.objects.contacts.read` scopes.
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

    const hs = async (path: string, body: unknown) => {
      const r = await fetch(`https://api.hubapi.com${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HubSpot ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    };
    // Lead ids belonging to contacts whose "Event Name" equals `eventName`
    const leadIdsForEventName = async (eventName: string) => {
      const contactIds: string[] = [];
      let after: string | undefined;
      do {
        const j = await hs("/crm/v3/objects/contacts/search", {
          filterGroups: [{ filters: [{ propertyName: "event_name", operator: "EQ", value: eventName }] }],
          properties: ["event_name"], limit: 100, ...(after ? { after } : {}),
        });
        contactIds.push(...j.results.map((c: { id: string }) => c.id));
        after = j.paging?.next?.after;
      } while (after);
      const ids = new Set<string>();
      for (let i = 0; i < contactIds.length; i += 1000) {
        const j = await hs("/crm/v4/associations/contacts/0-136/batch/read", {
          inputs: contactIds.slice(i, i + 1000).map((id) => ({ id })),
        });
        for (const r of j.results || []) for (const to of r.to || []) ids.add(String(to.toObjectId));
      }
      return ids;
    };

    // 2. Count stages for every event linked to HubSpot
    const { data: rows, error } = await sb.from("events").select("id,name,data");
    if (error) throw error;
    const now = new Date().toISOString();
    const matched = new Set<string>();
    const events = [];
    for (const ev of (rows || []).filter((r) => r.data?.hubspotTag || r.data?.hubspotEventName)) {
      const c = { new: 0, mql: 0, sql: 0, sao: 0, dq: 0 };
      const byEventName = !ev.data.hubspotTag ? await leadIdsForEventName(ev.data.hubspotEventName) : null;
      const tag = norm(ev.data.hubspotTag);
      for (const l of leads) {
        if (byEventName ? byEventName.has(l.id) : norm(l.properties.hs_lead_name).includes("- " + tag)) {
          const k = STAGE[l.properties.hs_pipeline_stage || ""];
          if (k) c[k]++;
          matched.add(l.id);
        }
      }
      const d = ev.data;
      const qualified = c.sql + c.sao;
      // opps_actual is the post-event lead count (the fixed ROI baseline) — never overwrite it.
      // The sync only records where those leads are now.
      const data = {
        ...d,
        hs_leads_total: c.new + c.mql + c.sql + c.sao + c.dq,
        hs_new: c.new, hs_mql: c.mql, hs_sql: c.sql, hs_sao: c.sao, hs_dq: c.dq,
        hs_synced_at: now,
      };
      const { error: ue } = await sb.from("events").update({ data }).eq("id", ev.id);
      if (ue) throw ue;
      events.push({ name: ev.name, tag: d.hubspotTag || d.hubspotEventName, qualified, ...c });
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
