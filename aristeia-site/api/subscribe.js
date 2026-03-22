const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 8;
const MAX_EMAIL_LENGTH = 254;
const rateLimitStore = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return String(xff[0]).split(",")[0].trim();
  }
  return "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const existing = rateLimitStore.get(ip);

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  existing.count += 1;
  if (existing.count > RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  return false;
}

function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [ip, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(ip);
    }
  }
}

function json(res, statusCode, payload) {
  return res.status(statusCode).json(payload);
}

function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function parseRequestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function isAllowedOrigin(req) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (!allowedOrigin) {
    return true;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  return origin === allowedOrigin;
}

async function saveToSupabase(email, metadata) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tableName = process.env.SUPABASE_TABLE || "aristeia_waitlist";

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return { ok: false, code: "CONFIG_MISSING" };
  }

  const endpoint = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${encodeURIComponent(tableName)}`;
  const payload = {
    email,
    source: "aristeia-site"
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify(payload)
  });

  if (response.ok) {
    return { ok: true, duplicate: false };
  }

  if (response.status === 409) {
    return { ok: true, duplicate: true };
  }

  const errorBody = await response.text().catch(() => "");
  return {
    ok: false,
    code: "SUPABASE_ERROR",
    message: `Supabase error (${response.status}): ${errorBody.slice(0, 200)}`
  };
}

module.exports = async function handler(req, res) {
  cleanupRateLimitStore();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed." });
  }

  if (!isAllowedOrigin(req)) {
    return json(res, 403, { ok: false, code: "ORIGIN_NOT_ALLOWED", error: "Request origin is not allowed." });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return json(res, 429, {
      ok: false,
      code: "RATE_LIMITED",
      error: "Too many requests. Please try again shortly."
    });
  }

  const body = parseRequestBody(req);
  const email = normalizeEmail(body.email);
  const honeypot = typeof body.company === "string" ? body.company.trim() : "";
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

  // Silent success for bots that fill hidden fields.
  if (honeypot) {
    return json(res, 200, { ok: true });
  }

  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
    return json(res, 400, { ok: false, code: "INVALID_EMAIL", error: "Invalid email address." });
  }

  const result = await saveToSupabase(email, { ip, userAgent });
  if (!result.ok) {
    if (result.code === "CONFIG_MISSING") {
      return json(res, 503, {
        ok: false,
        code: "SERVICE_UNAVAILABLE",
        error: "Subscription service is temporarily unavailable."
      });
    }

    console.error("Subscribe failed:", result.message);
    return json(res, 500, {
      ok: false,
      code: "SUBSCRIBE_FAILED",
      error: "Subscription failed. Please try again."
    });
  }

  return json(res, 200, { ok: true, duplicate: Boolean(result.duplicate) });
};
