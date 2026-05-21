FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install -D typescript tsx

ENV NODE_ENV=production
ENV HEADLESS=true

CMD ["npx", "tsx", "src/index.ts"]
