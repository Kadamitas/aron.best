#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/openat2.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <linux/sockios.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#define SYS_landlock_add_rule 445
#define SYS_landlock_restrict_self 446
#endif

#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)
#define FS_TRUNCATE (1ULL << 14)
#define FS_ALL ((1ULL << 16) - 1)
#define NET_BIND_TCP (1ULL << 0)
#define NET_CONNECT_TCP (1ULL << 1)
#define SCOPED_ALL 3ULL
#define DENY (SECCOMP_RET_ERRNO | EPERM)

struct sandbox_ruleset { uint64_t filesystem; uint64_t network; uint64_t scoped; };
struct sandbox_path { uint64_t access; int32_t parent_fd; } __attribute__((packed));
struct sandbox_port { uint64_t access; uint64_t port; };
struct grant { const char *path; int writable; };

static void fail(const char *operation) {
  fprintf(stderr, "Sandbox refused to start: %s: %s\n", operation, strerror(errno));
  exit(125);
}

static void invalid(const char *message) {
  fprintf(stderr, "Sandbox refused to start: %s\n", message);
  exit(125);
}

static int ruleset(void) {
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, 1);
  if (abi < 0) fail("Landlock is unavailable");
  if (abi < 6) invalid("Landlock ABI 6 or newer is required");
  struct sandbox_ruleset attributes = { .filesystem = FS_ALL, .network = NET_BIND_TCP | NET_CONNECT_TCP, .scoped = SCOPED_ALL };
  int fd = syscall(SYS_landlock_create_ruleset, &attributes, sizeof(attributes), 0);
  if (fd < 0) fail("create mandatory Landlock policy");
  return fd;
}

static void grant_path(int rules, const char *name, int writable, int executable, int optional) {
  if (name[0] != '/') invalid("all filesystem grants must be absolute");
  struct open_how how = { .flags = O_PATH | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
  int fd = syscall(SYS_openat2, AT_FDCWD, name, &how, sizeof(how));
  if (fd < 0) { if (optional && errno == ENOENT) return; fail(name); }
  struct stat info;
  if (fstat(fd, &info)) fail("inspect granted path");
  uint64_t allowed = FS_READ_FILE;
  if (S_ISDIR(info.st_mode)) allowed |= FS_READ_DIR;
  if (executable) allowed |= FS_EXECUTE;
  if (writable) {
    allowed |= FS_WRITE_FILE;
    if (S_ISREG(info.st_mode) || S_ISDIR(info.st_mode)) allowed |= FS_TRUNCATE;
    if (S_ISDIR(info.st_mode)) allowed |= FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SYM | FS_REFER;
  }
  struct sandbox_path attributes = { .access = allowed, .parent_fd = fd };
  if (syscall(SYS_landlock_add_rule, rules, 1, &attributes, 0)) fail("add filesystem restriction");
  close(fd);
}

static void grant_system_path(int rules, const char *path, int writable, int executable) {
  char resolved[PATH_MAX];
  if (!realpath(path, resolved)) { if (errno == ENOENT) return; fail(path); }
  grant_path(rules, resolved, writable, executable, 0);
}

static void grant_port(int rules, uint64_t access, uint16_t port) {
  struct sandbox_port attributes = { .access = access, .port = port };
  if (syscall(SYS_landlock_add_rule, rules, 2, &attributes, 0)) fail("add TCP restriction");
}

static void seccomp_policy(void) {
  struct sock_filter code[512];
  size_t count = 0;
#define STATEMENT(operation, value) do { if (count == sizeof(code) / sizeof(*code)) invalid("seccomp policy is too large"); code[count++] = (struct sock_filter)BPF_STMT(operation, value); } while (0)
#define JUMP(operation, value, yes, no) do { if (count == sizeof(code) / sizeof(*code)) invalid("seccomp policy is too large"); code[count++] = (struct sock_filter)BPF_JUMP(operation, value, yes, no); } while (0)
#define BLOCK(number) do { JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1); STATEMENT(BPF_RET | BPF_K, DENY); } while (0)
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
#if defined(__aarch64__)
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0);
#elif defined(__x86_64__)
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
#else
#error Unsupported sandbox architecture
#endif
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#if defined(__x86_64__)
  JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
#endif
  JUMP(BPF_JMP | BPF_JGE | BPF_K, 451, 0, 1);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
  BLOCK(SYS_ptrace);
  BLOCK(SYS_process_vm_readv);
  BLOCK(SYS_process_vm_writev);
  BLOCK(SYS_pidfd_getfd);
  BLOCK(SYS_pidfd_open);
  BLOCK(SYS_execveat);
  BLOCK(SYS_unshare);
  BLOCK(SYS_setns);
  BLOCK(SYS_mount);
  BLOCK(SYS_umount2);
  BLOCK(SYS_pivot_root);
  BLOCK(SYS_chroot);
  BLOCK(SYS_bpf);
  BLOCK(SYS_perf_event_open);
  BLOCK(SYS_io_uring_setup);
  BLOCK(SYS_io_uring_enter);
  BLOCK(SYS_io_uring_register);
  BLOCK(SYS_open_by_handle_at);
  BLOCK(SYS_memfd_create);
#ifdef SYS_memfd_secret
  BLOCK(SYS_memfd_secret);
#endif
  BLOCK(SYS_kcmp);
  BLOCK(SYS_process_madvise);
  BLOCK(SYS_process_mrelease);
  BLOCK(SYS_fanotify_init);
  BLOCK(SYS_add_key);
  BLOCK(SYS_request_key);
  BLOCK(SYS_keyctl);
  BLOCK(SYS_shmget);
  BLOCK(SYS_shmat);
  BLOCK(SYS_shmdt);
  BLOCK(SYS_shmctl);
  BLOCK(SYS_msgget);
  BLOCK(SYS_msgsnd);
  BLOCK(SYS_msgrcv);
  BLOCK(SYS_msgctl);
  BLOCK(SYS_semget);
  BLOCK(SYS_semop);
  BLOCK(SYS_semtimedop);
  BLOCK(SYS_semctl);
  BLOCK(SYS_fchmod);
  BLOCK(SYS_fchmodat);
  BLOCK(SYS_fchown);
  BLOCK(SYS_fchownat);
  BLOCK(SYS_utimensat);
  BLOCK(SYS_setxattr);
  BLOCK(SYS_lsetxattr);
  BLOCK(SYS_fsetxattr);
  BLOCK(SYS_removexattr);
  BLOCK(SYS_lremovexattr);
  BLOCK(SYS_fremovexattr);
#ifdef SYS_chmod
  BLOCK(SYS_chmod);
#endif
#ifdef SYS_chown
  BLOCK(SYS_chown);
#endif
#ifdef SYS_lchown
  BLOCK(SYS_lchown);
#endif
#ifdef SYS_utime
  BLOCK(SYS_utime);
#endif
#ifdef SYS_utimes
  BLOCK(SYS_utimes);
#endif
#ifdef SYS_futimesat
  BLOCK(SYS_futimesat);
#endif
#ifdef SYS_fork
  BLOCK(SYS_fork);
#endif
#ifdef SYS_vfork
  BLOCK(SYS_vfork);
#endif
  uint32_t self = getpid();
  const struct { uint32_t number; unsigned int argument; int selector; } process_calls[] = {
    { SYS_prlimit64, 0, -1 },
    { SYS_sched_setaffinity, 0, -1 },
    { SYS_sched_setscheduler, 0, -1 },
    { SYS_sched_setparam, 0, -1 },
    { SYS_sched_setattr, 0, -1 },
    { SYS_setpriority, 1, PRIO_PROCESS },
    { SYS_ioprio_set, 1, 1 }
  };
  for (size_t index = 0; index < sizeof(process_calls) / sizeof(*process_calls); index++) {
    size_t start = count;
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, process_calls[index].number, 0, 0);
    if (process_calls[index].selector >= 0) {
      STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
      JUMP(BPF_JMP | BPF_JEQ | BPF_K, process_calls[index].selector, 1, 0);
      STATEMENT(BPF_RET | BPF_K, DENY);
    }
    STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + sizeof(uint64_t) * process_calls[index].argument);
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0);
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, self, 1, 0);
    STATEMENT(BPF_RET | BPF_K, DENY);
    STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
    code[start].jf = count - start - 1;
  }
  size_t fcntl_call = count;
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fcntl, 0, 0);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]));
  const uint32_t fcntl_commands[] = { F_SETOWN, F_SETOWN_EX, F_SETSIG, F_SETLEASE, F_NOTIFY };
  for (size_t index = 0; index < sizeof(fcntl_commands) / sizeof(*fcntl_commands); index++) BLOCK(fcntl_commands[index]);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  code[fcntl_call].jf = count - fcntl_call - 1;
  const struct { uint32_t number; unsigned int argument; } send_calls[] = {
    { SYS_sendto, 3 }, { SYS_sendmsg, 2 }, { SYS_sendmmsg, 3 }
  };
  for (size_t index = 0; index < sizeof(send_calls) / sizeof(*send_calls); index++) {
    size_t start = count;
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, send_calls[index].number, 0, 0);
    STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + sizeof(uint64_t) * send_calls[index].argument);
    JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 0, 1);
    STATEMENT(BPF_RET | BPF_K, DENY);
    STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
    code[start].jf = count - start - 1;
  }
  size_t ioctl_call = count;
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 0);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]));
  const uint32_t ioctl_commands[] = { FIONREAD, FIONBIO, FIOCLEX, FIONCLEX, TCGETS, TIOCGWINSZ, TIOCGETD, SIOCGIFCONF, SIOCGIFFLAGS, SIOCGIFADDR, SIOCGIFNETMASK, SIOCGIFHWADDR, SIOCGIFINDEX };
  for (size_t index = 0; index < sizeof(ioctl_commands) / sizeof(*ioctl_commands); index++) {
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, ioctl_commands[index], 0, 1);
    STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  }
  STATEMENT(BPF_RET | BPF_K, DENY);
  code[ioctl_call].jf = count - ioctl_call - 1;
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
  size_t clone = count;
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 0);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + sizeof(uint32_t));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  JUMP(BPF_JMP | BPF_JSET | BPF_K, ~(CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID), 0, 1);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  code[clone].jf = count - clone - 1;
  size_t socket = count;
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 0);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0);
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]));
  STATEMENT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0);
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, 6, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  code[socket].jf = count - socket - 1;
  size_t pair = count;
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 0);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]));
  STATEMENT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  STATEMENT(BPF_RET | BPF_K, DENY);
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  code[pair].jf = count - pair - 1;
  STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog program = { .len = count, .filter = code };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail("install seccomp restrictions");
}

static int approved_java(const char *path) {
  const char *paths[] = { "/opt/java/openjdk/bin/java", "/opt/java/8/bin/java", "/opt/java/17/bin/java", "/opt/java/21/bin/java" };
  for (size_t index = 0; index < sizeof(paths) / sizeof(*paths); index++) if (!strcmp(path, paths[index])) return 1;
#ifdef SANDBOX_TEST_EXEC_PATH
  if (!strcmp(path, SANDBOX_TEST_EXEC_PATH)) return 1;
#endif
  return 0;
}

int main(int argc, char **argv) {
  int rules = ruleset();
  int probe = argc == 2 && !strcmp(argv[1], "--probe");
  struct grant grants[128];
  size_t grant_count = 0;
  int command = 0;
  int connect_granted = 0;
  int tls_granted = 0;
  int bind_granted = 0;
  if (!probe) {
    for (int index = 1; index < argc; index++) {
      if (!strcmp(argv[index], "--")) { command = index + 1; break; }
      if (index + 1 >= argc) invalid("missing option value");
      if (!strcmp(argv[index], "--read") || !strcmp(argv[index], "--write")) {
        if (grant_count == 128) invalid("too many filesystem grants");
        grants[grant_count++] = (struct grant){ .path = argv[index + 1], .writable = !strcmp(argv[index], "--write") };
      } else if (!strcmp(argv[index], "--connect") && !strcmp(argv[index + 1], "3129")) connect_granted = 1;
      else if (!strcmp(argv[index], "--connect") && !strcmp(argv[index + 1], "443")) tls_granted = 1;
      else if (!strcmp(argv[index], "--bind") && !strcmp(argv[index + 1], "25566")) bind_granted = 1;
      else invalid("unsupported sandbox option");
      index++;
    }
    if (!command || command >= argc || !approved_java(argv[command])) invalid("only the approved Java runtimes may execute");
    if (geteuid() == 0) invalid("the Minecraft runtime must not run as root");
    const char *system_paths[] = { "/opt/java", "/usr/lib", "/lib", "/etc/ssl", "/etc/fonts", "/usr/share/fonts", "/etc/localtime", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/ld.so.cache", "/dev/urandom", "/dev/random" };
    for (size_t index = 0; index < sizeof(system_paths) / sizeof(*system_paths); index++) grant_system_path(rules, system_paths[index], 0, 0);
    grant_system_path(rules, "/dev/null", 1, 0);
    grant_system_path(rules, "/lib/ld-linux-aarch64.so.1", 0, 1);
    grant_system_path(rules, "/lib64/ld-linux-x86-64.so.2", 0, 1);
    for (size_t index = 0; index < grant_count; index++) grant_path(rules, grants[index].path, grants[index].writable, 0, 0);
    grant_path(rules, argv[command], 0, 1, 0);
    if (connect_granted) grant_port(rules, NET_CONNECT_TCP, 3129);
    if (tls_granted) grant_port(rules, NET_CONNECT_TCP, 443);
    if (bind_granted) grant_port(rules, NET_BIND_TCP, 25566);
  }
  struct rlimit core = { 0, 0 };
  if (setrlimit(RLIMIT_CORE, &core)) fail("disable core dumps");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("require no-new-privileges");
  if (syscall(SYS_landlock_restrict_self, rules, 0)) fail("apply mandatory Landlock policy");
  close(rules);
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0)) fail("close inherited descriptors");
  seccomp_policy();
  if (probe) { puts("Landlock ABI >= 6 and mandatory seccomp policy enforced"); return 0; }
  execv(argv[command], &argv[command]);
  fail("execute isolated Java");
}
