#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *stage) {
  dprintf(STDERR_FILENO, "lumx-fd-harness:%s:%s\n", stage, strerror(errno));
  return 70;
}

int main(int argc, char **argv) {
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

  const int targets[] = { 0, 1, 2, 3, 10, 11, 512 };
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
