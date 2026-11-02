# HAPI FHIR with the access rules built in: the stock image plus this jar in its
# loader path (/app/extra-classes). Keep the base tag equal to pom.xml's hapi.version.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /w
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src src
RUN mvn -q -B package

FROM hapiproject/hapi:v8.12.0-1@sha256:d7f38d3676900b07e8a7d3500426eaf8d90ea9ced9a6726416f080f68e230fb0
COPY --from=build /w/target/hapi-interceptors-1.0.0.jar /app/extra-classes/
