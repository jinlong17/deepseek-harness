#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static int fail(const char *stage, int code) {
  dprintf(STDERR_FILENO, "lumx-bootstrap:%s:%s\n", stage, strerror(code));
  return 70;
}

static int read_bootstrap_frame(void) {
  static const char expected[] = "LUMX_BOOTSTRAP_V1\n";
  char actual[sizeof(expected) - 1];
  size_t offset = 0;
  while (offset < sizeof(actual)) {
    ssize_t count = read(STDIN_FILENO, actual + offset, sizeof(actual) - offset);
    if (count == 0) return EPIPE;
    if (count < 0) {
      if (errno == EINTR) continue;
      return errno;
    }
    offset += (size_t)count;
  }
  return memcmp(actual, expected, sizeof(actual)) == 0 ? 0 : EPROTO;
}

int main(int argc, char **argv) {
  if (argc != 6) return fail("arguments", EINVAL);
  for (int index = 1; index < argc; index += 1) {
    if (argv[index][0] != '/') return fail("absolute-path", EINVAL);
  }
  int error = read_bootstrap_frame();
  if (error != 0) return fail("control-frame", error);

  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  if ((error = posix_spawn_file_actions_init(&actions)) != 0) return fail("file-actions-init", error);
  if ((error = posix_spawnattr_init(&attributes)) != 0) return fail("attributes-init", error);
  for (int index = 0; index < 3; index += 1) {
    if ((error = posix_spawn_file_actions_addinherit_np(&actions, index)) != 0) return fail("stdio-inherit", error);
  }
  short flags = POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT;
  if ((error = posix_spawnattr_setflags(&attributes, flags)) != 0) return fail("attributes-flags", error);

  char *child[] = { argv[1], "-f", argv[2], argv[3], argv[4], argv[5], NULL };
  error = posix_spawn(NULL, argv[1], &actions, &attributes, child, environ);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  return fail("exec", error);
}
