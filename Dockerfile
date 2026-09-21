ARG NODE_IMAGE=node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212
ARG JAVA_IMAGE=eclipse-temurin:25.0.4_7-jre-jammy@sha256:abed22bb0186ab4554c339fa41e0a361daed337b938929c95a1f2e4a228c1935
ARG JAVA8_IMAGE=eclipse-temurin:8-jre-jammy@sha256:06641b36281c1ac815c33f3f3528cfea1c6fc41ddc60d261746e4343d19cbe65
ARG JAVA17_IMAGE=eclipse-temurin:17-jre-jammy@sha256:e85989f3e4d136b3d7dde921e157fddb9c7016805a225c1ec483326b825b3ca5
ARG JAVA21_IMAGE=eclipse-temurin:21-jre-jammy@sha256:61d6c7b34d36aee3f45d043101259f97f3c6d428dc2a6f75513789983c5e254f
ARG CADDY_IMAGE=caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src
COPY public ./public
COPY server ./server
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 workshop && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /data workshop \
    && install -d -o 10001 -g 10001 -m 0700 /data
WORKDIR /app
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY deploy/docker/restore-state.mjs ./deploy/docker/restore-state.mjs
ENV NODE_ENV=production HOST=0.0.0.0 RUNTIME_DIRECTORY=/data
USER 10001:10001

FROM runtime AS app
EXPOSE 3000
CMD ["node", "dist/server/index.js"]

FROM ${JAVA_IMAGE} AS java
FROM ${JAVA8_IMAGE} AS java8
FROM ${JAVA17_IMAGE} AS java17
FROM ${JAVA21_IMAGE} AS java21

FROM ${NODE_IMAGE} AS sandbox-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY deploy/sandbox/launcher.c /build/launcher.c
RUN cc -O2 -Wall -Wextra -Werror -std=c11 -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now /build/launcher.c -o /build/minecraft-sandbox

FROM runtime AS minecraft
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libfontconfig1 libfreetype6 && rm -rf /var/lib/apt/lists/*
COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=java8 /opt/java/openjdk /opt/java/8
COPY --from=java17 /opt/java/openjdk /opt/java/17
COPY --from=java21 /opt/java/openjdk /opt/java/21
COPY --from=sandbox-build /build/minecraft-sandbox /usr/local/bin/minecraft-sandbox
RUN install -d -o 10001 -g 10001 -m 0700 /runtime-trust \
    && node -e 'const fs=require("node:fs"),crypto=require("node:crypto");fs.writeFileSync("/usr/local/share/minecraft-java.json",JSON.stringify(Object.fromEntries(["openjdk","8","17","21"].map(v=>{const p="/opt/java/"+v+"/bin/java";return[p,crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]}))))'
ENV JAVA_HOME=/opt/java/openjdk JAVA_PATH=/opt/java/openjdk/bin/java CONTAINER_SANDBOX=true
USER 10001:10001
EXPOSE 3001 25565
CMD ["node", "dist/server/controller-index.js"]

FROM runtime AS network-edge
EXPOSE 25565 3128 3129 443
CMD ["node", "dist/server/network-edge-index.js"]

FROM ${CADDY_IMAGE} AS caddy
RUN setcap -r /usr/bin/caddy && mkdir -p /data /config && chown -R 10001:10001 /data /config && chmod 0700 /data /config /data/caddy /config/caddy
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
USER 10001:10001
EXPOSE 8080 8443
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
