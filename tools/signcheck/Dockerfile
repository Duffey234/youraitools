# SignCheck MCP server (stdio). Free offline preview via the hosted API; paid mode with SIGNCHECK_X402_PRIVATE_KEY.
#   docker build -t signcheck-mcp . && docker run -i --rm signcheck-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json LICENSE README.md ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/mcp-stdio.js"]
