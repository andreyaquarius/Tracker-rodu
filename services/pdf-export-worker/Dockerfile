FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates qpdf \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=8080
USER node
EXPOSE 8080

CMD ["node", "server.mjs"]
