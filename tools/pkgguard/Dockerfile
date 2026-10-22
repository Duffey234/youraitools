# PkgGuard MCP server (stdio). Parses manifests locally; free preview via the hosted API.
#   docker build -t pkgguard-mcp . && docker run -i --rm pkgguard-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json LICENSE README.md ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/mcp-stdio.js"]
