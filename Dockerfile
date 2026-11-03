FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./

USER node

EXPOSE 8080

ENV HOST=0.0.0.0
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=5s CMD wget --spider -q http://127.0.0.1:${PORT:-8080}/health || exit 1

CMD ["node", "server.js"]
