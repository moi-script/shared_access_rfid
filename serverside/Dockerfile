# Multi-stage: the TypeScript toolchain and the dev dependencies it needs never
# reach the runtime image.
#
# Node 22, not 20: the Node 20 line reached end of life in April 2026 and stops
# receiving security patches. Rebuild this image periodically — a pinned base
# tag accumulates CVEs in its OS packages even when the app code never changes.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Attendance dates, the occupancy reset boundary and vehicle-pass expiry are
# bucketed in the container's LOCAL time. Without tzdata, TZ=Asia/Manila is
# silently ignored on Alpine and the whole system runs on UTC.
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Don't run as root. node:alpine ships an unprivileged `node` user.
USER node

EXPOSE 3000
# Not `npm start`: npm sits between the signal and node, so SIGTERM never
# reaches the graceful-shutdown handlers in src/server.ts and the platform
# eventually SIGKILLs mid-request.
CMD ["node", "dist/server.js"]
