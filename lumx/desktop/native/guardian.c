#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  char *end = NULL;
  long value = strtol(argv[1], &end, 10);
  if (end == argv[1] || *end != '\0' || value <= 1) return 65;
  char byte;
  while (read(STDIN_FILENO, &byte, 1) > 0) {}
  pid_t group = (pid_t)value;
  if (kill(-group, SIGTERM) != 0 && errno != ESRCH) return 66;
  usleep(500000);
  if (kill(-group, SIGKILL) != 0 && errno != ESRCH) return 67;
  return 0;
}
