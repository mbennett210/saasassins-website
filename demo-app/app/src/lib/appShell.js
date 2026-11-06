// The office shell's phone scroll lock (UI_RULES §106).
//
// On a phone the office shell never scrolls as a document: in the iOS standalone PWA a scrolling
// document floats the fixed nav mid-screen and lets the page slide behind an open menu. So at
// 640px and below index.css pins html, body and #root to the measured screen height (`--cs-vh`)
// with overflow hidden, and `.main` scrolls inside them. That lock is written ONLY under this
// class, which AppLayout puts on <html> while it is mounted. Every page outside the shell (the
// login, the public quote, inspection report and QR scan pages, the customer hub) is therefore
// an ordinary document that scrolls, with nothing to opt into or out of.
// test-phone-scroll-lock.mjs fails an unscoped lock; lint:responsive drives both at 390×844.
export const APP_SHELL_CLASS = 'cs-app-shell';
