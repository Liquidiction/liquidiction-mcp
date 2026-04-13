FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm install tsx typescript

COPY . .

EXPOSE 3000

CMD ["npx", "tsx", "mcp-server.ts"]
