FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache dumb-init docker-cli

COPY --from=base /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/package.json ./package.json
COPY scripts/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV MIGRATIONS_DIR=/app/migrations

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]
