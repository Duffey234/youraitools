# DomainCheck MCP server (stdio). Full domain + email checks run locally over public DoH + RDAP.
#   docker build -t domaincheck-mcp . && docker run -i --rm domaincheck-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json LICENSE README.md ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/mcp-stdio.js"]
