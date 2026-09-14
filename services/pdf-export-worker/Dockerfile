FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libpcre2-8-0 qpdf \
  && rm -rf /var/lib/apt/lists/* \
  # This worker runs a dependency-free Node entrypoint. Do not ship npm's
  # package installer (and its unrelated vulnerable dependency graph).
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=8080
USER node
EXPOSE 8080

CMD ["node", "server.mjs"]
