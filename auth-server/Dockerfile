# BlockWhiz Auth Server — production image
# Build: docker build -t craftmate-auth-server ./auth-server
# Run:   docker run --env-file .env -p 127.0.0.1:8080:8080 craftmate-auth-server

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 本番依存関係のみ（build stage で prune 済み）
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# data/ は MockMailer の outbox・開発用鍵の保存先。
# 本番では環境変数で鍵を注入するため通常は空だが、
# loadKeys/mailer が mkdir するため node ユーザーが書き込める必要がある。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8080
# SIGTERM で graceful shutdown するため PID1 として node を直接実行する
CMD ["node", "dist/index.js"]
