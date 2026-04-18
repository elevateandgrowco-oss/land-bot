FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --omit=dev
COPY . .

CMD ["node", "server.js"]
