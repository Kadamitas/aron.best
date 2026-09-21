ARG NODE_IMAGE=node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212
FROM ${NODE_IMAGE} AS compiler
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /sandbox
COPY launcher.c smoke.c ./
RUN cc -O2 -Wall -Wextra -Werror -std=c11 launcher.c -o workshop-sandbox \
    && cc -O2 -Wall -Wextra -Werror -std=c11 '-DSANDBOX_TEST_EXEC_PATH="/sandbox/probe"' launcher.c -o test-launcher \
    && cc -O2 -Wall -Wextra -Werror -std=c11 -pthread '-DSANDBOX_PROBE_PATH="/sandbox/probe"' smoke.c -o probe

FROM aron-best-minecraft:local
COPY --from=compiler /sandbox/workshop-sandbox /sandbox/test-launcher /sandbox/probe /sandbox/
ENTRYPOINT ["/sandbox/workshop-sandbox"]
