FROM node:20-slim

WORKDIR /opt/whapy-design

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY data/users.json ./data/users.json

# Create screenshots directory
RUN mkdir -p ./data/screenshots

EXPOSE 3030

ENV NODE_ENV=production
ENV PORT=3030

CMD ["node", "server.js"]
