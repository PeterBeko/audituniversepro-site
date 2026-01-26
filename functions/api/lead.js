const ALLOWED_ORIGINS = new Set([
  "https://audituniversepro.com",
  "https://www.audituniversepro.com",
  "https://audituniversepro-site.pages.dev",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
]);

function normalizeStr(v, maxLen = 4000) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isValidEmail(email) {
  // Simple, practical validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAllowedOrigin(req) {
  const origin = req.headers.get("Origin");
  if (!origin) return ""; // same-origin / server-to-server
  return ALLOWED_ORIGINS.has(origin) ? origin : "";
}

function jsonResponse(payload, { status = 200, origin = "" } = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  return new Response(JSON.stringify(payload), { status, headers });
}

function corsPreflight(origin) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  return new Response(null, { status: 204, headers });
}

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await request.json();
  }
  // supports application/x-www-form-urlencoded and multipart/form-data
  const fd = await request.formData();
  const obj = {};
  for (const [k, v] of fd.entries()) obj[k] = v;
  return obj;
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = getAllowedOrigin(request);

  if (request.method === "OPTIONS") {
    return corsPreflight(origin);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: "Method not allowed" },
      { status: 405, origin }
    );
  }

  try {
    const body = await readBody(request);

    const name = normalizeStr(body.name, 200);
    const email = normalizeStr(body.email, 200).toLowerCase();
    const website = normalizeStr(body.website, 500);
    const message = normalizeStr(body.message, 4000);

    const consentRaw = body.consent;
    const consent =
      consentRaw === true ||
      consentRaw === "true" ||
      consentRaw === "1" ||
      consentRaw === 1 ||
      consentRaw === "on";

    if (!email || !isValidEmail(email)) {
      return jsonResponse(
        { ok: false, error: "Invalid email" },
        { status: 400, origin }
      );
    }

    // GDPR-friendly: store only if consent is explicitly given
    if (!consent) {
      return jsonResponse(
        { ok: false, error: "Consent required" },
        { status: 400, origin }
      );
    }

    let source_path = normalizeStr(body.source_path, 500);
    if (!source_path) {
      const ref = request.headers.get("Referer") || "";
      try {
        if (ref) source_path = new URL(ref).pathname || "";
      } catch (_) {}
      if (!source_path) source_path = new URL(request.url).pathname || "";
    }

    const user_agent = normalizeStr(request.headers.get("User-Agent") || "", 500);

    if (!env || !env.LEADS_DB) {
      return jsonResponse(
        { ok: false, error: "Server misconfiguration (LEADS_DB missing)" },
        { status: 500, origin }
      );
    }

    // Insert into D1
    await env.LEADS_DB.prepare(
      `INSERT INTO leads (name, email, website, message, consent, source_path, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(name, email, website, message, 1, source_path, user_agent)
      .run();

    // Optional: forward to Make webhook
    const hook = (env.LEAD_WEBHOOK_URL || "").trim();
    let webhook_sent = false;

    if (hook) {
      try {
        await fetch(hook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            email,
            website,
            message,
            consent: true,
            source_path,
            user_agent,
            ts: new Date().toISOString(),
          }),
        });
        webhook_sent = true;
      } catch (e) {
        console.warn("LEAD_WEBHOOK_URL fetch failed:", e);
      }
    }

    return jsonResponse(
      { ok: true, webhook_sent },
      { status: 200, origin }
    );
  } catch (err) {
    console.error("Lead handler error:", err);
    return jsonResponse(
      { ok: false, error: "Server error" },
      { status: 500, origin }
    );
  }
}