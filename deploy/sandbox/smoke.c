#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/ipc.h>
#include <sys/ioctl.h>
#include <sys/msg.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>

#ifndef SANDBOX_PROBE_PATH
#define SANDBOX_PROBE_PATH "/tmp/sandbox-probe"
#endif

static int checks;
static char root[PATH_MAX];

static void check(int condition, const char *label) {
  if (!condition) { fprintf(stderr, "FAIL: %s (errno %d: %s)\n", label, errno, strerror(errno)); exit(1); }
  checks++;
}

static char *file(const char *relative) {
  static char paths[16][PATH_MAX];
  static unsigned int index;
  char *result = paths[index++ % 16];
  check(snprintf(result, PATH_MAX, "%s/%s", root, relative) < PATH_MAX, "bounded fixture path");
  return result;
}

static void create_file(const char *relative) {
  int fd = open(file(relative), O_CREAT | O_EXCL | O_WRONLY, 0600);
  check(fd >= 0, "create fixture file");
  check(write(fd, "trusted", 7) == 7, "write fixture file");
  close(fd);
}

static int listener(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  check(fd >= 0, "create fixture TCP listener");
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  check(bind(fd, (struct sockaddr *)&address, sizeof(address)) == 0, "bind fixture TCP listener");
  check(listen(fd, 8) == 0, "listen for fixture TCP connections");
  return fd;
}

static void connection(int port, int allowed) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  check(fd >= 0, "TCP sockets remain available");
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  check(allowed ? result == 0 : result == -1 && (errno == EACCES || errno == EPERM), allowed ? "auth proxy connection allowed" : "other TCP ports denied");
  close(fd);
}

static void *thread(void *value) { *(int *)value = 1; return NULL; }

static int inside(const char *parent_text, int tls) {
  pid_t parent = strtol(parent_text, NULL, 10);
  int fd = open(file("selected/runtime.jar"), O_RDONLY);
  check(fd >= 0, "selected sealed runtime readable");
  unsigned long flags = FS_IMMUTABLE_FL;
  check(ioctl(fd, FS_IOC_SETFLAGS, &flags) == -1 && errno == EPERM, "sealed runtime inode flags cannot change");
  struct fsxattr attributes = { .fsx_xflags = FS_XFLAG_IMMUTABLE };
  check(ioctl(fd, FS_IOC_FSSETXATTR, &attributes) == -1 && errno == EPERM, "sealed runtime filesystem attributes cannot change");
  check(fcntl(fd, F_SETLEASE, F_RDLCK) == -1 && errno == EPERM, "sealed runtime leases denied");
  close(fd);
  check(open(file("credentials"), O_RDONLY) == -1 && errno == EACCES, "controller credentials unreadable");
  check(open(file("sibling/installation.json"), O_RDONLY) == -1 && errno == EACCES, "other slots unreadable");
  check(open(file("selected/runtime.jar"), O_WRONLY | O_TRUNC) == -1 && errno == EACCES, "sealed runtime cannot be overwritten");
  check(unlink(file("selected/runtime.jar")) == -1 && errno == EACCES, "sealed runtime cannot be removed");
  check(chmod(file("sibling/installation.json"), 0000) == -1 && (errno == EPERM || errno == ENOSYS), "other slot permissions cannot change");
  check(utimensat(AT_FDCWD, file("sibling/installation.json"), NULL, 0) == -1 && errno == EPERM, "other slot timestamps cannot change");
  check(setxattr(file("sibling/installation.json"), "user.test", "x", 1, 0) == -1 && errno == EPERM, "other slot attributes cannot change");
  check(rename(file("selected/runtime.jar"), file("selected/world/stolen.jar")) == -1, "sealed runtime cannot move into writable subtree");
  check(link(file("selected/runtime.jar"), file("selected/world/alias.jar")) == -1, "sealed runtime cannot be hard-linked into writable subtree");
  fd = open(file("selected/world/level.dat.tmp"), O_CREAT | O_EXCL | O_WRONLY, 0600);
  check(fd >= 0, "world files may be created");
  check(write(fd, "world", 5) == 5, "world file writes permitted");
  close(fd);
  check(rename(file("selected/world/level.dat.tmp"), file("selected/world/level.dat")) == 0, "world atomic replace permitted");
  check(symlink(file("credentials"), file("selected/world/escape")) == 0, "create adversarial symlink");
  check(open(file("selected/world/escape"), O_RDONLY) == -1 && errno == EACCES, "symlink cannot expose controller credentials");
  fd = open(file("private/tmp-file"), O_CREAT | O_EXCL | O_WRONLY, 0600);
  check(fd >= 0, "private per-run temporary files permitted");
  close(fd);
  check(open("/tmp/unshared-file", O_CREAT | O_WRONLY, 0600) == -1 && errno == EACCES, "shared temporary directory remains denied");
  char proc[128];
  snprintf(proc, sizeof(proc), "/proc/%ld/environ", (long)parent);
  check(open(proc, O_RDONLY) == -1 && (errno == EACCES || errno == EPERM), "controller process environment unreadable");
  char contents;
  check(read(100, &contents, 1) == -1 && errno == EBADF, "inherited sensitive descriptors closed");
  check(kill(parent, 0) == -1 && errno == EPERM, "controller cannot be signaled");
  check(kill(getpid(), 0) == 0, "self signaling remains possible");
  check(ptrace(PTRACE_TRACEME, 0, 0, 0) == -1 && errno == EPERM, "ptrace denied");
  check(syscall(SYS_process_vm_readv, parent, NULL, 0, NULL, 0, 0) == -1 && errno == EPERM, "cross-process memory reads denied");
  check(syscall(SYS_pidfd_getfd, -1, 100, 0) == -1 && errno == EPERM, "pidfd descriptor theft denied");
  struct rlimit limit;
  check(prlimit(0, RLIMIT_NOFILE, NULL, &limit) == 0, "self resource limits remain readable");
  check(prlimit(getpid(), RLIMIT_NOFILE, NULL, &limit) == 0, "explicit self resource limits remain readable");
  limit.rlim_cur = 0;
  check(prlimit(parent, RLIMIT_NOFILE, &limit, NULL) == -1 && errno == EPERM, "controller resource limits cannot change");
  check(setpriority(PRIO_PROCESS, parent, 19) == -1 && errno == EPERM, "controller priority cannot change");
  check(setpriority(PRIO_PGRP, 0, 19) == -1 && errno == EPERM, "process group priority cannot change");
  cpu_set_t affinity;
  CPU_ZERO(&affinity);
  CPU_SET(0, &affinity);
  check(sched_setaffinity(parent, sizeof(affinity), &affinity) == -1 && errno == EPERM, "controller CPU affinity cannot change");
  struct sched_param scheduling = { .sched_priority = 0 };
  check(sched_setscheduler(parent, SCHED_IDLE, &scheduling) == -1 && errno == EPERM, "controller scheduler cannot change");
  check(sched_setparam(parent, &scheduling) == -1 && errno == EPERM, "controller scheduler parameters cannot change");
  check(syscall(SYS_sched_setattr, parent, NULL, 0) == -1 && errno == EPERM, "controller extended scheduler attributes cannot change");
  check(syscall(SYS_ioprio_set, 1, parent, 3 << 13) == -1 && errno == EPERM, "controller IO priority cannot change");
  check(syscall(SYS_ioprio_set, 2, 0, 3 << 13) == -1 && errno == EPERM, "process group IO priority cannot change");
  check(msgget(IPC_PRIVATE, IPC_CREAT | 0600) == -1 && errno == EPERM, "System V IPC denied");
  pid_t child = fork();
  if (child == 0) _exit(2);
  check(child == -1 && errno == EPERM, "fork denied");
  pthread_t worker;
  int threaded = 0;
  check(pthread_create(&worker, NULL, thread, &threaded) == 0, "JVM-style threads permitted");
  check(pthread_join(worker, NULL) == 0 && threaded == 1, "thread joins succeed");
  check(socket(AF_INET, SOCK_DGRAM, 0) == -1 && errno == EPERM, "IPv4 UDP denied");
  check(socket(AF_INET6, SOCK_DGRAM, 0) == -1 && errno == EPERM, "IPv6 UDP denied");
  check(socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) == -1 && errno == EPERM, "raw sockets denied");
  check(socket(AF_INET, SOCK_STREAM, 262) == -1 && errno == EPERM, "MPTCP sockets denied");
  check(socket(AF_NETLINK, SOCK_RAW, 0) == -1 && errno == EPERM, "netlink denied");
  check(socket(AF_UNIX, SOCK_STREAM, 0) == -1 && errno == EPERM, "pathname and abstract UNIX sockets denied");
  int pair[2];
  check(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == -1 && errno == EPERM, "UNIX datagram pairs denied");
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0, "anonymous UNIX stream pair permitted");
  int nonblocking = 1;
  check(ioctl(pair[0], FIONBIO, &nonblocking) == 0, "socket nonblocking ioctl permitted");
  check(fcntl(pair[0], F_SETOWN, parent) == -1 && errno == EPERM, "asynchronous signals cannot target controller");
  struct f_owner_ex owner = { .type = F_OWNER_PID, .pid = parent };
  check(fcntl(pair[0], F_SETOWN_EX, &owner) == -1 && errno == EPERM, "extended asynchronous owner changes denied");
  check(fcntl(pair[0], F_SETSIG, SIGTERM) == -1 && errno == EPERM, "asynchronous signal selection denied");
  check(fcntl(pair[0], F_GETFL) >= 0, "normal descriptor flags remain readable");
  struct sockaddr_un unix_address = { .sun_family = AF_UNIX };
  check(strlen(file("controller.sock")) < sizeof(unix_address.sun_path), "bounded UNIX socket path");
  strcpy(unix_address.sun_path, file("controller.sock"));
  check(connect(pair[0], (struct sockaddr *)&unix_address, sizeof(unix_address)) == -1, "socketpair cannot reconnect to controller socket");
  close(pair[0]); close(pair[1]);
  fd = socket(AF_INET, SOCK_STREAM, 0);
  check(fd >= 0, "create Fast Open probe socket");
  struct sockaddr_in controller = { .sin_family = AF_INET, .sin_port = htons(3001), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  char payload = 'x';
  check(sendto(fd, &payload, 1, MSG_FASTOPEN | MSG_DONTWAIT, (struct sockaddr *)&controller, sizeof(controller)) == -1 && errno == EPERM, "sendto cannot bypass Landlock with TCP Fast Open");
  struct iovec data = { .iov_base = &payload, .iov_len = 1 };
  struct msghdr message = { .msg_name = &controller, .msg_namelen = sizeof(controller), .msg_iov = &data, .msg_iovlen = 1 };
  check(sendmsg(fd, &message, MSG_FASTOPEN | MSG_DONTWAIT) == -1 && errno == EPERM, "sendmsg cannot bypass Landlock with TCP Fast Open");
  struct mmsghdr batch = { .msg_hdr = message };
  check(sendmmsg(fd, &batch, 1, MSG_FASTOPEN | MSG_DONTWAIT) == -1 && errno == EPERM, "sendmmsg cannot bypass Landlock with TCP Fast Open");
  close(fd);
  connection(3129, 1);
  connection(443, tls);
  connection(3128, 0);
  connection(3001, 0);
  fd = listener(25566);
  close(fd);
  fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in forbidden = { .sin_family = AF_INET, .sin_port = htons(25565), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  check(bind(fd, (struct sockaddr *)&forbidden, sizeof(forbidden)) == -1 && errno == EACCES, "other listener ports denied");
  close(fd);
  char *arguments[] = { "/bin/sh", "-c", "exit 97", NULL };
  check(execv(arguments[0], arguments) == -1 && errno == EACCES, "shell execution denied");
  printf("Sandbox adversarial payload passed %d checks\n", checks);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "--inside")) {
    check(strlen(argv[2]) < sizeof(root), "bounded fixture root");
    strcpy(root, argv[2]);
    return inside(argv[3], !strcmp(argv[4], "tls"));
  }
  check(argc == 2 || (argc == 3 && !strcmp(argv[2], "--tls")), "provide test launcher path and optional TLS grant");
  int tls = argc == 3;
  strcpy(root, "/tmp/workshop-sandbox-smoke-XXXXXX");
  check(mkdtemp(root) != NULL, "create isolated fixture root");
  check(mkdir(file("selected"), 0700) == 0, "create selected slot");
  check(mkdir(file("selected/world"), 0700) == 0, "create world root");
  check(mkdir(file("sibling"), 0700) == 0, "create sibling slot");
  check(mkdir(file("private"), 0700) == 0, "create private temporary root");
  create_file("credentials"); create_file("selected/runtime.jar"); create_file("sibling/installation.json");
  listener(3129); listener(443); listener(3128); listener(3001);
  int control = socket(AF_UNIX, SOCK_STREAM, 0);
  check(control >= 0, "create parent UNIX socket");
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  check(strlen(file("controller.sock")) < sizeof(address.sun_path), "bounded parent UNIX socket path");
  strcpy(address.sun_path, file("controller.sock"));
  check(bind(control, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(control, 8) == 0, "listen on parent UNIX socket");
  int secret = open(file("credentials"), O_RDONLY);
  check(secret >= 0 && dup2(secret, 100) == 100, "pass intentional sensitive descriptor");
  struct rlimit initial_limit;
  check(getrlimit(RLIMIT_NOFILE, &initial_limit) == 0, "capture parent resource limits");
  int initial_priority = getpriority(PRIO_PROCESS, 0);
  pid_t child = fork();
  check(child >= 0, "launch fixture child");
  if (child == 0) {
    char parent[32];
    snprintf(parent, sizeof(parent), "%ld", (long)getppid());
    execl(argv[1], argv[1], "--read", file("selected"), "--write", file("selected/world"), "--write", file("private"), "--connect", "3129", "--connect", tls ? "443" : "3129", "--bind", "25566", "--", SANDBOX_PROBE_PATH, "--inside", root, parent, tls ? "tls" : "no-tls", NULL);
    perror("launch sandbox");
    _exit(1);
  }
  int result;
  check(waitpid(child, &result, 0) == child, "wait for sandbox child");
  check(WIFEXITED(result) && WEXITSTATUS(result) == 0, "sandbox payload succeeds");
  struct stat metadata;
  check(stat(file("sibling/installation.json"), &metadata) == 0 && (metadata.st_mode & 0777) == 0600, "sibling permissions preserved");
  struct rlimit final_limit;
  check(getrlimit(RLIMIT_NOFILE, &final_limit) == 0 && final_limit.rlim_cur == initial_limit.rlim_cur && final_limit.rlim_max == initial_limit.rlim_max, "parent resource limits preserved");
  check(getpriority(PRIO_PROCESS, 0) == initial_priority, "parent process priority preserved");
  puts("Sandbox parent credentials, metadata, listeners and process remain protected");
  return 0;
}
