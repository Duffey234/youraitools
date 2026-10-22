# WebRead MCP server (stdio). The stdio server has no runtime dependencies.
#   docker build -t webread-mcp . && docker run -i --rm webread-mcp
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json LICENSE README.md ./
COPY src ./src
USER node
ENTRYPOINT ["node", "src/mcp-stdio.js"]
