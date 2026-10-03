# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
RUN addgroup -S likho && adduser -S -u 10001 -G likho likho
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY queries ./queries
USER likho
ENV NODE_ENV=production LIKHO_ENV=production
EXPOSE 4060
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD ["wget", "-qO-", "http://127.0.0.1:4060/readyz"]
CMD ["node", "dist/cli.js", "serve"]
