# ---- build stage: full dependencies, compile the app ----
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force
COPY . .
RUN npx prisma generate && npm run build

# ---- runtime stage: production dependencies only, non-root ----
FROM node:22-alpine
RUN apk add --no-cache openssl tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY prisma ./prisma
RUN npx prisma generate && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# tini forwards SIGTERM so the scheduler can finish its current pass and release locks.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "docker-start"]
