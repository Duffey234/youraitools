# LeakGuard MCP server (stdio). Local, offline detection + redaction; paid deep scan with LEAKGUARD_X402_PRIVATE_KEY.
#   docker build -t leakguard-mcp . && docker run -i --rm leakguard-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json LICENSE README.md ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/mcp-stdio.js"]
