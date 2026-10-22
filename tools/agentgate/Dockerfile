# AgentGate MCP server (stdio), tool check_agent (Concordium Agent Registry, mainnet by default).
#   docker build -t agentgate-mcp . && docker run -i --rm agentgate-mcp
#   offline demo data: docker run -i --rm -e AGENTGATE_MOCK=1 agentgate-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY mcp ./mcp
COPY LICENSE README.md ./
USER node
ENTRYPOINT ["node", "mcp/server.js"]
