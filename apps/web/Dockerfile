# Propus web (Next.js) for Cloud Run. Build context is the REPO ROOT so the
# @propus/contract workspace and the root lockfile resolve.
FROM node:20-slim

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /srv

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contract packages/contract
RUN npm ci

COPY apps/web apps/web

# NEXT_PUBLIC_* values are inlined at build time, so the API URL is a build arg.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_MODE="live"
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_MODE=$NEXT_PUBLIC_MODE
RUN npm run build --workspace apps/web

ENV NODE_ENV=production
CMD exec npm run start --workspace apps/web -- --port ${PORT:-8080} --hostname 0.0.0.0
