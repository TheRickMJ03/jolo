# Local Firestore emulator for the brain (docker-compose.emulator.yml).
# Rules and indexes are mounted from jolo-app/, so the emulator enforces the same ones as the real project.
FROM node:22-bookworm-slim

# The emulator is a Java program; firebase-tools 14+ needs Java 21.
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH

# Same version as jolo-app/package.json.
RUN npm install -g firebase-tools@15.34.1 && npm cache clean --force

WORKDIR /firebase
COPY firebase.json ./
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Download the emulator jar now, not on every start.
RUN firebase setup:emulators:firestore

EXPOSE 8080 4000
ENTRYPOINT ["/entrypoint.sh"]
