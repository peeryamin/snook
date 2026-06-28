FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/
COPY web/ ./web/

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DB_PATH=/data/parlor.db

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server.js"]
