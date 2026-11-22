# Воркер E2E Hub. Сборка из корня репозитория:
#   docker build -f apps/worker/Dockerfile -t e2e-hub-worker .
FROM mcr.microsoft.com/playwright:v1.65.1-noble AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @e2e/worker...
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @e2e/worker build \
 && pnpm deploy --filter @e2e/worker --prod --legacy /out

FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/worker/dist ./dist
# браузеры уже есть в базовом образе Playwright; запускаемся не от root
USER pwuser
CMD ["node", "--enable-source-maps", "dist/index.js"]
