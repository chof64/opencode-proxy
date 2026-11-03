FROM node:24-alpine

WORKDIR /app

COPY package.json server.js ./

USER node

EXPOSE 8080

ENV HOST=0.0.0.0
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=5s CMD wget --spider -q http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.js"]
