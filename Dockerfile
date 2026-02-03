FROM node:20-slim

WORKDIR /app

# Copy package files and install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS and persona files
COPY dist/ ./dist/
COPY persona*.md ./

EXPOSE 3000

CMD ["node", "dist/cloud-server.js"]
