export async function onRequest(context) {
  const { request, env } = context;

  const origin = request.headers.get("Origin") || "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed. Use POST." }, 405);
  }

  // Parse body
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  let data = {};
  try {
    if (ct.includes("application/json")) {
      data = await request.json();
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const txt = await request.text();
      data = Object.fromEntries(new URLSearchParams(txt));
    } else if (ct.includes("multipart/form-data")) {
      const fd = await request.formData();
      data = Object.fromEntries(fd.entries());
    } else {
      // fallback
      const txt = await request.text();
      data = Object.fromEntries(new URLSearchParams(txt));
    }
  } catch {
    data = {};
  }

  const str = (v) => (v == null ? "" : String(v)).trim();

  // Honeypot
  const hp = str(data.hp || data.company);
  if (hp) {
    return json({ ok: true });
  }

  const name = str(data.name).slice(0, 120);
  const email = str(data.email).slice(0, 200);
  const website = str(data.website).slice(0, 300);
  const message = str(data.message).slice(0, 3000);
  const source_path = str(data.source_path).slice(0, 500);
  const user_agent = str(request.headers.get("User-Agent")).slice(0, 400);

  const consentRaw = str(data.consent).toLowerCase();
  const consent = ["1", "true", "on", "yes"].includes(consentRaw) ? 1 : 0;

  if (!email) return json({ ok: false, error: "Email is required." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "Invalid email format." }, 400);
  }
  if (!consent) return json({ ok: false, error: "Consent is required." }, 400);

  // Insert into D1
  try {
    if (!env.LEADS_DB) {
      return json({ ok: false, error: "Server not configured (LEADS_DB missing)." }, 500);
    }

    await env.LEADS_DB.prepare(
      `INSERT INTO leads (name, email, website, message, consent, source_path, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(name || null, email, website || null, message || null, consent, source_path || null, user_agent || null).run();
  } catch (e) {
    return json({ ok: false, error: "Database insert failed." }, 500);
  }

  // Forward to Make (best-effort)
  const webhook = str(env.LEAD_WEBHOOK_URL);
  if (webhook) {
    const ip =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      "";

    const payload = {
      created_at: new Date().toISOString(),
      name,
      email,
      website,
      message,
      consent: !!consent,
      source_path,
      user_agent,
      ip,
    };

    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // ignore forwarding errors
    }
  }

  return json({ ok: true });
}