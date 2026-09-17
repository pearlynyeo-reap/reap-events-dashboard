// Supabase Edge Function: notify-slack
// Posts a message to a Slack Incoming Webhook when a new event is added for evaluation.
// The webhook URL is read from the SLACK_WEBHOOK_URL secret (never exposed to the browser).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { name, region, addedBy, priorityTier, date } = await req.json();
    const webhook = Deno.env.get("SLACK_WEBHOOK_URL");
    if (!webhook) {
      return new Response(JSON.stringify({ error: "SLACK_WEBHOOK_URL not set" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const bits = [
      region ? `*Region:* ${region}` : null,
      priorityTier ? `*Tier:* ${priorityTier}` : null,
      date ? `*Date:* ${date}` : null,
    ].filter(Boolean).join("   ");
    const text =
      `🆕 *New event added for evaluation:* ${name}\n` +
      (bits ? bits + "\n" : "") +
      `*Added by:* ${addedBy || "unknown"}\n` +
      `<https://pearlynyeo-reap.github.io/reap-events-dashboard/|Open dashboard → filter “🆕 To evaluate”>`;

    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return new Response(JSON.stringify({ ok: r.ok }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
