// functions/api/lead.js

function jsonResponse(body, { status = 200, origin = "" } = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  // CORS (szigorúbb, de fejlesztésbarát)
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(JSON.stringify(body), { status, headers });
}

function pickAllowedOrigin(req) {
  const origin = req.headers.get("Origin") || "";
  if (!origin) return ""; // pl. curl

  const allow = [
    "https://audituniversepro.com",
    "https://www.audituniversepro.com",
  ];

  // Pages preview / dev
  if (origin.endsWith(".pages.dev")) return origin;

  // local dev
  if (origin.startsWith("http://localhost")) return origin;

  return allow.includes(origin) ? origin : allow[0];
}

function normalizeString(v, max = 500) {
  if (v == null) return "";
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function isValidEmail(email) {
  // egyszerű, de elég jó validáció (a szerver oldali túl szigorú regex gyakran rossz UX)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function readBody(request) {
  const ct = request.headers.get("Content-Type") || "";

  // JSON
  if (ct.includes("application/json")) {
    const data = await request.json();
    return {
      name: data.name,
      email: data.email,
      website: data.website,
      message: data.message,
      consent: data.consent,
      source_path: data.source_path,
      // opcionális honeypot mező (ha később bevezetnéd a formban)
      company: data.company,
    };
  }

  // FormData (multipart vagy urlencoded)
  const form = await request.formData();
  const get = (k) => form.get(k);

  return {
    name: get("name"),
    email: get("email"),
    website: get("website"),
    message: get("message"),
    consent: get("consent"),
    source_path: get("source_path"),
    company: get("company"),
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = pickAllowedOrigin(request);

  // Preflight
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true }, { status: 204, origin });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405, origin });
  }

  try {
    // kötelező bindingek
    if (!env.LEADS_DB) {
      return jsonResponse(
        { ok: false, error: "Missing D1 binding: LEADS_DB" },
        { status: 500, origin }
      );
    }

    const raw = await readBody(request);

    // Honeypot: ha van ilyen mező és kitöltötték, valószínű bot → csendben OK-t adunk (ne tanítsuk)
    const company = normalizeString(raw.company, 200);
    if (company) {
      return jsonResponse({ ok: true }, { status: 200, origin });
    }

    const name = normalizeString(raw.name, 120);
    const email = normalizeString(raw.email, 200).toLowerCase();
    const website = normalizeString(raw.website, 300);
    const message = normalizeString(raw.message, 2000);

    // consent lehet "1", "true", "on", stb.
    const consentRaw = String(raw.consent ?? "").toLowerCase();
    const consent =
      consentRaw === "1" || consentRaw === "true" || consentRaw === "on" ? 1 : 0;

    const source_path = normalizeString(raw.source_path, 300) || new URL(request.url).pathname;
    const user_agent = normalizeString(request.headers.get("User-Agent"), 300);

    if (!email || !isValidEmail(email)) {
      return jsonResponse(
        { ok: false, error: "Valid email is required." },
        { status: 400, origin }
      );
    }

    // D1 insert
    await env.LEADS_DB.prepare(
      `INSERT INTO leads (name, email, website, message, consent, source_path, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(name || null, email, website || null, message || null, consent, source_path || null, user_agent || null)
      .run();

    // Make webhook (opcionális, de nálad be van állítva)
    const hook = env.LEAD_WEBHOOK_URL;
    if (hook) {
      // Ne blokkoljon UX-et, de legyen await, hogy a Make biztos megkapja.
      // Ha inkább "best effort" kell, kiveheted az await-et.
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          website,
          message,
          consent: !!consent,
          source_path,
          user_agent,
          ts: new Date().toISOString(),
        }),
      });
    }

    return jsonResponse({ ok: true }, { status: 200, origin });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "S
