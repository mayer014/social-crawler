FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Defaults — sobrescreva no EasyPanel:
#   API_BASE_URL=https://fotodeapoio.easychain.com.br
#   SOCIAL_HMAC_SECRET=<mesma do app>
#   WORKER_ID=crawler-1 (opcional)
#   POLL_INTERVAL_MS=15000 (opcional)
#   HEARTBEAT_INTERVAL_MS=30000 (opcional)
ENV NODE_ENV=production

CMD ["npm", "start"]
