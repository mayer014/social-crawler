import { createHmac } from "node:crypto";
import { env } from "./env.js";

function sign(rawBody: string): { sig: string; ts: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", env.SOCIAL_HMAC_SECRET)
    .update(`${rawBody}.${ts}`)
    .digest("hex");
  return { sig: `sha256=${sig}`, ts };
}

async function postSigned(path: string, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  const { sig, ts } = sign(raw);
  return await fetch(`${env.API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Social-Signature": sig,
      "X-Social-Timestamp": ts,
      "X-Worker-Id": env.WORKER_ID,
    },
    body: raw,
  });
}

export type Job = {
  id: string;
  job_type: "crawl_profile" | "crawl_post";
  candidate_id: string;
  profile_id: string | null;
  post_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

export type ProfileMeta = {
  id: string;
  username: string;
  platform: "instagram";
  profile_type: "own_profile" | "competitor" | "portal" | "influencer";
  last_checked_at: string | null;
  followers_count: number | null;
};

export async function fetchNextJob(): Promise<{ job: Job; profile: ProfileMeta | null } | null> {
  const raw = "{}";
  const { sig, ts } = sign(raw);
  const res = await fetch(`${env.API_BASE_URL}/api/public/social/next-job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Social-Signature": sig,
      "X-Social-Timestamp": ts,
      "X-Worker-Id": env.WORKER_ID,
    },
    body: raw,
  });
  if (!res.ok) {
    console.error(`[loop] erro: POST /api/public/social/next-job -> ${res.status}: ${await res.text()}`);
    return null;
  }
  const data = (await res.json()) as { job: Job | null; profile: ProfileMeta | null };
  if (!data.job) return null;
  return { job: data.job, profile: data.profile };
}

export async function reportIngest(body: Record<string, unknown>): Promise<boolean> {
  const res = await postSigned("/api/public/social/ingest", body);
  if (!res.ok) {
    console.error(`[report] ingest ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

export type Heartbeat = {
  status?: "online" | "idle" | "degraded" | "offline";
  jobs_processed?: number;
  last_error?: string;
  meta?: Record<string, unknown>;
};

export async function sendHeartbeat(hb: Heartbeat): Promise<{ breaker_open: boolean } | null> {
  try {
    const res = await postSigned("/api/public/social/heartbeat", hb);
    if (!res.ok) return null;
    const data = (await res.json()) as { breaker?: { breaker_open?: boolean } };
    return { breaker_open: !!data.breaker?.breaker_open };
  } catch {
    return null;
  }
}

export type LogKind =
  | "login_wall" | "rate_limit" | "timeout" | "parser_failure"
  | "ingest_failure" | "network_error" | "captcha" | "breaker" | "other";

export async function sendLog(args: {
  level: "debug" | "info" | "warn" | "error" | "critical";
  kind: LogKind;
  message: string;
  profile_id?: string | null;
  job_id?: string | null;
  context?: Record<string, unknown>;
}): Promise<void> {
  try {
    await postSigned("/api/public/social/log", args);
  } catch {
    /* best-effort */
  }
}

export function classifyError(err: string): LogKind {
  const e = err.toLowerCase();
  if (e.includes("login") || e.includes("accounts/login") || e.includes("auth")) return "login_wall";
  if (e.includes("429") || e.includes("rate") || e.includes("too many")) return "rate_limit";
  if (e.includes("captcha") || e.includes("challenge")) return "captcha";
  if (e.includes("timeout") || e.includes("timed out")) return "timeout";
  if (e.includes("net::") || e.includes("network") || e.includes("dns")) return "network_error";
  if (e.includes("parse") || e.includes("selector") || e.includes("not found")) return "parser_failure";
  return "other";
}
