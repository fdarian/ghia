//! Wakes JS for the work WebKit queues on the main run loop.
//!
//! JS drives GPUI by ticking the renderer, which pumps the main run loop; an idle window is not
//! ticked until the run loop's ports signal (`gpui_macos::run_loop_wake`). WebKit answers the UI
//! process with `CFRunLoopWakeUp`, which CoreFoundation drops while the run loop is not running,
//! so with nothing else going on a page's navigation events and the results of
//! `executeJavaScript` would wait for the next input or frame.
//!
//! While a page exists, `gpui_macos::main_run_loop_wakeups::enable` makes that wake send its
//! message, which the watch sees. It reads private memory of CoreFoundation and refuses on a
//! machine it cannot vouch for; then this falls back to a repeating run loop timer, which does
//! wake the watch: quick for a moment after anything that asks a page for work (a load, a
//! script, a key or a click) and slow otherwise, which catches what a page does by itself.
use std::{cell::RefCell, ffi::c_void, ptr, sync::Once, time::Instant};

use gpui_macos::main_run_loop_wakeups;

/// How long after the last request the timer stays quick, and how quick.
const BUSY_FOR_MS: u64 = 1500;
const BUSY_PERIOD_S: f64 = 0.016;
/// The period a page that nobody asks anything of is looked at.
const IDLE_PERIOD_S: f64 = 0.25;

#[repr(C)]
struct TimerContext {
    version: isize,
    info: *mut c_void,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    fn CFRunLoopGetMain() -> *mut c_void;
    fn CFAbsoluteTimeGetCurrent() -> f64;
    fn CFRunLoopTimerCreate(
        allocator: *const c_void,
        fire_date: f64,
        interval: f64,
        flags: usize,
        order: isize,
        callout: extern "C" fn(*mut c_void, *mut c_void),
        context: *mut TimerContext,
    ) -> *mut c_void;
    fn CFRunLoopAddTimer(run_loop: *mut c_void, timer: *mut c_void, mode: *const c_void);
    fn CFRunLoopTimerSetNextFireDate(timer: *mut c_void, fire_date: f64);
    fn CFRunLoopTimerInvalidate(timer: *mut c_void);
    fn CFRelease(object: *const c_void);
}

struct Pulse {
    pages: usize,
    /// The timer of the fallback, null while the wakes come from the run loop or no page exists.
    timer: *mut c_void,
    wakeups_enabled: bool,
    busy_until: Instant,
}

thread_local! {
    static PULSE: RefCell<Pulse> = RefCell::new(Pulse {
        pages: 0,
        timer: ptr::null_mut(),
        wakeups_enabled: false,
        busy_until: Instant::now(),
    });
}

static WARNED: Once = Once::new();

extern "C" fn tick(timer: *mut c_void, _: *mut c_void) {
    let busy = PULSE.with(|pulse| pulse.borrow().busy_until > Instant::now());
    if busy {
        unsafe { CFRunLoopTimerSetNextFireDate(timer, CFAbsoluteTimeGetCurrent() + BUSY_PERIOD_S) };
    }
}

/// A page exists: until every page is gone, its wakes reach JS.
pub(crate) fn page_added() {
    PULSE.with(|pulse| {
        let mut pulse = pulse.borrow_mut();
        pulse.pages += 1;
        if pulse.pages > 1 {
            return;
        }
        match main_run_loop_wakeups::enable() {
            Ok(()) => pulse.wakeups_enabled = true,
            Err(error) => {
                WARNED.call_once(|| {
                    log::warn!("webview: waking JS with a timer, the run loop's wakes are not available: {error}")
                });
                pulse.timer = start_timer();
            }
        }
    });
    page_busy();
}

fn start_timer() -> *mut c_void {
    unsafe {
        let mut context = TimerContext {
            version: 0,
            info: ptr::null_mut(),
            retain: ptr::null(),
            release: ptr::null(),
            copy_description: ptr::null(),
        };
        let timer = CFRunLoopTimerCreate(
            ptr::null(),
            CFAbsoluteTimeGetCurrent() + IDLE_PERIOD_S,
            IDLE_PERIOD_S,
            0,
            0,
            tick,
            &mut context,
        );
        CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
        timer
    }
}

/// A page is gone. Called while the thread's locals may be going too, at process exit.
pub(crate) fn page_removed() {
    let _ = PULSE.try_with(|pulse| {
        let mut pulse = pulse.borrow_mut();
        pulse.pages = pulse.pages.saturating_sub(1);
        if pulse.pages > 0 {
            return;
        }
        if pulse.wakeups_enabled {
            main_run_loop_wakeups::disable();
            pulse.wakeups_enabled = false;
        }
        if !pulse.timer.is_null() {
            unsafe {
                CFRunLoopTimerInvalidate(pulse.timer);
                CFRelease(pulse.timer);
            }
            pulse.timer = ptr::null_mut();
        }
    });
}

/// Something asked a page for work, or the page reported some: look at it quickly for a while.
/// Only the fallback timer has a pace to change.
pub(crate) fn page_busy() {
    let _ = PULSE.try_with(|pulse| {
        let mut pulse = pulse.borrow_mut();
        if pulse.timer.is_null() {
            return;
        }
        let was_idle = pulse.busy_until <= Instant::now();
        pulse.busy_until = Instant::now() + std::time::Duration::from_millis(BUSY_FOR_MS);
        if was_idle {
            unsafe { CFRunLoopTimerSetNextFireDate(pulse.timer, CFAbsoluteTimeGetCurrent() + BUSY_PERIOD_S) };
        }
    });
}
