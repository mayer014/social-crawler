export const env = {
  API_BASE_URL: required("API_BASE_URL"),
  SOCIAL_HMAC_SECRET: required("SOCIAL_HMAC_SECRET"),
  WORKER_ID: process.env.WORKER_ID || `worker-${Math.random().toString(36).slice(2, 8)}`,
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || 15000),
  IDLE_BACKOFF_MS: Number(process.env.IDLE_BACKOFF_MS || 60000),
  MAX_POSTS_PER_RUN: Number(process.env.MAX_POSTS_PER_RUN || 12),
  HEADLESS: (process.env.HEADLESS ?? "true") !== "false",
  PROXY_URL: process.env.PROXY_URL || undefined,
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[crawler] missing env: ${name}`);
    process.exit(1);
  }
  return v;
}
