FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# The default catalog is built in; mount another read-only over /app/config to change it.
ENV CONFIG_DIR=/app/config
ENV FHIR_VALIDATOR_IG=/config/np.core-1.0.0.tgz
ENV VALIDATOR_URL=http://127.0.0.1:8081/validateResource
RUN apk add --no-cache openjdk17-jre-headless curl
RUN curl -fsSL -o /app/validator_cli.jar \
  https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
COPY start.sh ./
RUN chmod +x start.sh
USER node
EXPOSE 4005
CMD ["./start.sh"]
