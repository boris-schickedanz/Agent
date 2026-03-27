FROM node:22-alpine

WORKDIR /app

# Native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/workspace

EXPOSE 9090

# Sentinel: prevents bin/agentcore.js from re-wrapping in another container
ENV AGENTCORE_IN_CONTAINER=1

ENTRYPOINT ["node", "src/index.js"]
