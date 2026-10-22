# PayGuard MCP server (stdio). Screens addresses offline against the bundled OFAC SDN snapshot.
#   docker build -t payguard-mcp . && docker run -i --rm payguard-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json LICENSE README.md ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/mcp-stdio.js"]
