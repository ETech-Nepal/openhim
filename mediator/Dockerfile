FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching. The compose service also
# re-runs `npm install` on start (bind-mounted source + anonymous node_modules
# volume) so live `node --watch` reload works in dev.
COPY package.json ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "start"]
