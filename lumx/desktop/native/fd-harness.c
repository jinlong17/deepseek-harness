#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static int diagnostic_fd = STDERR_FILENO;
static const int targets[] = { 0, 1, 2, 3, 10, 11, 512 };

static int fail(const char *stage) {
  dprintf(diagnostic_fd, "lumx-fd-harness:%s:%s\n", stage, strerror(errno));
  return 70;
}

static int parse_fd(const char *value, int *result) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 0 || parsed > INT_MAX) return -1;
  *result = (int)parsed;
  return 0;
}

static int validate_canary(int canary, struct stat *metadata, char *bytes, ssize_t *count) {
  static const char prefix[] = "native-host-canary/v1:";
  if (fstat(canary, metadata) != 0) return -1;
  *count = pread(canary, bytes, 4096, 0);
  if (*count != (ssize_t)(sizeof(prefix) - 1 + 64 + 1)
      || memcmp(bytes, prefix, sizeof(prefix) - 1) != 0 || bytes[*count - 1] != '\n') { errno = EINVAL; return -1; }
  for (ssize_t index = (ssize_t)(sizeof(prefix) - 1); index < *count - 1; index += 1) {
    if (!((bytes[index] >= '0' && bytes[index] <= '9') || (bytes[index] >= 'a' && bytes[index] <= 'f'))) {
      errno = EINVAL; return -1;
    }
  }
  return 0;
}

static int legacy(int argc, char **argv) {
  if (argc != 6) { errno = EINVAL; return fail("arguments"); }
  int canary = open(argv[5], O_RDONLY);
  if (canary < 0) return fail("open-canary");
  struct stat metadata;
  char bytes[64];
  if (fstat(canary, &metadata) != 0) return fail("fstat-canary");
  ssize_t count = pread(canary, bytes, sizeof(bytes), 0);
  if (count < 0) return fail("pread-canary");
  static const char expected[] = "native-host-canary\n";
  int matched = count == (ssize_t)(sizeof(expected) - 1) && memcmp(bytes, expected, sizeof(expected) - 1) == 0;
  int receipt = open(argv[4], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (receipt < 0) return fail("open-receipt");
  dprintf(receipt, "{\"nativeVerified\":true,\"dev\":%" PRIu64 ",\"ino\":%" PRIu64 ",\"bytes\":%zd,\"contentMatched\":%s}\n",
    (uint64_t)metadata.st_dev, (uint64_t)metadata.st_ino, count, matched ? "true" : "false");
  if (close(receipt) != 0 || !matched) { errno = EIO; return fail("receipt"); }
  for (size_t index = 0; index < sizeof(targets) / sizeof(targets[0]); index += 1) {
    if (dup2(canary, targets[index]) < 0) return fail("dup-canary");
  }
  if (canary > 512 && close(canary) != 0) return fail("close-original");
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return fail("getrlimit");
  limit.rlim_cur = 64;
  if (setrlimit(RLIMIT_NOFILE, &limit) != 0) return fail("setrlimit");
  execl(argv[1], argv[1], argv[2], "--output", argv[3], "--canary", argv[5], NULL);
  return fail("exec-node");
}

static int destination_closed(int fd) {
  errno = 0;
  return fcntl(fd, F_GETFD) == -1 && errno == EBADF;
}

static int duplicate_exact(int source, int destination) {
  int value = fcntl(source, F_DUPFD, destination);
  if (value == destination) return 0;
  if (value >= 0) close(value);
  errno = EBUSY;
  return -1;
}

static int controller(int argc, char **argv) {
  static const char *tail_flags[] = {
    "--consumer", "--runtime-role", "--source-anchor-sha256", "--preparation-anchor-sha256",
    "--materials-module", "--supervisor-module", "--factory-module", "--scenario-config",
    "--scenario-config-sha256", "--ready-fd", "--ack-fd", "--ack-timeout-ms",
  };
  if (argc != 34 || strcmp(argv[1], "--b5-controller") != 0
      || strcmp(argv[2], "--receipt") != 0 || strcmp(argv[4], "--canary") != 0
      || strcmp(argv[6], "--node") != 0 || strcmp(argv[8], "--controller") != 0
      || argv[3][0] != '/' || argv[5][0] != '/' || argv[7][0] != '/' || argv[9][0] != '/') {
    errno = EINVAL; return fail("controller-arguments");
  }
  for (size_t index = 0; index < sizeof(tail_flags) / sizeof(tail_flags[0]); index += 1) {
    if (strcmp(argv[10 + index * 2], tail_flags[index]) != 0) { errno = EINVAL; return fail("controller-order"); }
  }
  int ready_source;
  int ack_source;
  if (parse_fd(argv[29], &ready_source) != 0 || parse_fd(argv[31], &ack_source) != 0) return fail("controller-fds");
  const int diagnostic_source = STDERR_FILENO;
  if (ready_source == ack_source || ready_source == diagnostic_source || ack_source == diagnostic_source) {
    errno = EINVAL; return fail("controller-source-collision");
  }
  const int sources[] = { ready_source, ack_source, diagnostic_source };
  for (size_t index = 0; index < sizeof(sources) / sizeof(sources[0]); index += 1) {
    if ((sources[index] >= 20 && sources[index] <= 23) || fcntl(sources[index], F_GETFD) < 0) {
      errno = EINVAL; return fail("controller-source-invalid");
    }
  }
  for (int fd = 20; fd <= 23; fd += 1) {
    if (!destination_closed(fd)) { errno = EBUSY; return fail("controller-destination-occupied"); }
  }
  if (duplicate_exact(ready_source, 20) != 0 || duplicate_exact(ack_source, 21) != 0
      || duplicate_exact(diagnostic_source, 22) != 0) return fail("controller-duplicate");
  diagnostic_fd = 22;
  for (size_t index = 0; index < sizeof(sources) / sizeof(sources[0]); index += 1) {
    if (close(sources[index]) != 0) return fail("controller-close-source");
  }
  int receipt = open(argv[3], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (receipt < 0) return fail("controller-open-receipt");
  if (receipt != 23) {
    int moved = fcntl(receipt, F_DUPFD, 23);
    int saved = errno;
    close(receipt);
    errno = saved;
    if (moved != 23) { if (moved >= 0) close(moved); errno = EBUSY; return fail("controller-receipt-fd"); }
    receipt = moved;
  }
  int canary = open(argv[5], O_RDONLY);
  if (canary < 0) return fail("controller-open-canary");
  struct stat metadata;
  char bytes[4096];
  ssize_t count;
  if (validate_canary(canary, &metadata, bytes, &count) != 0) return fail("controller-canary");
  for (size_t index = 0; index < sizeof(targets) / sizeof(targets[0]); index += 1) {
    if (dup2(canary, targets[index]) < 0) return fail("controller-poison");
  }
  int canary_is_target = 0;
  for (size_t index = 0; index < sizeof(targets) / sizeof(targets[0]); index += 1) {
    if (canary == targets[index]) canary_is_target = 1;
  }
  if (!canary_is_target && close(canary) != 0) return fail("controller-close-canary");
  struct rlimit before;
  if (getrlimit(RLIMIT_NOFILE, &before) != 0) return fail("controller-getrlimit");
  struct rlimit after = before;
  after.rlim_cur = 64;
  if (setrlimit(RLIMIT_NOFILE, &after) != 0) return fail("controller-setrlimit");
  if (dprintf(receipt,
      "{\"schema\":\"g9-b5-fd-controller-preexec/v1\",\"pid\":%d,\"targets\":[0,1,2,3,10,11,512],\"controlFds\":{\"ready\":20,\"ack\":21,\"diagnostic\":22},\"transientReceiptFd\":23,\"canary\":{\"dev\":%" PRIu64 ",\"ino\":%" PRIu64 ",\"bytes\":%zd},\"canaryFormatMatched\":true,\"softRlimitBefore\":\"%" PRIu64 "\",\"softRlimitAfter\":64}\n",
      getpid(), (uint64_t)metadata.st_dev, (uint64_t)metadata.st_ino, count, (uint64_t)before.rlim_cur) < 0
      || fsync(receipt) != 0 || close(receipt) != 0) return fail("controller-receipt");
  char **child = calloc((size_t)argc, sizeof(char *));
  if (child == NULL) return fail("controller-argv-allocation");
  size_t output = 0;
  child[output++] = argv[7];
  child[output++] = argv[9];
  for (int index = 10; index < argc; index += 2) {
    child[output++] = argv[index];
    if (strcmp(argv[index], "--ready-fd") == 0) child[output++] = "20";
    else if (strcmp(argv[index], "--ack-fd") == 0) child[output++] = "21";
    else child[output++] = argv[index + 1];
  }
  child[output++] = "--diagnostic-fd";
  child[output++] = "22";
  child[output] = NULL;
  execv(argv[7], child);
  return fail("controller-exec-node");
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--b5-controller") == 0) return controller(argc, argv);
  return legacy(argc, argv);
}
