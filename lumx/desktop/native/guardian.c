#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void close_transport(void) {
  close(3); close(4); close(5);
}

static int wait_group_gone(pid_t child) {
  for (int attempt = 0; attempt < 40; attempt += 1) {
    if (kill(-child, 0) != 0 && errno == ESRCH) return 0;
    usleep(50000);
  }
  return 74;
}

static int report_exit(pid_t child, int status) {
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  int signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  kill(-child, SIGKILL);
  int gone = wait_group_gone(child);
  if (gone != 0) return gone;
  dprintf(STDOUT_FILENO, "exit:%d:%d\n", code, signal);
  return 0;
}

static int terminate_group(pid_t child) {
  int status = 0;
  if (kill(-child, SIGTERM) != 0 && errno != ESRCH) return 70;
  for (int attempt = 0; attempt < 10; attempt += 1) {
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) return report_exit(child, status);
    if (waited < 0 && errno != EINTR) return 71;
    usleep(50000);
  }
  if (kill(-child, SIGKILL) != 0 && errno != ESRCH) return 72;
  while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 73;
  return report_exit(child, status);
}

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  char start = 0;
  ssize_t received;
  do received = read(STDIN_FILENO, &start, 1); while (received < 0 && errno == EINTR);
  if (received == 0) { close_transport(); return 0; }
  if (received != 1 || start != 'S') { close_transport(); return 65; }

  pid_t child = fork();
  if (child < 0) { close_transport(); return 66; }
  if (child == 0) {
    if (setpgid(0, 0) != 0) _exit(125);
    if (dup2(3, STDIN_FILENO) < 0 || dup2(4, STDOUT_FILENO) < 0 || dup2(5, STDERR_FILENO) < 0) _exit(126);
    close_transport();
    execv(argv[1], &argv[1]);
    _exit(127);
  }
  close_transport();
  if (setpgid(child, child) != 0 && errno != EACCES) return terminate_group(child);
  dprintf(STDOUT_FILENO, "pid:%d\n", child);

  for (;;) {
    int status = 0;
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) return report_exit(child, status);
    if (waited < 0 && errno != EINTR) return 67;
    struct pollfd owner = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP | POLLERR };
    int ready;
    do ready = poll(&owner, 1, 50); while (ready < 0 && errno == EINTR);
    if (ready < 0) return terminate_group(child);
    if (ready > 0) {
      char ignored[64];
      ssize_t count = read(STDIN_FILENO, ignored, sizeof(ignored));
      if (count <= 0 || (owner.revents & (POLLHUP | POLLERR)) != 0) return terminate_group(child);
    }
  }
}
