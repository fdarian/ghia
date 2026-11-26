// Asks another process to quit the way the Dock's Quit, logout and restart do: `-[NSRunningApplication
// terminate]` sends it the quit Apple Event (kAEQuitApplication) from this process, off the app's own
// threads. Prints the wall-clock time in milliseconds, taken just before the request, on stdout.
#import <AppKit/AppKit.h>
#include <sys/time.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "usage: quit_killer <pid>\n");
      return 2;
    }
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:atoi(argv[1])];
    if (!app) {
      fprintf(stderr, "quit_killer: no running application for pid %s\n", argv[1]);
      return 2;
    }
    struct timeval now;
    gettimeofday(&now, NULL);
    printf("%.3f\n", now.tv_sec * 1000.0 + now.tv_usec / 1000.0);
    fflush(stdout);
    if (![app terminate]) {
      fprintf(stderr, "quit_killer: terminate returned NO\n");
      return 2;
    }
  }
  return 0;
}
