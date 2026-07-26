FROM node:20.17.0-alpine3.20 AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.17.0-alpine3.20 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY healthcheck.mjs ./healthcheck.mjs

RUN mkdir -p /app/data && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node healthcheck.mjs || exit 1

CMD ["node", "dist/index.js"]
