import { env } from "./env.js";
import { fetchNextJob, reportIngest, sendHeartbeat, sendLog, classifyError } from "./queue.js";
import { crawlProfile } from "./crawler.js";
import { jitter } from "./antiBlock.js";
import { shutdown } from "./browser.js";

let jobsProcessed = 0;
let lastError: string | undefined;
let breakerOpen = false;

async function tick(): Promise<"job" | "idle" | "paused"> {
  if (breakerOpen) return "paused";

  const next = await fetchNextJob();
  if (!next) return "idle";

  const { job, profile } = next;
  console.log(`[worker] ${job.id} ${job.job_type} attempt=${job.attempts} profile=${profile?.username}`);

  if (job.job_type !== "crawl_profile" || !profile) {
    await reportIngest({
      job_id: job.id,
      profile_id: job.profile_id,
      ok: false,
      error: "unsupported job_type (Fase 1: apenas crawl_profile)",
    });
    return "job";
  }

  try {
    const result = await crawlProfile(profile.username);
    const ok = await reportIngest({
      job_id: job.id,
      profile_id: job.profile_id,
      ok: true,
      profile_update: {
        display_name: result.display_name,
        avatar_url: result.avatar_url,
        bio: result.bio,
        followers_count: result.followers_count,
      },
      posts: result.posts,
    });
    if (!ok) {
      lastError = "ingest report failed";
      await sendLog({
        level: "error",
        kind: "ingest_failure",
        message: `ingest failed for ${profile.username}`,
        profile_id: job.profile_id,
        job_id: job.id,
      });
    } else {
      jobsProcessed++;
      lastError = undefined;
    }
  } catch (e) {
    const err = (e as Error).message || "crawler error";
    const kind = classifyError(err);
    lastError = err.slice(0, 200);
    console.error(`[worker] crawl failed ${profile.username}: ${err}`);
    await sendLog({
      level: kind === "login_wall" || kind === "rate_limit" || kind === "captcha" ? "critical" : "error",
      kind,
      message: `${profile.username}: ${err.slice(0, 400)}`,
      profile_id: job.profile_id,
      job_id: job.id,
    });
    await reportIngest({
      job_id: job.id,
      profile_id: job.profile_id,
      ok: false,
      error: err.slice(0, 480),
    });
  }
  return "job";
}

async function heartbeatLoop() {
  while (true) {
    const r = await sendHeartbeat({
      status: breakerOpen ? "degraded" : "online",
      jobs_processed: jobsProcessed,
      last_error: lastError,
      meta: { version: "phase1", node: process.version },
    });
    if (r) breakerOpen = r.breaker_open;
    await new Promise((res) => setTimeout(res, 30_000));
  }
}

async function main() {
  console.log(`[worker] starting ${env.WORKER_ID} → ${env.API_BASE_URL}`);
  heartbeatLoop().catch((e) => console.error("[heartbeat] loop error", e));

  let consecutiveIdle = 0;
  while (true) {
    try {
      const r = await tick();
      if (r === "paused") {
        console.warn("[worker] circuit breaker OPEN — sleeping 60s");
        await new Promise((res) => setTimeout(res, 60_000));
      } else if (r === "idle") {
        consecutiveIdle++;
        const wait = Math.min(env.IDLE_BACKOFF_MS * Math.max(1, consecutiveIdle), 300_000);
        await jitter(wait * 0.8, wait);
      } else {
        consecutiveIdle = 0;
        await jitter(env.POLL_INTERVAL_MS * 0.7, env.POLL_INTERVAL_MS * 1.3);
      }
    } catch (e) {
      console.error("[worker] loop error", (e as Error).message);
      lastError = (e as Error).message?.slice(0, 200);
      await jitter(10_000, 20_000);
    }
  }
}

main().catch(async (e) => {
  console.error("[worker] fatal", e);
  await shutdown();
  process.exit(1);
});
