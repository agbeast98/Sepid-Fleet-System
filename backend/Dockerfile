FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
ENV NODE_ENV=production PORT=55320 HOST=0.0.0.0
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ ./dist/
COPY backend/infra/migrations/ ./infra/migrations/
COPY backend/scripts/migrate.cjs ./scripts/migrate.cjs
EXPOSE 55320
CMD ["sh", "-c", "node scripts/migrate.cjs && node dist/main.js"]
