// social-crawler — consome a fila do app Foto de Apoio
// Endpoints: /api/public/social/{heartbeat,next-job,ingest,log}
// HMAC: sha256(rawBody + "." + tsSeconds) com SOCIAL_HMAC_SECRET

const crypto = require('crypto');
const os = require('os');
const { chromium } = require('playwright');

// ---------- Config ----------
const API_BASE_URL = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const SECRET = process.env.SOCIAL_HMAC_SECRET || '';
const WORKER_ID = process.env.WORKER_ID || `crawler-${os.hostname()}`;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10);
const MAX_POSTS = parseInt(process.env.MAX_POSTS_PER_PROFILE || '12', 10);
const HEADFUL = process.env.HEADFUL === 'true';

if (!API_BASE_URL) { console.error('FATAL: API_BASE_URL não definido'); process.exit(1); }
if (!SECRET) { console.error('FATAL: SOCIAL_HMAC_SECRET não definido'); process.exit(1); }

let jobsProcessed = 0;
let lastError = '';

// ---------- HTTP assinado ----------
function sign(rawBody, ts) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${rawBody}.${ts}`).digest('hex');
}

async function post(path, body) {
  const raw = JSON.stringify(body || {});
  const ts = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Social-Signature': sign(raw, ts),
      'X-Social-Timestamp': ts,
      'X-Worker-Id': WORKER_ID,
    },
    body: raw,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function sendLog(level, kind, message, extra = {}) {
  try {
    await post('/api/public/social/log', {
      level, kind, message: String(message).slice(0, 1000),
      profile_id: extra.profile_id || null,
      job_id: extra.job_id || null,
      context: extra.context || {},
    });
  } catch (e) {
    console.error('[log] falhou:', e.message);
  }
}

async function heartbeat(status = 'online') {
  try {
    const res = await post('/api/public/social/heartbeat', {
      status, jobs_processed: jobsProcessed, last_error: lastError, meta: { headful: HEADFUL },
    });
    return res?.breaker || { breaker_open: false };
  } catch (e) {
    console.error('[heartbeat] falhou:', e.message);
    return { breaker_open: false };
  }
}

// ---------- Playwright: scrape Instagram ----------
let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

function parseCount(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase().replace(/\./g, '').replace(',', '.');
  const m = t.match(/^([\d.]+)\s*(k|m|mi|mil|b)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const suf = m[2];
  if (suf === 'k' || suf === 'mil') n *= 1_000;
  else if (suf === 'm' || suf === 'mi') n *= 1_000_000;
  else if (suf === 'b') n *= 1_000_000_000;
  return Math.round(n);
}

function extractHashtags(s) {
  if (!s) return [];
  return Array.from(new Set((s.match(/#[\p{L}0-9_]+/gu) || []).map(x => x.toLowerCase()))).slice(0, 50);
}
function extractMentions(s) {
  if (!s) return [];
  return Array.from(new Set((s.match(/@[\p{L}0-9_.]+/gu) || []).map(x => x.toLowerCase()))).slice(0, 50);
}

async function scrapeInstagramProfile(username) {
  const br = await getBrowser();
  const context = await br.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    locale: 'pt-BR',
  });
  const page = await context.newPage();
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (resp && resp.status() === 404) {
      throw Object.assign(new Error('profile not found'), { kind: 'parser_failure' });
    }

    // Detectar login wall
    const html = await page.content();
    if (/login|entrar/i.test(await page.title()) && /loginForm|password/i.test(html)) {
      throw Object.assign(new Error('login wall'), { kind: 'login_wall' });
    }
    if (/checkpoint|challenge|captcha/i.test(html)) {
      throw Object.assign(new Error('captcha/challenge'), { kind: 'captcha' });
    }
    if (resp && (resp.status() === 429 || /rate.?limit/i.test(html))) {
      throw Object.assign(new Error('rate limited'), { kind: 'rate_limit' });
    }

    // Tenta extrair via og:tags + JSON do <script type="application/ld+json">
    const meta = await page.evaluate(() => {
      const get = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) || null;
      return {
        title: get('meta[property="og:title"]'),
        description: get('meta[property="og:description"]'),
        image: get('meta[property="og:image"]'),
      };
    });

    // og:description costuma ser "X Followers, Y Following, Z Posts - See Instagram..."
    let followers = null;
    if (meta.description) {
      const m = meta.description.match(/([\d.,]+[KMmilB]?)\s+(Followers|Seguidores)/i);
      if (m) followers = parseCount(m[1]);
    }
    const display_name = meta.title ? meta.title.replace(/\s*\(@.*\).*$/, '').trim() : null;

    // Posts: links /p/ ou /reel/ no DOM
    await page.waitForTimeout(2500);
    const posts = await page.evaluate((max) => {
      const seen = new Set();
      const out = [];
      const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/(p|reel)\/([^/?#]+)/);
        if (!m) continue;
        const id = m[2];
        if (seen.has(id)) continue;
        seen.add(id);
        const img = a.querySelector('img');
        out.push({
          external_id: id,
          post_type: m[1] === 'reel' ? 'reel' : 'feed',
          thumbnail_url: img?.getAttribute('src') || null,
          caption: img?.getAttribute('alt') || null,
        });
        if (out.length >= max) break;
      }
      return out;
    }, MAX_POSTS);

    const normalized = posts.map(p => ({
      external_id: p.external_id,
      post_type: p.post_type,
      caption: p.caption,
      hashtags: extractHashtags(p.caption),
      mentions: extractMentions(p.caption),
      media_urls: p.thumbnail_url ? [p.thumbnail_url] : [],
      thumbnail_url: p.thumbnail_url,
      posted_at: null,
      likes: null,
      comments: null,
      views: null,
    }));

    return {
      profile_update: {
        display_name,
        avatar_url: meta.image,
        bio: meta.description,
        followers_count: followers,
      },
      posts: normalized,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------- Loop principal ----------
async function processJob(job, profile) {
  const jobCtx = { job_id: job.id, profile_id: job.profile_id };
  console.log(`[job ${job.id}] type=${job.job_type} profile=${profile?.username}`);

  if (job.job_type !== 'crawl_profile' || !profile?.username) {
    await post('/api/public/social/ingest', {
      job_id: job.id, profile_id: job.profile_id, ok: false,
      error: `unsupported job_type=${job.job_type}`,
    });
    return;
  }

  if ((profile.platform || 'instagram') !== 'instagram') {
    await post('/api/public/social/ingest', {
      job_id: job.id, profile_id: job.profile_id, ok: false,
      error: `platform not supported: ${profile.platform}`,
    });
    return;
  }

  try {
    const result = await scrapeInstagramProfile(profile.username);
    await post('/api/public/social/ingest', {
      job_id: job.id,
      profile_id: job.profile_id,
      ok: true,
      profile_update: result.profile_update,
      posts: result.posts,
    });
    jobsProcessed++;
    lastError = '';
    console.log(`[job ${job.id}] OK — ${result.posts.length} posts`);
  } catch (err) {
    lastError = err.message;
    const kind = err.kind || 'parser_failure';
    console.error(`[job ${job.id}] FAIL (${kind}):`, err.message);
    await sendLog(
      kind === 'login_wall' || kind === 'captcha' || kind === 'rate_limit' ? 'critical' : 'error',
      kind, err.message, jobCtx,
    );
    await post('/api/public/social/ingest', {
      job_id: job.id, profile_id: job.profile_id, ok: false, error: err.message,
    }).catch(e => console.error('[ingest] falhou:', e.message));
  }
}

async function mainLoop() {
  console.log(`social-crawler iniciado — worker=${WORKER_ID} api=${API_BASE_URL}`);

  // Heartbeat em background
  setInterval(() => { heartbeat('online').catch(() => {}); }, HEARTBEAT_MS);
  await heartbeat('online');

  while (true) {
    try {
      const breaker = await heartbeat('online');
      if (breaker?.breaker_open) {
        console.log(`[breaker] aberto: ${breaker.breaker_reason || ''} — aguardando ${POLL_MS * 4}ms`);
        await new Promise(r => setTimeout(r, POLL_MS * 4));
        continue;
      }

      const res = await post('/api/public/social/next-job', {});
      if (!res?.job) {
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      await processJob(res.job, res.profile);
    } catch (err) {
      lastError = err.message;
      console.error('[loop] erro:', err.message);
      await sendLog('error', 'network_error', err.message).catch(() => {});
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM recebido, encerrando...');
  await heartbeat('offline').catch(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

mainLoop().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
