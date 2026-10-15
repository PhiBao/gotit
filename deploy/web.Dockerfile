# Multi-stage: build the pnpm workspace, serve the static app with Caddy.
# Caddy also provides the same-origin proxies the browser expects:
#   /issuer/*       -> the issuer Fly app (TLS)
#   /proof-server/* -> the proving service (TLS)
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/contract/package.json packages/contract/
COPY packages/issuer/package.json packages/issuer/
RUN pnpm install --frozen-lockfile

COPY . .

# Baked at build time so visitors land on the deployed contract instantly
ARG VITE_CONTRACT_ADDRESS
ENV VITE_CONTRACT_ADDRESS=$VITE_CONTRACT_ADDRESS
# The Wave 2 contract. Baked for the same reason, and more urgently: without it
# the address only exists in the deployer's localStorage, so every other browser
# saw "no contract configured" while the data sat on chain and read it as a broken
# app. Set in fly.web.toml; empty is fine and means v2 is simply not configured.
ARG VITE_CONTRACT_ADDRESS_V2
ENV VITE_CONTRACT_ADDRESS_V2=$VITE_CONTRACT_ADDRESS_V2
# Which network and indexer path this image targets. Both are deployment-specific:
# preprod is Blockfrost (/api/v0, needs a token), preview is Midnight-hosted
# (/api/v4/graphql, needs none).
ARG VITE_MIDNIGHT_NETWORK
ENV VITE_MIDNIGHT_NETWORK=$VITE_MIDNIGHT_NETWORK
ARG VITE_INDEXER_PATH
ENV VITE_INDEXER_PATH=$VITE_INDEXER_PATH
ARG VITE_INDEXER_WS_PATH
ENV VITE_INDEXER_WS_PATH=$VITE_INDEXER_WS_PATH
ARG VITE_HOSTED_PROVER
ENV VITE_HOSTED_PROVER=$VITE_HOSTED_PROVER
ARG VITE_ISSUER_KEY
ENV VITE_ISSUER_KEY=$VITE_ISSUER_KEY

RUN pnpm build

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
