#!/bin/sh
set -eu
cc -O2 -Wall -Wextra -Werror -std=c11 /sandbox/launcher.c -o /tmp/workshop-sandbox
/tmp/workshop-sandbox --probe
cc -O2 -Wall -Wextra -Werror -std=c11 '-DSANDBOX_TEST_EXEC_PATH="/tmp/sandbox-probe"' /sandbox/launcher.c -o /tmp/sandbox-test
cc -O2 -Wall -Wextra -Werror -std=c11 -pthread /sandbox/smoke.c -o /tmp/sandbox-probe
/tmp/sandbox-probe /tmp/sandbox-test
/tmp/sandbox-probe /tmp/sandbox-test --tls
