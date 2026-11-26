// Test-only helper loaded by the quit e2e's app through bun:ffi. It touches only the app's own window.
// `qe_close_window_later` queues the close on the main queue, so that it runs while the app's run loop
// is pumped, as a click on the close button does; called straight from JS it would run outside the pump.
#import <AppKit/AppKit.h>

static NSWindow *app_window(void) {
  for (NSWindow *window in [NSApp windows]) {
    if ([window isVisible]) return window;
  }
  return nil;
}

int qe_visible_windows(void) {
  int count = 0;
  for (NSWindow *window in [NSApp windows]) {
    if ([window isVisible]) count++;
  }
  return count;
}

// Closes the app's visible window the way the close button does (`performClose:`: the delegate's
// windowShouldClose: runs, then the window goes). Returns 1 if there was a window to close.
int qe_close_window_later(void) {
  NSWindow *window = app_window();
  if (!window) return 0;
  dispatch_async(dispatch_get_main_queue(), ^{
    [window performClose:nil];
  });
  return 1;
}
