FROM node:24.22.1-alpine

WORKDIR /app

# Install dependencies first for better layer caching. The compose service also
# re-runs `npm install` on start (bind-mounted source + anonymous node_modules
# volume) so live `node --watch` reload works in dev.
COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 4001

RUN npm run build

CMD ["npm", "start"]
