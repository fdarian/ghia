//! Opening a link in the system's default handler (`App::open_url`: the browser for `http(s):`, the mail
//! client for `mailto:`, the phone handler for `tel:`).
//!
//! The renderer's `openUrl` goes through [`open`]; the test renderer's through [`record`], because a
//! test must not start a browser, and keeps the requests for [`recorded`]. Both refuse a scheme the
//! document may not hand to the system: `file:` and custom schemes launch other programs. JS
//! (`js/shell/open-link.ts`) decides which links are other-origin; this is the second check.

use std::collections::HashMap;

use gpui::{App, Global, WindowId};

const SCHEMES: [&str; 4] = ["http", "https", "mailto", "tel"];

fn check(url: &str) -> Result<(), String> {
    let scheme = url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase());
    match scheme {
        Some(scheme) if SCHEMES.contains(&scheme.as_str()) => Ok(()),
        _ => Err(format!("{url} is not an http:, https:, mailto: or tel: URL, which is all a link opens")),
    }
}

pub(crate) fn open(cx: &mut App, url: &str) -> Result<(), String> {
    check(url)?;
    cx.open_url(url);
    Ok(())
}

/// What each test window was asked to open, in order.
#[derive(Default)]
struct Requests(HashMap<WindowId, Vec<String>>);

impl Global for Requests {}

pub(crate) fn record(cx: &mut App, window: WindowId, url: &str) -> Result<(), String> {
    check(url)?;
    cx.default_global::<Requests>().0.entry(window).or_default().push(url.to_owned());
    Ok(())
}

pub(crate) fn recorded(cx: &mut App, window: WindowId) -> Vec<String> {
    cx.default_global::<Requests>().0.get(&window).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn only_web_mail_and_phone_links_open() {
        for url in ["http://a.test/", "HTTPS://a.test/x?y#z", "mailto:a@b.test", "tel:+15551234"] {
            assert!(check(url).is_ok(), "{url}");
        }
        for url in ["file:///etc/passwd", "javascript:alert(1)", "slack://open", "data:text/html,x", "/relative", "a.test/x", ""] {
            assert!(check(url).is_err(), "{url}");
        }
    }
}
