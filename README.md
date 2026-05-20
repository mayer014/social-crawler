# social-crawler

Worker que consome a fila `social_jobs` do app **Foto de Apoio** (TanStack/Supabase) via HTTP assinado por HMAC.

## Como funciona

Loop:
1. `POST /api/public/social/heartbeat` — anuncia que está vivo.
2. `POST /api/public/social/next-job` — reivindica próximo job (`claim_next_social_job` no Postgres).
3. Se houver job de `crawl_profile`: abre o Instagram com Playwright, extrai perfil + últimos posts.
4. `POST /api/public/social/ingest` — envia resultado (ou erro). O endpoint marca o job como `done`/`failed` via `complete_social_job`.
5. Erros graves (login wall, rate limit, captcha) → `POST /api/public/social/log` para o circuit breaker decidir pausar.

Todos os requests são assinados:

```
X-Social-Signature: sha256=<hex(hmac_sha256(SECRET, rawBody + "." + ts))>
X-Social-Timestamp: <unix seconds>
X-Worker-Id: <WORKER_ID>
```

## Variáveis de ambiente (EasyPanel)

| Nome | Obrigatória | Default | Descrição |
|---|---|---|---|
| `API_BASE_URL` | sim | — | Ex: `https://fotodeapoio.easychain.com.br` (sem barra no final) |
| `SOCIAL_HMAC_SECRET` | sim | — | Mesma do app |
| `WORKER_ID` | não | `crawler-<hostname>` | Identificador do worker |
| `POLL_INTERVAL_MS` | não | `15000` | Intervalo entre polls quando não há job |
| `HEARTBEAT_INTERVAL_MS` | não | `30000` | Intervalo entre heartbeats |
| `MAX_POSTS_PER_PROFILE` | não | `12` | Posts a coletar por perfil |
| `HEADFUL` | não | `false` | `true` para abrir browser visível (debug local) |

## Rodar local

```bash
export API_BASE_URL=https://fotodeapoio.easychain.com.br
export SOCIAL_HMAC_SECRET=...
npm install
npx playwright install chromium
npm start
```
