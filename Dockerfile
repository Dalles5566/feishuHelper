# Build stage — install all deps (including devDeps for tsc) and compile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Production stage — only production dependencies + compiled JS
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
