// ENGLISH — THE SOURCE CATALOG (CS-193). Every word the converted screens show, keyed. The
// Spanish and Creole catalogs (es.js, ht.js) are keyed exactly the same way; a key missing
// there shows the English here. Adding a string: brain/architecture/i18n.md, "How to add one".
//
// FORMAT
//   'area.thing': 'English, with {placeholders}',
//   'area.count': { one: '{count} clean', other: '{count} cleans' },      ← a plural
//   {name, time} / {name, date} / {name, number} / {name, list} …       ← formatted (core.js)
//   <b>…</b>                                                              ← bold, kept by translators
//
// TRANSLATOR NOTES ride in `//` comments directly above a key. Comments never reach the app
// (the bundler strips them); `npm --prefix app run i18n:export` reads them into the sheet:
//   // @max 12        a hard length limit: the layout cannot grow (a tab, a chip, a button)
//   // @ph name: …    what a placeholder stands for, when the glossary's meaning is not enough
//   // @note …        anything else the translator needs to know
//   // @icon          an icon beside it carries the meaning — Creole: as short as possible (LANG-9)
// A `// ──` line names the section that follows. Keep the one-line `'key': value,` shape:
// test-i18n-catalog.mjs parses this file as text to prove every key's notes are read.
export default {
  // ── Shared words ───────────────────────────────────────────────────────────────────────
  // @max 16
  'common.loading': 'Loading…',
  // @max 16
  'common.cancel': 'Cancel',
  // @max 16
  'common.save': 'Save',
  // @max 16
  'common.retry': 'Retry',
  // @max 16
  'common.close': 'Close',
  // @max 16
  'common.confirm': 'Confirm',
  // @max 16
  'common.discard': 'Discard',
  // @max 16
  'common.dismiss': 'Dismiss',
  // @max 14
  'common.previous': 'Previous',
  // @max 14
  'common.next': 'Next',
  'common.areYouSure': 'Are you sure?',
  // @max 16
  'common.select': 'Select…',
  // @max 20
  'common.search': 'Search…',
  'common.noMatches': 'No matches',
  // @max 24
  'common.clearSelection': 'Clear selection',
  // @max 16
  'common.filter': 'Filter',
  'common.typeToFilter': 'Type to filter…',
  // @ph shown: how many are listed; total: how many there are
  // @note Under a long list in a picker, when only the first ones are shown.
  'common.cappedNote': 'Showing {shown} of {total, number}. Type to narrow.',
  // @ph first: the earlier items, already joined with commas; last: the last item
  // @note How a list ends: "Ana, Luis and Rosa". Only the word between the last two changes.
  'common.listAnd': '{first} and {last}',
  // @max 16
  'common.saving': 'Saving…',
  // @max 16
  'common.done': 'Done',

  // ── The clock (My Day, the visit steps, a clean's page) ────────────────────────────────
  // @max 22
  // @icon
  'clock.in': 'Clock in',
  // @max 22
  // @icon
  'clock.out': 'Clock out',
  // @max 22
  'clock.locating': 'Locating…',
  // @max 44
  // @note On the clock-out button when the cleaner's checklist is not finished; the button is greyed out.
  'clock.outLocked': 'Finish your checklist to clock out',
  // @max 52
  // @ph done: items finished so far; total: items on the checklist
  // @note The same button, with how far the checklist has got (e.g. 12/46).
  'clock.outLockedProgress': 'Finish your checklist to clock out · {done}/{total}',
  // @max 24
  'clock.openChecklist': 'Open checklist',
  'clock.hint.noSignal': 'No signal. Finish the checklist on this phone, or reconnect.',
  'clock.hint.checkFailed': 'Couldn’t check your checklist just now. Open it, or try again in a moment.',
  // @max 24
  'clock.inSince': 'In since {time}',
  // @ph duration: hours and minutes worked, e.g. 3h 15m
  'clock.doneSummary': 'Clocked out · <b>{duration}</b>',
  // @max 14
  // @note A small grey note beside a punch saved offline that has not reached the office yet.
  'clock.willSync': '· will sync',
  'clock.willSyncTitle': 'Saved on this device. Will sync when you’re back online.',
  // @note Under a disabled Clock in button: the clean's clock-in has not opened yet (CS-052).
  'clock.window.opensAt': 'Clock-in opens at {time}.',
  // @ph hours: how many hours before the clean starts clock-in opens, e.g. 2
  'clock.window.earlyTitle': 'You can clock in from {hours} hours before the clean starts.',
  // @note Under a disabled Clock in button: the clean ended long enough ago that clock-in has closed.
  'clock.window.closed': 'This clean has ended. Ask the office to add your time.',
  'clock.window.earlyError': 'It’s too early to clock in to this clean. Clock-in opens at {time}.',
  // @note A short message after a successful clock-in.
  'clock.inDone': 'Clocked in',
  'clock.outDone': 'Clocked out',
  'clock.inOffline': 'Clocked in. Offline. It’ll sync when you’re back online.',
  'clock.outOffline': 'Clocked out. Offline. It’ll sync when you’re back online.',
  // @ph distance: a rough distance, e.g. 340 ft or 1.2 mi
  'clock.offSiteDistance': 'You’re about {distance} from this location.',
  // @note Shown after a clock-in or clock-out recorded away from the building. Nothing is blocked; the supervisor reviews the time.
  'clock.offSite': 'You’re outside the building’s area. Your supervisor will review this time.',
  // @note Shown after a clock-in or clock-out recorded with NO location (Location off or denied for this app). Nothing is blocked; the supervisor reviews the time.
  'clock.noLocation': 'We couldn’t get your location. Turn on Location for this app in your phone’s settings. Your supervisor will review this time.',
  // @ph time: the clock-out time the app wrote, e.g. 4:00 AM
  // @note On a finished clean's card when the app closed a punch the cleaner never clocked out of (CS-667). Nothing is blocked; the manager checks the time.
  'clock.autoClosed': 'You didn’t clock out, so the app clocked you out at {time}. Your manager will check this time.',
  // @ph time: the clock-out time the app wrote, e.g. 4:00 AM
  // @note The same, for a cleaner who clocked in after the clean's scheduled end: the app counted the clean's usual length from their own clock-in.
  'clock.autoClosedLate': 'You clocked in after this clean’s scheduled end, so the app clocked you out at {time}. Your manager will check this time.',
  // @ph feet: a whole number of feet
  'clock.distanceFeet': '{feet} ft',
  // @ph miles: miles with one decimal, e.g. 1.2
  'clock.distanceMiles': '{miles} mi',
  'clock.error.alreadyIn': 'You’re already clocked in to this clean.',
  // @ph place: the customer or building they are still clocked in at
  'clock.error.alreadyOnClockAt': 'You’re still clocked in at {place}. Clock out there first.',
  'clock.error.alreadyOnClock': 'You’re still clocked in at another clean. Clock out there first.',
  'clock.error.checklistIncomplete': 'Finish your checklist before you clock out',
  'clock.error.checkFailed': 'Couldn’t check your checklist. Try again.',
  'clock.error.clockInFailed': 'Couldn’t clock in. Please try again.',
  'clock.error.clockOutFailed': 'Couldn’t clock out. Please try again.',
  'clock.error.unbufferableIn': 'Can’t save your clock-in on this phone while it’s offline. Get a signal, then clock in.',
  'clock.error.unbufferableOut': 'Can’t save your clock-out on this phone while it’s offline. Get a signal, then clock out.',
  // ── Asked before a clock-in on a day the cleaner is booked off (CS-693) ──
  // @max 40
  'clock.timeOff.title': 'You’re booked off this day',
  'clock.timeOff.body': 'You called out or have time off on the day of this clean. Clock in only if your manager asked you to work it.',
  // @max 22
  'clock.timeOff.confirm': 'Clock in anyway',

  // ── My Day (the cleaner's home screen) ─────────────────────────────────────────────────
  // @max 30
  'myDay.stillClockedIn': 'Still clocked in',
  // @max 12
  // @icon
  'myDay.chip.done': 'Done',
  // @max 12
  // @icon
  'myDay.chip.missed': 'Missed',
  // @max 14
  // @icon
  'myDay.chip.onSite': 'On site',
  // @max 30
  // @icon
  // @note On the cleaner's card while a punch made away from the building waits for the supervisor's approval.
  'myDay.chip.offSiteHeld': 'Off site · held for review',
  // @max 30
  // @icon
  // @note On the cleaner's card while a punch made with no location (Location off) waits for the supervisor's approval.
  'myDay.chip.noLocationHeld': 'No location · held for review',
  // @note Stands in for the customer's name when a clean has none.
  'myDay.cleanFallback': 'Clean',
  'myDay.thisLocation': 'this location',
  // @ph day: a short date, e.g. Fri, Oct 2
  'myDay.carryoverMeta': 'Clocked in {day} · in since {time} · {duration} elapsed',
  // @ph count: minutes of driving
  'myDay.driveEstimate': { one: 'Estimated time: {count} minute', other: 'Estimated time: {count} minutes' },
  'myDay.punchesFailed': {
    one: '{count} clock punch couldn’t sync. Please tell your manager so your time is recorded.',
    other: '{count} clock punches couldn’t sync. Please tell your manager so your time is recorded.',
  },
  'myDay.punchesWaiting': { one: '{count} clock punch waiting to sync', other: '{count} clock punches waiting to sync' },
  'myDay.punchesWaitingNote': 'Saved on this device. They’ll sync automatically when you’re back online.',
  'myDay.error.clockStatus': 'Couldn’t load your clock status.',
  'myDay.error.stillListed': 'Your cleans are still listed below.',
  // @max 40
  'myDay.empty.title': 'Nothing scheduled today',
  'myDay.empty.message': 'When you’re assigned a clean for today, it shows here with a clock-in button.',
  // @ph days: a number of days
  'myDay.noUpcoming': 'No upcoming cleans in the next {days} days.',
  // @max 40
  // @note At the top of My Day when the cleaner called out or has time off today.
  'myDay.timeOff.title': 'You’re booked off today',
  'myDay.timeOff.body': 'Your cleans below are still on your list. Check with your manager before you clock in.',

  // ── The Cleaner Hub: the crew app's frame (brief A, 2026-10-13) ────────────────────────────────
  // @max 16
  // @note The cleaner's home screen, on a back button: "← Home".
  'crewShell.home': 'Home',
  // @note The round back button's spoken name.
  'crewShell.backTo': 'Back to {place}',
  // @ph name: the team member whose app the owner is looking at
  // @note A line across the top while the owner looks at the app as one of the cleaners. Nothing can be saved from it.
  'crewShell.preview': 'Viewing as {name}. Actions are turned off.',

  // ── The Cleaner Hub: Home (the cleaner's home screen) ──────────────────────────────────────────
  // @ph name: the cleaner's first name
  'crewHome.greeting': 'Hey, {name}',
  // @ph count: how many cleans the cleaner has today
  'crewHome.stopsToday': { one: '{count} stop today', other: '{count} stops today' },
  // @ph count: how many cleans the cleaner has tonight
  // @note Shown instead of "today" from 5 PM.
  'crewHome.stopsTonight': { one: '{count} stop tonight', other: '{count} stops tonight' },
  // @note The Messages button's spoken name.
  'crewHome.messages': 'Messages',
  // @ph count: unread messages
  'crewHome.messagesUnread': { one: 'Messages, {count} unread', other: 'Messages, {count} unread' },
  // @note The round picture at the top right opens the cleaner's menu; this is its spoken name.
  'crewHome.menu.open': 'Open your menu',
  // @max 28
  'crewHome.menu.account': 'Your account',
  // @max 28
  // @icon
  'crewHome.menu.keys': 'My keys',
  'crewHome.offline': 'No signal. Clock punches and checklists are kept on this phone and sync when you’re back online.',
  // @max 40
  // @ph count: checklist tasks still to do
  // @note On the big Clock out card when the checklist is not finished.
  'crewHome.hero.finishTasks': { one: 'Finish {count} checklist task to unlock', other: 'Finish {count} checklist tasks to unlock' },
  // @max 40
  'crewHome.hero.finishChecklist': 'Finish your checklist to unlock',
  // @max 40
  // @note On the big Clock out card when the checklist is finished on the phone but not saved yet.
  'crewHome.hero.readyToSave': 'Checklist done · saves as you clock out',
  // @ph time: when they clocked in
  // @ph duration: time since then, e.g. 1h 42m
  'crewHome.hero.clockedInFor': 'Clocked in {time} · {duration} elapsed',
  // @max 30
  // @note Under "Clock in" before the clock-in opens (2 hours before the clean).
  'crewHome.hero.opensAt': 'Opens at {time}',
  // @max 30
  'crewHome.hero.allDone': 'All done for today',
  // @ph count: the cleans finished today
  'crewHome.hero.allDoneCount': { one: 'You finished {count} stop', other: 'You finished all {count} stops' },
  'crewHome.hero.someDone': '{done} of {total} stops finished',
  // @max 30
  'crewHome.hero.none': 'No stops today',
  // @ph place: the next customer
  'crewHome.hero.next': 'Next: {place} · {day} at {time}',
  // @max 18
  // @icon
  // @note Before clocking in, when the phone is outside the building's area.
  'crewHome.chip.notOnSite': 'Not on site',
  // @max 30
  'crewHome.stops.title': 'Today’s Stops',
  // @max 16
  'crewHome.stops.viewAll': 'View all',
  // @max 18
  // @icon
  // @note "AM" is the account manager (the cleaner's supervisor for this customer). Keep it short.
  'crewHome.am.message': 'Message AM',
  // @max 18
  // @icon
  'crewHome.am.call': 'Call AM',
  'crewHome.am.noStop': 'No stop today, so there is no account manager to reach.',
  'crewHome.am.noManager': 'No account manager is set for {place}.',
  // @ph name: the account manager
  'crewHome.am.noPhone': '{name} has no phone number on file.',
  // @max 30
  // @icon
  'crewHome.scan': 'Scan site QR code',
  // @max 20
  'crewHome.tile.checklist': 'My Checklist',
  // @ph place: the customer
  'crewHome.tile.checklistProgress': '{place} · {done} of {total}',
  // @ph place: the customer
  'crewHome.tile.checklistNotStarted': '{place} · Not started',
  'crewHome.tile.noChecklist': 'No checklist today',
  // @max 14
  'crewHome.tile.continue': 'Continue',
  // @max 20
  'crewHome.tile.hours': 'My Hours',
  'crewHome.tile.hoursSub': 'Your hours this pay period',
  // @max 14
  'crewHome.tile.view': 'View',
  // @max 20
  'crewHome.tile.supplies': 'Request Supplies',
  // @note The Request Supplies tile's line: the cleaner's newest supply order and where it stands (S131).
  // @ph no: the order's number, e.g. SO-1047; status: where the order stands, e.g. Partially fulfilled
  'crewHome.tile.suppliesOrder': '#{no} · {status}',
  // @note The Request Supplies tile's line when the cleaner has no supply order yet.
  'crewHome.tile.suppliesNone': 'Order supplies',
  // @max 14
  'crewHome.tile.request': 'Request',
  // @max 20
  'crewHome.tile.requests': 'Client Requests',
  'crewHome.tile.requestsSub': 'Requests sent to you',
  // @note The Client Requests tile when the cleaner has none open.
  'crewHome.tile.requestsNone': 'Nothing assigned to you',

  // ── The Cleaner Hub: My Stops Today ────────────────────────────────────────────────────────────
  // @max 24
  'crewStops.title': 'My Stops Today',
  // @ph count: how many locations
  'crewStops.locations': { one: '{count} location', other: '{count} locations' },
  // @max 14
  'crewStops.state.inProgress': 'In progress',
  // @max 14
  'crewStops.state.upcoming': 'Upcoming',
  // @icon
  'crewStops.line.inside': 'Inside site perimeter',
  // @icon
  // @note Before clocking in, when the phone is outside the building's area. Clock in still works; the manager approves the time.
  'crewStops.line.outsideHeld': 'Outside the site perimeter · time is held for approval',
  // @icon
  'crewStops.line.unknown': 'Can’t see your location yet',
  // @icon
  'crewStops.line.locating': 'Finding your location…',
  // @icon
  'crewStops.line.onSite': 'Clocked in on site',
  // @max 16
  'crewStops.checklist': 'Checklist',
  'crewStops.checklistProgress': '{done} of {total}',
  // @max 16
  'crewStops.notStarted': 'Not started',
  // @max 16
  'crewStops.noChecklist': 'No checklist',
  // @max 22
  'crewStops.viewChecklist': 'View checklist',
  // @max 22
  'crewStops.previewChecklist': 'Preview checklist',
  // @max 16
  'crewStops.details': 'Details',
  // @max 24
  'crewStops.comingUp': 'Coming up',
  'crewStops.qrNote': 'Scanning the QR code posted on site opens that location’s checklist directly.',
  // @max 22
  // @note A button on a stop: tells the customer that the crew is on the way (a notice and an alert in their app, and a text).
  'crewStops.onMyWay': 'On my way',
  // @max 22
  'crewStops.onMyWaySending': 'Telling the customer…',
  // @max 34
  // @note Shown instead of the button once the customer has been told.
  'crewStops.onMyWaySent': 'Customer told you’re on the way',
  // @ph place: the customer
  'crewStops.onMyWayDone': 'We told {place} you’re on the way.',
  'crewStops.onMyWayFailed': 'It didn’t go. Try again in a minute.',
  // @note Nobody at the customer uses the app and there is no number to text, so nobody can be told.
  'crewStops.onMyWayNobody': 'Nobody at this customer can be told yet.',
  // @note The customer replied STOP to the company's texts, so the "on my way" text cannot go.
  'crewStops.onMyWayOptedOut': 'This customer has turned off texts, so they weren’t texted.',

  // ── The Cleaner Hub: the Clock in / Clock out screen ───────────────────────────────────────────
  // @ph place: the customer
  // @ph time: when the clean starts
  'crewClock.sub': '{place} · {time} shift',
  // @icon
  'crewClock.status.outside': 'Outside site perimeter',
  // @icon
  'crewClock.status.unknown': 'Location not available',
  'crewClock.insideBody': 'You’re on site. Clock in when you’re ready to start.',
  // @ph place: the customer
  // @note Nothing is blocked: the cleaner can clock in away from the building, and the manager approves the time.
  'crewClock.outsideBody': 'Your phone isn’t inside {place}’s boundary. You can still clock in — your time will be held until your account manager approves it.',
  // @note The location has no centre on the map yet, so the app cannot tell whether the phone is there. Nothing is blocked.
  'crewClock.noRing': 'No site perimeter is set for this location yet.',
  'crewClock.unknownBody': 'Turn on Location for this app so it can see you’re on site. You can still clock in — your time will be held until your account manager approves it.',
  // @ph place: the customer
  'crewClock.outsideOutBody': 'Your phone isn’t inside {place}’s boundary. You can still clock out — this time will be held until your account manager approves it.',
  'crewClock.checklistAfterIn': 'Your checklist opens once you’re clocked in.',
  // @ph count: the checklist's tasks
  'crewClock.checklistDone': { one: 'Your {count} task is complete or flagged', other: 'All {count} tasks complete or flagged' },
  'crewClock.clearToGo': 'Nice work — you’re clear to clock out.',
  // @ph count: checklist tasks still to do
  'crewClock.checklistLeft': { one: '{count} task left before you can clock out', other: '{count} tasks left before you can clock out' },
  'crewClock.checklistNotStarted': 'Finish your checklist before you clock out.',
  // @max 30
  'crewClock.summary': 'Shift summary',
  // @max 24
  'crewClock.clockedIn': 'Clocked in',
  // @max 24
  'crewClock.clockingOut': 'Clocking out',
  // @max 24
  'crewClock.timeOnSite': 'Time on site',
  // @max 20
  'crewClock.nextStop': 'Next stop',
  // @ph place: the next customer
  // @ph time: when it starts
  'crewClock.nextStopLine': '{place} · {time}',
  // @max 30
  'crewClock.done.title': 'You’re clocked out',
  // @max 24
  'crewClock.backHome': 'Back to Home',
  'crewClock.notFound.title': 'This clean isn’t on your schedule',
  'crewClock.notFound.body': 'It may have been moved or cancelled. Check your stops for today.',
  // @max 24
  'crewClock.seeStops': 'See my stops',
  // @max 40
  // @note The Clock out button when the checklist is finished on the phone but not saved yet: one tap saves it, then clocks out.
  'crewClock.saveAndClockOut': 'Save checklist & clock out',
  'crewClock.draftReady': 'Done on this phone. It’s saved when you clock out.',
  // @note The checklist could not be saved, so the clock-out did not happen either.
  'crewClock.saveFailed': 'Your checklist couldn’t be saved, so you’re still clocked in. Try again.',
  // @note The office turned the checklist off for this cleaner, so the clock-out went ahead; what they ticked is still on the phone.
  'crewClock.partialNotSaved': 'Clocking out. Your checklist couldn’t be saved, so it stays on this phone.',

  // ── The checklist fill (the pop-up a cleaner ticks) ────────────────────────────────────
  // @max 30
  'checklist.fill.titleFill': 'Complete checklist',
  // @max 30
  'checklist.fill.titleNew': 'New checklist',
  // @max 24
  'checklist.fill.customer': 'Customer',
  // @max 24
  'checklist.fill.checklist': 'Checklist',
  // @max 24
  'checklist.fill.location': 'Location',
  'checklist.fill.customerPlaceholder': 'Select a customer…',
  'checklist.fill.customerSearch': 'Search customers…',
  'checklist.fill.noCustomers': 'No customers',
  'checklist.fill.checklistPlaceholder': 'Select a published checklist…',
  'checklist.fill.customerFirstPlaceholder': 'Pick a customer first…',
  'checklist.fill.checklistSearch': 'Search checklists…',
  'checklist.fill.noChecklists': 'No published checklists',
  'checklist.fill.customerFirstHelp': 'Pick the customer first — each one has its own checklists.',
  // @note For the office. "Overview → Service setup" and "Quality → Assignments" name real screens; keep them recognizable.
  'checklist.fill.noneForCustomer': 'This customer has no published checklists yet. The office adds them on the customer’s page (Overview → Service setup) or in Quality → Assignments.',
  'checklist.fill.locationPlaceholderCrew': 'Select your location…',
  'checklist.fill.locationPlaceholderOffice': 'no specific location',
  'checklist.fill.locationSearch': 'Search locations…',
  // @max 16
  'checklist.fill.start': 'Start',
  // @max 24
  'checklist.fill.submit': 'Submit checklist',
  'checklist.fill.offlineNote': 'You’re offline. Your completed checklist will be saved on this device and synced automatically when you’re back online.',
  'checklist.fill.needsLocationForPhotos': 'This checklist has items that need a photo, and photos are attached to a location. Go back and pick the location before filling it in.',
  // @note Stands in for a section of the checklist that has no name.
  'checklist.fill.areaFallback': 'Area',
  // @note Stands in for a checklist item that has no wording.
  'checklist.fill.itemFallback': 'Item',
  // @max 6
  // @icon
  // @note "Not applicable": the button a cleaner taps when an item does not apply tonight.
  'checklist.fill.na': 'N/A',
  // @ph item: the checklist item's wording
  // @note Read aloud by a screen reader for the N/A button.
  'checklist.fill.naAria': 'Mark “{item}” not applicable',
  // @max 16
  'checklist.fill.notePlaceholder': 'Note',
  'checklist.fill.noteAria': 'Note for “{item}”',
  // @ph count: how many items the checklist has
  'checklist.fill.allDone': 'All {count} done',
  // @ph done: items finished; total: items on the checklist
  'checklist.fill.someDone': '{done} of {total} done',
  'checklist.fill.naCount': { one: '{count} marked N/A', other: '{count} marked N/A' },
  'checklist.fill.pickChecklist': 'Pick a checklist',
  'checklist.fill.loadFailed': 'Couldn’t load the checklist.',
  'checklist.fill.savedOffline': 'Saved on this device. It’ll sync when you’re back online.',
  'checklist.fill.submitted': 'Checklist submitted',
  'checklist.fill.submitFailed': 'Couldn’t submit the checklist.',

  // ── A checklist item's camera button ───────────────────────────────────────────────────
  // @max 14
  // @icon
  'checklist.photo.add': 'Add photo',
  // @max 14
  'checklist.photo.adding': 'Adding…',
  // @max 14
  // @icon
  // @note On the camera button once photos are attached: a tick, then how many when more than one.
  'checklist.photo.attached': { one: 'Photo ✓', other: 'Photo ✓ {count}' },
  // @max 20
  'checklist.photo.required': 'Photo required',
  // @max 24
  'checklist.photo.savedOnDevice': 'Saved on this device',
  'checklist.photo.takeAria': 'Take the photo “{item}” needs',
  'checklist.photo.addAnotherAria': { one: 'Add another photo for “{item}” — {count} attached', other: 'Add another photo for “{item}” — {count} attached' },
  // @note Read aloud for the camera button on a task where a photo is welcome but not required.
  'checklist.photo.addAria': 'Add a photo of “{item}”',
  'checklist.photo.addFailed': 'Couldn’t add that photo.',

  // ── A clean's checklist card (My Day, the visit steps, a clean's page) ─────────────────
  // @max 24
  'checklist.clean.checklist': 'Checklist',
  // @max 30
  'checklist.clean.byCleaner': 'Checklists by cleaner',
  // @max 16
  'checklist.clean.notStarted': 'Not started',
  // @max 20
  'checklist.clean.notCheckedYet': 'Not checked yet',
  // @max 24
  'checklist.clean.noChecklist': 'No checklist',
  // @max 16
  // @ph done: items finished; total: items on the checklist
  'checklist.clean.doneProgress': '{done}/{total} done',
  // @max 30
  'checklist.clean.complete': 'Complete checklist',
  // @max 30
  'checklist.clean.completeAgain': 'Complete again',
  // @max 30
  // @icon
  'checklist.clean.completeDone': '✓ Checklist complete',
  // @max 34
  'checklist.clean.finishProgress': 'Finish checklist · {done}/{total}',
  // @ph name: the cleaner whose shift this one is covering
  'checklist.clean.coveringFor': 'Covering for {name}',
  'checklist.clean.coveringForLower': 'covering for {name}',
  'checklist.clean.coveringForSentence': 'Covering for {name}.',
  'checklist.clean.anotherCleaner': 'another cleaner',
  'checklist.clean.setForThisClean': 'A checklist is set for this clean.',
  'checklist.clean.assignedCrewCompletes': 'A checklist is assigned for this clean. The crew completes it on the clean.',
  // @ph time: when the clean's checklist can be filled in, e.g. 6:30 AM (2 hours before it starts)
  // @note Under the checklist button before the clean's window opens (CS-690): a checklist only counts when filled in at the clean.
  'checklist.clean.opensAt': 'The checklist opens at {time}.',
  // @note Under the checklist button after the clean's window has closed, for a cleaner not clocked in there.
  'checklist.clean.closed': 'This clean’s checklist has closed.',

  // ── My Checklist: the cleaner's checklist page (Cleaner Hub, UI_RULES §166) ──────────────
  // @max 24
  'crewChecklist.title': 'My Checklist',
  // @ph start: when the clean starts
  'crewChecklist.sub': '{customer} · {start, time} shift',
  // @note A cleaner covering someone's shift fills that person's checklist on this clean.
  'crewChecklist.coveringFor': 'Covering for {name} · {checklist}',
  // @ph place: where the back arrow returns to, e.g. Home
  'crewChecklist.backTo': 'Back to {place}',
  // @max 16
  // @note The cleaner's home screen, where the back arrow returns when nothing else is known.
  'crewChecklist.home': 'Home',
  // @note The banner when the clock-out waits on this checklist.
  'crewChecklist.lock': 'Complete or flag every task to unlock Clock Out',
  // @note The banner before the cleaner has clocked in to this clean: the tasks are shown, not yet tickable.
  'crewChecklist.preview': 'Opens for check-off once you’re clocked in on site',
  // @max 16
  'crewChecklist.tasks': 'Tasks',
  // @note "Resolved" = done, marked N/A, or marked not completed with a reason.
  'crewChecklist.resolved': '{done} of {total} resolved',
  // @max 16
  'crewChecklist.notStarted': 'Not started',
  'crewChecklist.none.title': 'No checklist for this stop',
  'crewChecklist.none.message': 'Your office hasn’t set a checklist for you on this clean.',
  'crewChecklist.notFound.title': 'This clean isn’t on your schedule',
  'crewChecklist.notFound.message': 'It may have been moved or cancelled. Go back and pick it again.',
  'crewChecklist.loadFailed': 'Couldn’t load the checklist.',
  'crewChecklist.noSignal': 'No signal. Your checklist is saved on this phone.',
  'crewChecklist.noSignalNoCopy': 'No signal. Open this checklist once with signal and it stays on this phone.',
  // @max 24
  // @note A quiet line: every tick is kept on the phone until the checklist is saved.
  'crewChecklist.savedOnPhone': 'Saved on this phone',
  'crewChecklist.photoRequired': 'Photo required before you tick this',
  'crewChecklist.commentAdd': 'Add a comment on “{item}”',
  'crewChecklist.commentEdit': 'Edit the comment on “{item}”',
  // @max 24
  'crewChecklist.commentTitle': 'Comment',
  // @note The comment goes to the office and to the customer's checklist page.
  'crewChecklist.commentHelp': 'The office and the customer can read this.',
  'crewChecklist.commentPlaceholder': 'Anything the office should know',
  // @max 24
  'crewChecklist.commentRemove': 'Remove comment',
  'crewChecklist.ncMark': 'Mark “{item}” as not completed',
  'crewChecklist.ncChange': '“{item}” is marked not completed. Change it',
  'crewChecklist.ncTitle': 'Why can’t this be done?',
  // @max 28
  'crewChecklist.ncPick.locked': 'Locked / no access',
  // @max 28
  'crewChecklist.ncPick.broken': 'Broken equipment',
  // @max 28
  'crewChecklist.ncPick.supplies': 'Out of supplies',
  // @max 28
  'crewChecklist.ncPick.other': 'Something else',
  // @max 16
  'crewChecklist.ncReason': 'Reason',
  // @ph min: the fewest characters allowed
  // @ph max: the most characters allowed
  'crewChecklist.ncHelp': 'A short reason, {min} to {max} characters. The office sees it; it still counts toward Clock Out.',
  // @max 28
  'crewChecklist.ncSave': 'Mark not completed',
  // @max 28
  'crewChecklist.ncUndo': 'It can be done after all',
  // @ph reason: the cleaner's own words for why it could not be done
  'crewChecklist.ncStrip': 'Not completed — {reason}',
  'crewChecklist.left': { one: '{count} task left — finish or mark not completed to unlock Clock Out', other: '{count} tasks left — finish or mark not completed to unlock Clock Out' },
  'crewChecklist.leftNoLock': { one: '{count} task left — finish it or mark it not completed', other: '{count} tasks left — finish them or mark them not completed' },
  'crewChecklist.previewFoot': 'Arrive on site and clock in to start this checklist',
  // @max 28
  'crewChecklist.save': 'Save checklist',
  'crewChecklist.saveFailed': 'Couldn’t save the checklist.',
  // @ph at: when it was saved
  'crewChecklist.savedAt': 'Saved at {at, time}',
  // @ph at: when it was saved
  'crewChecklist.savedPending': 'Saved on this phone at {at, time}. It sends when you have signal.',
  'crewChecklist.savedReadOnly': 'This checklist is saved and can’t be changed here.',
  // @max 20
  'crewChecklist.clockOut': 'Clock Out',

  // ── The visit steps (a cleaner's view of one clean) ────────────────────────────────────
  // @max 30
  'visit.title': 'Visit checklist',
  // @max 30
  // @icon
  'visit.step.clockIn': 'Clock in & start',
  'visit.step.clockInSub': 'Verify you’re on site. This starts the clean and your time.',
  'visit.step.clockInSince': 'On the clock since {time}',
  // @max 30
  // @icon
  'visit.step.before': 'Before photos',
  'visit.step.beforeSub': 'Snap the space before you start.',
  // @max 30
  'visit.step.clean': 'Do the clean',
  'visit.step.cleanSub': 'See the instructions below.',
  // @ph address: the building's street address
  'visit.step.cleanSubAt': '{address} · see instructions below.',
  // @max 30
  // @icon
  'visit.step.after': 'After photos',
  'visit.step.afterSub': 'Show the finished result.',
  // @max 30
  // @icon
  'visit.step.clockOut': 'Clock out',
  'visit.step.clockOutSub': 'Wraps the clean and marks it done.',
  'visit.step.clockedOut': 'Clocked out · {duration}',
  // @max 18
  // @icon
  'visit.addPhotos': 'Add photos',
  'visit.beforeHint': 'The space before you start. Images up to 10MB, video up to 200MB.',
  'visit.afterHint': 'The finished result. Images up to 10MB, video up to 200MB.',

  // ── Photos and video ────────────────────────────────────────────────────────────────────
  'media.defaultLabel': 'Photos & video',
  'media.defaultHint': 'Viewable in-app. Crew see these on the account. Images up to 10MB, video up to 200MB.',
  'media.empty': 'No photos or video yet.',
  // @max 30
  // @icon
  'media.upload': 'Upload photo / video',
  // @max 30
  'media.uploading': 'Uploading…',
  'media.uploaded': { one: 'Uploaded', other: '{count} uploaded' },
  'media.savedOffline': {
    one: 'Saved on this device. It’ll upload when you’re back online.',
    other: '{count} saved on this device. They’ll upload when you’re back online.',
  },
  'media.pendingNote': {
    one: '1 photo/video saved on this device. Waiting to upload. This happens automatically when you’re back online.',
    other: '{count} photos/videos saved on this device. Waiting to upload. This happens automatically when you’re back online.',
  },
  'media.offlineNote': 'You’re offline. Photos and short videos still save on this device and upload automatically once you’re back online. Large videos (over 50MB) need a signal; those stay in your camera roll.',
  'media.loadFailed': 'Couldn’t load the photos.',
  'media.uploadFailed': 'Upload failed.',
  'media.deleteFailed': 'Couldn’t delete it.',
  'media.noteSaved': 'Note saved',
  'media.noteFailed': 'Couldn’t save the note.',
  'media.deleteAria': 'Delete this photo or video',
  'media.photoAlt': 'Site photo',
  'media.videoAlt': 'Video poster',
  // @ph label: the gallery's name; n: which photo; count: how many there are
  'media.viewerTitle': '{label} — {n} / {count}',
  'media.captionPlaceholder': 'Add a note / caption for this photo…',
  // @max 20
  'media.saveNote': 'Save note',

  // ── Account notes on a clean ────────────────────────────────────────────────────────────
  // @max 30
  'notes.title': 'Account notes',
  'notes.openLink': 'Open reference link ↗',
  'notes.fromOffice': 'From the office',
  // @ph date: when the office last changed them, e.g. Oct 3
  'notes.fromOfficeUpdated': 'From the office · updated {date}',

  // ── Punches stranded on an old phone (one-time recovery) ───────────────────────────────
  'recovery.stranded': {
    one: '{count} clock record on this phone never reached the office',
    other: '{count} clock records on this phone never reached the office',
  },
  'recovery.strandedNote': 'This phone was on an old app version that saved your clock-ins locally. Send them in so your hours can be counted.',
  'recovery.sent': {
    one: '{count} clock record sent to the office',
    other: '{count} clock records sent to the office',
  },
  'recovery.sentNote': 'They’ll be reviewed and added to your hours. Nothing was deleted from this phone.',
  // @max 20
  'recovery.send': 'Send to office',
  // @max 20
  'recovery.sending': 'Sending…',
  'recovery.failed': 'Upload failed. Try again with a better signal.',

  // ── Items that could not sync (checklists and photos kept on the phone) ────────────────
  'offline.failedCount': { one: '{count} item couldn’t sync', other: '{count} items couldn’t sync' },
  'offline.failedNote': 'Still saved on this phone. Try again, or discard if you no longer need it. Tell your manager if it keeps failing.',
  // @max 20
  'offline.kind.checklist': 'Checklist',
  // @max 20
  'offline.kind.photo': 'Photo',
  // @max 20
  'offline.kind.video': 'Video',
  'offline.thisItem': 'This item',
  'offline.retrying': 'Trying again…',
  'offline.stillFailed': 'Still couldn’t sync. It’s kept on this device.',
  'offline.discarded': 'Discarded',
  'offline.discardTitle': 'Discard this?',
  // @ph name: what is being thrown away — a file name, or "Checklist" / "Photo"
  'offline.discardMessage': '“{name}” will be deleted from this phone and never reaches the office. This can’t be undone.',

  // ── Settings → Your account: language ──────────────────────────────────────────────────
  // @max 24
  // @icon
  'lang.title': 'Language',
  'lang.description': 'The app follows your phone’s language. Choose one here to always use it instead.',
  // @ph language: the phone's language, written in that language (English, Español or Kreyòl ayisyen)
  // @note The first choice in the list: keep following whatever language the phone is set to.
  'lang.auto': 'Use my phone’s language ({language})',
  // @note Shown only on the login-free demo. Leave it in English if you like; it never reaches the real app.
  'lang.demoNote': 'Demo: a line that has no Spanish or Creole yet shows as bracketed placeholder text, so you can see which lines still need it.',

  // ── Roles (what a person's access level is called) ─────────────────────────────────────
  // @max 20
  'role.owner': 'Super Admin',
  'role.owner.desc': 'Full access. Can assign roles, edit permissions, and override access per user. The top tier.',
  // @max 20
  'role.admin': 'Admin',
  'role.admin.desc': 'Manages day-to-day ops: customers, jobs, messages, team. Cannot see financials or assign roles.',
  // @max 20
  // @note A manager who looks after their own buildings (customers). Since 2026-10-14 the Manager role has two levels: this one, and the Operations Manager below.
  'role.manager': 'Account Manager',
  'role.manager.desc': 'Fully configurable. Starts with the same access as Super Admin — pare it back to exactly what a manager should have.',
  // @max 20
  // @note The Manager role's higher level: account managers report to them, and they see every building their account managers look after.
  'role.opsManager': 'Operations Manager',
  // @note Under the Operations Manager's own permissions column (Settings → Roles), next to the Account Manager's.
  'role.opsManager.desc': 'Oversees a team of account managers and sees all of their buildings. Starts with the same access as an Account Manager.',
  // @note Under the Account Manager permissions column (Settings → Roles). Since 2026-10-16 the Operations Manager has a column of their own, so this one is the account managers' alone.
  'role.managerColumn.desc': 'Looks after their own buildings. Starts with Super Admin’s access — pare it back to fit.',
  // @max 20
  // @note A person who runs supply orders: sends approved orders to the supplier and records deliveries. They do not approve orders.
  'role.supply_manager': 'Supply Manager',
  'role.supply_manager.desc': 'Supplies only: the order queue, the supply catalog, deliveries and supply usage. Approved orders reach them; they don’t approve orders themselves.',
  // @max 20
  'role.crew': 'Crew',
  'role.crew.desc': 'Sees their own jobs and assigned customers. Can update job status and add notes.',

  // ── Settings → Your account ─────────────────────────────────────────────────────────────
  // @max 30
  'account.title': 'Your Account',
  // @max 30
  'account.fullName': 'Full name',
  // @max 30
  'account.initials': 'Initials',
  'account.initialsHelp': '2–3 characters used in the avatar',
  // @max 30
  'account.email': 'Email',
  // @max 30
  'account.phone': 'Phone',
  'account.emailLocked': 'Your sign-in email. Contact a Super Admin to change it.',
  // @ph brand: the app's name
  'account.emailVsMailboxes': '<b>Account email vs. connected mailboxes.</b> Your account email is what we use to sign you in and to send you app notifications, password resets, etc. Mailboxes you connect under <b>Settings → Connected Inboxes</b> are different: those are the addresses you send and receive as inside Messaging. The two can be the same person, but they’re stored separately and {brand} never assumes one matches the other.',
  'account.profileSaved': 'Profile saved',
  // @max 16
  'account.edit': 'Edit',
  // @max 24
  'account.saveChanges': 'Save Changes',
  // @max 20
  'account.saving': 'Saving…',
  'account.unsaved': 'Unsaved changes',
  'account.noChanges': 'No changes yet',
  // @max 30
  'account.notifications.title': 'Notifications',
  'account.notifications.mandatory': 'Notifications are required for your role and can’t be turned off.',
  'account.notifications.none': 'No notification preferences are available for your role.',
  'account.push.title': 'Mobile push notifications',
  'account.push.unsupported': 'This browser does not support push notifications.',
  'account.push.statusOff': 'Off. Turn on to receive notifications on this device even when the app is closed.',
  'account.push.statusSubscribed': 'Subscribed on this device. Events you have turned on above will arrive as push notifications.',
  'account.push.statusIosInstall': 'On for your account. Install this app to your home screen to receive push on this iPhone or iPad.',
  'account.push.statusDenied': 'On for your account, but this browser is blocking notifications.',
  'account.push.statusSubscribeHere': 'On for your account. Subscribe this device to start receiving push here.',
  'account.push.iosHowTo': 'On iPhone or iPad, install this app to your home screen first: tap the share icon in Safari, then “Add to Home Screen”, then return here.',
  'account.push.blockedHowTo': 'Notifications are blocked for this site in your browser. Allow them in site settings, then tap Subscribe this device.',
  // @max 30
  'account.push.subscribe': 'Subscribe this device',
  // @max 24
  'account.push.sendTest': 'Send test push',
  // @max 24
  'account.push.device': 'Device',
  // @ph date: a date, e.g. 10/3/2026
  'account.push.subscribedOn': 'subscribed {date}',
  // @max 16
  'account.push.remove': 'Remove',
  'account.push.subscribed': 'This device is subscribed.',
  'account.push.subscribeFailed': 'Couldn’t subscribe this device.',
  'account.push.updateFailed': 'Couldn’t update mobile push.',
  'account.push.testStub': 'Test push fired locally (demo mode, no backend wired).',
  'account.push.testNone': 'Test push reached 0 devices. Subscribe this device first (it may have been unsubscribed).',
  // @ph count: how many devices failed
  'account.push.testNoneFailed': 'Test push reached 0 devices. {count} failed. The subscription may be expired or the server’s push keys may not match.',
  // @ph count: devices reached; failed: devices that failed
  'account.push.testSomeFailed': { one: 'Test push sent to {count} device; {failed} failed.', other: 'Test push sent to {count} devices; {failed} failed.' },
  'account.push.testSent': { one: 'Test push sent to {count} device.', other: 'Test push sent to {count} devices.' },
  'account.push.testFailed': 'Test push failed.',
  'account.push.deviceRemoved': 'Device removed.',
  'account.push.removeFailed': 'Couldn’t remove the device.',
  // @max 30
  'account.alerts.title': 'Alerts on your phone',
  // @max 30
  'account.alerts.quietHours': 'Quiet hours',
  'account.alerts.quietHoursDesc': 'No phone notifications during these hours. A missed shift, and an urgent ticket, always come through, and everything else still lands in your bell, waiting for the morning.',
  // @max 16
  'account.alerts.from': 'From',
  // @max 16
  'account.alerts.until': 'Until',
  'account.alerts.crossesMidnight': 'Crosses midnight when the “until” time is earlier than the “from” time.',
  'account.alerts.setTwoTimes': 'Set two different times for quiet hours to take effect.',
  // @max 30
  'account.alerts.texts': 'Text me alerts',
  'account.alerts.textsDesc': 'A text message as well as the notification, for missed shifts and urgent tickets only.',
  // @ph phone: the phone number the texts go to
  'account.alerts.textsTo': 'Sent to {phone}.',
  'account.alerts.addPhone': 'Add a phone number above to be texted.',
  'account.alerts.optedOut': 'This number replied <b>STOP</b> to a text, so the carrier is blocking them. Reply <b>START</b> from the phone, then switch this back on.',
  'account.alerts.companySwitch': 'Texting has to be switched on for the whole company under <b>Settings → Integrations</b> before any text goes out.',
  // @max 30
  'account.signature.title': 'Email signature',
  'account.signature.on': 'Added automatically to new emails, replies, and forwards you send from Messaging.',
  'account.signature.off': 'Off. Your signature is not added to outgoing emails.',
  // @max 24
  'account.signature.preview': 'Preview',
  'account.signature.none': 'No signature added yet.',
  // @max 30
  'account.signature.text': 'Signature text',
  'account.signature.yourName': 'Your name',
  // @max 30
  'account.signature.image': 'Signature image (optional)',
  'account.signature.imageAlt': 'Signature',
  // @max 20
  'account.signature.removeImage': 'Remove image',
  // @max 20
  'account.signature.addImage': 'Add image',
  // @max 20
  'account.signature.uploading': 'Uploading…',
  // @ph kb: a size in kilobytes
  'account.signature.imageHelp': 'PNG, JPG, or GIF, up to {kb} KB. Shows up in your signature on every email you send.',
  // @max 24
  'account.signature.size': 'Image size',
  'account.signature.sizeAria': 'Signature image size',
  // @max 12
  'account.signature.small': 'Small',
  // @max 12
  'account.signature.medium': 'Medium',
  // @max 12
  'account.signature.large': 'Large',
  'account.signature.saved': 'Signature saved',
  'account.signature.wrongType': 'Please choose a PNG, JPG, or GIF image.',
  // @ph kb: a size in kilobytes
  'account.signature.tooBig': 'Signature image must be under {kb} KB.',
  'account.signature.unreadable': 'Couldn’t read that image.',
  // @max 30
  'account.password.title': 'Password',
  // @max 30
  'account.password.new': 'New password',
  // @max 30
  'account.password.confirm': 'Confirm new password',
  'account.password.help': 'At least 8 characters',
  // @max 24
  'account.password.change': 'Change password',
  'account.password.changed': 'Password changed.',
  'account.password.tooShort': 'Password must be at least 8 characters.',
  'account.password.mismatch': 'Passwords do not match.',
  'account.password.failed': 'Couldn’t change the password.',

  // ── A team member's photo (Settings → Your account, and Team → a member's Profile) ──────
  // @note The photo shows in the round avatar wherever the person's initials show today.
  // @max 18
  'avatarPhoto.add': 'Add photo',
  // @max 18
  'avatarPhoto.change': 'Change photo',
  // @max 18
  'avatarPhoto.remove': 'Remove photo',
  // @ph name: the team member's full name
  // @note Read aloud by a screen reader for the round avatar, which opens the photo picker.
  'avatarPhoto.pickFor': 'Choose a photo for {name}',
  'avatarPhoto.notAnImage': 'Use a JPG or PNG photo.',
  'avatarPhoto.saved': 'Photo saved',
  'avatarPhoto.removed': 'Photo removed',
  'avatarPhoto.saveFailed': 'Couldn’t save the photo. Try again.',
  'avatarPhoto.removeFailed': 'Couldn’t remove the photo. Try again.',
  // @max 18
  'avatarPhoto.saving': 'Saving…',
  'avatarPhoto.confirmRemove.title': 'Remove this photo?',
  'avatarPhoto.confirmRemove.self': 'Your initials will show again wherever your photo did.',
  // @ph name: the team member's first name
  'avatarPhoto.confirmRemove.other': '{name}’s initials will show again wherever their photo did.',
  // @max 30
  'avatarPhoto.editor.title': 'Crop photo',
  'avatarPhoto.editor.hint': 'Drag to move the photo. Zoom with the slider.',
  // @note A screen reader's name for the square that shows the photo; the keys move it.
  'avatarPhoto.editor.area': 'Photo position. Arrow keys move it, plus and minus zoom.',
  // @max 12
  'avatarPhoto.editor.zoom': 'Zoom',
  // @max 18
  'avatarPhoto.editor.use': 'Use photo',

  // ── Settings → Your account: which notifications you get ───────────────────────────────
  // @max 24
  'notifPrefs.group.messaging': 'Messaging',
  'notifPrefs.newClientMessage': 'New client SMS or email',
  'notifPrefs.newClientMessage.desc': 'When a client texts or emails a thread you can see.',
  'notifPrefs.newDM': 'Someone DMs me',
  'notifPrefs.newDM.desc': 'Direct messages from teammates.',
  'notifPrefs.newInternalMessage': 'New message in a channel',
  'notifPrefs.newInternalMessage.desc': 'Internal staff channels you are part of.',
  // @max 24
  'notifPrefs.group.schedule': 'Schedule',
  'notifPrefs.jobCreatedOrRescheduled': 'A job assigned to me is created or rescheduled',
  'notifPrefs.jobCreatedOrRescheduled.desc': 'Crew receive these only for their own jobs.',
  'notifPrefs.jobCancelled': 'A job I am on is cancelled',
  'notifPrefs.shiftMissed': 'A shift is missed',
  'notifPrefs.shiftMissed.desc': 'When nobody has clocked in to a scheduled clean a set number of minutes after it was due to start. Goes to the account supervisor.',
  'notifPrefs.offSitePunch': 'Someone clocks in or out away from the building',
  'notifPrefs.offSitePunch.desc': 'When a clock-in or clock-out is recorded outside the building’s area, or with no location. The time is held for your approval. Goes to the account supervisor.',
  'notifPrefs.scanFillIn': 'A cleaner fills in from a scan',
  'notifPrefs.scanFillIn.desc': 'When a cleaner scans a building’s QR code and fills in for someone on today’s clean there. Goes to the account supervisor.',
  // @max 24
  'notifPrefs.group.operations': 'Operations',
  'notifPrefs.accountOpsUpdated': 'An account I work is updated',
  'notifPrefs.accountOpsUpdated.desc': 'Security, cleaning instructions, expected time, or assigned cleaners changed on an account you are assigned to.',
  'notifPrefs.keyCustody': 'A key is checked out to me',
  'notifPrefs.keyCustody.desc': 'When a manager or teammate checks a key out in your name. Custody transfers stop being silent.',
  'notifPrefs.keyLost': 'A key is marked lost or unknown',
  'notifPrefs.keyLost.desc': 'When a key’s whereabouts become unclear. Missing from the lockbox or holder unconfirmed.',
  'notifPrefs.reminderFailed': 'A customer reminder fails to send',
  'notifPrefs.reminderFailed.desc': 'When an automated appointment reminder (text or email) to a customer cannot be delivered, so a missed reminder is caught instead of failing silently.',
  'notifPrefs.specialServiceDue': 'A building’s special service is coming up',
  'notifPrefs.specialServiceDue.desc': 'Once for each date, 14 days before a special service like carpet cleaning or strip and wax. Goes to the building’s account manager and their operations manager.',
  // @max 24
  'notifPrefs.group.supplies': 'Supplies',
  'notifPrefs.supplyRequestSubmitted': 'A supply request needs my approval',
  'notifPrefs.supplyRequestSubmitted.desc': 'When a supervisor requests supplies for a building you approve for, so you can approve or reject it before the office fills it.',
  'notifPrefs.supplyRequestApproved': 'A supply request is approved and ready to send',
  'notifPrefs.supplyRequestApproved.desc': 'When an approver clears a supply request, so the office can send it out. Goes to whoever can fulfill requests.',
  'notifPrefs.supplyOrderApproved': 'My supply order is approved',
  'notifPrefs.supplyOrderApproved.desc': 'When the account manager approves supplies you asked for, so you know they are being ordered.',
  'notifPrefs.supplyOrderDeclined': 'My supply order is declined',
  'notifPrefs.supplyOrderDeclined.desc': 'When the account manager turns down supplies you asked for, with their reason.',
  'notifPrefs.supplyItemsDelivered': 'Supplies are delivered',
  'notifPrefs.supplyItemsDelivered.desc': 'Each time items on an order are delivered to the building: for an order you asked for, or one for a building you manage. Anything still on backorder is named with its date.',
  'notifPrefs.supplyItemBackordered': 'A supply is backordered',
  'notifPrefs.supplyItemBackordered.desc': 'When the supplier puts an item on an order on backorder, with the day it is expected.',
  'notifPrefs.supplyItemCancelled': 'A supply on an order is cancelled',
  'notifPrefs.supplyItemCancelled.desc': 'When the Supply Manager cancels an item on an order, for example because the supplier discontinued it, with the reason.',
  'notifPrefs.supplyOrderCompleted': 'A supply order is complete',
  'notifPrefs.supplyOrderCompleted.desc': 'When every item on an order is delivered or cancelled and the order is closed.',
  'notifPrefs.supplyRequestCancelled': 'A supply request is cancelled',
  'notifPrefs.supplyRequestCancelled.desc': 'When someone else cancels a supply request you asked for, or one for a building you approve for, before it goes out.',
  'notifPrefs.supplyOrderDue': 'A building has not ordered supplies this month',
  'notifPrefs.supplyOrderDue.desc': 'On a building’s supply-order day, when nothing has been submitted for it this calendar month. Goes to the account supervisor.',
  'notifPrefs.supplyOrderOverdue': 'A building’s supply order is overdue',
  'notifPrefs.supplyOrderOverdue.desc': 'The day after a building’s order day, when still nothing has been submitted. Goes to whoever can fulfill requests.',
  'notifPrefs.supplyBudgetExceeded': 'A building goes over its supply budget',
  'notifPrefs.supplyBudgetExceeded.desc': 'When a building’s delivered supplies for the calendar month pass the budget set on its account. Once per month, to whoever approves its requests.',
  // @max 24
  'notifPrefs.group.quality': 'Quality',
  'notifPrefs.problemReported': 'A new work order is filed',
  'notifPrefs.problemReported.desc': 'When a ticket is raised — by a client or by a cleaner in the field. Goes to the account supervisor. When the account has none, a client’s request goes to the Admins (the Super Admins when there are none) and any other ticket to the office.',
  'notifPrefs.ticketUrgent': 'An urgent ticket needs attention',
  'notifPrefs.ticketUrgent.desc': 'Every alert about an URGENT ticket: when it is raised, every 10 minutes until someone replies to the client, and again until it is completed. These come through at any hour and are texted as well as pushed.',
  'notifPrefs.ticketUnanswered': 'A ticket has had no reply',
  'notifPrefs.ticketUnanswered.desc': 'A ticket nobody has answered yet, and one still open past its response time. Office hours only.',
  'notifPrefs.inspectionFailed': 'An inspection fails or needs follow-up',
  'notifPrefs.inspectionFailed.desc': 'When a submitted site inspection scores below its passing threshold (or has no scored items). So a bad clean gets a follow-up instead of dead-ending in the report.',
  'notifPrefs.inspectionRedo': 'An area I am on site for needs redoing',
  'notifPrefs.inspectionRedo.desc': 'When an inspection marks something failed at a building you are clocked into, naming the areas to go back to. If nobody is on site, the account supervisor is told instead.',
  'notifPrefs.checklistDue': 'A daily checklist is not logged',
  'notifPrefs.checklistDue.desc': 'When a cleaner has not finished their checklist on a clean. That cleaner is nudged first; once the clean has ended, the account supervisor and the owner get one alert naming who is missing.',
  'notifPrefs.inspectionDue': 'An account is due for inspection',
  'notifPrefs.inspectionDue.desc': 'When an account has not been inspected within the cadence set in Operations. Goes to the account supervisor.',
  // @note A customer wrote in their building's Messages, in the customer hub.
  'notifPrefs.customerMessage': 'A customer sends a message',
  'notifPrefs.customerMessage.desc': 'When a customer writes in their building’s Messages. Goes to the building’s manager; with no manager, to the Admins; with no Admins, to the Super Admins.',
  // @max 24
  'notifPrefs.group.invoices': 'Invoices',
  'notifPrefs.invoicePaid': 'An invoice gets paid',
  'notifPrefs.invoiceOverdue': 'An invoice goes overdue',
  // @max 24
  'notifPrefs.group.contracts': 'Contracts',
  'notifPrefs.contractReminder': 'A contract is coming up for renewal, a price change or its notice deadline',
  'notifPrefs.contractReminder.desc': 'Sixty days ahead of each contract renewal, end date, price change and cancellation-notice deadline. Goes to the account’s manager and the owner.',
  // @max 24
  // @note The group of notification switches about employee warnings (HR).
  'notifPrefs.group.hr': 'HR',
  'notifPrefs.hrWarningToSign': 'I have a warning to review and sign',
  'notifPrefs.hrWarningToSign.desc': 'When a supervisor issues you a warning, and again if it is still unsigned a day later.',
  'notifPrefs.hrWarningUnsigned': 'A warning I issued is still not signed',
  'notifPrefs.hrWarningUnsigned.desc': 'One reminder, a day after you issue a warning the employee has not signed yet.',
  'notifPrefs.crewQuiet': 'A cleaner hasn’t used the app in 30 days',
  'notifPrefs.crewQuiet.desc': 'Once each time someone on the crew goes 30 days without using the app, so they can be turned off if they’ve left. Goes to their account manager and the Admins.',
  // @max 24
  'notifPrefs.group.marketing': 'Marketing',
  'notifPrefs.marketingReplyAssigned': 'A contact replies to a sequence I’m assigned to',
  'notifPrefs.marketingReplyAssigned.desc': 'When someone replies to a marketing sequence and you’re set as its notify-on-reply owner.',
  'notifPrefs.inboxExpired': 'A sending inbox needs reconnecting',
  'notifPrefs.inboxExpired.desc': 'When a marketing inbox’s connection expires or is revoked and it drops out of the sequence rotation. So your drips don’t silently stall.',
  // @max 24
  'notifPrefs.group.sales': 'Sales',
  'notifPrefs.newLead': 'A new inbound lead comes in',
  'notifPrefs.newLead.desc': 'When a lead arrives from a connected webhook (Zapier / Make / n8n / your website form). Off by default. Turn on to be pinged for every new lead.',
  'notifPrefs.quoteSigned': 'A client signs a quote',
  'notifPrefs.quoteSigned.desc': 'When a prospect signs a service agreement you sent.',
  // ── Alerts: what lands on a phone, in the bell and in a text message ───────────────────
  // These are written in each RECIPIENT's language. A notification title shows on a locked
  // phone, so it must make sense on its own and stay short.
  // @note Stands in for a customer's name when the alert has none.
  'alerts.aCustomer': 'a customer',
  // @max 40
  'alerts.generic': 'Operational alert',
  // @max 60
  'alerts.shiftMissed.title': 'Missed shift: {customer}',
  // @ph start: when the clean was scheduled to start
  'alerts.shiftMissed.body': 'Scheduled {start, time}, nobody has clocked in.',
  'alerts.shiftMissed.bodyNoTime': 'Nobody has clocked in.',
  // @max 60
  'alerts.checklistDue.title': 'Checklist not logged: {customer}',
  // @ph start: when the clean was scheduled to start
  'alerts.checklistDue.body': 'The {start, time} clean needs your checklist.',
  'alerts.checklistDue.bodyNoTime': 'Your clean needs your checklist.',
  // @max 60
  'alerts.checklistEscalation.title': 'Checklist still not logged: {customer}',
  // @ph start: when the clean was scheduled to start
  'alerts.checklistEscalation.body': 'The {start, time} clean ended with no checklist.',
  // @ph start: when the clean was scheduled to start; who: the cleaners who have not finished their checklist
  'alerts.checklistEscalation.bodyWho': 'The {start, time} clean ended with no checklist from {who, list}.',
  // @max 60
  'alerts.inspectionDue.title': 'Inspection due: {customer}',
  // @ph date: the day of the last inspection
  'alerts.inspectionDue.body': 'Last inspected {date, date}.',
  'alerts.inspectionDue.never': 'Last inspected never.',
  // @max 60
  'alerts.ticketRepeat.title': 'No reply yet: {customer}',
  // @max 70
  'alerts.ticketRepeat.titleUrgent': 'Urgent · No reply yet: {customer}',
  // @ph since: how long it has waited, e.g. 41 min or 2 hours
  'alerts.ticketRepeat.reason': 'Waiting {since} for a reply to the client.',
  // @max 60
  'alerts.ticketEscalate.title': 'Ticket unanswered: {customer}',
  // @max 70
  'alerts.ticketEscalate.titleUrgent': 'Urgent · Ticket unanswered: {customer}',
  // @ph since: how long it has waited, e.g. 41 min or 2 hours
  'alerts.ticketEscalate.reason': 'Still no reply to the client after {since}.',
  // @max 60
  'alerts.ticketOpenRepeat.title': 'Ticket still open: {customer}',
  // @max 70
  'alerts.ticketOpenRepeat.titleUrgent': 'Urgent · Ticket still open: {customer}',
  'alerts.ticketOpenRepeat.reason': 'Answered, but not completed yet.',
  // @max 60
  'alerts.ticketSla.title': 'Response time passed: {customer}',
  // @max 70
  'alerts.ticketSla.titleUrgent': 'Urgent · Response time passed: {customer}',
  // @ph due: when the response was due
  'alerts.ticketSla.reason': '{priority} priority — due {due, time} and still open.',
  'alerts.ticketSla.reasonNoTime': '{priority} priority — due earlier and still open.',
  // @note A ticket's own title, then the reason: "Paper towels out — Waiting 41 min for a reply to the client."
  'alerts.ticket.titleThenReason': '{ticket} — {reason}',
  // @max 12
  'alerts.priority.low': 'Low',
  // @max 12
  'alerts.priority.medium': 'Medium',
  // @max 12
  'alerts.priority.urgent': 'Urgent',
  'alerts.since.aWhile': 'a while',
  'alerts.since.minutes': { one: '{count} min', other: '{count} min' },
  'alerts.since.hours': { one: '{count} hour', other: '{count} hours' },
  'alerts.since.days': { one: '{count} day', other: '{count} days' },
  // @max 50
  // @ph start: when the shift starts
  'alerts.shiftReminder.title': 'Your shift starts {start, time}',
  // @max 50
  'alerts.shiftReminder.titleSoon': 'Your shift starts soon',
  'alerts.shiftReminder.body': '{customer} — tap to open your day.',
  'alerts.shiftReminder.bodyNoCustomer': 'Tap to open your day.',
  // @max 60
  'alerts.supplyOrderDue.title': 'Supply order due: {customer}',
  'alerts.supplyOrderDue.body': 'Nothing ordered this month (order day: the {orderDay, ordinal}).',
  // @max 60
  'alerts.supplyOrderOverdue.title': 'Supply order still not submitted: {customer}',
  'alerts.supplyOrderOverdue.body': 'The {orderDay, ordinal} has passed with no order this month.',
  // @max 60
  // @ph name: the employee's name
  // @note To a supervisor: the employee has not signed a warning the supervisor gave them.
  'alerts.hrWarning.unsignedTitle': '{name} has not signed their warning',
  // @max 60
  'alerts.hrWarning.unsignedTitleNoName': 'A warning is still not signed',
  // @ph date: the day the warning was given
  'alerts.hrWarning.unsignedBody': 'Issued {date, date}. Have them sign it in person, or mark it refused.',
  // @max 60
  // @note To an employee: a supervisor gave them a written warning to read and sign.
  'alerts.hrWarning.issuedTitle': 'You have a warning to review',
  'alerts.hrWarning.issuedBody': 'Open it to read it and sign that you received it.',
  // @max 60
  'alerts.hrWarning.nudgeTitle': 'Your warning still needs your signature',
  'alerts.hrWarning.nudgeBody': 'You have not signed it yet. Open it to read it and sign that you received it.',
  // @max 60
  // @ph name: the cleaner's name
  // @ph days: how many days (30)
  // @note To an account manager or the office: a cleaner hasn't opened the app or clocked in for 30 days, so they may have left.
  'alerts.crewQuiet.title': '{name} hasn’t used the app in {days} days',
  // @max 60
  'alerts.crewQuiet.titleNoName': 'A cleaner hasn’t used the app in {days} days',
  // @ph date: the last day they opened the app or clocked in
  'alerts.crewQuiet.bodyLastUsed': 'Last used it {date, date}. If they’ve left, turn them off in Team.',
  // @ph date: the day they were added to the team
  'alerts.crewQuiet.bodyAdded': 'Not used since they were added on {date, date}. If they’ve left, turn them off in Team.',
  // @ph days: how many days the app keeps (60)
  'alerts.crewQuiet.bodyNoRecord': 'No use on record in the last {days} days. If they’ve left, turn them off in Team.',
  // @max 60
  // @ph count: how many cleaners (4 or more)
  // @note One alert for several cleaners at once, when more than three reach 30 days on the same morning.
  'alerts.crewQuiet.listTitle': '{count} cleaners haven’t used the app in {days} days',
  // @ph names: the cleaners' names, a list ("Ana Diaz, John Smith and 9 more")
  'alerts.crewQuiet.listBody': '{names}. If they’ve left, turn them off in Team.',
  // @ph count: how many more cleaners the list leaves out
  'alerts.crewQuiet.more': '{count} more',
  // @max 60
  // @ph service: the special service's name (the office's words, e.g. "Carpet cleaning"); customer: the building
  // @note Task #507: to a building's account manager and their operations manager, 14 days before a special service.
  'alerts.specialSvc.title': '{service} at {customer}',
  // @max 60
  // @ph service: the special service's name
  'alerts.specialSvc.titleNoName': '{service} is coming up',
  // @ph date: its next scheduled date; frequency: how often it's done ("Quarterly")
  'alerts.specialSvc.bodySoon': 'Scheduled for {date, date} ({frequency}). Time to coordinate the work.',
  // @ph date: the date it was due; frequency: how often it's done ("Quarterly")
  'alerts.specialSvc.bodyOverdue': 'It was due {date, date} ({frequency}). Mark it done on the customer’s page once it’s done.',
  // @max 60
  'alerts.supplyBudget.title': 'Over supply budget: {customer}',
  'alerts.supplyBudget.body': '{amount, money} delivered this month against a {budget, money} budget.',
  // @max 60
  'alerts.message.emailFrom': 'New email from {name}',
  // @max 60
  'alerts.message.messageFrom': 'New message from {name}',
  // @max 60
  'alerts.message.emailFromClient': 'New email from a client',
  // @max 60
  'alerts.message.messageFromClient': 'New message from a client',
  // @max 60
  'alerts.message.dmFrom': 'DM from {name}',
  // @max 60
  'alerts.message.dmFromTeammate': 'DM from a teammate',
  // @max 60
  // @ph name: the channel's name
  'alerts.message.inChannel': 'New message in {name}',
  // @max 60
  'alerts.message.inAChannel': 'New message in a channel',
  // @max 60
  'alerts.message.new': 'New message',
  // @max 60
  // @ph name: the person who made the change
  'alerts.ops.updatedBy': '{name} updated {customer}',
  // @max 60
  'alerts.ops.updatedByManager': 'A manager updated {customer}',
  'alerts.ops.accountUpdated': 'Account operations were updated.',
  // @ph site: the location's name
  'alerts.ops.siteUpdatedNamed': '{site}: site details were updated.',
  'alerts.ops.siteUpdated': 'Site details were updated.',
  'alerts.ops.accessUpdated': 'Access or security details were updated.',
  'alerts.ops.checklistAssignments': 'Checklist assignments were updated.',
  'alerts.ops.notesUpdated': 'Account notes for the crew were updated.',
  'alerts.ops.serviceSetup': 'Account service setup was updated.',
  // @max 60
  // @ph key: the key's label, e.g. Front door #2
  'alerts.key.checkedOut': 'Key {key} checked out to you',
  // @max 60
  'alerts.key.checkedOutUnnamed': 'Key checked out to you',
  // @ph name: who checked it out
  'alerts.key.byWhom': 'by {name}',
  // @max 60
  // @ph key: the key's label, e.g. Front door #2
  // @note To the office: someone reported the key as confirmed gone (a security signal).
  'alerts.key.lost': 'Key {key} reported LOST',
  // @max 60
  'alerts.key.lostUnnamed': 'A key was reported LOST',
  // @max 60
  // @ph key: the key's label, e.g. Front door #2
  // @note To the office: nobody is sure where the key is (missing from the lockbox, holder unconfirmed).
  'alerts.key.unknown': 'Key {key} marked unknown',
  // @max 60
  'alerts.key.unknownUnnamed': 'A key was marked unknown',
  // @ph when: the clean's date and time
  'alerts.job.when': '{when, dateTime}',
  // @ph when: the clean's new date and time
  'alerts.job.now': 'Now {when, dateTime}',
  // @max 60
  'alerts.job.cancelled': 'A job you were on was cancelled',
  // @max 60
  'alerts.job.rescheduled': 'Job rescheduled',
  // @max 60
  'alerts.job.assigned': 'New job assigned to you',
  // @max 60
  // @ph number: an invoice number
  'alerts.invoice.paid': 'Invoice {number} paid',
  // @max 60
  // @ph number: an invoice number
  'alerts.invoice.overdue': 'Invoice {number} is overdue',  // @note Stands in for an account's name when the alert has none.
  'alerts.anAccount': 'an account',
  // @max 60
  // @ph areas: the parts of the building that failed, as the office named them
  'alerts.redo.title': 'Please redo: {areas, list}',
  // @max 60
  // @ph areas: the parts of the building that failed, as the office named them
  'alerts.redo.titleNobody': 'Nobody on site to redo: {areas, list}',
  // @ph place: the building; count: how many checklist items failed
  'alerts.redo.body': { one: '{place} — {count} item failed inspection.', other: '{place} — {count} items failed inspection.' },
  'alerts.redo.theBuilding': 'the building',
  // @note Groups failed items the inspection could not place in a named area.
  'alerts.redo.otherItems': 'Other items',
  // @max 60
  'alerts.inspection.failed': 'Inspection failed — {place}',
  // @max 70
  // @ph score: the inspection's score, a whole number of percent
  'alerts.inspection.failedScore': 'Inspection failed — {place} ({score}%)',
  // @max 60
  'alerts.inspection.followUp': 'Inspection needs follow-up — {place}',
  // @max 70
  // @ph score: the inspection's score, a whole number of percent
  'alerts.inspection.followUpScore': 'Inspection needs follow-up — {place} ({score}%)',
  // @max 60
  'alerts.ticketRaised.title': 'Work order — {place}',
  // @max 60
  'alerts.ticketRaised.titleUrgent': 'Urgent work order — {place}',
  // @max 60
  'alerts.ticketRaised.titleNoPlace': 'New work order',
  // @max 60
  'alerts.ticketRaised.titleUrgentNoPlace': 'Urgent work order',
  // @max 60
  // @note A customer wrote on their own ticket from the customer hub; the office should answer.
  // @ph place: the building (the customer's name)
  'alerts.ticketReplied.title': 'The client replied — {place}',
  // @max 60
  // @ph place: the building (the customer's name)
  'alerts.ticketReplied.titleUrgent': 'Urgent ticket: the client replied — {place}',
  // @max 60
  'alerts.ticketReplied.titleNoPlace': 'The client replied on a ticket',
  // @max 60
  'alerts.ticketReplied.titleUrgentNoPlace': 'Urgent ticket: the client replied',
  // @max 160
  // @ph said: the customer's own words, quoted as they wrote them (never translated)
  'alerts.ticketReplied.bodyNoTitle': 'Ticket: “{said}”',
  // @max 70
  // @note A customer wrote in their building's Messages (the customer hub); the office should answer.
  // @ph place: the building (the customer's name); name: the customer contact who wrote, as written
  'alerts.customerMessage.title': '{place}: message from {name}',
  // @max 70
  // @ph place: the building (the customer's name)
  'alerts.customerMessage.titleNoName': '{place}: a customer sent a message',
  // @max 70
  // @ph name: the cleaner; place: the building
  'alerts.offSite.titleIn': 'Off-site clock-in: {name} at {place}',
  // @max 70
  // @ph name: the cleaner; place: the building
  'alerts.offSite.titleOut': 'Off-site clock-out: {name} at {place}',
  // @ph away: how far away, or that there was no location — already in the reader's language
  'alerts.offSite.body': '{away} The time is held for your approval.',
  // @ph feet: a whole number of feet
  'alerts.offSite.distance': 'About {feet, number} ft from the building.',
  'alerts.offSite.distanceUnknown': 'Away from the building.',
  'alerts.offSite.noLocation': 'No location was available on their device.',
  'alerts.offSite.aCleaner': 'a cleaner',
  // @max 90
  // @ph name: the cleaner filling in; covered: who they fill in for; place: the building
  'alerts.fillIn.title': '{name} is filling in for {covered} at {place} today',
  // @ph start: when today's clean starts
  'alerts.fillIn.body': 'They scanned the building’s QR code for today’s {start, time} clean.',
  'alerts.supply.aLocation': 'a location',
  // @max 60
  'alerts.supply.toApproveTitle': 'Supply request to approve: {place}',
  // @ph count: how many items; amount: the request's total
  'alerts.supply.toApproveBody': { one: '{count} item · {amount, money}', other: '{count} items · {amount, money}' },
  // @ph count: how many items; amount: the request's total; name: who asked for it
  'alerts.supply.toApproveBodyBy': { one: '{count} item · {amount, money} · by {name}', other: '{count} items · {amount, money} · by {name}' },
  // @max 60
  'alerts.supply.approvedTitle': 'Supply request approved: {place}',
  // @ph count: how many items; amount: the request's total
  'alerts.supply.approvedBody': { one: '{count} item · {amount, money}', other: '{count} items · {amount, money}' },
  // @ph count: how many items; amount: the request's total; name: who approved it
  'alerts.supply.approvedBodyBy': { one: '{count} item · {amount, money} · approved by {name}', other: '{count} items · {amount, money} · approved by {name}' },
  // ── the supply orders (S131): an order's news, to whoever asked and the account manager ──
  // @note Stands in for an order's number when it has none.
  'alerts.supply.orderWord': 'Order',
  // @note Stands in for a supply line that has no name.
  'alerts.supply.anItem': 'an item',
  // @ph item: a supply's name, as the office wrote it; qty: how many
  'alerts.supply.itemQty': '{item} ×{qty}',
  // @note A supply the supplier has on backorder, with the day the supplier expects it.
  // @ph item: a supply's name, as the office wrote it; eta: the day the supplier expects it
  'alerts.supply.itemEta': '{item} (backordered, ETA {eta, date})',
  // @ph count: how many items the order lists
  'alerts.supply.orderItems': { one: '{count} item', other: '{count} items' },
  // @max 60
  // @ph no: the order's number, e.g. SO-1047
  'alerts.supply.orderApprovedTitle': '{no} approved: {place}',
  // @max 60
  // @ph no: the order's number, e.g. SO-1047
  'alerts.supply.orderDeclinedTitle': '{no} declined: {place}',
  // @ph reason: the account manager's own words, as written
  'alerts.supply.orderDeclinedBody': '“{reason}”',
  // @max 60
  // @ph no: the order's number, e.g. SO-1047
  'alerts.supply.orderCompletedTitle': '{no} complete: {place}',
  'alerts.supply.orderCompletedBody': 'Every item on it is delivered or cancelled.',
  // @max 90
  // @ph items: what arrived, e.g. "Paper towels ×3 and Glass cleaner ×2"
  'alerts.supply.deliveredItemsTitle': 'Delivered to {place}: {items, list}',
  // @ph no: the order's number, e.g. SO-1047; items: what is still to come, a backordered one with its ETA
  'alerts.supply.deliveredRest': '{no} · still to come: {items, list}',
  // @ph no: the order's number, e.g. SO-1047
  'alerts.supply.deliveredAllIn': '{no} · everything has arrived',
  // @max 90
  // @ph items: the backordered supplies, each with the day the supplier expects it
  'alerts.supply.backorderedTitle': 'Backordered for {place}: {items, list}',
  // @ph no: the order's number, e.g. SO-1047
  'alerts.supply.orderRef': 'Order {no}',
  // @max 90
  // @note The Supply Manager cancelled a supply on an order (the supplier discontinued it, say).
  // @ph items: the cancelled supplies' names
  'alerts.supply.itemCancelledTitle': 'Cancelled for {place}: {items, list}',
  // @ph no: the order's number, e.g. SO-1047; reason: the Supply Manager's own words, as written
  'alerts.supply.itemCancelledBody': '{no} · “{reason}”',
  // ── a request cancelled before it went out (CS-670): the requester and the approver ──
  // @max 60
  'alerts.supply.cancelledTitle': 'Supply request cancelled: {place}',
  // @ph count: how many items the request asked for
  'alerts.supply.cancelledBody': { one: '{count} item', other: '{count} items' },
  // @ph count: how many items the request asked for; name: who cancelled it
  'alerts.supply.cancelledBodyBy': { one: '{count} item · cancelled by {name}', other: '{count} items · cancelled by {name}' },
  // @max 50
  'alerts.unapproved.title': 'Time waiting for your approval',
  // @ph punches: e.g. "3 punches"; people: e.g. "2 cleaners"; day: the day, as YYYY-MM-DD
  'alerts.unapproved.body': '{punches} from {people} still need your approval for {day}. Unapproved hours are not paid on this run.',
  'alerts.unapproved.punches': { one: '{count} punch', other: '{count} punches' },
  'alerts.unapproved.cleaners': { one: '{count} cleaner', other: '{count} cleaners' },
  // @max 50
  'alerts.watchdog.title': 'No clock-ins recorded',
  // @ph count: how many cleans; hours: how many hours back
  'alerts.watchdog.body': { one: '{count} clean in the last {hours}h and zero clock-ins. The time clock may be broken, or crew phones are on an old app version.', other: '{count} cleans in the last {hours}h and zero clock-ins. The time clock may be broken, or crew phones are on an old app version.' },
  // @max 50
  // @note When many notifications arrive at once, the phone gets one summary instead.
  'push.digest.title': { one: '{count} new notification', other: '{count} new notifications' },
  // @ph brand: the app's name
  'push.digest.body': 'Open {brand} to catch up.',
  // ── The notifications list (the bell) ───────────────────────────────────────────────────
  // @max 24
  'notif.title': 'Notifications',
  // @ph count: how many are unread
  'notif.bellAriaUnread': { one: 'Notifications ({count} unread)', other: 'Notifications ({count} unread)' },
  'notif.allCaughtUp': 'You’re all caught up.',
  // @max 20
  'notif.markAllRead': 'Mark all read',
  // @max 16
  'notif.clearAll': 'Clear all',
  // @max 40
  // @note The question asked, at the foot of the list, before every notification is removed.
  'notif.clearAllTitle': 'Clear all notifications?',
  'notif.clearAllBody': 'This cannot be undone.',
  // @max 10
  // @icon
  'notif.all': 'All',
  'notif.filterAria': 'Filter notifications',
  // @max 12
  // @note Filter buttons above the phone's notifications list, one per kind of notification.
  'notif.filter.alerts': 'Alerts',
  // @max 12
  'notif.filter.messages': 'Messages',
  // @max 12
  // @note Schedule changes, inspections, checklists and work orders.
  'notif.filter.work': 'Work',
  // @max 12
  'notif.filter.supplies': 'Supplies',
  // @max 12
  // @note Invoices, contracts, quotes and new leads.
  'notif.filter.money': 'Money',
  // @max 14
  'notif.today': 'Today',
  // @max 14
  'notif.yesterday': 'Yesterday',
  // @max 14
  'notif.earlier': 'Earlier',
  // @max 8
  // @icon
  // @note Shown behind a notification while it is swiped right to mark it read.
  'notif.read': 'Read',
  // @note On a notification about a clean that was later removed from the schedule.
  'notif.cleanRemoved': 'clean removed',
  // @note The same, as a full line under the notification on a phone.
  'notif.cleanDeleted': 'This clean was deleted',
  'notif.removedTitle': 'This clean was removed from the schedule',
  'notif.dismissAria': 'Dismiss notification',

  // ── How long ago ────────────────────────────────────────────────────────────────────────
  // @max 12
  'ago.justNow': 'just now',
  // @max 12
  'ago.minutesAgo': { one: '{count}m ago', other: '{count}m ago' },
  // @max 12
  'ago.hoursAgo': { one: '{count}h ago', other: '{count}h ago' },
  // @max 12
  'ago.daysAgo': { one: '{count}d ago', other: '{count}d ago' },
  // @max 8
  'ago.minutesShort': { one: '{count}m', other: '{count}m' },
  // @max 8
  'ago.hoursShort': { one: '{count}h', other: '{count}h' },
  // @max 8
  'ago.daysShort': { one: '{count}d', other: '{count}d' },
  // @max 12
  'ago.yearsAgo': { one: '{count}y ago', other: '{count}y ago' },

  // ── Navigation: the bottom tabs, the menu and the desktop sidebar ───────────────────────
  // @max 12
  // @icon
  // @note A bottom tab on the phone: short, the icon above it carries the meaning (LANG-9).
  'nav.dashboard': 'Dashboard',
  // @max 12
  // @icon
  'nav.schedule': 'Schedule',
  // @max 12
  // @icon
  // @note The cleaner's home screen: today's cleans and the clock-in button.
  'nav.myDay': 'My Day',
  // @max 12
  // @icon
  'nav.messaging': 'Messaging',
  // @max 12
  // @icon
  'nav.customers': 'Customers',
  // @max 20
  // @icon
  'nav.reports': 'Reports',
  // @max 20
  // @icon
  // @note The sales pipeline (leads and deals), office only.
  'nav.pipeline': 'Pipeline',
  // @max 20
  // @icon
  'nav.marketing': 'Marketing',
  // @max 20
  // @icon
  // @note A heading in the office menu that groups the day-to-day tools below it.
  'nav.operations': 'Operations',
  // @max 20
  // @icon
  // @note The supervisor's desk for approving clock-ins, clock-outs and overtime.
  'nav.approvals': 'Approvals',
  // @max 20
  // @icon
  'nav.timeClock': 'Time Clock',
  // @max 20
  // @icon
  // @note The report comparing scheduled hours with hours actually worked.
  'nav.variance': 'Variance',
  // @max 20
  // @icon
  'nav.payroll': 'Payroll',
  // @max 12
  // @icon
  // @note Quality control: inspections, checklists and work orders. On a cleaner's phone it is a bottom tab.
  'nav.quality': 'Quality',
  // @max 20
  // @icon
  // @note Building keys and access cards.
  'nav.keys': 'Keys',
  // @max 20
  // @icon
  // @note Cleaning supplies and the requests for them.
  'nav.supplies': 'Supplies',
  // @max 20
  // @icon
  // @note The delivery driver's list: supplies the office sent out, to drop off and mark delivered.
  'nav.deliveries': 'Deliveries',
  // @max 24
  // @icon
  // @note The page listing every account (customer) of an Operations Manager's team with its account manager; the owner's lists every account.
  'nav.teamAccounts': 'Accounts',
  // @max 20
  // @icon
  // @note A heading in the office menu that groups quotes, contracts and invoices.
  'nav.finances': 'Finances',
  // @max 20
  // @icon
  'nav.quotes': 'Quotes',
  // @max 20
  // @icon
  'nav.contracts': 'Contracts',
  // @max 20
  // @icon
  'nav.invoices': 'Invoices',
  // @max 20
  // @icon
  // @note Human resources: employees, pay, time off and documents.
  'nav.hr': 'HR',
  // @max 20
  // @icon
  'nav.settings': 'Settings',
  // @max 20
  // @icon
  // @note The office's review workspace (drafts and decisions to approve).
  'nav.review': 'Review',
  // @max 5
  // @note A small gold tag beside a menu item that is new. Keep it very short.
  'nav.new': 'NEW',
  // @max 20
  // @note The heading at the top of the phone's menu, above the list of sections.
  'nav.goTo': 'Go to',
  // @max 24
  // @icon
  'nav.search': 'Search',
  // @max 24
  // @icon
  // @note Opens a form to tell the office something in the app is broken.
  'nav.reportIssue': 'Report an issue',
  'nav.openMenu': 'Open menu',
  'nav.closeMenu': 'Close menu',
  'nav.allSections': 'All sections',
  'nav.primary': 'Primary navigation',
  // @note Read aloud by a screen reader for the round button that jumps to the top of the page and reloads it.
  'nav.toTop': 'Scroll to top and refresh',
  // @max 16
  // @note Under the company name at the top of the desktop sidebar.
  'nav.platform': 'Platform',
  // @ph count: how many review items need attention; fresh: how many of them are new
  'nav.reviewCountAria': { one: '{count} item needs review, {fresh} new', other: '{count} items need review, {fresh} new' },
  // @max 20
  // @icon
  // @note The office's page listing every building's QR codes (one per cleaning area), to print as labels.
  'nav.qrCodes': 'QR codes',
  // ── The Launcher: the desktop menu's sections, their groups and a line on each page (UI_RULES §182) ──
  // @max 20
  // @note A section of the desktop menu: hours, approvals, payroll and HR.
  'nav.section.team': 'Team',
  // @max 20
  // @note A section of the desktop menu: invoices and reports.
  'nav.section.finance': 'Finance',
  // @max 24
  // @note A group heading inside a menu section: the day-to-day pages (schedule, shift check-in, checklists, keys).
  'nav.group.today': 'Today',
  // @max 24
  // @note A group heading inside a menu section: inspections, client requests and QR codes.
  'nav.group.serviceQuality': 'Service quality',
  // @max 24
  // @note A group heading inside a menu section: the time clock, hour approvals and variance.
  'nav.group.time': 'Time',
  // @max 24
  // @note A group heading inside a menu section: payroll and HR.
  'nav.group.payPeople': 'Pay & people',
  // @max 24
  // @note A group heading inside a menu section: the customer list and accounts.
  'nav.group.directory': 'Directory',
  // @max 24
  // @note A group heading inside a menu section: the sales pipeline, quotes and contracts.
  'nav.group.sales': 'Sales',
  // @ph count: how many pages the open menu section holds
  'nav.pageCount': { one: '{count} page', other: '{count} pages' },
  // @note Read aloud for the X that closes an open menu section.
  'nav.closeSection': 'Close',
  // @max 26
  // @note Under "Supplies" in the desktop menu: what the section holds (supply requests, the catalog, deliveries).
  'nav.line.supplies': 'Orders and deliveries',
  // @max 44
  // @note Under a page's name in an open menu section: what the page is for. Keep it short.
  'nav.desc.schedule': 'Every visit by day and crew',
  // @max 44
  'nav.desc.customers': 'People and companies',
  // @max 44
  'nav.desc.reports': 'P&L, labor and quality reports',
  // @max 44
  'nav.desc.pipeline': 'Deals by stage',
  // @max 44
  'nav.desc.marketing': 'Email campaigns',
  // @max 44
  'nav.desc.teamAccounts': 'Every account with its manager',
  // @max 44
  'nav.desc.shiftCheckIn': 'Who arrived and who is late',
  // @max 44
  'nav.desc.approvals': 'Hours to sign off before payroll',
  // @max 44
  'nav.desc.timeClock': 'Every punch in and out',
  // @max 44
  'nav.desc.variance': 'Scheduled hours against worked',
  // @max 44
  'nav.desc.payroll': 'Pay runs and exports',
  // @max 44
  'nav.desc.quality': 'Inspections and templates',
  // @max 44
  'nav.desc.clientRequests': 'Open work orders and deadlines',
  // @max 44
  'nav.desc.checklistsToday': 'Today’s checklist for each visit',
  // @max 44
  'nav.desc.qrCodes': 'Each building’s area codes, to print',
  // @max 44
  'nav.desc.keys': 'Who holds which key',
  // @max 44
  'nav.desc.supplies': 'Requests and approved lists',
  // @max 44
  'nav.desc.supplyCatalog': 'The master supply list',
  // @max 44
  'nav.desc.deliveries': 'The driver’s drop-offs',
  // @max 44
  'nav.desc.quotes': 'Proposals out for signature',
  // @max 44
  'nav.desc.contracts': 'Signed agreements and renewals',
  // @max 44
  'nav.desc.invoices': 'Billing and payments',
  // @max 44
  'nav.desc.hr': 'Employees, PTO and documents',

  // ── The manager's menu (the manager view redesign, Builder B — UI_RULES §152) ──────────────
  // @max 20
  // @icon
  // @note The manager's first menu row: their home page. (The phone's bottom tab for the same page keeps "Dashboard".)
  'nav.home': 'Home',
  // @max 20
  // @icon
  // @note The manager's menu row for inspections of buildings (the Quality page).
  'nav.inspections': 'Inspections',
  // @max 20
  // @icon
  // @note The manager's menu row for approving cleaners' clock-ins, clock-outs and overtime.
  'nav.hoursApproval': 'Hours Approval',
  // @max 20
  // @icon
  // @note The manager's menu row for messages.
  'nav.messages': 'Messages',
  // @max 20
  // @icon
  // @note The manager's menu row for their own account settings.
  'nav.account': 'Account',
  // @max 20
  // @icon
  // @note The last row of the manager's menu: it opens the list of every other page.
  'nav.more': 'More',
  // @max 20
  // @note The back button's word on a page reached from the profit & loss by property page.
  'nav.propertyPnl': 'Property P&L',
  // @ph count: the number on the small pill beside a menu row (crews not checked in, timesheets waiting, open requests, customer messages waiting for a reply, buildings needing attention)
  'nav.countAria': { one: '{count} needs attention', other: '{count} need attention' },
  // ── The supply manager's menu and bottom bar (S131 Wave 2, UI_RULES §169) ──
  // @max 20
  // @icon
  // @note The supply manager's first menu row: their home page, the list of approved supply orders to process.
  'nav.orderQueue': 'Order Queue',
  // @max 20
  // @icon
  // @note The supply manager's menu row for the supply products each building may order.
  'nav.supplyCatalog': 'Supply Catalog',
  // @max 10
  // @icon
  // @note The supply manager's first bottom tab (narrow, so one short word): the list of supply orders to process, their home page.
  'nav.tab.orders': 'Orders',
  // @max 10
  // @icon
  // @note The supply manager's bottom tab (narrow, so one short word) for the supply products each building may order.
  'nav.tab.catalog': 'Catalog',

  // ── The back button ("← Team") at the top of a page ─────────────────────────────────────
  // @max 20
  // @note The back button's word when the page it returns to has no name of its own.
  'back.back': 'Back',
  // @max 20
  // @note The back button's word for the page it returns to (Settings → Team).
  'back.team': 'Team',
  // @max 20
  'back.account': 'Account',
  // @max 20
  'back.company': 'Company',
  // @max 20
  'back.services': 'Services',
  // @max 20
  'back.tags': 'Tags',
  // @max 20
  'back.roles': 'Roles',
  // @max 20
  // @note The settings page for the automatic reminders sent to customers.
  'back.reminders': 'Reminders',
  // @max 20
  'back.integrations': 'Integrations',

  // ── Settings: the landing page's groups and cards ───────────────────────────────────────
  'settingsHub.sub': 'Everything you can configure, grouped by what it affects.',
  // @max 24
  // @icon
  'settingsHub.quickStart': 'Quick Start',
  // @ph name: the app's name
  'settingsHub.quickStartDesc': 'Finish setting up {name}.',
  // @max 24
  'settingsHub.group.business': 'Your business',
  // @max 24
  'settingsHub.group.operations': 'How you work',
  // @max 24
  'settingsHub.group.people': 'People & access',
  // @max 24
  'settingsHub.group.connections': 'Connections',
  // @max 24
  // @note The group holding the person's own account, not the company's settings.
  'settingsHub.group.you': 'You',
  // @max 24
  // @icon
  'settingsHub.company': 'Company',
  'settingsHub.companyDesc': 'Name, address, logo and the office email customers reply to.',
  // @max 24
  // @icon
  'settingsHub.services': 'Services',
  'settingsHub.servicesDesc': 'The work you sell, and what it is called on a quote.',
  // @max 24
  // @icon
  'settingsHub.tags': 'Tags & Variables',
  'settingsHub.tagsDesc': 'Reusable tags for customers, and the merge fields used in messages.',
  // @max 24
  // @icon
  'settingsHub.operations': 'Operations',
  'settingsHub.operationsDesc': 'Clock-in geofence, auto-close grace and the variance thresholds.',
  // @max 24
  // @icon
  'settingsHub.reminders': 'Customer Reminders',
  'settingsHub.remindersDesc': 'Automatic nudges before and after a visit.',
  // @max 24
  // @icon
  'settingsHub.team': 'Team',
  'settingsHub.teamDesc': 'Who can log in, and what each person may see.',
  // @max 24
  // @icon
  'settingsHub.roles': 'Roles & Permissions',
  'settingsHub.rolesDesc': 'What Admin and Crew are allowed to do.',
  // @max 24
  // @icon
  'settingsHub.clientLogins': 'Customer Logins',
  'settingsHub.clientLoginsDesc': 'Let a customer contact sign in to see the buildings they look after.',
  // @max 24
  // @icon
  'settingsHub.integrations': 'Integrations',
  'settingsHub.integrationsDesc': 'Texting, email delivery and payments.',
  // @max 24
  // @icon
  'settingsHub.inboxes': 'Connected Inboxes',
  'settingsHub.inboxesDesc': 'Mailboxes the app sends and receives from.',
  // @max 24
  // @icon
  'settingsHub.account': 'Account',
  'settingsHub.accountDesc': 'Your own profile, password and notification preferences.',

  // ── The account chip (who is signed in, sign out) ───────────────────────────────────────
  // @max 24
  'userMenu.account': 'Account',
  // @max 24
  'userMenu.signedInAs': 'Signed in as',
  // @max 24
  // @note An owner can look at the app the way another team member sees it.
  'userMenu.viewAs': 'View as',
  // @max 30
  'userMenu.backToMine': '↩ Back to my view',
  // @max 30
  'userMenu.signOut': 'Sign out',
  // @max 40
  'userMenu.signingOut': 'Signing out. Saving changes…',
  // @max 16
  // @note Beside a team member who has been invited but has not signed in yet.
  'userMenu.invited': 'Invited',
  // @note Shown only on the login-free demo.
  'userMenu.sandbox': 'Switch view (sandbox)',
  'userMenu.switchView': 'Switch view',
  // @note Shown only on the login-free demo.
  'userMenu.allUsers': 'All users',
  // @note In the user menu, and as the title of the box that follows. In the live app it lets the office pick a building and see the customer hub exactly as that building's customers see it, read-only; on the login-free demo it opens the hub as a demo customer contact.
  'userMenu.previewHub': 'Preview the customer hub',
  // @max 16
  // @note A small label on the user menu's "Preview the customer hub" row, marking it as the way into what the customers see (not one more team member to view the app as).
  'userMenu.customerView': 'Customer view',

  // ── Preview as customer (the office sees one building's customer hub, read-only) ──────────
  // @max 28
  // @note A button on a customer's page. "Customer hub" is the website the building's own customers sign in to.
  'hubPreview.button': 'Preview customer hub',
  'hubPreview.pickHelp': "Pick a building. You'll use the customer hub as its customer: what you send there is real and reaches the office.",
  // @max 24
  'hubPreview.building': 'Building',
  // @max 40
  // @note The placeholder of the search box above the building list.
  'hubPreview.search': 'Search buildings…',
  // @max 60
  'hubPreview.noMatch': 'No building matches that search.',
  // @max 60
  'hubPreview.empty': 'There are no buildings yet.',
  // @max 24
  'hubPreview.open': 'Open customer view',

  // ── Turning on phone notifications (the prompt after signing in on a phone) ─────────────
  // @max 40
  'pushGate.title': 'Turn on notifications',
  'pushGate.iosInstall': 'To get alerts on this iPhone or iPad, add the app to your Home Screen first.',
  // @note "Share" and "Add to Home Screen" are the names of the iPhone's own buttons: use the names the iPhone shows in that language.
  'pushGate.iosSteps': 'Tap the Share button, choose <b>Add to Home Screen</b>, open the app from there, then come back to turn notifications on.',
  'pushGate.blocked': 'Notifications are currently blocked for this app in your device settings.',
  'pushGate.blockedFix': 'Turn them on in your browser or site settings, then reopen the app.',
  'pushGate.why': 'Get alerted about late or missed shifts, new work orders, and job updates even when the app is closed. It takes one tap.',
  // @max 16
  'pushGate.notNow': 'Not now',
  // @max 24
  'pushGate.enabling': 'Enabling…',
  // @max 24
  'pushGate.enable': 'Enable notifications',
  'pushGate.on': 'Notifications are on for this device.',
  'pushGate.failed': 'Could not enable notifications.',

  // ── The Home Screen welcome (a phone's browser, the first time: the sign-in page, the app) ───────
  // @max 48
  'installWelcome.title': 'Put the app on your Home Screen',
  'installWelcome.why': 'It opens like any app: full screen, with its own icon and alerts.',
  // @ph product: the app's name (Clean Corner), never translated.
  'installWelcome.whyPrompt': 'One tap and {product} sits on your Home Screen like any app, with its own icon and alerts.',
  // @ph browser: Safari on an iPhone, Chrome on Android: the browser's own name, never translated.
  'installWelcome.inappWhy': 'This page is open inside another app, which can’t add it to your Home Screen. Open it in {browser} first, then add it from there.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.safari27Menu': 'Tap the menu button at the left end of the address bar.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.safari26Menu': 'Tap <b>⋯</b> beside the address bar.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.safariShare': 'Tap <b>Share</b>. If <b>Add to Home Screen</b> isn’t in the list, tap <b>View More</b>.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.safariAdd': 'Tap <b>Add to Home Screen</b>, leave <b>Open as Web App</b> on, then tap <b>Add</b>.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.safariLegacyShare': 'Tap the <b>Share</b> button in Safari’s toolbar (a square with an arrow).',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.ipadShare': 'Tap the <b>Share</b> button at the top of Safari (a square with an arrow).',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.legacyAdd': 'Tap <b>Add to Home Screen</b>, then tap <b>Add</b>.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.chromeIosShare': 'Tap the <b>Share</b> button at the right of the address bar.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.otherIosShare': 'Open this browser’s menu and tap <b>Share</b>.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.androidMenu': 'Tap <b>⋮</b> at the right of the address bar.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.androidInstall': 'Tap <b>Install and create shortcut</b> (on some phones <b>Add to Home screen</b> or <b>Install app</b>), then <b>Install</b>.',
  // @note The words in <b> are the names of the phone's own buttons: use the names the phone shows in that language.
  'installWelcome.step.androidOtherMenu': 'Open this browser’s menu and tap <b>Add to Home screen</b> or <b>Install</b>.',
  // @ph product: the app's name (Clean Corner), never translated.
  'installWelcome.step.open': 'Open {product} from your Home Screen.',
  // @ph browser: Safari on an iPhone, Chrome on Android: the browser's own name, never translated.
  // @note The words in <b> are names of buttons in other apps: use the names those apps show in that language.
  'installWelcome.step.inappOpen': 'In this app’s menu (often <b>⋯</b> or <b>⋮</b>), tap <b>Open in {browser}</b> or <b>Open in browser</b>.',
  // @ph browser: Safari on an iPhone, Chrome on Android: the browser's own name, never translated.
  'installWelcome.step.inappCopy': 'Or tap <b>Copy link</b> below and paste it into {browser}.',
  'installWelcome.note.useSafari': 'Can’t find it? Open this page in Safari and add it from there.',
  'installWelcome.note.useChrome': 'Can’t find it? Open this page in Chrome and add it from there.',
  // @max 32
  'installWelcome.continue': 'Continue in the browser',
  // @max 28
  'installWelcome.haveIt': 'I already have the app',
  // @max 24
  'installWelcome.never': 'Don’t show again',
  // @max 20
  'installWelcome.install': 'Install',
  // @max 20
  'installWelcome.copyLink': 'Copy link',
  // @max 20
  'installWelcome.copied': 'Link copied',
  'installWelcome.copyFailed': 'Couldn’t copy it. Copy the address from the address bar instead.',

  // ── Saving (the small marker beside the bell) ───────────────────────────────────────────
  // @max 16
  'sync.saving': 'Saving…',
  // @max 16
  // @note Red: the phone is offline, and the change is saved on the phone until it reconnects.
  'sync.offline': 'Offline. Saved',
  'sync.savingTitle': 'Saving your changes…',
  'sync.offlineTitle': 'You’re offline. Your changes are saved on this device and will sync automatically when the connection returns.',
  // @max 16
  // @note Red: the server answered but did not accept the save. The changes are kept on the device and tried again.
  'sync.error': 'Not saved yet',
  'sync.errorTitle': 'The server didn’t accept your last save. Your changes are kept on this device and will be tried again in a moment. If this stays, tell the office.',

  // ── The boot screen: before the company's data has loaded (CS-672) ──────────────────────
  // @note The whole screen, under a spinner, while the app loads the company's data after signing in.
  'boot.loading': 'Loading your workspace…',
  // @note Shown under the line above when loading takes longer than usual (a weak signal).
  'boot.slow': 'This is taking longer than usual. It opens as soon as everything has arrived.',
  // @max 40
  // @ph brand: the app's name
  'boot.unreachableTitle': 'Can’t reach {brand}',
  'boot.unreachableLead': 'Check your connection. The app keeps trying by itself and opens as soon as your company’s data arrives.',
  // @max 16
  'boot.retry': 'Try again',
  // @max 16
  'boot.signOut': 'Sign out',
  // @ph count: whole seconds until the next try
  'boot.retryIn': { one: 'Trying again in {count} second…', other: 'Trying again in {count} seconds…' },
  'boot.retrying': 'Trying again…',
  'boot.signOutFailed': 'Couldn’t sign out without a connection. Try again once you’re back online.',

  // ── A screen the phone hasn't kept, opened with no signal (CS-665) ──────────────────────
  // @max 40
  'offlineScreen.title': 'No signal',
  // @note Fills the page in place of a screen whose code the phone could not fetch. The app's menu stays; it opens by itself when the signal returns.
  'offlineScreen.body': 'This screen opens when you’re back online. Your other screens still work.',
  // @max 16
  'offlineScreen.back': 'Go back',

  // ── A role change catching up (a banner across the top) ─────────────────────────────────
  // @ph rosterRole: the access level the team list shows; accessRole: the access level the person actually has
  'roleSync.banner': 'Your team roster is being updated (roster shows “{rosterRole}”, your access is “{accessRole}”). Your access is correct; the roster will catch up shortly, or an owner can re-save your role in Settings → Team.',
  // @note Shown inside the banner above when the team list has no access level for the person.
  'roleSync.none': 'none',

  // ── A page you cannot open ──────────────────────────────────────────────────────────────
  // @max 40
  'noAccess.title': 'Page not available',
  'noAccess.body': 'You don’t have access to this page.',
  // @max 20
  'noAccess.home': 'Go home',
  'notFound.body': 'That page doesn’t exist. Or your role can’t see it.',
  // @max 24
  'notFound.home': 'Back to Dashboard',

  // ── The crash screen (the whole app hit an error) ───────────────────────────────────────
  // @max 40
  'crash.title': 'Something went wrong',
  'crash.body': 'The page hit an unexpected error. Reloading usually fixes it. Your data is safe.',
  // @max 16
  'crash.reload': 'Reload',
  'crash.reported': 'Thanks — it’s reported.',
  // @ph ref: a short reference code for the report, like 3FA9C2
  'crash.reportedRef': 'Thanks — it’s reported (reference <b>{ref}</b>).',
  // @max 24
  'crash.reporting': 'Reporting…',
  // @max 24
  'crash.report': 'Report this problem',
  'crash.reportFailed': 'That didn’t go through. Reload and use “Report an issue” in the menu.',

  // ── Signing in ──────────────────────────────────────────────────────────────────────────
  // @max 36
  'login.signInTo': 'Sign in to your workspace',
  // @max 36
  'login.setNew': 'Set a new password',
  // @max 30
  'login.email': 'Email',
  // @max 30
  'login.password': 'Password',
  // @max 24
  'login.forgot': 'Forgot password?',
  // @max 24
  'login.signIn': 'Sign in',
  // @max 24
  'login.signingIn': 'Signing in…',
  'login.needAccount': 'Need an account? Access is provisioned by your administrator.',
  // @max 30
  'login.newPassword': 'New password',
  // @max 30
  'login.atLeast8': 'At least 8 characters',
  // @max 30
  'login.confirmNew': 'Confirm new password',
  // @max 30
  'login.setAndSignIn': 'Set password & sign in',
  // @max 24
  'login.backToSignIn': 'Back to sign in',
  'login.enterEmailFirst': 'Enter your email above, then tap “Forgot password”.',
  'login.badEmail': 'Enter your full email address above, then tap “Forgot password?”.',
  'login.resetSent': 'If that email has an account, a password-reset link is on its way.',
  // @note the "Forgot password?" allowance: three reset emails an hour per address, ten asks an hour per network
  'login.resetTooMany': 'Too many reset requests for now. Check your inbox (and spam) for the latest email, or try again in an hour.',
  // @max 24
  // @note the "Forgot password?" link while its request is on its way
  'login.sending': 'Sending…',
  'login.tooShort': 'Password must be at least 8 characters.',
  'login.mismatch': 'Passwords do not match.',
  'login.setFailed': 'Could not set the new password. The link may have expired. Go back and request a new one.',
  'login.sessionExpired': 'Your session expired for your security. Please sign in again to continue.',
  'login.accountDisabled': 'This account has been disabled — contact an owner.',
  'login.notOnTeam': 'This account is no longer on the team — contact an owner.',
  'login.error.credentials': 'The email or password is incorrect. Double-check both. If you’ve forgotten your password, use “Forgot password?” below.',
  'login.error.notActivated': 'This account isn’t activated yet. Check your email for the setup link, or ask your administrator to resend your invite.',
  'login.error.tooMany': 'Too many attempts. Please wait a minute, then try again.',
  'login.error.unreachable': 'Couldn’t reach the server. Check your connection and try again in a moment.',
  'login.error.unavailable': 'Sign-in isn’t available right now. Please contact your administrator.',
  'login.error.generic': 'Sign in failed. Please try again.',

  // ── Report an issue (the form that goes to the support team) ────────────────────────────
  // @max 30
  'report.title': 'Report an issue',
  'report.intro': 'Tell us what went wrong. Your report goes straight to the support team, along with technical details from this session that help us fix it faster.',
  // @max 30
  'report.subjectLabel': 'What’s the issue?',
  'report.subjectPlaceholder': 'Short title, e.g. “Schedule won’t load on Fridays”',
  // @max 30
  'report.descLabel': 'What happened?',
  'report.descPlaceholder': 'What were you doing, what did you expect, and what happened instead?',
  // @max 20
  'report.priority': 'Priority',
  // @max 12
  'report.priority.normal': 'Normal',
  // @max 12
  'report.priority.high': 'High',
  // @max 12
  'report.priority.low': 'Low',
  'report.unavailable': 'Support is temporarily unavailable. Please try again shortly, or email your account manager.',
  'report.needTitle': 'Please give the issue a short title.',
  'report.failed': 'Something went wrong. Please try again.',
  'report.failedToast': 'Could not send the report.',
  // @max 20
  'report.sending': 'Sending…',
  // @max 20
  'report.send': 'Send report',
  // @max 30
  'report.sent': 'Report sent',
  // @ph ref: a short reference code for the report, like 3FA9C2
  'report.reference': 'Reference: <b>{ref}</b>',
  'report.notified': 'Our team has been notified. We’ll reach out if we need more detail.',
  // @max 24
  'report.files.label': 'Screenshots',
  'report.files.hint': 'Paste with Ctrl+V, drag files in, or browse. PNG, JPG, WebP, GIF or PDF.',
  // @max 20
  'report.files.addOne': 'Add file',
  // @max 20
  'report.files.addMore': 'Add files',
  'report.files.choose': 'Choose files',
  // @ph max: the most files one report can carry
  'report.files.limitTitle': '{max} files is the limit',
  // @ph max: the most files one report can carry
  'report.files.full': '{max} of {max}. That’s the limit',
  // @ph count: the most files one report can carry
  'report.files.limitReached': { one: 'That’s the limit. {count} file per report.', other: 'That’s the limit. {count} files per report.' },
  // @ph count: how many files were added; max: the most one report can carry
  'report.files.onlyFirst': { one: 'Only the first {count} file was added. {max} per report is the limit.', other: 'Only the first {count} files were added. {max} per report is the limit.' },
  // @ph name: the file's name
  'report.files.remove': 'Remove {name}',
  // @ph name: the file's name (or "That file")
  'report.files.badType': '{name} isn’t a supported type. Use PNG, JPG, WebP, GIF or PDF.',
  // @ph name: the file's name (or "That file"); size: how big it is, like 12.4 MB; limit: the largest allowed
  'report.files.tooBig': '{name} is {size}. The limit is {limit}.',
  // @note Stands in for a file's name when it has none, at the start of the two sentences above.
  'report.files.thatFile': 'That file',
  'report.files.none': 'No file',

  // ── Filling in an inspection (the supervisor's walk-through): the New Inspection form as Matt drew it (2026-10-09) ──
  // @max 40
  'inspectionFill.titleNew': 'New Inspection',
  // @max 30
  'inspectionFill.template': 'Template',
  'inspectionFill.templatePlaceholder': 'Select a published template…',
  'inspectionFill.templateSearch': 'Search templates…',
  'inspectionFill.noTemplates': 'No published templates',
  'inspectionFill.noTemplatesHint': 'No published inspection templates yet. Create and publish one first.',
  'inspectionFill.loadingTemplates': 'Loading the inspection templates…',
  'inspectionFill.templatesFailed': 'The inspection templates didn’t load.',
  // @max 16
  'inspectionFill.tryAgain': 'Try again',
  'inspectionFill.starting': 'Opening the checklist…',
  'inspectionFill.offline': 'No connection. An inspection starts and submits once you’re back online.',
  // @max 30
  'inspectionFill.location': 'Location',
  // @note An inspection is started at a location (CS-697): its photos and any ticket it opens are filed there.
  'inspectionFill.pickLocation': 'Pick a location',
  'inspectionFill.locationSearch': 'Search locations…',
  // @max 24
  'inspectionFill.start': 'Start inspection',
  'inspectionFill.pickTemplate': 'Pick a template',
  'inspectionFill.startFailed': 'Could not start the inspection',
  // @max 24
  // @note The score card's small heading above "5 of 7".
  'inspectionFill.scoreLabel': 'Checklist score',
  // @ph done: items ticked; total: items that apply (N/A ones left out)
  'inspectionFill.scoreOf': '{done} of {total}',
  // @ph done: items given a rating so far; total: items that apply (N/A ones left out)
  'inspectionFill.scoreRated': '{done} of {total} rated',
  // @note Every item was marked N/A, so there is nothing to score.
  'inspectionFill.scoreNone': 'Nothing to score',
  // @ph pct: the score, a whole number from 0 to 100
  'inspectionFill.scorePct': '{pct}%',
  // @max 24
  'inspectionFill.checklist': 'Checklist',
  'inspectionFill.untickedHint': 'An item left unticked counts as failed when you submit.',
  // @max 8
  // @note A small toggle on an item: it does not apply this time. Keep it very short.
  'inspectionFill.na': 'N/A',
  'inspectionFill.naAria': 'Doesn’t apply: {item}',
  // @ph item: the item's wording
  'inspectionFill.rateAria': 'Rating for {item}',
  // @max 16
  // @note A link on an item that opens a comment box. The client reads item comments on the report.
  'inspectionFill.comment': 'Comment',
  // @max 16
  'inspectionFill.commentEdit': 'Edit comment',
  'inspectionFill.commentAria': 'Comment on {item}',
  'inspectionFill.commentPlaceholder': 'What you saw (the client sees this on the report)',
  // @max 24
  'inspectionFill.photos': 'Photos',
  // @max 12
  // @note A photo tile: the photos taken before the work.
  'inspectionFill.before': 'Before',
  // @max 12
  // @note A photo tile: the photos taken after the work.
  'inspectionFill.after': 'After',
  'inspectionFill.addBefore': 'Add a before photo',
  'inspectionFill.addAfter': 'Add an after photo',
  // @ph count: how many photos are on this tile
  'inspectionFill.photoCount': { one: '{count} photo', other: '{count} photos' },
  'inspectionFill.photosNeedSite': 'Photos need a location. Start the inspection with one picked to add them.',
  // @max 30
  'inspectionFill.notes': 'Notes (optional)',
  'inspectionFill.notesPlaceholder': 'Anything the office should know…',
  'inspectionFill.notesHelp': 'For your team only: the client won’t see this on the report, the shared link, the PDF or any email. Put anything meant for the client in an item’s comment.',
  // @max 24
  'inspectionFill.submit': 'Submit Inspection',
  // @max 24
  'inspectionFill.submitting': 'Submitting…',
  'inspectionFill.submitted': 'Inspection submitted',
  'inspectionFill.submitFailed': 'Could not submit',
  // @note Stands in for a section with no name.
  'inspectionFill.areaFallback': 'Area',
  // @note Stands in for an item with no name.
  'inspectionFill.itemFallback': 'Item',
  // ── Finish it later: an inspection left open and continued (Matt, 2026-10-06) ──
  // @max 30
  // @note The form's title when an inspection left open earlier is reopened.
  'inspectionFill.titleContinue': 'Continue Inspection',
  // @max 40
  // @note A quiet line at the top of the form: every tick is saved as you go. Shown before the first change.
  'inspectionFill.draft.autosave': 'Saves as you go',
  // @max 40
  'inspectionFill.draft.saving': 'Saving…',
  // @max 40
  // @ph at: when it was last saved (a time today)
  'inspectionFill.draft.saved': 'Saved · {at, time}',
  // @max 50
  // @ph at: when it was last saved (an earlier day)
  'inspectionFill.draft.savedEarlier': 'Saved · {at, dateTime}',
  // @max 50
  // @note The last save did not reach the office; it is tried again by itself.
  'inspectionFill.draft.retry': 'Not saved, will retry',
  // @max 60
  'inspectionFill.draft.offlineKept': 'No signal: kept on this phone, will save when back online',
  'inspectionFill.draft.notOpen': 'This inspection is no longer open: it was submitted or discarded.',
  'inspectionFill.draft.notYours': 'Only the person who started this inspection, or the office, can work on it.',
  'inspectionFill.draft.gone': 'This inspection was discarded.',
  // @max 30
  // @note A button beside Submit: save the inspection and close it, to finish later.
  'inspectionFill.draft.saveLater': 'Save and finish later',
  'inspectionFill.draft.savedLater': 'Saved. Continue it from Inspections whenever you’re ready.',
  'inspectionFill.draft.savedOnDevice': 'Saved on this phone. It reaches the office when you have signal; open it again from Inspections to finish.',
  'inspectionFill.draft.opening': 'Opening the inspection…',
  'inspectionFill.draft.openFailed': 'The inspection didn’t open.',
  // @max 20
  // @note A badge on an inspection that was started and not yet submitted.
  'inspectionFill.draft.inProgress': 'In progress',
  // @max 40
  // @ph at: when the inspection was started
  'inspectionFill.draft.started': 'Started {at, dateTime}',
  // @max 30
  // @ph done: items answered so far; total: items on the checklist
  'inspectionFill.draft.answered': '{done} of {total} answered',
  // @max 16
  'inspectionFill.draft.continue': 'Continue',
  // @ph place: the building; at: when the inspection was started
  'inspectionFill.draft.continueAria': 'Continue the inspection at {place}, started {at, dateTime}',
  // @max 16
  'inspectionFill.draft.discard': 'Discard',
  // @ph place: the building; at: when the inspection was started
  'inspectionFill.draft.discardAria': 'Discard the inspection at {place}, started {at, dateTime}',
  // @max 40
  'inspectionFill.draft.discardTitle': 'Discard this inspection?',
  // @ph place: the building
  'inspectionFill.draft.discardMessage': 'The ticks, comments, notes and photos saved so far at {place} are deleted. This can’t be undone.',
  // @max 24
  'inspectionFill.draft.discardConfirm': 'Discard inspection',
  'inspectionFill.draft.discarded': 'Inspection discarded',
  'inspectionFill.draft.discardFailed': 'Could not discard the inspection',
  // @note Before a new inspection: this person already has one open at this building.
  'inspectionFill.resume.lead': 'You have an inspection in progress here.',
  // @ph building: the customer or building's name
  'inspectionFill.resume.leadAt': 'You have an inspection in progress at {building}.',
  // @max 50
  // @ph at: when it was started (today)
  'inspectionFill.resume.continueToday': 'Continue the one you started at {at, time}',
  // @max 60
  // @ph at: when it was started (an earlier day)
  'inspectionFill.resume.continueEarlier': 'Continue the one you started {at, dateTime}',
  // @max 30
  'inspectionFill.resume.startNew': 'Start a new one',

  // ── Inspections list: who in the office follows up a failed inspection ──────────────────
  // @max 30
  // @note The name of the picker on a failed inspection's row: the office person who follows it up.
  'inspections.followUp.assign': 'Assign follow-up',
  // @max 20
  // @note The follow-up picker's first row: nobody follows it up yet.
  'inspections.followUp.unassigned': 'Unassigned',

  // ── Checklist editor: translations (office, optional — the server translates on save) ────
  // @max 20
  'translations.tabWording': 'Wording',
  // @max 20
  'translations.tabTranslations': 'Translations',
  'translations.viewAria': 'Wording or translations',
  // @note The Translations view of a checklist or inspection template. Nobody has to check anything: the server translates on Save.
  'translations.introAuto': 'Each section and item is translated into Spanish and Haitian Creole automatically when you save. You can change any line here; your wording stays until the English changes.',
  'translations.languageAria': 'Language to view',
  // @ph done: how many lines have a translation; total: how many lines there are; language: the language's own name
  'translations.summary': '{done} of {total} lines in {language}',
  // @max 30
  // @note A line the server translated for today's English.
  'translations.auto': 'Translated automatically',
  // @max 30
  // @note A line the office typed itself; it stays until the English changes.
  'translations.edited': 'Edited',
  // @max 30
  // @note No line yet for today's English (new, or the English changed): the next Save translates it.
  'translations.pending': 'Translated when you save',
  'translations.demoNote': 'The demo has no translation service, so lines you add stay in English here.',
  'translations.nothing': 'Add sections and items first, then translate them here.',
  // @max 12
  // @note The template's own name, listed first in its Translations view.
  'translations.name': 'Name',
  // @max 12
  'translations.section': 'Section',
  // @max 12
  'translations.item': 'Item',
  // @ph language: the language's own name
  'translations.placeholder': 'In {language}…',
  // @ph english: the line in English; language: the language's own name
  'translations.inputAria': '{english}, in {language}',
  'translations.saveNote': 'Save to translate new or changed lines. Cleaners see them once the template is published.',

  // ── Messages: the inboxes, the thread list, starting a channel or a direct message ──────
  // @max 12
  // @icon
  // @note A tab: messages with customers (texts and email). Office only.
  'messages.inbox': 'Inbox',
  // @max 12
  // @icon
  // @note A tab: group conversations among the team.
  'messages.channels': 'Channels',
  // @max 12
  // @icon
  // @note A tab: private one-to-one messages between two team members ("direct messages").
  'messages.dms': 'DMs',
  // @max 16
  'messages.filters': 'Filters',
  'messages.filtersActive': 'filters active',
  // @max 16
  'messages.clearAll': 'Clear all',
  // @max 20
  // @note A filter heading: the KIND of message (text, email, internal, direct) — not the team channels above.
  'messages.filter.channels': 'Channels',
  // @max 10
  'messages.channel.sms': 'SMS',
  // @max 10
  'messages.channel.email': 'Email',
  // @max 10
  'messages.channel.internal': 'Internal',
  // @max 10
  'messages.channel.dm': 'DM',
  // @max 24
  'messages.filter.pinnedOnly': 'Pinned only',
  // @max 20
  'messages.filter.tags': 'Tags',
  'messages.filter.tagPlaceholder': 'Filter by tag…',
  // @max 20
  'messages.filter.dateRange': 'Date range',
  // @max 20
  'messages.date.24h': 'Last 24h',
  // @max 20
  'messages.date.7d': 'Last 7 days',
  // @max 20
  'messages.date.30d': 'Last 30 days',
  // @max 20
  'messages.date.all': 'All time',
  // @max 24
  'messages.filter.combine': 'Combine filters',
  // @max 14
  'messages.filter.matchAll': 'Match all',
  // @max 14
  'messages.filter.matchAny': 'Match any',
  // @max 16
  'messages.newDm': 'New DM',
  'messages.newDmTitle': 'Start a direct message with another user',
  // @max 20
  // @ph count: how many channels lost their creator
  'messages.orphaned': 'Orphaned ({count})',
  'messages.orphanedTitle': 'Channels whose creator was removed or is no longer active',
  // @max 20
  'messages.newChannel': 'New channel',
  'messages.newChannelTitle': 'Start a new channel',
  'messages.noChannelPermission': 'You lack permission to start channels',
  // @max 24
  'messages.newConversation': 'New conversation',
  'messages.newConversationTitle': 'Start a new conversation',
  'messages.noConversationPermission': 'You lack permission to start conversations',
  'messages.search': 'Search by name or message…',
  // @ph count: how many conversations are listed
  'messages.threadCount': { one: '{count} thread', other: '{count} threads' },
  // @ph shown: how many are listed after filtering; total: how many there are
  'messages.threadCountFiltered': '{shown} of {total}',
  // @max 12
  'messages.done': 'Done',
  'messages.noConversations': 'No conversations',
  'messages.noConversationsHint': 'Try a different inbox or clear your filters.',
  // @max 30
  'messages.yourChannels': 'Your channels',
  // @max 30
  'messages.teamChannels': 'Team channels',
  // @max 30
  'messages.pinned': 'Pinned',
  // @max 30
  'messages.allConversations': 'All conversations',
  'messages.unknownUser': 'Unknown user',
  'messages.teamDiscussion': 'Team discussion',
  // @note A customer conversation not linked to any contact.
  'messages.unlinked': 'Unlinked',
  'messages.noMessagesYet': 'No messages yet',
  // @ph name: the conversation's name
  'messages.rowActions': 'Actions for {name}',
  'messages.actions': 'Actions',
  // @max 24
  'messages.select': 'Select',
  // @max 24
  'messages.markRead': 'Mark as read',
  // @max 24
  'messages.markUnread': 'Mark as unread',
  // @max 24
  'messages.delete': 'Delete',
  'messages.deleteOnlyCreator': 'Only the thread’s creator or a Super Admin can delete it',
  // @ph name: the conversation's name
  'messages.selectRow': 'Select {name}',
  'messages.youCreated': 'You created this thread',
  'messages.youMuted': 'You silenced notifications for this thread',
  'messages.muted': 'Notifications silenced',
  // @ph count: unread messages
  'messages.unreadCount': { one: '{count} unread', other: '{count} unread' },
  // @max 10
  'messages.pin': 'Pin',
  // @max 10
  'messages.unpin': 'Unpin',
  'messages.bulkActions': 'Bulk actions',
  // @max 20
  'messages.selectAll': 'Select all',
  // @max 20
  'messages.deselectAll': 'Deselect all',
  // @ph count: how many are selected
  'messages.selectedCount': '<b>{count}</b> selected',
  // @max 16
  'messages.markReadShort': 'Mark read',
  // @max 16
  'messages.markUnreadShort': 'Mark unread',
  'messages.bulkDeleteHint': 'Permanently delete selected threads (only those you can delete will be removed)',
  'messages.resizeList': 'Resize thread list',
  'messages.resizeContext': 'Resize context panel',
  'messages.dragToResize': 'Drag to resize',
  'messages.deletedForEveryone': 'Thread deleted for everyone.',
  'messages.noPhone': 'Contact has no phone number on file.',
  'messages.noEmail': 'Contact has no email address on file.',
  'messages.cantDelete': 'You can’t delete this thread. Only its creator or a Super Admin can.',
  'messages.cantDeleteAny': 'You can’t delete any of the selected threads. Only their creators or a Super Admin can.',
  // @ph count: threads deleted; skipped: threads the person was not allowed to delete
  'messages.deletedSome': { one: 'Deleted {count} thread; skipped {skipped} you couldn’t delete.', other: 'Deleted {count} threads; skipped {skipped} you couldn’t delete.' },
  // @ph count: threads deleted
  'messages.deletedAll': { one: 'Deleted {count} thread for everyone.', other: 'Deleted {count} threads for everyone.' },
  'messages.deleteTitle': 'Permanently delete this thread?',
  // @ph count: how many messages the thread has
  'messages.deleteMessage': { one: 'This permanently deletes the thread and its {count} message for everyone. This cannot be undone.', other: 'This permanently deletes the thread and all {count} messages for everyone. This cannot be undone.' },
  'messages.deleteMessageAny': 'This permanently deletes the thread and all of its messages for everyone. This cannot be undone.',
  // @max 20
  'messages.deleteForever': 'Delete forever',
  // @ph count: how many threads
  'messages.bulkDeleteTitle': { one: 'Permanently delete {count} thread?', other: 'Permanently delete {count} threads?' },
  'messages.bulkDeleteTitleAny': 'Permanently delete threads?',
  // @ph count: how many threads
  'messages.bulkDeleteMessage': { one: 'This permanently deletes {count} selected thread and every message in it, for everyone. This cannot be undone.', other: 'This permanently deletes {count} selected threads and every message in them, for everyone. This cannot be undone.' },
  // @ph count: how many other threads will be left alone
  'messages.bulkDeleteSkipped': { one: '{count} other thread you can’t delete will be skipped.', other: '{count} other threads you can’t delete will be skipped.' },
  // @max 40
  'messages.newDmModalTitle': 'New direct message',
  'messages.newDmIntro': 'Pick a teammate to start a private 1:1 conversation. Only the two of you can see it.',
  'messages.searchTeammates': 'Search teammates by name or email…',
  'messages.noMatchingTeammates': 'No matching teammates.',
  // @ph name: the teammate's name
  'messages.dmOpened': 'DM with {name} opened',
  // @note Stands in for a teammate's name when it is missing.
  'messages.someone': 'user',
  'messages.newChannelIntro': 'Pick the teammates who should see this channel, or select everyone in the org. You’re included automatically.',
  // @max 30
  'messages.channelTitle': 'Title',
  'messages.channelTitlePlaceholder': 'e.g. Holiday schedule planning',
  // @max 30
  'messages.members': 'Members',
  // @max 30
  // @ph count: how many teammates are picked
  'messages.membersSelected': 'Members ({count} selected)',
  'messages.searchMembers': 'Search teammates…',
  'messages.clearMembers': 'Clear member selection',
  'messages.selectEveryone': 'Select everyone in the org',
  // @max 16
  'messages.selectAllMembers': 'Select All',
  'messages.teammates': 'Teammates',
  'messages.noTeammates': 'No other teammates yet.',
  'messages.noTeammatesMatch': 'No teammates match your search.',
  // @max 30
  'messages.firstMessage': 'First message (optional)',
  'messages.firstMessagePlaceholder': 'Kick off the discussion…',
  // @max 20
  'messages.createChannel': 'Create channel',
  // @ph title: the new channel's title
  'messages.channelCreated': 'Channel “{title}” created',

  // ── Messages: one conversation (the thread, the composer, email) ────────────────────────
  'messages.pickConversation': 'Select a conversation',
  'messages.pickConversationHint': 'Pick a thread from the list to start chatting.',
  // @note A link named a conversation that was deleted, or one this person is not part of (CS-149).
  'messages.unavailable.title': 'This conversation isn’t available',
  'messages.unavailable.body': 'It may have been deleted, or you may not be part of it.',
  // @max 24
  'messages.unavailable.back': 'Back to conversations',
  'messages.noMessagesYetDot': 'No messages yet.',
  'messages.backToInbox': 'Back to inbox',
  'messages.dmSub': 'Direct message · only the two of you can see this',
  'messages.internalChannel': 'Internal team channel',
  // @ph name: who created the channel (with "(removed)" or "(inactive)" after it when they have left)
  'messages.internalChannelBy': 'Internal team channel · Created by {name}',
  // @ph name: a person's name
  'messages.creatorInactive': '{name} (inactive)',
  // @ph name: a person's name
  'messages.creatorRemoved': '{name} (removed)',
  'messages.noContactInfo': 'No contact info',
  // @max 6
  // @note A red tag: this customer asked not to be contacted ("Do Not Contact").
  'messages.dnc': 'DNC',
  'messages.star': 'Star',
  'messages.unstar': 'Unstar',
  'messages.snooze': 'Snooze notifications for this thread',
  'messages.snoozed': 'Snoozed. Click to un-snooze notifications',
  'messages.snoozeAria': 'Snooze notifications',
  'messages.unsnoozeAria': 'Un-snooze notifications',
  'messages.deleteThread': 'Delete thread',
  'messages.deleteThreadTitle': 'Permanently delete the thread and all messages for everyone',
  // @max 12
  'messages.today': 'Today',
  // @max 12
  'messages.yesterday': 'Yesterday',
  // @ph name: the teammate's first name
  'messages.compose.dm': 'Message {name}…',
  'messages.compose.dmSomeone': 'Message teammate…',
  'messages.compose.internal': 'Internal note. Only your team can see this.',
  'messages.compose.text': 'Type a text…',
  'messages.compose.email': 'Type a message…',
  // @max 16
  'messages.send': 'Send',
  // @max 20
  'messages.reviewAndSend': 'Review & Send',
  // @max 12
  // @note Beside a two-way switch over the message box: send this reply as a text (SMS) or an email.
  'messages.sendAs': 'Send as',
  'messages.compose.hint':'Enter to send · Shift+Enter for new line',
  'messages.compose.hintEmail': 'Review & Send opens a preview · Enter for new line',
  // @max 20
  'messages.email.sendingAs': 'Sending as:',
  // @note After the inbox chosen by default.
  'messages.email.default': '(default)',
  // @ph provider: Gmail, Microsoft or SMTP
  'messages.email.via': 'via {provider}',
  'messages.email.noInbox': '<b>No connected inbox.</b> <link>Connect Gmail, Outlook, or SMTP</link> so emails come from your real address.',
  // @max 20
  'messages.email.subjectLabel': 'Subject:',
  'messages.email.subjectRequired': 'Subject (required for new threads)',
  'messages.email.subject': 'Subject',
  // @max 8
  'messages.email.cc': 'Cc',
  // @max 8
  'messages.email.bcc': 'Bcc',
  // @max 8
  'messages.email.ccLabel': 'Cc:',
  // @max 8
  'messages.email.bccLabel': 'Bcc:',
  'messages.email.hideCc': 'Hide Cc',
  'messages.email.hideBcc': 'Hide Bcc',
  // @max 16
  'messages.email.attach': 'Attach',
  'messages.email.remove': 'Remove',
  // @max 12
  'messages.email.from': 'From:',
  // @max 12
  'messages.email.to': 'To:',
  // @max 12
  'messages.email.date': 'Date:',
  'messages.email.you': 'You',
  'messages.email.unknownSender': 'Unknown',
  'messages.email.untitled': 'Email',
  'messages.email.noSubject': '(no subject)',
  'messages.email.noRecipient': 'No recipient email on this thread',
  'messages.email.replyOrForward': 'Reply or forward',
  // @max 16
  'messages.email.reply': 'Reply',
  // @max 16
  'messages.email.replyAll': 'Reply All',
  // @max 16
  'messages.email.forward': 'Forward',
  'messages.email.pick': 'Choose <b>Reply</b> to answer the sender, <b>Reply All</b> to include everyone on the thread, or <b>Forward</b> to send it on to someone else.',
  'messages.email.dnc': 'This contact is marked <b>Do Not Contact</b>. Only reply if they contacted you first.',
  'messages.email.multiHint': 'Sending to more than one person? Separate addresses with a comma. E.g. <code>alex@acme.com, sam@acme.com</code>.',
  'messages.email.forwardNote': 'Add a note. The original is quoted below…',
  'messages.email.replyPlaceholder': 'Type your reply…',
  'messages.email.signatureNote': 'Your signature is added when you send',
  // @ph action: the name of the send button ("Send" or "Forward")
  'messages.email.sendHint': 'Click {action} or ⌘/Ctrl+Enter to send · Enter for new line',
  'messages.email.needForwardTo': 'Add someone to forward to.',
  'messages.email.needTo': 'Add a recipient in the To field.',
  // @max 24
  'messages.email.review': 'Review & send',
  // @max 20
  'messages.email.backToEdit': 'Back to edit',
  // @ph count: how many files are attached
  'messages.email.attachments': { one: '{count} attachment', other: '{count} attachments' },
  // @max 16
  'messages.email.open': 'Open',
  // @max 16
  'messages.email.readReply': 'Read & Reply',
  // @ph name: the file's name; size: its size, like 31.2 MB; max: the largest allowed
  'messages.email.fileTooBig': '“{name}” is {size}. Over the {max} limit.',
  // @ph count: how many files; max: the largest allowed per file
  'messages.email.filesTooBig': '{count} files exceeded the {max} per-file limit and were skipped.',
  // @max 24
  'messages.failed.label': 'Failed to deliver',
  // @max 16
  'messages.failed.channel': 'Channel',
  // @max 16
  'messages.failed.why': 'Why',
  // @max 16
  'messages.failed.reference': 'Reference',
  // @ph code: an error number from the text-message or email service
  'messages.failed.error': 'Error {code}',
  'messages.failed.noRecipient': 'No recipient',
  'messages.failed.notConfigured': 'Not configured',
  'messages.failed.bounced': 'Bounced',
  'messages.failed.authExpired': 'Auth expired',
  // @max 14
  'messages.status.queued': 'Queued',
  // @max 14
  'messages.status.sending': 'Sending',
  // @max 14
  'messages.status.sent': 'Sent',
  // @max 14
  'messages.status.delivered': 'Delivered',
  // @max 14
  'messages.status.received': 'Received',
  // @max 14
  'messages.status.undelivered': 'Undelivered',

  // ── Messages: the side panel beside a conversation ──────────────────────────────────────
  'messages.ctx.pickConversation': 'Select a conversation to see contact details.',
  // @max 16
  'messages.ctx.tab.contact': 'Contact',
  // @max 16
  'messages.ctx.tab.activities': 'Activities',
  // @max 16
  'messages.ctx.tab.notes': 'Notes',
  // @max 24
  'messages.ctx.contact': 'Contact',
  'messages.ctx.notLinked': 'This conversation isn’t linked to a contact yet.',
  'messages.ctx.linkContact': 'Link a contact…',
  // @ph name: a contact's name; email: the email address
  'messages.ctx.emailTaken': '{name} already uses {email}',
  'messages.ctx.contactUpdated': 'Contact updated',
  // @max 24
  'messages.ctx.details': 'Details',
  // @max 12
  'messages.ctx.edit': 'Edit',
  // @max 16
  'messages.ctx.email': 'Email',
  // @max 16
  'messages.ctx.phone': 'Phone',
  // @max 16
  'messages.ctx.title': 'Title',
  // @max 16
  // @note Short for "department".
  'messages.ctx.department': 'Dept.',
  // @max 16
  'messages.ctx.company': 'Company',
  // @max 16
  'messages.ctx.lastActivity': 'Last activity',
  // @max 16
  'messages.ctx.created': 'Created',
  'messages.ctx.participantMissing': 'Participant not found',
  // @max 20
  'messages.ctx.directMessage': 'Direct Message',
  // @max 12
  'messages.ctx.inactive': 'Inactive',
  // @max 24
  'messages.ctx.participant': 'Participant',
  // @max 16
  'messages.ctx.name': 'Name',
  // @max 16
  'messages.ctx.role': 'Role',
  // @max 16
  'messages.ctx.status': 'Status',
  // @max 12
  'messages.ctx.active': 'Active',
  'messages.ctx.participantGone': 'The other participant could not be found. They may have been removed.',
  // @max 24
  'messages.ctx.privacy': 'Privacy',
  'messages.ctx.dmPrivacy': 'Direct messages are visible only to the two participants. Owners and admins cannot read this thread unless they’re a participant.',
  'messages.ctx.internalOnly': 'Internal-only channel. Not visible to clients.',
  // @max 24
  'messages.ctx.participants': 'Participants',
  'messages.ctx.noParticipants': 'No participants yet.',
  'messages.ctx.everyoneIn': 'Everyone is already in this channel.',
  // @max 24
  'messages.ctx.addParticipant': 'Add participant',
  'messages.ctx.noContactLinked': 'No contact linked',
  // @ph channel: SMS or EMAIL
  'messages.ctx.channelConversation': '{channel} conversation',
  'messages.ctx.unlinkedConversation': 'Unlinked conversation',
  // @max 16
  'messages.ctx.lifecycle.lead': 'Lead',
  // @max 16
  'messages.ctx.lifecycle.prospect': 'Prospect',
  // @max 16
  'messages.ctx.lifecycle.client': 'Client',
  // @max 16
  'messages.ctx.lifecycle.vendor': 'Vendor',
  // @max 24
  'messages.ctx.tags': 'Tags',
  'messages.ctx.noTags': 'No tags',
  'messages.ctx.noActivity': 'No activity yet.',
  'messages.ctx.linkForActivity': 'Link a contact to see their activity.',
  // @max 24
  // @ph count: how many invoices
  'messages.ctx.invoices': 'Invoices ({count})',
  'messages.ctx.noInvoices': 'No invoices linked.',
  'messages.ctx.linkForInvoices': 'Link a contact to see related invoices.',
  // @max 24
  // @ph count: how many jobs (cleans)
  'messages.ctx.jobs': 'Jobs ({count})',
  'messages.ctx.noJobs': 'No jobs linked via this contact’s client.',
  'messages.ctx.linkForJobs': 'Link a contact to see related jobs.',
  'messages.ctx.service': 'Service',
  // @max 14
  'messages.ctx.invoice.paid': 'Paid',
  // @max 14
  'messages.ctx.invoice.overdue': 'Overdue',
  // @max 14
  'messages.ctx.invoice.pending': 'Pending',
  // @max 14
  'messages.ctx.invoice.draft': 'Draft',
  // @max 14
  'messages.ctx.job.upcoming': 'upcoming',
  // @max 14
  'messages.ctx.job.in_progress': 'in progress',
  // @max 14
  'messages.ctx.job.done': 'done',
  // @max 14
  'messages.ctx.job.cancelled': 'cancelled',
  // @max 24
  'messages.ctx.notes': 'Notes',
  'messages.ctx.linkForNotes': 'Link a contact to add notes.',
  'messages.ctx.noteAdded': 'Note added',
  // @note The keyboard shortcut to save: Command (or Ctrl) and Return.
  'messages.ctx.saveShortcut': '⌘↵ to save',
  'messages.ctx.notePlaceholder': 'Call recap, follow-up, decision…',
  // @max 20
  'messages.ctx.appendNote': 'Append note',
  'messages.ctx.noNotes': 'No notes yet. Notes are timestamped and appended in order.',

  // ── Messages: the small dock (desktop) ──────────────────────────────────────────────────
  // @max 16
  'messages.dock.messages': 'Messages',
  // @ph name: the conversation's name
  'messages.dock.conversationWith': 'Conversation with {name}',
  'messages.dock.back': 'Back to messages',
  'messages.dock.openFull': 'Open in full Messaging',
  'messages.dock.openFullShort': 'Open full Messaging',
  'messages.dock.close': 'Close messages',
  'messages.dock.empty': 'No conversations here yet.',
  // @ph count: unread messages
  'messages.dock.launcherAria': { one: 'Messages, {count} unread', other: 'Messages, {count} unread' },
  'messages.channelName': 'Channel name',
  'messages.rename': 'Rename this channel',
  // @max 12
  // @icon
  'messages.dock.dm': 'DM',
  'messages.dock.subDm': 'Direct message',
  'messages.dock.subChannel': 'Team channel',
  'messages.dock.subEmail': 'Email',
  'messages.dock.subText': 'Text',
  // @ph when: how long ago, like 5m or 3d
  'messages.orphan.active': 'Active {when}',
  'messages.orphan.neverActive': 'Never active',

  // ── Customer messages: Messaging → Customers, and a customer's Messages tab (office) ────────
  // @note Each building has ONE conversation with the office, written from the customer hub.
  // @max 16
  'custMsg.tab': 'Customers',
  // @max 16
  'custMsg.customerTab': 'Messages',
  // @max 12
  'custMsg.list.mine': 'Mine',
  // @max 12
  'custMsg.list.all': 'All',
  // @max 12
  // @note The conversations whose customer is waiting for the office's reply, the longest wait first.
  'custMsg.list.waiting': 'Waiting',
  'custMsg.list.scope': 'Which conversations to show',
  // @max 24
  'custMsg.filter.manager': 'Manager',
  // @max 24
  'custMsg.filter.anyManager': 'All managers',
  // @max 24
  'custMsg.filter.customer': 'Customer',
  // @max 24
  'custMsg.filter.anyCustomer': 'All customers',
  'custMsg.list.count': { one: '{count} conversation', other: '{count} conversations' },
  'custMsg.list.unread': { one: '{count} unread message', other: '{count} unread messages' },
  'custMsg.list.empty': 'No customer messages yet',
  'custMsg.list.emptyHint': 'When a customer writes from the customer hub, the conversation shows up here.',
  'custMsg.list.emptyFiltered': 'No conversations match these filters.',
  // @ph count: how many conversations are waiting for the office's reply
  'custMsg.list.waitingCount': { one: '{count} waiting for a reply', other: '{count} waiting for a reply' },
  'custMsg.list.emptyWaiting': 'No customer is waiting for a reply',
  'custMsg.list.emptyWaitingHint': 'A customer’s message shows here until the office answers it, the longest wait first.',
  // @max 20
  // @note A customer's message, written moments ago, that the office has not answered yet.
  'custMsg.wait.justNow': 'Waiting just now',
  // @max 20
  // @ph time: how long the customer has waited for the office's reply, e.g. 50m
  'custMsg.wait.for': 'Waiting {time, duration}',
  // @max 20
  // @ph count: how many days the customer has waited for the office's reply
  'custMsg.wait.days': { one: 'Waiting {count} day', other: 'Waiting {count} days' },
  'custMsg.list.noManager': 'No manager',
  // @note The word for the rows under the list's pager: "Showing 1–20 of 45 conversations".
  'custMsg.list.noun': 'conversations',
  'custMsg.thread.pick': 'Pick a conversation',
  'custMsg.thread.pickHint': 'Choose a customer to read their messages and reply.',
  'custMsg.thread.manager': 'Manager: {name}',
  'custMsg.thread.noManager': 'No manager assigned',
  'custMsg.thread.back': 'Back to the conversations',
  'custMsg.thread.openCustomer': 'Open the customer page',
  'custMsg.thread.empty': 'No messages yet',
  'custMsg.thread.emptyHint': 'Write the first message. Everyone at the customer who can see this building in the customer hub can read it.',
  'custMsg.thread.loadEarlier': 'Show earlier messages',
  // @max 24
  // @note Shown as the author of a customer's line when their name is no longer on file.
  'custMsg.thread.customer': 'Customer',
  // @max 24
  // @note Shown as the author of an office line when the person is no longer on file.
  'custMsg.thread.staff': 'Staff',
  'custMsg.thread.placeholder': 'Write to {customer}…',
  // @max 16
  'custMsg.thread.send': 'Send',
  // @max 16
  'custMsg.thread.sending': 'Sending…',
  'custMsg.thread.noReply': 'You can read these messages. Replying needs the “Reply to customer messages” permission.',
  'custMsg.thread.shared': 'The customer reads this conversation in the customer hub.',
  'custMsg.error.list': 'The conversations could not be loaded.',
  'custMsg.error.load': 'The messages could not be loaded.',
  'custMsg.error.send': 'The message was not sent.',
  // @max 32
  'custMsg.ctx.title': 'About this building',
  // @max 24
  'custMsg.ctx.number': 'Customer number',
  // @max 24
  'custMsg.ctx.manager': 'Manager',
  // @max 24
  'custMsg.ctx.audience': 'Who reads this',
  'custMsg.ctx.audienceText': 'Everyone at the customer who can see this building in the customer hub, and the office.',
  // ── A customer's text reply in the conversation, and the office's answer texted back ─────
  // @note Beside the name on a customer's message that came in as a text message.
  // @ph phone: the phone number the text came from, like (754) 203-9207
  'custMsg.text.from': 'Text from {phone}',
  // @note Under the office's reply: it was also sent as a text message.
  // @ph phone: the phone number it was texted to
  'custMsg.text.sent': 'Also texted to {phone}',
  // @ph phone: the phone number it is being texted to
  'custMsg.text.sending': 'Texting {phone}…',
  // @note STOP is the word the customer texted to turn texts off; keep it in capitals, untranslated.
  // @ph phone: the phone number that turned texts off
  'custMsg.text.optedOut': 'Not texted: {phone} replied STOP',
  'custMsg.text.notSetUp': 'Not texted: texting is not set up',
  // @note A made-up customer used for trying the app out is never texted.
  'custMsg.text.sample': 'Not texted: sample customer',
  // @ph phone: the phone number the text was meant for
  'custMsg.text.failed': 'The text to {phone} did not go through',
  // @note Above the reply box when the customer's newest message came in as a text.
  // @ph phone: the phone number the customer texted from
  'custMsg.text.next': 'Your reply is also texted to {phone}, the number this customer texted from.',
  // @note STOP is the word the customer texted to turn texts off; keep it in capitals, untranslated.
  // @ph phone: the phone number that turned texts off; date: the day it did, like Oct 28, 2026
  'custMsg.text.nextOff': 'Texts are off for {phone} (it replied STOP on {date}), so your reply is not texted.',

  // ── A phone number that turned texts off (the customer page) ───────────────────────────
  // @note Under a phone number. STOP is the word the customer texted; keep it in capitals, untranslated.
  // @ph date: the day the number replied STOP, like Oct 28, 2026
  'textsOff.note': 'Texts off: replied STOP on {date}',
  'textsOff.hint': 'This number texted STOP, so no text goes to it. Texts start again only if it texts START.',

  // ── How long ago, in a sentence ─────────────────────────────────────────────────────────
  // @ph when: how long ago, like 5m or 3d
  'ago.edited': 'edited {when}',
  // @ph when: how long ago, like 5m or 3d
  'ago.updated': 'Updated {when}',
  // @ph when: how long ago, like 5m or 3d; name: who changed it
  'ago.updatedBy': 'Updated {when} by {name}',

  // ── A list's pager and search box (every table) ─────────────────────────────────────────
  // @ph start: the first row shown; end: the last row shown; total: how many rows; noun: what the rows are ("punches", "cleans"…)
  'pager.showing': 'Showing {start}–{end} of {total} {noun}',
  // @max 20
  // @ph page: this page's number; pages: how many pages
  'pager.page': 'Page {page} of {pages}',
  // @max 16
  'tableSearch.placeholder': 'Search',
  'tableSearch.clear': 'Clear search',
  // @note What a list's rows are, after "Showing 1–25 of 300 …".
  'pager.noun.punches': 'punches',
  // @note A cleaner's pending hours, one per person (Hours Approval).
  'pager.noun.timesheets': 'timesheets',
  'pager.noun.cleans': 'cleans',
  'pager.noun.weeks': 'weeks',
  'pager.noun.requests': 'requests',
  // @note Supplies by building: the buildings in the list.
  'pager.noun.buildings': 'buildings',
  'pager.noun.items': 'items',
  'pager.noun.results': 'results',

  // ── A clock punch: the words every time screen shares ───────────────────────────────────
  'punch.refusal.stale': 'This punch changed since you opened it. Reload and try again.',
  'punch.refusal.paidLocked': 'This time was already paid in a closed payroll. Add a correcting entry instead.',
  'punch.refusal.outOfScope': "That location isn't one of yours.",
  'punch.refusal.ownEntry': 'A Super Admin approves or changes your own time.',
  'punch.refusal.invalidTimes': "Those clock times don't look right. Check them and try again.",
  'punch.refusal.reasonRequired': 'A reason is required.',
  'punch.refusal.notClosed': "It's still on the clock.",
  'punch.refusal.voided': 'This time was deleted. Restore it first.',
  'punch.refusal.rejectRemoved': 'Reject was replaced by Delete. Reload the app.',
  'punch.refusal.missingIn': 'A clock-in time is required.',
  'punch.refusal.inFuture': 'That clock-in is in the future.',
  'punch.refusal.outBeforeIn': 'Clock-out has to be after clock-in.',
  'punch.refusal.tooLong': "That's longer than 24 hours — check the times.",
  'punch.refusal.missingOut': "A closed punch can't have its clock-out cleared.",
  // @max 32
  'punch.geo.offForCleaner': 'Geofence off for this cleaner',
  // @max 32
  'punch.geo.offAtLocation': 'Geofence off at this location',
  // @max 32
  'punch.geo.manualEntry': 'Manual entry',
  // @max 32
  'punch.geo.legacyOffsite': 'Clocked in off-site',
  // @max 30
  'punch.flag.offSiteIn': 'Off-site clock-in',
  // @max 40
  // @ph feet: how far from the location, in feet
  'punch.flag.offSiteInAway': 'Off-site clock-in · {feet, number} ft',
  // @max 30
  'punch.flag.offSiteOut': 'Off-site clock-out',
  // @max 40
  // @ph feet: how far from the location, in feet
  'punch.flag.offSiteOutAway': 'Off-site clock-out · {feet, number} ft',
  // @max 30
  'punch.flag.noLocationIn': 'No location at clock-in',
  // @max 30
  'punch.flag.noLocationOut': 'No location at clock-out',
  // @max 16
  'punch.flag.override': 'Override',
  // @max 40
  // @ph label: why the location check was skipped
  'punch.flag.overrideAtOut': '{label} at clock-out',
  // @max 16
  // @note The punch was saved on the phone without a connection and sent later.
  'punch.flag.offline': 'Offline',
  // @max 20
  'punch.flag.checklistUnknown': 'Checklist unknown',
  // @max 20
  // @ph done: items done; total: items on the checklist
  'punch.flag.checklist': 'Checklist {done}/{total}',
  // @max 24
  'punch.flag.overlap': 'Two cleans at once',
  // @max 16
  'punch.flag.autoClosed': 'Auto-closed',
  // @max 28
  // @note An approval-queue chip (CS-667): the app closed this punch, and the cleaner had clocked in after the clean's scheduled end.
  'punch.flag.autoClosedLate': 'Auto-closed · late start',
  // @max 16
  'punch.flag.manual': 'Manual',
  // @max 16
  'punch.flag.edited': 'Edited',
  // @max 20
  'punch.flag.cleanCancelled': 'Clean cancelled',
  // @max 20
  // @ph hours: overtime hours, like 1.5
  'punch.flag.ot': 'incl. {hours}h OT',
  // @max 20
  'punch.status.deleted': 'Deleted',
  // @max 20
  'punch.status.onTheClock': 'On the clock',
  // @max 20
  'punch.status.noShow': 'No-show',
  // @max 20
  'punch.status.approved': 'Approved',
  // @max 20
  'punch.status.rejected': 'Rejected',
  // @max 20
  'punch.status.autoClosed': 'Auto-closed',
  // @max 20
  'punch.status.pending': 'Pending review',
  // @max 14
  'punch.geo.onSite': 'On-site',
  // @max 14
  'punch.geo.offSite': 'Off-site',
  // @max 14
  'punch.geo.noGps': 'No GPS',

  // ── Time clock (the supervisor's punch history) ─────────────────────────────────────────
  // @max 30
  'timeClock.title': 'Time Clock',
  'timeClock.intro': 'Every crew clock-in and clock-out: who, where, when, how long. The same history appears on each account’s <b>Time clock</b> tab, each crew member’s page and each clean; the Variance report compares it against expected time.',
  // @max 30
  'timeClock.allPunches': 'All punches',
  // @max 30
  'timeClock.defaultTitle': 'Time clock',
  // @max 12
  'timeClock.period.7d': '7 days',
  // @max 12
  'timeClock.period.30d': '30 days',
  // @max 12
  'timeClock.period.90d': '90 days',
  'timeClock.period': 'Period',
  'timeClock.search': 'Search punches',
  // @ph shown: rows matching the search; total: rows loaded
  'timeClock.searchCount': '{shown} of {total}',
  // @max 16
  'timeClock.addTime': 'Add time',
  // @max 20
  'timeClock.customer': 'Customer',
  // @max 20
  'timeClock.cleaner': 'Cleaner',
  'timeClock.allCustomers': 'All customers',
  'timeClock.allCleaners': 'All cleaners',
  'timeClock.outOfScope': 'This isn’t one of your locations.',
  'timeClock.noLocations': 'No locations are assigned to you yet',
  'timeClock.noLocationsHint': 'A Super Admin assigns each location’s manager on the customer’s Service setup.',
  'timeClock.loading': 'Loading clock history…',
  'timeClock.loadFailed': 'Could not load clock history',
  'timeClock.empty': 'No clock-ins here yet',
  'timeClock.emptyClean': 'Nobody has clocked in to this clean.',
  'timeClock.emptyWindow': 'No crew clock-ins in this window — try a longer period.',
  'timeClock.noMatch': 'No matching punches',
  // @ph query: what was typed in the search box
  'timeClock.noMatchHint': 'Nothing matches “{query}”. Try a name, location, date or status.',
  // @ph count: how many punches; duration: the total time, like 12h 30m
  'timeClock.summary': { one: '{count} punch · {duration} clocked', other: '{count} punches · {duration} clocked' },
  // @ph count: how many people are on the clock now
  'timeClock.summaryOpen': '<b>{count} on the clock now</b>',
  // @ph count: the most rows shown at once
  'timeClock.summaryTruncated': 'showing the newest {count} — narrow the period for the rest',
  // @max 16
  'timeClock.col.date': 'Date',
  // @max 16
  'timeClock.col.cleaner': 'Cleaner',
  // @max 16
  'timeClock.col.location': 'Location',
  // @max 10
  'timeClock.col.in': 'In',
  // @max 10
  'timeClock.col.out': 'Out',
  // @max 16
  'timeClock.col.duration': 'Duration',
  // @max 16
  'timeClock.col.status': 'Status',
  // @max 12
  'timeClock.soFar': 'so far',
  'timeClock.approved': 'Entry approved',
  'timeClock.approveFailed': 'Could not approve this entry',
  'timeClock.updateFailed': 'Could not update the entry',
  // @max 30
  'timeClock.detail.title': 'Punch details',
  // @max 20
  'timeClock.detail.cleaner': 'Cleaner',
  // @max 20
  'timeClock.detail.location': 'Location',
  // @max 20
  'timeClock.detail.in': 'Clock-in',
  // @max 20
  'timeClock.detail.out': 'Clock-out',
  'timeClock.detail.stillOn': 'Still on the clock',
  // @max 20
  'timeClock.detail.duration': 'Duration',
  // @max 20
  'timeClock.detail.status': 'Status',
  // @max 20
  'timeClock.detail.approvedBy': 'Approved by',
  'timeClock.detail.aManager': 'A manager',
  // @max 24
  'timeClock.detail.locationCheck': 'Location check',
  // @ph feet: how far from the location, in feet
  'timeClock.detail.feetFromSite': '{feet, number} ft from site',
  'timeClock.detail.atClockIn': 'at clock-in',
  // @ph reason: the reason written down when the check was skipped
  'timeClock.detail.override': 'Override: {reason}',
  // @max 24
  'timeClock.detail.outLocation': 'Clock-out location',
  // @max 20
  'timeClock.detail.note': 'Note',
  // @max 20
  'timeClock.detail.history': 'History',
  // @max 20
  'timeClock.detail.viewClean': 'View clean',
  // @max 16
  'timeClock.detail.restore': 'Restore',
  // @max 16
  'timeClock.detail.approve': 'Approve',
  // @max 16
  'timeClock.detail.edit': 'Edit',
  // @max 16
  'timeClock.detail.delete': 'Delete',

  // ── Adding or correcting time (the supervisor's time-entry form) ────────────────────────
  // @max 30
  'timeEntry.correctTitle': 'Correct time entry',
  // @max 30
  'timeEntry.addTitle': 'Add time',
  // @max 20
  'timeEntry.cleaner': 'Cleaner',
  'timeEntry.cleanerPlaceholder': 'Select a cleaner…',
  'timeEntry.cleanerSearch': 'Search cleaners…',
  // @max 20
  'timeEntry.day': 'Day',
  'timeEntry.prevDay': 'Previous day',
  'timeEntry.nextDay': 'Next day',
  // @max 20
  'timeEntry.clean': 'Clean',
  'timeEntry.cleanFirst': 'Select a cleaner first',
  'timeEntry.cleanPlaceholder': 'Select the clean…',
  'timeEntry.cleanSearch': 'Search this cleaner’s cleans…',
  'timeEntry.noCleans': 'No cleans for this cleaner on this day — step to another day',
  // @note Stands in for a customer's name when the clean has none.
  'timeEntry.aClean': 'Clean',
  // @max 20
  'timeEntry.clockIn': 'Clock-in',
  // @max 20
  'timeEntry.clockOut': 'Clock-out',
  'timeEntry.blankOut': '(blank = still on the clock)',
  // @max 20
  'timeEntry.note': 'Note',
  'timeEntry.notePlaceholder': 'Optional. Shown with the entry',
  // @max 20
  'timeEntry.reason': 'Reason',
  'timeEntry.reasonCorrect': 'Why is this being corrected? (audit trail)',
  'timeEntry.reasonAdd': 'e.g. forgot to clock in',
  // @max 20
  'timeEntry.saveChanges': 'Save changes',
  // @max 20
  'timeEntry.addEntry': 'Add entry',
  'timeEntry.badTimes': 'Those clock times don’t look right.',
  'timeEntry.required': 'Cleaner, clean, and clock-in are required',
  'timeEntry.savedNeedsApproval': 'Saved. It needs approval again.',
  'timeEntry.updated': 'Time entry updated',
  // @note Save was pressed but no time and no note were changed, so nothing was sent (CS-694).
  'timeEntry.noChanges': 'Nothing to save. The times and the note are as they were.',
  // @ph time: the wall-clock time that happened twice, e.g. 1:30 AM
  // @note Under a time field on the night the clocks go back (CS-668): times from 1:00 to 1:59 AM happen twice, an hour apart.
  'timeEntry.fold.prompt': 'Clocks went back an hour that night, so {time} happened twice. Which one?',
  // @max 24
  // @note Screen-reader name of the two buttons that choose between the two times.
  'timeEntry.fold.label': 'Which time',
  // @max 28
  // @ph time: the time with its zone, e.g. 1:30 AM EDT
  'timeEntry.fold.first': 'First · {time}',
  // @max 28
  // @ph time: the time with its zone, e.g. 1:30 AM EST
  'timeEntry.fold.second': 'Second · {time}',
  // @ph time: the wall-clock time that happened twice, e.g. 1:30 AM
  'timeEntry.fold.required': 'Choose which {time}. Clocks went back an hour that night.',
  'timeEntry.added': 'Manual entry added',
  'timeEntry.saveFailed': 'Could not save the time entry',
  // @max 20
  'timeEntry.deleteTitle': 'Delete time',
  // @ph name: whose time it is
  'timeEntry.deleteMessageFor': 'Delete this time for {name}? It won’t be paid. The record and the reason stay in the history.',
  'timeEntry.deleteMessage': 'Delete this time? It won’t be paid. The record and the reason stay in the history.',
  'timeEntry.deleteReason': 'Why is this being deleted?',
  // @max 20
  'timeEntry.deleting': 'Deleting…',
  'timeEntry.deleted': 'Time deleted',
  'timeEntry.deleteFailed': 'Could not delete the time',
  // @max 20
  'timeEntry.restoreTitle': 'Restore time',
  // @ph name: whose time it is
  'timeEntry.restoreMessageFor': 'Restore this time for {name}? It goes back to waiting for approval.',
  'timeEntry.restoreMessage': 'Restore this time? It goes back to waiting for approval.',
  // @max 20
  'timeEntry.restoring': 'Restoring…',
  // @max 20
  'timeEntry.restore': 'Restore',
  'timeEntry.restored': 'Time restored',
  'timeEntry.restoreFailed': 'Could not restore the time',

  // ── Approvals (the supervisor's daily desk) ─────────────────────────────────────────────
  // @max 30
  // @note The page's title (Matt's board, 2026-10-09). Every clock-in and clock-out is approved here before payroll.
  'approvals.title': 'Hours Approval',
  'approvals.intro': 'Approve every clock-in and clock-out before payroll. Hours are paid only after they’re approved.',
  // @max 20
  'approvals.tab.approve': 'To approve',
  // @max 20
  'approvals.tab.missing': 'Missing time',
  // @max 20
  'approvals.tab.overtime': 'Overtime',
  // @ph label: the tab's name; count: how many are waiting
  'approvals.tabCount': '{label} ({count})',
  'approvals.viewAria': 'Approvals view',
  // @max 20
  'approvals.customer': 'Customer',
  // @max 20
  'approvals.cleaner': 'Cleaner',
  // @max 20
  'approvals.manager': 'Manager',
  // @max 20
  'approvals.window': 'Window',
  // @max 6
  // @ph days: a number of days
  'approvals.days': '{days}d',
  'approvals.allCustomers': 'All customers',
  'approvals.allCleaners': 'All cleaners',
  'approvals.allManagers': 'All managers',
  // @ph name: the signed-in manager's own name
  'approvals.me': '{name} (me)',
  'approvals.noManager': 'No manager',
  'approvals.loadFailed': 'Could not load approvals.',
  'approvals.missingLoadFailed': 'Could not load missing time.',
  'approvals.approveFailed': 'Could not approve this punch',
  'approvals.approved': 'Punch approved',
  'approvals.bulkFailed': 'Could not approve the punches',
  // @ph count: how many were approved
  'approvals.bulkApproved': 'Approved {count}.',
  // @ph count: how many changed while the page was open
  'approvals.bulkStale': { one: '{count} changed since you opened the page, so it was left for you to check.', other: '{count} changed since you opened the page, so they were left for you to check.' },
  // @ph count: how many could not be approved
  'approvals.bulkOther': "{count} couldn't be approved.",
  'approvals.otFailed': 'Could not approve this overtime',
  'approvals.otApproved': 'Overtime approved',
  'approvals.noLocations': 'No locations are assigned to you yet',
  'approvals.noLocationsHint': 'A Super Admin assigns each location’s manager on the customer’s Service setup.',
  'approvals.loading': 'Loading…',
  'approvals.noMatch': 'Nothing matches these filters',
  'approvals.noMatchHint': 'Clear a filter to see more.',
  'approvals.nothingWaiting': 'Nothing waiting',
  'approvals.nothingWaitingHint': 'Every clock-in at your locations is approved.',
  // @max 20
  'approvals.approving': 'Approving…',
  // ── Hours Approval by person (the manager view redesign, 2026-10-09: one row per cleaner) ──
  // @note Under the page title. A "timesheet" is one cleaner's pending clock-ins and clock-outs. The date is the last day of the pay period the hours belong to.
  // @ph count: how many cleaners have hours waiting
  // @ph due: the last day of the pay period, as a weekday and date
  'approvals.person.summary': { one: '{count} timesheet pending · due {due, weekday}', other: '{count} timesheets pending · due {due, weekday}' },
  // @max 20
  // @note Approves every cleaner whose hours carry no flag. Cleaners with a flag are left to review.
  'approvals.all.button': 'Approve all',
  // @ph count: how many cleaners' hours were approved
  'approvals.all.approved': { one: 'Approved {count} timesheet', other: 'Approved {count} timesheets' },
  // @note Follows "Approved N timesheets ·" after Approve all: the cleaners it left because their hours carry a flag.
  // @ph count: how many cleaners were left for a look
  'approvals.all.needLook': { one: '{count} needs a look', other: '{count} need a look' },
  'approvals.all.noneHint': 'Every timesheet left has a flag. Open each one with Review to approve it.',
  // @max 14
  // @note On a cleaner whose hours carry a flag (off-site, overtime, two cleans at once…): opens their clock-ins to look at before approving.
  'approvals.person.review': 'Review',
  // @max 24
  // @ph count: how many buildings the cleaner's pending hours are at
  'approvals.person.buildings': { one: '{count} building', other: '{count} buildings' },
  // @max 18
  // @note Regular (not overtime) hours waiting for approval.
  // @ph hours: hours to one decimal in the reader's number format, e.g. 7.5
  'approvals.person.reg': '{hours} hrs reg',
  // @max 12
  // @note Shown after the regular hours: the overtime among them.
  // @ph hours: hours to one decimal in the reader's number format, e.g. 1.5
  'approvals.person.ot': '+ {hours} OT',
  // @ph name: the cleaner's name
  'approvals.person.approvedToast': '{name}’s hours approved',
  // @max 40
  // @note Under one cleaner's opened clock-ins: approves all of them at once, after looking.
  // @ph count: how many clock-ins
  // @ph name: the cleaner's name
  'approvals.person.approveAll': { one: 'Approve {count} punch for {name}', other: 'Approve all {count} punches for {name}' },
  'approvals.offline': 'No signal. Approvals need a connection — they’ll work again once you’re back online.',
  // @max 14
  'approvals.col.employee': 'Employee',
  // @max 14
  'approvals.col.property': 'Property',
  // @max 14
  'approvals.col.hours': 'Hours',
  // @max 14
  'approvals.col.date': 'Date',
  // @max 14
  'approvals.col.cleaner': 'Cleaner',
  // @max 14
  'approvals.col.location': 'Location',
  // @max 8
  'approvals.col.in': 'In',
  // @max 8
  'approvals.col.out': 'Out',
  // @max 14
  'approvals.col.duration': 'Duration',
  // @max 14
  'approvals.col.expected': 'Expected',
  // @max 14
  'approvals.col.flags': 'Flags',
  // @max 14
  'approvals.col.review': 'Review',
  // @max 14
  'approvals.col.scheduled': 'Scheduled',
  // @max 14
  'approvals.col.status': 'Status',
  // @max 14
  'approvals.col.fix': 'Fix',
  // @max 14
  'approvals.col.weekOf': 'Week of',
  // @max 14
  'approvals.col.overtime': 'Overtime',
  // @max 14
  'approvals.col.approvedOt': 'Approved',
  // @max 14
  'approvals.col.awaiting': 'Awaiting',
  // @max 14
  'approvals.approve': 'Approve',
  // @max 14
  'approvals.edit': 'Edit',
  // @max 14
  'approvals.delete': 'Delete',
  'approvals.noMissing': 'No missing time',
  'approvals.noMissingHint': 'Every scheduled clean in this window was clocked in and out.',
  // @max 24
  'approvals.noClockIn': 'No clock-in',
  // @max 30
  'approvals.missingOut': 'Missing clock-out',
  // @max 30
  'approvals.missingOutAuto': 'Missing clock-out (auto)',
  // @max 20
  'approvals.addTime': 'Add time',
  // @max 20
  'approvals.fixOut': 'Fix clock-out',
  'approvals.noOvertime': 'No overtime waiting',
  'approvals.noOvertimeHint': 'Approved overtime is paid on the next payroll.',
  'approvals.otHelp': 'Overtime is approved after it’s worked. Approved overtime is paid on the next payroll.',
  'approvals.noCustomer': 'No customer',
  // @max 24
  'approvals.approveOt': 'Approve overtime',
  'approvals.couldNotLoad': 'Couldn’t load',
  // @max 16
  'approvals.tryAgain': 'Try again',

  // ── Client Requests (the manager view redesign, 2026-10-09, Builder C: `/requests`) ─────────
  // The office's queue of what customers have requested: the open work orders, overdue first (Matt's
  // email, 2026-10-09). Requests only: a customer's message waiting for a reply is not one (HUB-24
  // (c), 2026-10-12) — it is told in Messaging → Customers (custMsg.*) and on the Home (mgrHome.msg.*).
  // @max 24
  // @icon
  'nav.clientRequests': 'Client Requests',
  // @max 30
  'clientReq.title': 'Client Requests',
  'clientReq.intro': 'What customers are waiting on, overdue first.',
  // @ph count: how many requests are open
  'clientReq.openCount': { one: '{count} open', other: '{count} open' },
  // @ph count: how many open requests are urgent
  'clientReq.urgentCount': { one: '{count} urgent', other: '{count} urgent' },
  // @ph count: how many requests are past their time (a first reply or a fix)
  'clientReq.overdueCount': { one: '{count} overdue', other: '{count} overdue' },
  // @note The banner's first half: the office's response standards. The <b> part is bold.
  // @ph reply: how soon the client gets a first reply, e.g. "30 minutes"
  // @ph complaint: how soon a complaint is fixed, e.g. "2 hours"
  // @ph request: how soon a request is done, e.g. "24 hours"
  // @ph failed: how soon a failed inspection is fixed, e.g. "48 hours"
  'clientReq.standards.line': '<b>Our standards:</b> first reply within {reply} · complaint fixed within {complaint} · request {request} · failed inspection {failed}.',
  // @note The same line when the office is set to answer the moment something comes in.
  // @ph complaint: how soon a complaint is fixed, e.g. "2 hours"
  // @ph request: how soon a request is done, e.g. "24 hours"
  // @ph failed: how soon a failed inspection is fixed, e.g. "48 hours"
  'clientReq.standards.lineNow': '<b>Our standards:</b> first reply right away · complaint fixed within {complaint} · request {request} · failed inspection {failed}.',
  // @note The banner's second half: an issue the crew reported (no customer waiting) is fixed by its urgency.
  // @ph urgent: the urgent deadline, e.g. "2 hours"
  // @ph medium: the medium deadline, e.g. "1 day"
  // @ph low: the low deadline, e.g. "3 days"
  'clientReq.standards.issues': 'Issues by urgency: urgent {urgent} · medium {medium} · low {low}.',
  // @ph count: a number of hours
  'clientReq.dur.hours': { one: '{count} hour', other: '{count} hours' },
  // @ph count: a number of days
  'clientReq.dur.days': { one: '{count} day', other: '{count} days' },
  // @ph count: a number of minutes
  'clientReq.dur.minutes': { one: '{count} minute', other: '{count} minutes' },
  // @max 20
  'clientReq.type': 'Type',
  // @max 24
  'clientReq.allTypes': 'All types',
  // @max 14
  'clientReq.type.complaint': 'Complaint',
  // @max 14
  'clientReq.type.request': 'Request',
  // @max 14
  'clientReq.type.issue': 'Issue',
  // @max 18
  // @note A work order opened because a building failed its inspection.
  'clientReq.type.failed_inspection': 'Failed inspection',
  // @max 14
  'clientReq.col.property': 'Property',
  // @max 14
  'clientReq.col.type': 'Type',
  // @max 14
  'clientReq.col.details': 'Details',
  // @max 14
  'clientReq.col.timeLeft': 'Time left',
  // @max 14
  // @note Opens the request: its conversation with the customer and the office's actions.
  'clientReq.respond': 'Respond',
  // @max 20
  // @ph time: how long until the deadline, e.g. 1h 10m
  'clientReq.left.remaining': '{time, duration} left',
  // @max 20
  // @ph time: how long past the deadline, e.g. 20m
  'clientReq.left.overdue': '{time, duration} overdue',
  // @max 24
  // @note The deadline is paused while the office waits for the customer to answer.
  'clientReq.left.paused': 'Waiting on the client',
  // @max 24
  // @note Nobody has answered the customer yet: how long until the first reply is due.
  // @ph time: how long until the first reply is due, e.g. 25m
  'clientReq.left.replyRemaining': 'Reply within {time, duration}',
  // @max 24
  // @note Nobody has answered the customer and the first reply is late.
  // @ph time: how long past due, e.g. 1h 5m
  'clientReq.left.replyOverdue': 'Reply {time, duration} late',
  'clientReq.openedJustNow': 'Opened just now',
  // @ph time: how long ago it was opened, e.g. 1h 40m
  'clientReq.openedAgo': 'Opened {time, duration} ago',
  // @ph count: how many days ago it was opened
  'clientReq.openedDays': { one: 'Opened {count} day ago', other: 'Opened {count} days ago' },
  'clientReq.empty': 'No open requests',
  'clientReq.emptyHint': 'Nothing from these customers is waiting on the office.',
  'clientReq.noMatch': 'No requests of this type',
  'clientReq.noMatchHint': 'Pick another type to see the rest.',
  'clientReq.loadFailed': 'Couldn’t load the requests',
  'clientReq.loadFailedHint': 'Check the connection, then try again.',
  // @max 16
  'clientReq.tryAgain': 'Try again',
  'clientReq.updateFailed': 'Couldn’t update the request',
  'clientReq.offline': 'No signal. Requests and replies need a connection — they’ll work again once you’re back online.',

  // ── Work Orders tab (the Quality hub): the resolved history is paged (CS-640, 2026-10-09) ──
  // @note The category picker's first choice: how many OPEN work orders the queue holds.
  // @ph count: how many open work orders
  'workOrders.categoryAllOpen': { one: 'All categories ({count} open)', other: 'All categories ({count} open)' },
  // @note A category in the picker, with how many OPEN work orders the queue holds in it.
  // @ph label: the category's name, e.g. Spill
  // @ph count: how many open work orders in it
  'workOrders.categoryOpen': '{label} ({count} open)',
  // @note Under the list: the resolved work orders are loaded a page at a time, newest resolved first.
  // @ph loaded: how many resolved work orders are on screen
  // @ph total: how many resolved work orders there are in this queue
  'workOrders.resolvedLoaded': 'Resolved: {loaded, number} of {total, number} loaded, newest resolved first.',
  // @max 24
  // @ph count: how many more resolved work orders the next page holds
  'workOrders.loadMore': { one: 'Load {count} more', other: 'Load {count} more' },
  // @max 24
  'workOrders.loadingMore': 'Loading…',
  'workOrders.resolvedFailed': 'Couldn’t load the resolved work orders.',
  // @max 16
  'workOrders.retry': 'Retry',
  // ── the work-order drawer: the first-reply clock (2026-10-09) ──
  // @max 16
  // @note In a work order's details: when the office first answered the client.
  'workOrders.firstReply.label': 'First reply',
  // @ph at: when the first reply was sent
  'workOrders.firstReply.sent': 'Sent {at, dateTime}',
  // @ph time: how long past due the first reply is, e.g. 12m
  'workOrders.firstReply.overdue': '{time, duration} late',
  // @ph time: how long until the first reply is due, e.g. 18m
  'workOrders.firstReply.left': 'Due in {time, duration}',

  // ── WO-19: the ticket a failed inspection opens (lib/failedInspectionTicket) ──────────────
  // The title and details are the ticket's STORED words, written in English like every
  // ticket's (the office's record); the drawer's lines below are read in the viewer's language.
  // @note A ticket's title, written when an inspection is submitted as a fail.
  // @ph date: the day of the inspection
  // @ph areas: the parts of the building that failed, as the office named them
  'workOrders.failedInspection.title': 'Failed inspection {date, date}: {areas, list}',
  // @note The same title when the failed items sit in no named area.
  // @ph date: the day of the inspection
  'workOrders.failedInspection.titleNoAreas': 'Failed inspection {date, date}',
  // @note The first line of the ticket's details.
  // @ph score: the inspection's score, a whole number of percent
  // @ph threshold: the pass mark, a whole number of percent
  'workOrders.failedInspection.scored': 'Scored {score}% against a pass mark of {threshold}%.',
  'workOrders.failedInspection.failedItems': 'Failed items:',
  // @note One line of the ticket's details: an area and its failed items.
  // @ph area: a part of the building, as the office named it
  // @ph items: the failed items in that area
  'workOrders.failedInspection.areaLine': '{area}: {items, list}',
  // @ph name: the inspector's name
  'workOrders.failedInspection.inspectedBy': 'Inspected by {name}.',
  // @max 30
  'workOrders.drawer.cleaners': 'Cleaners on this ticket',
  // @ph names: the cleaners' names
  'workOrders.drawer.cleanerNames': '{names, list}',
  'workOrders.drawer.noCleaners': 'Nobody was on this building’s schedule that week.',
  // @max 30
  'workOrders.drawer.openReport': 'Open the inspection report',
  // QR Wave 2 (2026-10-17, QR-22..QR-26): who raised a ticket, on the office's Work Orders list and
  // in its drawer — a customer from the hub, the office itself, or a VISITOR who scanned an area's
  // QR code without signing in and reported a problem.
  // @max 24
  // @note A small chip on each work order. The diamond is a mark, kept as it is.
  'workOrders.origin.portal': '◆ Client portal',
  // @max 24
  // @note A small chip: a ticket the office or a cleaner logged.
  'workOrders.origin.internal': 'Internal',
  // @max 28
  // @note A small chip and a line: someone who scanned the QR code on a wall reported this.
  'workOrders.origin.visitor': 'Reported by a visitor',
  // @ph name: the name the visitor typed (their own words, as written)
  'workOrders.drawer.visitorBy': 'Reported by a visitor: {name}',
  // @note The visitor left no name and no phone or email, so nobody can reply to them.
  'workOrders.drawer.visitorNoContact': 'Reported by a visitor, who left no name or way to reply',
  // @max 24
  // @note The heading over the photo a visitor added to their report.
  'workOrders.drawer.visitorPhoto': 'Visitor’s photo',
  // @max 16
  // @note A label: the part of the building the ticket is about (a lobby, the restrooms).
  'workOrders.drawer.area': 'Area',
  // @note The ticket named an area that has since been taken off the building's list.
  'workOrders.drawer.areaRemoved': 'An area since removed',
  // A ticket's LOCATION (CS-697): a completion photo is filed under the building, so a ticket with no
  // location could never be resolved. New work orders need one; the office gives an older one its own.
  'workOrders.drawer.noLocation': 'No location yet, so no photo can be attached and this ticket can’t be resolved.',
  // @max 30
  'workOrders.drawer.setLocation': 'Set its location',
  'workOrders.drawer.askOffice': 'Ask the office to set its location.',
  // @max 24
  'workOrders.modal.location': 'Location',
  // @max 30
  'workOrders.modal.pickLocation': 'Pick a location',
  'workOrders.modal.searchLocations': 'Search locations…',
  'workOrders.modal.locationHelp': 'A work order belongs to one location: its photos, its queue and closing it all need it.',
  'workOrders.modal.saveFailed': 'Could not save the work order',
  'workOrders.location.required': 'Pick a location first.',
  'workOrders.location.unknown': 'That location is not one of this company’s.',
  'workOrders.location.otherCustomer': 'Pick one of this ticket’s customer’s locations.',
  'workOrders.location.set': 'This ticket already has a location.',
  'workOrders.location.officeOnly': 'Only the office can set a ticket’s location.',

  // ── Supplies (the supervisor's supply requests, the office's approved lists) ────────────
  // @max 30
  'supplyPage.title': 'Supplies',
  // @ph waiting: how many orders wait for approval; approved: how many are approved and wait for the Supply Manager to order them; sent: how many are with the supplier (nothing or only some delivered yet)
  'supplyPage.sub': '<b>{waiting}</b> waiting for approval · <b>{approved}</b> new · <b>{sent}</b> with the supplier',
  // @ph count: how many buildings spent past their monthly supply budget
  'supplyPage.overBudgetCount': { one: '{count} building over budget', other: '{count} buildings over budget' },
  // @max 24
  'supplyPage.request': 'Request supplies',
  'supplyPage.viewsAria': 'Supplies views',
  // @max 20
  'supplyPage.tab.requests': 'Requests',
  // @max 20
  'supplyPage.tab.usage': 'Usage',
  // @max 20
  // @note A tab: the master list of every supply item (SKU, name, category, how it comes, price).
  'supplyPage.tab.catalog': 'Catalog',
  // ── Supplies by building (the manager view redesign, 2026-10-09, Builder C) ──
  // @max 20
  // @note A tab: every building with one supply state (needs attention, order placed, all set).
  'supplyPage.tab.buildings': 'By building',
  // @ph count: how many buildings are listed
  'supplyPage.bld.properties': { one: '{count} property', other: '{count} properties' },
  // @ph count: how many buildings need attention
  'supplyPage.bld.needAttention': { one: '{count} needs attention', other: '{count} need attention' },
  // @max 20
  // @note A building over its monthly supply budget.
  'supplyPage.bld.state.attention': 'Needs attention',
  // @max 20
  // @note A building with a supply order waiting for its account manager to approve it. Also a tile: the orders waiting for YOUR approval.
  'supplyPage.bld.state.pending': 'Pending approval',
  // @max 20
  // @note A building whose supply request is approved and waits for the office to send it, or is on its way.
  'supplyPage.bld.state.placed': 'Order placed',
  // @max 20
  // @note A building with no supply request in progress, within its budget or with none.
  'supplyPage.bld.state.allSet': 'All set',
  // @note On a phone, one line in place of every building that is all set.
  // @ph count: how many buildings are all set
  'supplyPage.bld.allSetLine': { one: '{count} property all set', other: '{count} properties all set' },
  // @max 14
  'supplyPage.bld.col.property': 'Property',
  // @max 14
  'supplyPage.bld.col.status': 'Status',
  // @max 14
  'supplyPage.bld.col.items': 'Items',
  // @ph name: the person who approves this building's supply requests
  'supplyPage.bld.waitingFor': 'Waiting for {name} to approve',
  // @ph spend: what was delivered this month, in dollars
  // @ph budget: the building's monthly supply budget, in dollars
  'supplyPage.bld.over': 'Over budget: {spend, money} of {budget, money} this month',
  // @max 12
  // @note After the first few item names: how many more items are on order.
  // @ph count: how many more items
  'supplyPage.bld.moreItems': { one: '+{count} more', other: '+{count} more' },
  // @max 14
  // @note Starts a new supply request for this building.
  'supplyPage.bld.reorder': 'Reorder',
  // @max 40
  'supplyPage.bld.search': 'Search buildings',
  'supplyPage.bld.loadFailed': 'Couldn’t load the buildings',
  'supplyPage.bld.empty': 'No buildings here yet',
  'supplyPage.bld.emptyHint': 'A building shows here once it has a manager, a supply budget or a request.',
  // The building's orders in progress, each line's state, and the approval box (S131 Wave 2, the account manager's board 8).
  // @note An item and how many were ordered, e.g. "Paper towels (3)".
  // @ph item: a supply item's name, as the office wrote it
  // @ph qty: how many were ordered
  'supplyPage.bld.itemQty': '{item} ({qty})',
  // @ph count: how many more orders this building has in progress
  'supplyPage.bld.moreOrders': { one: '+{count} more order', other: '+{count} more orders' },
  // @note One item of an order with the supplier: it has arrived.
  // @ph item: a supply item's name, as the office wrote it
  'supplyPage.bld.line.delivered': '{item} — delivered',
  // @note One item of an order with the supplier: the supplier is out of it and gave a date.
  // @ph item: a supply item's name, as the office wrote it
  // @ph eta: the day the supplier says it will arrive, as the Supply Manager entered it
  'supplyPage.bld.line.backordered': '{item} — backordered (ETA {eta, date})',
  // @note One item of an order with the supplier: the supplier is out of it, no date given.
  // @ph item: a supply item's name, as the office wrote it
  'supplyPage.bld.line.backorderedNoEta': '{item} — backordered',
  // @note One item of an order: it will not come (discontinued), cancelled by the Supply Manager.
  // @ph item: a supply item's name, as the office wrote it
  'supplyPage.bld.line.cancelled': '{item} — cancelled',
  // @note One item of an order with the supplier: some of it has arrived.
  // @ph item: a supply item's name, as the office wrote it
  // @ph delivered: how many arrived
  // @ph qty: how many were ordered
  'supplyPage.bld.line.partly': '{item} — {delivered} of {qty} delivered',
  // @note One item of an order with the supplier: ordered, not arrived yet.
  // @ph item: a supply item's name, as the office wrote it
  'supplyPage.bld.line.onOrder': '{item} — on order',
  // @max 32
  // @note The heading of the box listing the supply orders this person may approve or decline.
  'supplyPage.bld.approvals.title': 'Awaiting your approval',
  // @ph name: who asked, as first name and last initial (Maria S.)
  // @ph when: the day and time they asked
  'supplyPage.bld.approvals.requested': 'Requested by {name} · {when, date}, {when, time}',
  // @note A link under the box when more orders wait than it lists; it opens the Requests tab.
  // @ph count: how many orders wait for this person's approval in all
  'supplyPage.bld.approvals.all': 'Review all {count} in Requests',
  'supplyPage.statusAria': 'Request status',
  // ── Supply orders (S131): an order's status, worded for its reader ──
  // @max 22
  // @note An order waiting for the account manager to approve it.
  'supplyPage.label.pending': 'Pending approval',
  // @max 22
  // @note An approved order the Supply Manager has not sent to the supplier yet.
  'supplyPage.label.new': 'New',
  // @max 22
  // @note The Supply Manager has sent the order to the supplier; nothing delivered yet.
  'supplyPage.label.supplier': 'Submitted to supplier',
  // @max 22
  // @note Some items on the order are delivered, the rest are still coming.
  'supplyPage.label.partial': 'Partially fulfilled',
  // @max 22
  // @note Every item is delivered or cancelled; the Supply Manager has not closed the order yet.
  'supplyPage.label.ready': 'Ready to complete',
  // @max 22
  'supplyPage.label.completed': 'Completed',
  // @max 22
  'supplyPage.label.declined': 'Declined',
  // @max 22
  // @note For the account manager: the order is approved and with the Supply Manager.
  'supplyPage.label.withSm': 'With Supply Manager',
  // @max 22
  // @note For the account manager: the Supply Manager has ordered it from the supplier.
  'supplyPage.label.withSupplier': 'With supplier',
  // @max 22
  // @note Every item has arrived (or was cancelled).
  'supplyPage.label.allDelivered': 'All delivered',
  // @max 22
  // @note For the cleaner: their order waits for the account manager.
  'supplyPage.label.waiting': 'Waiting for approval',
  // @max 22
  'supplyPage.label.approved': 'Approved',
  // @max 22
  // @note For the cleaner: the order has been placed with the supplier.
  'supplyPage.label.ordered': 'Ordered',
  // @max 22
  'supplyPage.label.delivered': 'Delivered',
  // @max 22
  // @note A tab of the order queue. A count sits beside it.
  'supplyPage.queue.tab.pending': 'Pending approval',
  // @max 22
  // @note A tab: approved orders to send to the supplier. A count sits beside it.
  'supplyPage.queue.tab.new': 'New',
  // @max 22
  // @note A tab: orders sent to the supplier, nothing delivered yet. A count sits beside it.
  'supplyPage.queue.tab.supplier': 'With supplier',
  // @max 22
  // @note A tab: orders with some items delivered. A count sits beside it.
  'supplyPage.queue.tab.partial': 'Partially fulfilled',
  // @max 22
  'supplyPage.queue.tab.completed': 'Completed',
  // @max 22
  'supplyPage.queue.tab.declined': 'Declined',
  // @max 18
  'supplyPage.col.order': 'Order',
  // @max 18
  'supplyPage.col.items': 'Items',
  // @max 18
  'supplyPage.col.status': 'Status',
  // @note When an order was asked for (or something happened on it), as a date and time.
  // @ph when: the moment
  'supplyPage.queue.when': '{when, dateTime}',
  // @note Under an order's items in the queue: its estimated cost, from the prices on the order.
  // @ph amount: the estimated cost, in dollars
  'supplyPage.queue.estCost': 'Est. {amount}',
  // @max 24
  // @note Sends an approved supply order to the supplier.
  'supplyPage.submitSupplier': 'Submit to supplier',
  // @max 20
  // @note Opens an order that is with the supplier, to record what arrived.
  'supplyPage.processOrder': 'Process order →',
  // @max 18
  'pager.noun.orders': 'orders',
  // ── The Supply Manager's tiles and Home (S131) ──
  // @max 22
  'supplyPage.tiles.new': 'New orders',
  // @max 22
  'supplyPage.tiles.supplier': 'With supplier',
  // @max 22
  'supplyPage.tiles.partial': 'Partially fulfilled',
  // @max 22
  'supplyPage.tiles.completedToday': 'Completed today',
  // @ph name: the reader's first name
  'supplyPage.home.greeting': 'Hey, {name}',
  // @max 30
  'supplyPage.home.title': 'Supply orders',
  // @max 30
  'supplyPage.home.queueTitle': 'Order Queue',
  // ── One supply order's page (S131) ──
  // @max 14
  // @note Stands in for an order's number where it has none.
  'supplyPage.order.noNumber': 'Order',
  'supplyPage.order.noBuilding': 'A building no longer on the list',
  // @max 24
  'supplyPage.order.items': 'Items',
  // @note Beside an item's name: how many were ordered.
  // @ph qty: how many were ordered
  'supplyPage.order.times': '× {qty}',
  // @max 20
  // @note An item on an order with the supplier, nothing of it arrived yet.
  'supplyPage.order.state.pending': 'Pending',
  // @max 20
  // @note Some of this item arrived; the rest is still to come.
  'supplyPage.order.state.partly': 'Partly delivered',
  // @max 20
  'supplyPage.order.state.delivered': 'Delivered',
  // @max 20
  'supplyPage.order.state.backordered': 'Backordered',
  // @max 20
  'supplyPage.order.state.cancelled': 'Cancelled',
  // @ph delivered: how many arrived; qty: how many were ordered
  'supplyPage.order.deliveredOf': '{delivered} of {qty} delivered',
  // @ph eta: the day the supplier expects to deliver
  'supplyPage.order.eta': 'Supplier ETA: {eta, date}',
  // @ph reason: why the item was cancelled, as written
  'supplyPage.order.cancelledReason': 'Cancelled: “{reason}”',
  // @note An item on an older order that never went out.
  'supplyPage.order.cancelledLegacy': 'Not sent',
  'supplyPage.order.photoAttached': 'Delivery photo attached',
  // @max 18
  // @note Marks an item backordered with the supplier's expected date.
  'supplyPage.order.backorder': 'Backordered',
  // @max 18
  'supplyPage.order.changeEta': 'Change ETA',
  // @max 18
  'supplyPage.order.cancelItem': 'Cancel item',
  // @max 24
  'supplyPage.order.deliveredSoFar': 'Delivered so far',
  // @max 24
  'supplyPage.order.approvals': 'Approvals',
  // @max 24
  'supplyPage.order.requestedBy': 'Requested by',
  // @max 24
  'supplyPage.order.approvedBy': 'Approved by',
  // @max 24
  'supplyPage.order.declinedBy': 'Declined by',
  // @ph name: a person's name, as stored; when: when they did it
  'supplyPage.order.personWhen': '{name} · {when, dateTime}',
  // @max 30
  'supplyPage.order.photosTitle': 'Delivery Photos',
  // @max 40
  'supplyPage.order.photosInvoiceTitle': 'Delivery Photos & Invoice',
  'supplyPage.order.photosEmpty': 'No delivery photos yet.',
  // @max 24
  'supplyPage.order.uploadPhotos': 'Upload photos',
  // @max 30
  'supplyPage.order.invoiceTitle': 'Invoice',
  // @max 24
  'supplyPage.order.uploadInvoice': 'Upload invoice',
  // @max 24
  'supplyPage.order.invoiceUploading': 'Uploading…',
  // @max 14
  'supplyPage.order.invoiceOpen': 'Open',
  // @max 28
  // @note In the demo the seeded invoice has no file behind it, so it can't be opened.
  'supplyPage.order.invoiceDemo': 'Demo file — can’t open',
  'supplyPage.order.invoiceDemoHint': 'The demo keeps no file for this invoice.',
  'supplyPage.order.invoiceOpenFailed': 'Couldn’t open the invoice. Try again.',
  // @max 14
  'supplyPage.order.invoiceRemove': 'Remove',
  // @ph file: the file's name
  'supplyPage.order.invoiceRemoveTitle': 'Remove {file}?',
  'supplyPage.order.invoiceRemoveMessage': 'The file is deleted. The order’s history keeps the line saying it was added.',
  'supplyPage.order.invoiceNone': 'No invoice yet.',
  'supplyPage.order.invoiceWaiting': 'An invoice can be added once the order is with the supplier.',
  // @max 30
  'supplyPage.order.commentsTitle': 'Comments',
  'supplyPage.order.commentsNone': 'No comments yet.',
  // @max 20
  'supplyPage.order.addComment': 'Add comment',
  'supplyPage.order.commentPlaceholder': 'A note for the office — what the supplier said, what to watch for.',
  // @max 14
  'supplyPage.order.commentPost': 'Post',
  'supplyPage.order.commentTooLong': 'Keep a comment under 1,000 characters.',
  // @max 18
  // @note Copies the order's lines (SKU, item, quantity) to paste into the supplier's form.
  'supplyPage.order.copy': 'Copy order',
  'supplyPage.order.copied': 'Order copied — paste it into the supplier’s form or email.',
  'supplyPage.order.copyFailed': 'Couldn’t copy here. Select the lines and copy them yourself.',
  // @max 24
  'supplyPage.order.complete': 'Mark Completed',
  // @note Under the disabled Mark Completed button.
  // @ph count: how many items are backordered; items: their names
  'supplyPage.order.lockedBackordered': { one: '{count} item backordered ({items, list}) — complete delivery to unlock', other: '{count} items backordered ({items, list}) — complete delivery to unlock' },
  // @note Under the disabled Mark Completed button.
  // @ph count: how many items are still to come; items: their names
  'supplyPage.order.lockedOpen': { one: '{count} item still to come ({items, list}) — complete delivery to unlock', other: '{count} items still to come ({items, list}) — complete delivery to unlock' },
  // @ph name: who completed the order; when: when
  'supplyPage.order.completedBy': 'Completed by {name} · {when, dateTime}',
  // @max 30
  'supplyPage.order.historyTitle': 'Order History',
  // @max 30
  'supplyPage.order.history.requested': 'Requested',
  // @max 30
  'supplyPage.order.history.approved': 'Approved',
  // @max 30
  'supplyPage.order.history.declined': 'Declined',
  // @max 30
  'supplyPage.order.history.submitted': 'Submitted to supplier',
  // @ph item: the item's name, as the office wrote it; qty: how many arrived
  'supplyPage.order.history.delivered': '{item} ×{qty} delivered',
  // @ph item: the item's name, as the office wrote it; eta: the supplier's expected day
  'supplyPage.order.history.backordered': '{item} backordered, ETA {eta, date}',
  // @ph item: the item's name, as the office wrote it
  'supplyPage.order.history.lineCancelled': '{item} cancelled',
  // @max 30
  'supplyPage.order.history.comment': 'Comment',
  // @max 30
  'supplyPage.order.history.photo': 'Delivery photo added',
  // @ph file: the invoice file's name
  'supplyPage.order.history.invoice': 'Invoice added: {file}',
  // @max 30
  'supplyPage.order.history.completed': 'Completed',
  'supplyPage.order.loadFailed': 'Couldn’t load this order',
  'supplyPage.order.gone': 'Order not found',
  'supplyPage.order.goneHint': 'It may have been cancelled. The order queue shows where everything is now.',
  // @ph item: the item's name, as the office wrote it
  'supplyPage.order.deliverTitle': 'Mark {item} delivered',
  // @ph building: the building's name
  'supplyPage.order.deliverTo': 'Delivered to {building}. The person who asked and the account manager are told.',
  // @max 30
  'supplyPage.order.deliverQty': 'How many arrived?',
  // @ph count: how many are still to come
  'supplyPage.order.deliverQtyHelp': { one: '{count} still to come.', other: '{count} still to come.' },
  // @max 30
  'supplyPage.order.deliverPhoto': 'Delivery photo (optional)',
  // @ph item: the item's name, as the office wrote it
  'supplyPage.order.backorderTitle': '{item} is backordered',
  'supplyPage.order.backorderHelp': 'The person who asked and the account manager are told, with the supplier’s date.',
  // @max 24
  'supplyPage.order.backorderEta': 'Supplier’s ETA',
  // @max 18
  'supplyPage.order.backorderConfirm': 'Save ETA',
  'supplyPage.order.etaInvalid': 'Pick today or a later day, within a year.',
  // @ph item: the item's name, as the office wrote it
  'supplyPage.order.cancelItemTitle': 'Cancel {item}?',
  'supplyPage.order.cancelItemHelp': 'The rest of the order carries on. The person who asked and the account manager are told, with your reason.',
  'supplyPage.order.cancelItemReason': 'Why? (for example, discontinued)',
  // @max 18
  'supplyPage.order.cancelItemConfirm': 'Cancel item',
  'supplyPage.order.reasonInvalid': 'Write 3 to 300 characters.',
  // @ph item: the item's name, as the office wrote it; qty: how many arrived
  'supplyPage.order.toast.delivered': '{item} ×{qty} marked delivered',
  // @ph item: the item's name, as the office wrote it
  'supplyPage.order.toast.backordered': '{item} marked backordered',
  // @ph item: the item's name, as the office wrote it
  'supplyPage.order.toast.cancelledItem': '{item} cancelled',
  'supplyPage.order.toast.completed': 'Order completed — the person who asked and the account manager are told',
  'supplyPage.order.toast.stale': 'This order changed since you opened it. It now shows where it is.',
  'supplyPage.order.toast.linesOpen': 'Every item has to be delivered or cancelled first.',
  'supplyPage.order.toast.moved': 'This order has already moved on. It now shows where it is.',
  'supplyPage.order.toast.lineResolved': 'That item is already delivered or cancelled.',
  'supplyPage.order.toast.notYours': 'You can’t make that change on this order.',
  'supplyPage.order.toast.tooManyFiles': 'This order already keeps as many files as it can.',
  'supplyPage.order.toast.invoiceType': 'Use a PDF, JPG or PNG file of up to 10 MB.',
  'supplyPage.order.toast.photoFailed': 'Marked delivered, but the photo didn’t upload. Add it under Delivery Photos.',
  'supplyPage.order.toast.commentAdded': 'Comment added',
  'supplyPage.order.toast.invoiceAdded': 'Invoice added',
  'supplyPage.order.toast.invoiceRemoved': 'Invoice removed',
  // @max 18
  'supplyPage.col.request': 'Request',
  // @max 18
  'supplyPage.col.customer': 'Customer',
  // @max 18
  'supplyPage.col.requestedBy': 'Requested by',
  // @max 18
  // @note Estimated cost of the request, from the prices the office entered.
  'supplyPage.col.cost': 'Est. cost',
  // @max 18
  'supplyPage.col.date': 'Date',
  // @max 18
  'supplyPage.col.select': 'Select',
  'supplyPage.col.actions': 'Actions',
  // @ph item: a supply's name, as the office wrote it; qty: how many were asked for
  'supplyPage.lineQty': '{item} ×{qty}',
  // @ph line: the first item and its quantity, e.g. "Glass cleaner ×4"; count: how many more items the request lists
  'supplyPage.lineMore': { one: '{line} +{count} more', other: '{line} +{count} more' },
  // @note Stands in for a supply line that has no name.
  'supplyPage.item': 'Item',
  // @max 12
  // @note The default unit for a supply (one bottle, one box…).
  'supplyPage.each': 'each',
  // @note Under a supply's name: its stock code (SKU) and how it comes.
  // @ph sku: the item's SKU, as the office wrote it; unit: how it comes, e.g. "case of 12"
  'supplyPage.skuUnit': '{sku} · {unit}',
  // @max 16
  'supplyPage.noPrice': 'No price',
  // @max 18
  'supplyPage.overBudget': 'Over budget',
  // @max 18
  // @note Shown where a building has no supervisor and no approver is named in Settings.
  'supplyPage.noApprover': 'No approver set',
  // @max 14
  'supplyPage.approve': 'Approve',
  // @max 14
  // @note Turns an order down (a reason is asked for).
  'supplyPage.reject': 'Decline',
  // @max 16
  // @note Marks a sent request as delivered at its building.
  'supplyPage.markDelivered': 'Mark delivered',
  // @max 14
  // @note Withdraws a request from the queue.
  'supplyPage.cancel': 'Cancel',
  // @max 14
  // @note Sends a finished request back to waiting for approval.
  'supplyPage.reopen': 'Reopen',
  // @max 22
  // @note The order queue's search box hint: it finds an order by its number (SO-1049), its building or an item on it. The box is narrow.
  'supplyPage.searchRequests': 'SO #, building or item',
  // @ph shown: how many rows match the search
  'supplyPage.matchCount': '{shown} of {total}',
  'supplyPage.noMatch': 'Nothing matches these filters',
  'supplyPage.noMatchHint': 'Clear the Manager or Customer filter to see more.',
  'supplyPage.noSearchMatch': 'Nothing matches your search',
  'supplyPage.noSearchMatchHint': 'Try another word, or clear the search.',
  'supplyPage.empty.requested': 'Nothing waiting for approval',
  'supplyPage.empty.requestedHint': 'When a cleaner or a manager orders supplies, the order lands here for the building’s account manager.',
  'supplyPage.empty.approved': 'No new orders',
  'supplyPage.empty.approvedHint': 'Approve an order and it moves here for the Supply Manager to send to the supplier.',
  'supplyPage.empty.sent': 'Nothing with the supplier',
  'supplyPage.empty.sentHint': 'An order submitted to the supplier waits here until something on it arrives.',
  'supplyPage.empty.partial': 'Nothing partly delivered',
  'supplyPage.empty.partialHint': 'An order moves here once something on it arrives, and stays until the Supply Manager completes it.',
  'supplyPage.empty.completed': 'No completed orders',
  // @ph months: how many months finished orders are kept
  'supplyPage.empty.completedHint': 'Completed orders are kept for {months} months.',
  'supplyPage.empty.rejected': 'No declined orders',
  // @ph months: how many months finished orders are kept
  'supplyPage.empty.rejectedHint': 'Declined orders are kept for {months} months.',
  'supplyPage.bulk.hintApprove': 'Select orders to approve several at once.',
  'supplyPage.bulk.hintSubmit': 'Select orders to submit several to the supplier at once.',
  // @ph count: how many requests are selected; amount: their estimated cost together
  'supplyPage.bulk.selected': '<b>{count}</b> selected · {amount}',
  // @max 24
  // @ph count: how many requests match the filters
  'supplyPage.selectAllN': 'Select all {count}',
  // @max 12
  'supplyPage.bulk.clear': 'Clear',
  // @max 24
  // @ph count: how many are selected
  'supplyPage.bulk.approveN': 'Approve {count}',
  // @max 30
  // @note Sends the selected approved orders to the supplier.
  // @ph count: how many are selected
  'supplyPage.bulk.submitN': 'Submit to supplier ({count})',
  // @ph count: how many requests are on this page
  'supplyPage.selectPageAria': 'Select the {count} requests on this page',
  'supplyPage.selectRowAria': 'Select the request for {customer}',
  // @ph amount: what was delivered to the building this month
  'supplyPage.budget.none': '{amount} delivered this month · no supply budget set',
  // @ph amount: what was delivered to the building this month
  'supplyPage.budget.of': '<b>{amount}</b> of {budget} this month',
  // @ph amount: how far past the budget
  'supplyPage.budget.over': 'Over by {amount}',
  // @ph amount: what is left of the budget
  'supplyPage.budget.left': '{amount} left',
  'supplyPage.toast.approved': 'Order approved — the Supply Manager has been told',
  // @ph count: how many orders were approved
  'supplyPage.toast.approvedN': { one: '{count} order approved — the Supply Manager has been told', other: '{count} orders approved — the Supply Manager has been told' },
  'supplyPage.toast.submittedSupplier': 'Submitted to the supplier',
  // @ph count: how many orders were submitted to the supplier
  'supplyPage.toast.submittedSupplierN': { one: '{count} order submitted to the supplier', other: '{count} orders submitted to the supplier' },
  'supplyPage.toast.rejected': 'Order declined',
  // @ph name: the person who asked for the supplies
  'supplyPage.toast.rejectedNotified': 'Order declined — {name} has been told',
  'supplyPage.toast.reopened': 'Order reopened — it needs approving again',
  // @ph count: how many orders already had something delivered
  'supplyPage.toast.partialDelivered': { one: '{count} already has deliveries, so it can’t be reopened.', other: '{count} already have deliveries, so they can’t be reopened.' },
  'supplyPage.toast.cancelled': 'Request cancelled',
  // @ph count: how many requests changed while the page was open
  'supplyPage.toast.partialStale': { one: '{count} changed since you opened the page, so it was left for you to check.', other: '{count} changed since you opened the page, so they were left for you to check.' },
  // @ph count: how many requests belong to another building's approver
  'supplyPage.toast.partialNotYours': { one: '{count} is another building’s to approve, so it was left.', other: '{count} are other buildings’ to approve, so they were left.' },
  // @ph count: how many requests had already been decided
  'supplyPage.toast.partialMoved': { one: '{count} had already moved on, so nothing changed on it.', other: '{count} had already moved on, so nothing changed on them.' },
  // @ph count: how many requests no longer exist
  'supplyPage.toast.partialGone': { one: '{count} no longer exists.', other: '{count} no longer exist.' },
  // @ph count: how many requests could not be changed
  'supplyPage.toast.partialOther': { one: '{count} couldn’t be changed.', other: '{count} couldn’t be changed.' },
  'supplyPage.toast.failed': 'Couldn’t save that. Check your connection and try again.',
  'supplyPage.toast.cancelRefused': 'You can’t cancel this request — only its requester (while it waits), its approver or the office can.',
  // @note Someone approved or changed the request while this person was cancelling it, so it was not cancelled.
  'supplyPage.toast.cancelStale': 'This request changed since you opened it, so it wasn’t cancelled. The list now shows where it is.',
  // @note An order can be cancelled only while it waits or is approved; once it is with the supplier the Supply Manager reopens it instead (while nothing has arrived).
  'supplyPage.toast.cancelGoneOut': 'This order is already with the supplier, so it can’t be cancelled. The Supply Manager can reopen it while nothing has arrived.',
  'supplyPage.toast.cancelGone': 'That request no longer exists.',
  'supplyPage.toast.itemGone': 'One of these items was taken off this location’s list. Open the request again.',
  // @note Shown when the device has no connection: nothing on the Supplies page is kept on the phone.
  'supplyPage.offline': 'No signal. Requests, approvals and lists here need a connection — they’ll work again once you’re back online.',
  'supplyPage.form.offline': 'No signal. Send this request when you’re back online.',
  'supplyPage.loadFailed': 'Couldn’t load the requests',
  'supplyPage.loadFailedHint': 'Check your connection and try again.',
  // @max 16
  'supplyPage.tryAgain': 'Try again',
  'supplyPage.budget.failed': 'This month’s spend couldn’t be loaded',
  // @ph count: how many requests matched the search
  'supplyPage.matchTotal': { one: '{count} match', other: '{count} matches' },
  // @ph count: how many requests are selected
  'supplyPage.bulk.selectedNoTotal': '<b>{count}</b> selected',
  'supplyPage.toast.submitted': 'Request sent — {name} has been asked to approve it',
  'supplyPage.toast.submittedNoApprover': 'Request sent — it is waiting for an approver',
  'supplyPage.cancelTitle': 'Cancel this request?',
  'supplyPage.cancelMessage': 'This removes the request from the queue, and whoever asked for it or approves it is told. It can’t be undone.',
  // @max 24
  'supplyPage.cancelConfirm': 'Cancel request',
  // @max 24
  'supplyPage.estTotal': 'Estimated total',
  'supplyPage.form.pickLocation': 'Pick a location…',
  'supplyPage.form.searchLocations': 'Search locations…',
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.form.less': 'One fewer {item}',
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.form.more': 'One more {item}',
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.form.qtyAria': 'How many {item}',
  'supplyPage.form.qtyHint': 'Type a number or use − and +. Leave anything you don’t need at 0.',
  'supplyPage.form.note': 'Note for the approver (optional)',
  'supplyPage.form.notePlaceholder': 'Anything they should know?',
  'supplyPage.form.noApprover': 'No approver is set for this building. Give it an account manager on the customer page, or name one in Settings → Operations.',
  // @max 24
  'supplyPage.form.submit': 'Submit request',
  'supplyPage.rejectTitle': 'Decline this order',
  'supplyPage.rejectTitleAt': 'Decline this order — {customer}',
  'supplyPage.rejectLead': 'The person who asked is told, with your reason. Nothing is ordered.',
  'supplyPage.rejectReason': 'Why are you declining it?',
  // @note Under the reason box while the reason typed is too short to send.
  // @ph min: the fewest characters a decline reason may have
  'supplyPage.rejectReasonShort': 'Write at least {min} characters.',
  'supplyPage.rejectPlaceholder': 'e.g. Ordered last week — check the store room first.',
  // @max 24
  'supplyPage.rejectConfirm': 'Decline order',
  // @ph name: the approver's name
  'supplyPage.detail.waitingOn': 'Waiting on {name}',
  // @ph qty: how many were asked for
  'supplyPage.detail.qty': '×{qty}',
  // @ph reason: the approver's reason, as they wrote it
  'supplyPage.detail.rejectedReason': '<b>Rejected:</b> “{reason}”',

  // ── Supplies: the request form's order sheet (round 3, 2026-10-06) ───────────────────────
  // @max 12
  'supplyPage.form.for': 'For',
  // @ph name: who approves this building's supply requests
  'supplyPage.form.route': '{name} approves it, then the Supply Manager orders it.',
  'supplyPage.form.routeSelfSupervisor': 'You approve it as this building’s account manager, then the Supply Manager orders it.',
  'supplyPage.form.routeSelf': 'You approve it, then the Supply Manager orders it.',
  // @ph day: the day of the month this building's orders are due
  'supplyPage.form.orderDay': 'Orders are due on the {day, ordinal} of the month.',
  // @ph customer: the building's name
  'supplyPage.form.need': 'What does {customer} need?',
  // @max 18
  'supplyPage.form.editList': 'Edit list',
  // @ph customer: the building's name
  'supplyPage.form.sheetAria': '{customer}’s supply list',
  // @max 16
  'supplyPage.form.col.item': 'Item',
  // @max 12
  'supplyPage.form.col.price': 'Price',
  // @max 12
  'supplyPage.form.col.qty': 'Quantity',
  // @ph count: how many of this item are already on a request nobody has approved yet; name: the approver's first name
  'supplyPage.form.onOrderWaiting': '{count} already on order · waiting for {name} to approve',
  // @ph count: how many of this item are already on a request waiting for the reader to approve
  'supplyPage.form.onOrderYou': '{count} already on order · waiting for you to approve',
  // @ph count: how many of this item are already on a request waiting for approval
  'supplyPage.form.onOrderNoApprover': '{count} already on order · waiting for approval',
  // @ph count: how many of this item are on an approved order the Supply Manager has not ordered yet
  'supplyPage.form.onOrderApproved': '{count} already on order · approved, with the Supply Manager',
  // @ph count: how many of this item are ordered from the supplier and still to come
  'supplyPage.form.onOrderSent': '{count} with the supplier · not delivered yet',
  // @ph name: the approver's first name
  'supplyPage.form.addNoteFor': 'Add a note for {name}',
  'supplyPage.form.addNoteOffice': 'Add a note for the office',
  'supplyPage.form.addNote': 'Add a note',
  // @ph name: the approver's first name
  'supplyPage.form.noteFor': 'Note for {name} (optional)',
  'supplyPage.form.noteOffice': 'Note for the office (optional)',
  // @ph count: how many different items are picked; amount: their estimated total
  'supplyPage.form.picked': { one: '<b>{count} item</b> · <b>{amount}</b>', other: '<b>{count} items</b> · <b>{amount}</b>' },
  'supplyPage.form.nothingPicked': 'Nothing picked yet',
  'supplyPage.form.nothingToOrder': 'Nothing to order yet',
  'supplyPage.form.noCustomers': 'No customers yet',
  'supplyPage.form.noCustomersHint': 'Add a customer first. Each one has its own supply list.',
  'supplyPage.form.budget.none': 'No supply budget set for this building.',
  'supplyPage.form.budget.loading': 'Checking this month’s spend…',
  // @ph delivered: what was delivered this month; onOrder: what is ordered and not delivered yet; budget: the monthly budget
  'supplyPage.form.budget.month': 'This month: {delivered} delivered, {onOrder} on order, of a {budget} budget.',
  // @ph amount: this month's spend with this request counted; budget: the monthly budget; onOrder: what is ordered and not delivered yet
  'supplyPage.form.budget.with': 'With this request: {amount} of the {budget} budget this month, counting {onOrder} already on order.',
  // @ph amount: this month's spend with this request counted; budget: the monthly budget
  'supplyPage.form.budget.withNoOrder': 'With this request: {amount} of the {budget} budget this month.',
  // @ph amount: how far past the budget this request would go; budget: the monthly budget; onOrder: what is ordered and not delivered yet
  'supplyPage.form.budget.over': 'With this request: {amount} over the {budget} budget this month, counting {onOrder} already on order.',
  // @ph amount: how far past the budget this request would go; budget: the monthly budget
  'supplyPage.form.budget.overNoOrder': 'With this request: {amount} over the {budget} budget this month.',
  // @ph name: the approver's first name
  'supplyPage.form.budget.overSees': '{name} will see that too.',

  // ── Supplies: a building's supply list (on the customer's Supplies tab) — the items the office
  //    switched on for it from the catalog ──────────────────────────────────────────────────────
  // @ph customer: the building's name
  'supplyPage.list.title': '{customer}’s supply list',
  'supplyPage.list.search': 'Search items',
  // @ph count: how many items are on this building's list
  'supplyPage.list.count': { one: '{count} item', other: '{count} items' },
  // @max 18
  // @note Opens the switches that choose which catalog items this building gets.
  'supplyPage.list.editList': 'Edit list',
  // @max 18
  'supplyPage.list.col.item': 'Item',
  // @max 18
  'supplyPage.list.col.howItComes': 'How it comes',
  // @max 18
  'supplyPage.list.col.price': 'Price',
  // @max 18
  'supplyPage.list.col.lastDelivered': 'Last delivered',
  // @max 18
  // @note How many were delivered in the last 90 days.
  'supplyPage.list.col.last90': 'Last 3 months',
  // @ph date: the day it was last delivered; qty: how many came that day
  'supplyPage.list.lastDeliveredValue': '{date, date} · {qty}',
  // @max 14
  'supplyPage.list.notYet': 'Not yet',
  // @ph q: what the reader searched for
  'supplyPage.list.noMatch': 'Nothing on the list matches “{q}”.',
  'supplyPage.list.loadFailed': 'Couldn’t load this building’s supply list',
  // @ph customer: the building's name
  'supplyPage.list.emptyTitle': '{customer} has no supply list yet',
  'supplyPage.list.emptyOffice': 'Switch on the items its supervisor can order, from the catalog. You can change it any time.',
  'supplyPage.list.emptyOther': 'There’s nothing to order here until the office adds this building’s supplies. Ask them to set up the list.',
  // @max 20
  'supplyPage.list.setUp': 'Set up the list',

  // ── Supplies: the master list (the Supplies page's Catalog tab; the Oct 6 call) ───────────
  // @note A line under the tab: what the catalog is for.
  'supplyPage.catalog.lead': 'Everything you supply, once. Each building switches on the items it gets, from its customer page.',
  // @max 24
  'supplyPage.catalog.category': 'Category',
  'supplyPage.catalog.allCategories': 'All categories',
  // @max 18
  // @note Items the office has not put in a category.
  'supplyPage.catalog.noCategory': 'No category',
  // @max 40
  'supplyPage.catalog.search': 'Search by name or SKU',
  // @ph count: how many items are in the catalog (or match the search)
  'supplyPage.catalog.count': { one: '{count} item', other: '{count} items' },
  // @max 18
  'supplyPage.catalog.add': 'Add item',
  // @max 14
  // @note A product's stock code.
  'supplyPage.catalog.col.sku': 'SKU',
  // @max 18
  'supplyPage.catalog.col.item': 'Item',
  // @max 18
  'supplyPage.catalog.col.category': 'Category',
  // @max 18
  'supplyPage.catalog.col.howItComes': 'How it comes',
  // @max 14
  'supplyPage.catalog.col.price': 'Price',
  // @max 18
  // @note The column saying how many buildings have the item switched on.
  'supplyPage.catalog.col.buildings': 'On',
  // @ph count: how many buildings have this item switched on
  'supplyPage.catalog.onBuildings': { one: '{count} building', other: '{count} buildings' },
  // @max 14
  'supplyPage.catalog.edit': 'Edit',
  // @max 14
  'supplyPage.catalog.delete': 'Delete',
  'supplyPage.catalog.loadFailed': 'Couldn’t load the catalog',
  'supplyPage.catalog.emptyTitle': 'The catalog is empty',
  'supplyPage.catalog.emptyOffice': 'Add each item you supply, with its SKU, how it comes and its price. Then switch each building on for the items it gets.',
  'supplyPage.catalog.emptyOther': 'The office hasn’t added any supplies yet.',
  'supplyPage.catalog.addTitle': 'Add to the catalog',
  'supplyPage.catalog.editTitle': 'Edit item',
  // @max 24
  'supplyPage.catalog.sku': 'SKU (optional)',
  'supplyPage.catalog.skuPlaceholder': 'e.g. CL-1001',
  'supplyPage.catalog.skuHelp': 'No two items share a SKU.',
  // @max 24
  'supplyPage.catalog.name': 'Item name',
  'supplyPage.catalog.namePlaceholder': 'e.g. Glass cleaner 32 oz',
  // @max 24
  'supplyPage.catalog.categoryField': 'Category (optional)',
  'supplyPage.catalog.categoryPlaceholder': 'e.g. Liquids',
  'supplyPage.catalog.categoryHelp': 'Pick one in use or type a new one.',
  // @max 24
  'supplyPage.catalog.howItComes': 'How it comes',
  'supplyPage.catalog.howItComesHelp': 'each, case of 12, gallon',
  // @max 24
  'supplyPage.catalog.price': 'Price (optional)',
  'supplyPage.catalog.pricePlaceholder': '$ 0.00',
  'supplyPage.catalog.priceHelp': 'For one of “how it comes”. Blank reads “No price”.',
  'supplyPage.catalog.nameRequired': 'Give the item a name.',
  'supplyPage.catalog.priceInvalid': 'Enter a price above zero, or leave it blank.',
  // @ph sku: the SKU typed; item: the name of the item that already has it
  'supplyPage.catalog.skuTaken': 'SKU {sku} is already on “{item}”.',
  'supplyPage.catalog.editHint': 'Every building with this item sees the change. Requests already sent keep the name and price they were sent with.',
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.catalog.added': '“{item}” added to the catalog',
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.catalog.saved': '“{item}” saved',
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.catalog.deleteTitle': 'Delete “{item}”?',
  'supplyPage.catalog.deleteMessageNone': 'No building has it switched on. Requests already sent keep their copy.',
  // @ph count: how many buildings have the item switched on
  'supplyPage.catalog.deleteMessage': { one: 'It also comes off the one building that has it switched on. Requests already sent keep their copy.', other: 'It also comes off the {count} buildings that have it switched on. Requests already sent keep their copy.' },
  // @ph item: a supply's name, as the office wrote it; count: how many buildings it was taken off
  'supplyPage.catalog.deleted': { one: '“{item}” deleted and taken off {count} building', other: '“{item}” deleted and taken off {count} buildings' },
  // @ph item: a supply's name, as the office wrote it
  'supplyPage.catalog.deletedNone': '“{item}” deleted',
  'supplyPage.catalog.gone': 'That item was already deleted.',
  // ── The catalog per building, and product photos (S131, Matt's board sm-web-03) ──
  // @max 24
  'supplyPage.catalog.building': 'Building',
  // @max 30
  // @note The building picker's first choice: the whole master list.
  'supplyPage.catalog.allProducts': 'All products',
  'supplyPage.catalog.leadBuilding': 'The products approved for this building. Its cleaners order only from this list.',
  'supplyPage.catalog.footer': 'Cleaners can only request products from their property’s assigned catalog — managed here per account.',
  // @max 18
  'supplyPage.catalog.col.product': 'Product',
  // @max 14
  'supplyPage.catalog.col.unitCost': 'Unit cost',
  // @max 20
  'supplyPage.catalog.addProduct': 'Add product',
  // @ph customer: the building's name
  'supplyPage.catalog.addProductTitle': 'Add products to {customer}',
  // @max 10
  'supplyPage.catalog.addOne': 'Add',
  // @max 30
  'supplyPage.catalog.createProduct': 'Create a new product',
  // @ph item: a supply's name, as the office wrote it; customer: the building's name
  'supplyPage.catalog.addedTo': '“{item}” added to {customer}',
  'supplyPage.catalog.allOn': 'Every catalog item is already on this building’s list.',
  'supplyPage.catalog.buildingEmpty': 'Add the products this building’s cleaners can order — from the catalog, or new.',
  // @max 24
  'supplyPage.catalog.image': 'Photo (optional)',
  // @max 20
  'supplyPage.catalog.imagePick': 'Choose a photo',
  // @max 20
  'supplyPage.catalog.imageChange': 'Change photo',
  // @max 20
  'supplyPage.catalog.imageRemove': 'Remove photo',
  'supplyPage.catalog.imageInvalid': 'Use a JPG or PNG photo of up to 1 MB.',
  'supplyPage.catalog.imageFailed': 'The item saved, but its photo didn’t. Try the photo again.',

  // ── Supplies: a building's switches (the customer's Supplies tab → Edit list) ─────────────
  'supplyPage.switches.lead': 'Switch on what this building gets from the catalog. Each change saves as you go.',
  // @ph count: how many catalog items this building has switched on; total: how many items the catalog holds
  'supplyPage.switches.countOn': '{count} of {total} items switched on',
  // @max 24
  'supplyPage.switches.saving': 'Saving…',
  // @max 24
  'supplyPage.switches.saved': 'Changes saved',
  // @ph count: how many switch changes did not reach the server
  'supplyPage.switches.failed': { one: '{count} change didn’t save.', other: '{count} changes didn’t save.' },
  // @max 16
  'supplyPage.switches.retry': 'Try again',
  // @max 18
  'supplyPage.switches.notSaved': 'Not saved',
  'supplyPage.switches.gone': 'No longer in the catalog',
  // @ph on: how many items in this group are switched on; total: how many items the group holds
  'supplyPage.switches.groupCount': '{on} of {total} on',
  // @max 10
  // @note Beside the switch that turns a whole category on or off.
  'supplyPage.switches.all': 'All',
  // @ph category: the category's name
  'supplyPage.switches.allAria': 'Every item in {category}',
  // @max 40
  'supplyPage.switches.search': 'Search the catalog',
  // @ph q: what the reader searched for
  'supplyPage.switches.noMatch': 'Nothing in the catalog matches “{q}”.',
  'supplyPage.switches.emptyCatalog': 'The catalog is empty',
  'supplyPage.switches.emptyCatalogHint': 'Add the items you supply on the Supplies page’s Catalog tab, then switch them on here.',
  // @max 24
  'supplyPage.switches.openCatalog': 'Open the catalog',
  // @max 14
  'supplyPage.switches.done': 'Done',

  // ── Supplies: a customer's own Supplies tab ─────────────────────────────────────────────
  // @max 16
  'supplyPage.cust.tab': 'Supplies',
  // @max 18
  'supplyPage.cust.thisMonth': 'This month',
  // @ph budget: the building's monthly supply budget
  'supplyPage.cust.thisMonthOf': 'delivered of {budget}',
  'supplyPage.cust.thisMonthNoBudget': 'delivered · no budget set',
  // @max 18
  'supplyPage.cust.onOrder': 'On order',
  // @ph count: how many of this building's requests are not delivered yet
  'supplyPage.cust.onOrderN': { one: '{count} request not delivered yet', other: '{count} requests not delivered yet' },
  'supplyPage.cust.onOrderNone': 'Nothing on order',
  // @max 18
  'supplyPage.cust.nextOrder': 'Next order',
  // @ph day: the day of the month this building's orders are due
  'supplyPage.cust.ordersOn': 'orders on the {day, ordinal}',
  // @max 18
  'supplyPage.cust.approver': 'Approver',
  'supplyPage.cust.approverSupervisor': 'the building’s account manager',
  'supplyPage.cust.approverNamed': 'named in Settings → Operations',
  'supplyPage.cust.approverNone': 'set a supervisor in Service setup',
  // @max 30
  'supplyPage.cust.editBudget': 'Edit budget and order day',
  'supplyPage.cust.requestsTitle': 'Requests for this building',
  // @max 18
  'supplyPage.cust.col.status': 'Status',
  // @max 20
  'supplyPage.cust.openInSupplies': 'Open in Supplies',
  'supplyPage.cust.noRequests': 'No requests for this building yet.',
  'supplyPage.cust.loadFailed': 'Couldn’t load this building’s requests',
  'supplyPage.cust.budgetTitle': 'Budget and order day',
  // @max 24
  'supplyPage.cust.budget': 'Monthly budget',
  'supplyPage.cust.budgetPlaceholder': '$ none',
  'supplyPage.cust.budgetHelp': 'Leave it blank for no budget.',
  // @max 24
  'supplyPage.cust.orderDay': 'Orders on day',
  // @ph day: the company's default order day
  'supplyPage.cust.orderDayPlaceholder': '{day} (company default)',
  // @ph day: the company's default order day
  'supplyPage.cust.orderDayHelp': '1 to 28, so every month has the day. Leave it blank to follow the company default (the {day, ordinal}).',
  'supplyPage.cust.budgetSaved': 'Supply settings updated',

  // ── The delivery step (Matt, 2026-10-12; per line since S131): the driver marks what arrived, ──
  //    and the cleaners see it on site

  // The driver's page (S4): phone first, no prices anywhere.
  // @max 30
  'deliveries.title': 'Deliveries',
  // @ph toDeliver: how many requests wait to be dropped off; delivered: how many were delivered today
  'deliveries.sub': '<b>{toDeliver}</b> to deliver · <b>{delivered}</b> delivered today',
  // @max 30
  'deliveries.toDeliver': 'To deliver',
  // @max 30
  'deliveries.deliveredToday': 'Delivered today',
  'deliveries.search': 'Search buildings or items',
  'deliveries.noAddress': 'No address on file',
  // @ph name: who in the office submitted it to the supplier; when: when they did
  'deliveries.sentBy': 'Ordered by {name} · {when, dateTime}',
  // @ph when: when it was submitted to the supplier
  'deliveries.sentAt': 'Ordered {when, dateTime}',
  // @ph count: how many items in the drop
  'deliveries.items': { one: '{count} item', other: '{count} items' },
  // @max 14
  // @note The driver taps it once one item is dropped off at the building.
  'deliveries.deliver': 'Delivered',
  // @max 18
  // @note The driver taps it once everything still to come on one order is dropped off.
  'deliveries.allDelivered': 'All delivered',
  // @max 22
  'deliveries.backordered': 'Backordered',
  // @max 30
  // @ph eta: the day the supplier expects to deliver
  'deliveries.backorderedEta': 'Backordered · ETA {eta, date}',
  // @max 60
  // @ph building: the building's name
  'deliveries.confirmTitle': 'Delivered to {building}?',
  // @ph count: how many items in the drop
  'deliveries.confirmMessage': { one: 'Everything still to come: {count} item. The person who asked and the account manager are told.', other: 'Everything still to come: {count} items. The person who asked and the account manager are told.' },
  // @ph item: the item's name, as the office wrote it; qty: how many arrived
  'deliveries.confirmLine': '{item} ×{qty}. The person who asked and the account manager are told.',
  // @max 30
  'deliveries.photo': 'Drop-off photo (optional)',
  // @max 18
  'deliveries.confirm': 'Yes, delivered',
  // @ph time: when it was delivered; name: who delivered it
  'deliveries.deliveredBy': 'Delivered at {time, time} by {name}',
  // @ph time: when it was delivered
  'deliveries.deliveredAt': 'Delivered at {time, time}',
  'deliveries.empty': 'Nothing to deliver',
  'deliveries.emptyHint': 'When the Supply Manager orders supplies from the supplier, they show here for you to drop off.',
  'deliveries.emptyToday': 'Nothing delivered yet today.',
  'deliveries.loadFailed': 'Couldn’t load the deliveries',
  // @note Shown when the phone has no connection: nothing on this page is kept on the phone.
  'deliveries.offline': 'No signal. Mark a delivery once you’re back online — nothing here is saved on the phone.',
  // @ph building: the building's name
  'deliveries.toast.done': 'Marked delivered — {building}',
  'deliveries.toast.moved': 'That changed since the list was read — it was already delivered, or the office took it back. The list now shows where it is.',
  'deliveries.toast.photoFailed': 'Marked delivered, but the photo didn’t upload.',
  'deliveries.toast.failed': 'Couldn’t save that. Check your connection and try again.',

  // The cleaners' line on My Stops Today and the visit (S6; PER LINE since S131 Builder C): item names
  // and quantities, nothing else.
  // @ph items: the items on their way, e.g. "Glass cleaner ×4 and Paper towels ×2"
  'crewSupply.onTheWay': 'Supplies on the way: {items, list}',
  // @ph item: a supply item and how many came, e.g. "Paper towels ×3"; time: when they came
  'crewSupply.lineDelivered': '{item} delivered today at {time, time}',
  // @ph item: a supply item and how many are still to come, e.g. "Trash liners ×2"; eta: the day the supplier expects to deliver it
  'crewSupply.lineBackordered': '{item} backordered — ETA {eta, date}',
  // @ph item: a supply item and how many are still to come, e.g. "Trash liners ×2"
  'crewSupply.lineBackorderedNoEta': '{item} backordered',

  // ── Supply usage (the Supplies page's Usage tab, and Reports → Supply usage) ───────────
  // @max 18
  'supplyUsage.col.item': 'Item',
  // @max 18
  // @note How many units were delivered.
  'supplyUsage.col.delivered': 'Delivered',
  // @max 18
  // @note How many deliveries (filled requests) included the item.
  'supplyUsage.col.deliveries': 'Deliveries',
  // @max 18
  'supplyUsage.col.unitPrice': 'Unit price',
  // @max 18
  'supplyUsage.col.spend': 'Spend',
  // @max 16
  'supplyUsage.noPrice': 'No price',
  // @max 24
  'supplyUsage.kpi.items': 'Items',
  // @max 24
  'supplyUsage.kpi.units': 'Units delivered',
  // @max 24
  'supplyUsage.kpi.spend': 'Spend',
  // @max 24
  'supplyUsage.kpi.budget': 'Budget this month',
  // @ph amount: what was delivered to the building this month
  'supplyUsage.budgetOf': '{amount} of {budget}',
  // @max 24
  'supplyUsage.noBudget': 'No budget set',
  'supplyUsage.search': 'Search items',
  // @ph shown: how many rows match the search
  'supplyUsage.matchCount': '{shown} of {total}',
  'supplyUsage.noMatch': 'Nothing matches your search',
  'supplyUsage.noMatchHint': 'Try another word, or clear the search.',
  'supplyUsage.emptyTitle': 'Nothing delivered',
  'supplyUsage.emptyHint': 'Nothing on a supply order was delivered in this period for these filters. An order counts here once an item on it is delivered.',
  // @ph months: how many months finished requests are kept
  'supplyUsage.note': 'Counted on delivery. Finished requests are kept for {months} months, so nothing older is here to count.',
  // @ph months: how many months finished requests are kept; date: the first day still kept
  'supplyUsage.beforeHistory': 'Finished requests are kept for {months} months, so a range can start no earlier than {date}.',

  // ── Reports: the filters, buttons and states every report shares ────────────────────────
  // @max 20
  'reportKit.day': 'Day',
  // @max 14
  'reportKit.today': 'Today',
  // @max 14
  'reportKit.yesterday': 'Yesterday',
  // @max 20
  'reportKit.period': 'Period',
  // @max 10
  'reportKit.period.7d': '7 days',
  // @max 10
  'reportKit.period.30d': '30 days',
  // @max 10
  'reportKit.period.90d': '90 days',
  // @max 10
  // @note The current calendar month, so far.
  'reportKit.period.month': 'Month',
  // @max 10
  // @note The last six months, up to today.
  'reportKit.period.6m': '6 months',
  // @max 10
  // @note The last twelve months, up to today.
  'reportKit.period.12m': '12 months',
  // @max 10
  // @note Pick your own start and end dates.
  'reportKit.period.custom': 'Custom',
  // @max 20
  'reportKit.dateRange': 'Date range',
  'reportKit.from': 'From',
  'reportKit.to': 'To',
  // @max 20
  'reportKit.manager': 'Manager',
  // @max 20
  'reportKit.customer': 'Customer',
  'reportKit.allManagers': 'All managers',
  // @note A Manager filter choice for an Operations Manager: every building of their account managers, and their own.
  'reportKit.myTeam': 'My team',
  'reportKit.allCustomers': 'All customers',
  // @ph name: the signed-in manager's own name
  'reportKit.me': '{name} (me)',
  // @max 18
  'reportKit.run': 'Run report',
  // @max 18
  'reportKit.running': 'Running…',
  // @max 18
  'reportKit.exportCsv': 'Export CSV',
  'reportKit.notRun': 'Set the criteria above and click <b>Run report</b>.',
  'reportKit.couldNotRun': 'Couldn’t run this report',
  // @max 16
  'reportKit.tryAgain': 'Try again',
  'reportKit.loadFailed': 'The report could not be loaded. Check your connection and try again.',
  // @note Reports, when the viewer may run none of the reports (each one needs its own permission).
  'reportKit.noReports': 'No reports to show',
  'reportKit.noReportsHint': 'Each report needs its own permission, and your access level includes none of them. Ask a Super Admin.',
  'reportKit.checkDates': 'Check the dates',
  'reportKit.pickBothDates': 'Pick both a start and an end date.',
  'reportKit.endBeforeStart': 'The end date is before the start date.',
  'reportKit.rangeTooLong': 'Pick a range of {days} days or fewer.',

  // ── Time to resolve (Matt's KPI: how long a ticket takes from opened to closed; lib/resolveTime) ──
  // @max 14
  // @note A span shorter than a minute, e.g. a ticket closed seconds after it was opened.
  'resolveTime.dur.underMinute': 'Under 1 min',
  // @max 10
  // @ph count: whole minutes, 1 to 59
  // @note A short span of time on a figure, e.g. "22 min". Keep it short: it sits under a big number.
  'resolveTime.dur.minutes': { one: '{count} min', other: '{count} min' },
  // @max 8
  // @ph count: whole hours, 1 to 23
  'resolveTime.dur.hours': { one: '{count} h', other: '{count} h' },
  // @max 16
  // @note A span of time, e.g. "3 h 10 min".
  'resolveTime.dur.hoursMinutes': '{hours} h {minutes} min',
  // @max 10
  // @ph count: whole days
  'resolveTime.dur.days': { one: '{count} day', other: '{count} days' },
  // @max 16
  // @ph count: whole days
  // @note A span of time, e.g. "1 day 4 h".
  'resolveTime.dur.daysHours': { one: '{count} day {hours} h', other: '{count} days {hours} h' },
  // @note The customer hub's Home tile. The hub stays in English for the customer (LANG-8); kept here so every word has one home.
  'resolveTime.hub.title': 'Average time to resolve',
  // @ph count: requests from the hub closed in the period
  'resolveTime.hub.closed': { one: '{count} request closed in the last {days} days', other: '{count} requests closed in the last {days} days' },
  'resolveTime.hub.none': 'No requests closed in the last {days} days.',
  'resolveTime.hub.cta': 'View requests →',
  // @max 24
  // @note Reports → the report's name in the picker, and in search.
  'resolveTime.report.tab': 'Time to resolve',
  'resolveTime.report.desc': 'How long tickets take from being opened to being closed, over a period: the average and the median for the whole company, by type and by customer, and how many were closed within their deadline.',
  'resolveTime.report.note': 'Counted from the moment a ticket is opened to the moment it is marked resolved. A reopened ticket counts once, to its last resolution. The deadline is the ticket’s own response standard.',
  // @max 28
  'resolveTime.report.kpi.average': 'Average time to resolve',
  // @max 28
  'resolveTime.report.kpi.median': 'Median',
  // @max 28
  'resolveTime.report.kpi.closed': 'Tickets closed',
  // @max 28
  'resolveTime.report.kpi.metDeadline': 'Closed within their deadline',
  // @ph onTime: tickets closed by their deadline; total: tickets closed
  'resolveTime.report.metOf': '{onTime} of {total}',
  // @max 28
  'resolveTime.report.byType': 'By type',
  // @max 28
  'resolveTime.report.byCustomer': 'By customer',
  // @max 20
  'resolveTime.report.col.type': 'Type',
  // @max 20
  'resolveTime.report.col.customer': 'Customer',
  // @max 16
  'resolveTime.report.col.closed': 'Closed',
  // @max 16
  'resolveTime.report.col.average': 'Average',
  // @max 16
  'resolveTime.report.col.median': 'Median',
  // @max 20
  'resolveTime.report.col.met': 'Within deadline',
  // @max 24
  'resolveTime.report.type.complaint': 'Complaint',
  // @max 24
  'resolveTime.report.type.request': 'Request',
  // @max 24
  'resolveTime.report.type.issue': 'Issue',
  // @max 24
  'resolveTime.report.type.failed_inspection': 'Failed inspection',
  'resolveTime.report.emptyTitle': 'No tickets closed',
  'resolveTime.report.emptyHint': 'No ticket was closed in this period for the selected criteria. Widen the period or clear the filters.',

  // ── Reports → Visitor ratings (QR-30, 2026-10-17): the thumbs up and down people tap under an
  // area's QR page, by building, worst first. Only the office reads them. ──
  // @max 24
  'visitorRatings.report.tab': 'Visitor ratings',
  'visitorRatings.report.desc': 'Thumbs up and down from people who scanned an area’s QR code, by building, the lowest first. Open a building for its areas. Only the office sees these.',
  // @note Under the Run button.
  'visitorRatings.report.note': 'One vote per phone, per area, per day; a phone can change its vote the same day.',
  // @max 22
  'visitorRatings.report.kpi.up': 'Thumbs up',
  // @max 22
  'visitorRatings.report.kpi.down': 'Thumbs down',
  // @max 22
  // @note The share of all votes that were thumbs up.
  'visitorRatings.report.kpi.positive': 'Positive',
  // @max 22
  'visitorRatings.report.kpi.buildings': 'Buildings rated',
  // @max 20
  'visitorRatings.report.col.building': 'Building',
  // @max 20
  'visitorRatings.report.col.area': 'Area',
  // @max 20
  'visitorRatings.report.col.location': 'Location',
  // @max 14
  'visitorRatings.report.col.up': 'Thumbs up',
  // @max 14
  'visitorRatings.report.col.down': 'Thumbs down',
  // @max 14
  'visitorRatings.report.col.positive': '% positive',
  // @ph pct: a whole number from 0 to 100
  'visitorRatings.report.pct': '{pct}%',
  // @note One area's figures inside its building's row.
  // @ph up: how many thumbs up
  // @ph down: how many thumbs down
  // @ph pct: the share that were up, a whole number from 0 to 100
  'visitorRatings.report.areaFigures': '{up} up · {down} down · {pct}% positive',
  // @ph building: the building's name
  'visitorRatings.report.areasOf': 'Areas of {building}',
  // @max 14
  'visitorRatings.report.archived': 'Archived',
  // @note A building or an area that has since been removed but still has votes in the period.
  'visitorRatings.report.removedLocation': 'A location since removed',
  'visitorRatings.report.removedArea': 'An area since removed',
  'visitorRatings.report.emptyTitle': 'No ratings in this period',
  'visitorRatings.report.emptyHint': 'Ratings appear here once people scan an area’s QR code and tap thumbs up or down.',

  // ── The shared inspection report (/inspect/:token): the customer's page, shown in English (LANG-8) ──
  // @max 40
  'publicReport.notFound.title': 'Report not found',
  // @note The link names no inspection report the customer may read.
  'publicReport.notFound.body': 'This link may be invalid or the inspection hasn’t been submitted.',
  // @max 48
  // @note The report exists but could not be loaded (the server was busy, or there was no signal).
  'publicReport.unavailable.title': 'This report couldn’t load just now',
  'publicReport.unavailable.body': 'Please check your signal and try again in a minute.',
  // @max 16
  'publicReport.tryAgain': 'Try again',
  // @max 18
  'publicReport.download': 'Download PDF',
  // @max 18
  'publicReport.preparing': 'Preparing…',
  'publicReport.downloadFailed': 'Could not download the PDF',

  // ── The satisfaction survey (/survey/:token): the customer's page, shown in English (LANG-8) ──
  // @max 48
  // @ph company: our company's name, from Settings → Company
  'publicSurvey.title': 'How is {company} doing?',
  // @max 40
  'publicSurvey.titlePlain': 'How are we doing?',
  'publicSurvey.intro': 'Rate your cleaning service from 1 (poor) to 5 (excellent). Your answer goes straight to our operations team.',
  // @max 24
  'publicSurvey.ratingLabel': 'Your rating',
  // @max 16
  // @ph n: the rating, 1 to 5
  'publicSurvey.ratingOption': '{n} of 5',
  // @max 20
  'publicSurvey.rating.1': 'Poor',
  // @max 20
  'publicSurvey.rating.5': 'Excellent',
  // @max 40
  'publicSurvey.commentLabel': 'Anything you would like us to know?',
  // @max 24
  'publicSurvey.commentOptional': '(optional)',
  // @max 18
  'publicSurvey.submit': 'Send my answer',
  // @max 22
  'publicSurvey.sending': 'Sending your answer…',
  // @max 18
  'publicSurvey.change': 'Change my answer',
  // @max 40
  'publicSurvey.thanksTitle': 'Thank you',
  'publicSurvey.thanksBody': 'We have your answer. You can change it from this link until the survey closes.',
  // @max 40
  'publicSurvey.closedTitle': 'This survey has closed',
  'publicSurvey.closedBody': 'Thank you all the same. If anything needs our attention, just reply to any of our emails.',
  // @max 40
  'publicSurvey.notFoundTitle': 'Survey not found',
  'publicSurvey.notFoundBody': 'This link may be invalid or incomplete. Please use the link in your email.',
  // @max 48
  'publicSurvey.unavailableTitle': 'This survey couldn’t load just now',
  'publicSurvey.unavailableBody': 'Please check your signal and try again in a minute.',
  // @max 16
  'publicSurvey.tryAgain': 'Try again',
  'publicSurvey.pickRating': 'Choose a rating from 1 to 5.',
  'publicSurvey.saveFailed': 'Your answer didn’t save. Please try again.',

  // ── Checklist assignments (who holds which checklist; supervisor) ───────────────────────
  // @max 40
  'cka.issue.overdue': 'Checklists overdue today',
  // @max 40
  'cka.issue.rules': 'Cleaners with a rule off',
  // @max 40
  'cka.issue.nobody': 'Checklists nobody holds',
  // @max 40
  'cka.issue.strays': 'Held by someone not scheduled there',
  'cka.hint.overdue': 'A cleaner on a clean that has started, past the reminder time, with their checklist unfinished.',
  'cka.hint.rules': 'The office turned the clock-out block or the clock-in location check off for this person.',
  'cka.hint.nobody': 'A checklist filed under a customer that no cleaner there holds. Nobody will ever fill it.',
  'cka.hint.strays': 'A cleaner still holds a checklist at a customer they are not on an upcoming clean for.',
  // @max 48
  'cka.rule.checklist': 'Must finish checklist before clocking out',
  // @max 48
  'cka.rule.geofence': 'Check location at clock-in (geofence)',
  // @max 24
  'cka.ruleOff.checklist': 'Checklist block off',
  // @max 24
  'cka.ruleOff.geofence': 'Geofence off',
  'cka.ruleMeaning.checklist': 'They can clock out without finishing their checklist.',
  'cka.ruleMeaning.geofence': 'They can clock in from anywhere — no location check.',
  // @max 16
  'cka.filter.all': 'All',
  // @max 24
  'cka.filter.with': 'With checklists',
  // @max 24
  'cka.filter.attn': 'Needs attention',
  // @max 30
  'cka.head.cleanerChecklist': 'Cleaner & checklist',
  // @max 20
  'cka.head.customer': 'Customer',
  // @max 20
  'cka.head.progress': 'Progress',
  // @max 20
  'cka.head.cleaner': 'Cleaner',
  // @max 20
  'cka.head.whatIsOff': 'What is off',
  // @max 20
  'cka.head.checklist': 'Checklist',
  'cka.assignedChecklist': 'Assigned checklist',
  // @ph done: items done; total: items on the checklist
  'cka.progress': '{done}/{total} done',
  // @max 20
  'cka.notStarted': 'Not started',
  // @max 12
  'cka.open': 'Open',
  // @max 20
  'cka.turnBackOn': 'Turn back on',
  // @ph checklist: the checklist's name; customer: the customer's name
  'cka.assignAria': 'Assign a cleaner to {checklist} at {customer}',
  'cka.notOnCleanThere': 'Not on an upcoming clean there.',
  // @max 12
  'cka.remove': 'Remove',
  'cka.offline': 'You’re offline. What’s below is the last thing this device read, and changes won’t save until you reconnect.',
  'cka.countersAria': 'Checklist assignments needing attention',
  // @ph detail: what went wrong
  'cka.loadFailed': 'Couldn’t load the checklists. {detail} The counters above cover only what did load.',
  'cka.checkConnection': 'Check your connection and try again.',
  // @max 16
  'cka.tryAgain': 'Try again',
  'cka.loading': 'Loading…',
  'cka.scheduleLoading': 'Still loading the schedule — this one needs the upcoming cleans.',
  'cka.nothingHere': 'Nothing here',
  // @ph label: the problem's name
  'cka.noneNow': '{label}: none right now.',
  'cka.noun.items': 'items',
  'cka.noun.customers': 'customers',
  'cka.noun.cleaners': 'cleaners',
  'cka.browseBy': 'Browse by',
  // @max 16
  'cka.customers': 'Customers',
  // @max 16
  'cka.cleaners': 'Cleaners',
  'cka.searchCustomers': 'Search customers',
  'cka.searchCleaners': 'Search cleaners',
  'cka.filterAria': 'Filter',
  'cka.needsAttention': 'Needs attention',
  'cka.outsideSearch': 'Open, but outside this search.',
  'cka.outsideFilter': 'Open, but outside this filter.',
  // @max 16
  'cka.showAll': 'Show all',
  'cka.noCustomersMatch': 'No customers match.',
  'cka.noCleanersMatch': 'No cleaners match.',
  // @ph count: how many customers
  'cka.customerCount': { one: '{count} customer', other: '{count} customers' },
  // @ph count: how many customers match
  'cka.customerMatch': { one: '{count} customer match', other: '{count} customers match' },
  // @ph count: how many cleaners
  'cka.cleanerCount': { one: '{count} cleaner', other: '{count} cleaners' },
  // @ph count: how many cleaners match
  'cka.cleanerMatch': { one: '{count} cleaner match', other: '{count} cleaners match' },
  // @ph count: how many checklists
  'cka.checklistCount': { one: '{count} checklist', other: '{count} checklists' },
  'cka.checklistsUnknown': 'Checklists —',
  'cka.ruleIsOff': 'a clock rule is off',
  // @max 24
  'cka.openCustomer': 'Open customer',
  'cka.pickCustomer': 'Pick a customer',
  'cka.pickCleaner': 'Pick a cleaner',
  'cka.pickCustomerHint': 'Search on the left to see a customer’s checklists and who holds each one.',
  'cka.pickCleanerHint': 'Search on the left to see everywhere a cleaner works and their checklist there.',
  // @max 30
  'cka.assignCleaner': '＋ Assign a cleaner',
  // @ph name: a cleaner's name
  'cka.scheduledHere': '{name} · scheduled here',
  // @ph name: a cleaner's name
  'cka.notScheduledHere': '{name} · not on an upcoming clean here',
  // @max 20
  'cka.doneToday': 'Done today',
  // @max 20
  // @ph done: items done; total: items on the checklist
  'cka.todayProgress': '{done}/{total} today',
  // @max 24
  'cka.notStartedToday': 'Not started today',
  // @max 20
  'cka.cleaner': 'Cleaner',
  // @max 24
  'cka.openTimeTab': 'Open Time tab',
  'cka.whereTheyWork': 'Where they work, and their checklist there',
  // @max 20
  'cka.theirChecklist': 'Their checklist',
  // @max 12
  'cka.today': 'Today',
  'cka.notScheduledAnywhere': 'Not scheduled anywhere yet',
  'cka.notScheduledAnywhereHint': 'They’ll appear here once they’re on a customer’s upcoming clean.',
  // @max 24
  'cka.noChecklist': 'No checklist',
  // @max 30
  'cka.notOnUpcoming': 'Not on an upcoming clean',
  // @max 24
  'cka.clockRules': 'Clock rules',
  'cka.ruleOffNote': 'Off for this cleaner — the office set it on their Time tab.',
  'cka.ruleOnNote': 'On.',
  // @max 8
  'cka.off': 'Off',
  // @max 8
  'cka.on': 'On',
  'cka.thatCleaner': 'that cleaner',
  'cka.thatChecklist': 'that checklist',
  // @ph name: a cleaner's name; checklist: a checklist's name
  'cka.moved': '{name} moved to {checklist}',
  // @ph name: a cleaner's name; checklist: a checklist's name
  'cka.nowHas': '{name} now has {checklist}',
  // @ph checklist: a checklist's name; name: a cleaner's name
  'cka.reassigned': '{checklist} moved to {name}',
  // @ph name: a cleaner's name
  'cka.removed': '{name} has no checklist here',
  // @ph name: a checklist's name
  'cka.deleted': '“{name}” deleted',
  'cka.deleteFailed': 'Could not delete the checklist',
  'cka.copied': 'Checklist added — edit it for this customer',
  'cka.copyFailed': 'Could not copy that checklist',
  'cka.anotherCustomer': 'another customer',
  // @max 30
  'cka.addChecklist': '＋ Add checklist',
  // @max 30
  'cka.blank': 'Blank checklist',
  // @ph name: a starter checklist's name
  'cka.startFrom': 'Start from · {name}',
  // @ph name: a checklist's name; customer: the customer it belongs to
  'cka.copyFrom': 'Copy · {name} · {customer}',
  // @max 30
  'cka.give': 'Give a checklist',
  // @ph customer: the customer's name
  'cka.addAria': 'Add a checklist for {customer}',
  // @max 20
  'cka.customer': 'Customer',
  // @ph name: the supervisor's name
  'cka.supervisor': 'Supervisor: {name}',
  // @ph count: how many cleaners are scheduled
  'cka.scheduledCount': { one: '{count} cleaner scheduled', other: '{count} cleaners scheduled' },
  'cka.checklistsForCustomer': 'Checklists for this customer',
  'cka.customersChecklists': 'This customer’s checklists',
  // @ph detail: what went wrong
  'cka.customerLoadFailed': 'Couldn’t load this customer’s checklists. {detail}',
  'cka.noChecklists': 'No checklists here. That’s fine for a short weekly clean — add one when a cleaner needs it.',
  // @ph count: how many items
  'cka.itemCount': { one: '{count} item', other: '{count} items' },
  // @max 20
  'cka.checklistWord': 'Checklist',
  // @max 12
  // @note After the item count: the checklist is not published yet.
  'cka.draft': 'Draft',
  // @max 12
  'cka.edit': 'Edit',
  // @max 12
  'cka.delete': 'Delete',
  // @max 30
  'cka.nobodyHolds': 'Nobody holds this checklist',
  // @max 16
  'cka.reassign': 'Reassign',
  // @ph checklist: a checklist's name; name: a cleaner's name
  'cka.reassignAria': 'Reassign {checklist} from {name}',
  // @ph name: a cleaner's name; checklist: a checklist's name
  'cka.removeAria': 'Remove {name} from {checklist}',
  // @ph checklist: a checklist's name
  'cka.assignToAria': 'Assign a cleaner to {checklist}',
  // @max 40
  'cka.withoutChecklist': 'Scheduled here without a checklist',
  // @ph name: a cleaner's name; customer: the customer's name
  'cka.giveAria': 'Give {name} a checklist at {customer}',
  'cka.deleteTitle': 'Delete checklist?',
  // @ph name: the checklist's name; count: how many cleaners hold it; customer: the customer's name
  'cka.deleteMessage': { one: 'Delete “{name}”? It comes off {count} cleaner at {customer}. Completed checklists keep their record. This can’t be undone.', other: 'Delete “{name}”? It comes off {count} cleaners at {customer}. Completed checklists keep their record. This can’t be undone.' },
  // @max 24
  'cka.deleteConfirm': 'Delete checklist',

  // ── A clean's page (what a cleaner reads on it) ─────────────────────────────────────────
  // @max 16
  'jobPage.status.upcoming': 'Upcoming',
  // @max 16
  'jobPage.status.in_progress': 'In Progress',
  // @max 16
  'jobPage.status.done': 'Done',
  // @max 16
  'jobPage.status.cancelled': 'Cancelled',
  // @max 16
  'jobPage.status.missed': 'Missed',
  // @note Stands in for a service's name when the clean has none.
  'jobPage.aJob': 'Job',
  'jobPage.notFound': 'Job not found',
  'jobPage.notYours': 'Not your clean',
  'jobPage.notYoursBody': 'This clean isn’t assigned to you.',
  // ── The clean's conflict banner (CS-693): a cleaner reads their own, in the second person ──
  // @max 40
  'jobPage.conflict.title': 'Scheduling conflict',
  // @note To the cleaner themself: they called out or have time off on this clean's day, and are still on it.
  'jobPage.conflict.youOff': 'You’re booked off this day but you’re still on this clean. Check with your manager before you clock in.',
  // @ph place: the customer of the other clean; time: its time range, e.g. 5:30 PM – 11:30 PM
  'jobPage.conflict.youOverlap': 'You’re also on {place} at {time}.',
  // @ph name: a team member's name
  'jobPage.conflict.theyOff': '{name} has time off this day but is still on this clean',
  // @ph name: a team member's name; reason: why, in the office's own words (not translated)
  'jobPage.conflict.theyOffReason': '{name} has time off this day ({reason}) but is still on this clean',
  // @ph name: a team member's name; place: the customer of the other clean; time: its time range
  'jobPage.conflict.theyOverlap': '{name} overlaps with {place} {time}',
  // @note Stands in for the other clean's customer when it has none.
  'jobPage.conflict.anotherClean': 'another clean',
  // @max 24
  'jobPage.backMyDay': 'My Day',
  // @max 24
  'jobPage.backSchedule': 'Schedule',
  // @max 30
  'jobPage.details': 'Details',
  // @max 20
  'jobPage.company': 'Company',
  // @max 20
  'jobPage.location': 'Location',
  // @max 16
  'jobPage.directions': 'Directions',
  // @max 20
  'jobPage.contact': 'Contact',
  // @max 12
  'jobPage.call': 'Call',
  // @max 12
  'jobPage.text': 'Text',
  'jobPage.contactOnSite': '(set on the site record)',
  // @max 20
  'jobPage.crew': 'Crew',
  // @max 24
  'jobPage.crewThisClean': 'Crew (this clean)',
  // @note Under the Crew field when the office edits a clean: a search box that adds cleaners.
  'jobPage.crewHelp': 'Type a name to add someone. Everyone on the clean can clock in; at least one is needed.',
  // @note After a cleaner's name: they are on this customer's regular (standing) crew.
  'jobPage.standing': '(standing)',
  // @max 20
  'jobPage.coveringFor': 'Covering for',
  // @ph cover: the cleaner covering; covered: the cleaner whose shift it is
  'jobPage.isCoveringFor': '{cover} <muted>is covering for</muted> {covered}',
  'jobPage.coverNote': 'They fill the covered cleaner’s checklist on this clean.',
  // @max 20
  'jobPage.notes': 'Notes',
  'jobPage.noNotes': 'No notes',
  // @max 30
  'jobPage.instructions': 'Service instructions',
  // @max 20
  'jobPage.expectedTime': 'Expected time',
  // @max 20
  'jobPage.notSet': 'Not set',
  // @max 20
  'jobPage.access': 'Access',
  // @max 20
  'jobPage.codes': 'Codes',
  // @max 12
  'jobPage.door': 'Door:',
  // @max 12
  'jobPage.alarm': 'Alarm:',
  // @ph hint: the office's reminder for the code
  'jobPage.hint': '(hint: {hint})',
  // @max 12
  'jobPage.reveal': 'Reveal',
  // @max 12
  'jobPage.hide': 'Hide',
  'jobPage.noCode': 'No code set',
  'jobPage.revealFailed': 'Could not reveal the code',
  // @max 30
  'jobPage.areas': 'Cleaning areas',
  'jobPage.noAreas': 'No cleaning instructions set for this site yet.',
  // @max 40
  'jobPage.referenceMedia': 'Reference photos & video',
  // @max 40
  'jobPage.seriesCrew': 'Crew across the whole series',
  // @max 16
  'jobPage.thisClean': 'this clean',
  // @max 40
  'jobPage.seriesVisits': 'Visits in this series',
  // @ph count: how many visits the series has
  'jobPage.seriesTotal': '{count} total',
  // @max 16
  'jobPage.unassigned': 'Unassigned',
  // @max 12
  'jobPage.viewing': 'Viewing',
  // @ph shown: visits listed; total: visits in the series
  'jobPage.seriesShowing': 'Showing {shown} of {total} visits — open one to page further through the series.',
  // @max 30
  'jobPage.timeClock': 'Time clock',
  'jobPage.someone': 'Unknown',

  // ── Keys (checking building keys in and out) ────────────────────────────────────────────
  'offline.savedOnDevice': 'Saved on this device. It’ll sync when you’re back online.',
  // @max 20
  'keyPage.title': 'Keys',
  // @max 16
  'keyPage.addKey': 'Add key',
  'keyPage.search': 'Search company, location, key, master code, or holder…',
  // @max 12
  'keyPage.status.all': 'All',
  // @max 12
  // @note The key is back in the lockbox.
  'keyPage.status.in': 'In',
  // @max 12
  // @note The key is checked out to someone.
  'keyPage.status.out': 'Out',
  // @max 12
  'keyPage.status.unknown': 'Unknown',
  // @max 12
  'keyPage.status.lost': 'Lost',
  'keyPage.emptyCrew': 'No keys for your companies yet. Keys appear here for the companies you’re scheduled at, plus any key checked out to you.',
  'keyPage.empty': 'No keys yet.',
  'keyPage.emptyManage': 'No keys yet. Click <b>Add key</b> to start, or import them from the sheet.',
  'keyPage.noMatch': 'No keys match.',
  // @ph query: what was typed in the search box
  'keyPage.noMatchQuery': 'No keys match “<b>{query}</b>”.',
  // @ph status: a key status (In, Out, Unknown, Lost)
  'keyPage.noMatchStatus': 'No keys match with status <b>{status}</b>.',
  // @ph query: what was typed; status: a key status
  'keyPage.noMatchBoth': 'No keys match “<b>{query}</b>” with status <b>{status}</b>.',
  // @note Stands in for a key's name when it has none.
  'keyPage.aKey': 'Key',
  // @ph key: the key's name
  'keyPage.checkedIn': '{key} checked in',
  // @ph key: the key's name
  'keyPage.checkedOut': '{key} checked out',
  // @ph key: the key's name
  'keyPage.markedUnknown': '{key} marked Unknown',
  // @ph key: the key's name
  'keyPage.reportedLost': '{key} reported lost',
  'keyPage.updated': 'Key updated',
  'keyPage.added': 'Key added',
  // @ph key: the key's name
  'keyPage.deletedToast': '{key} deleted',
  // @ph key: the key's name
  'keyPage.historyTitle': 'History. {key}',
  // @ph key: the key's name
  'keyPage.deleteTitle': 'Delete {key}?',
  'keyPage.thisKey': 'this key',
  'keyPage.deleteMessage': 'The key and its history will be removed.',
  // @max 16
  'keyPage.delete': 'Delete',
  // @ph count: how many keys the company has
  'keyPage.groupCount': { one: '{count} key', other: '{count} keys' },
  'keyPage.noun': 'keys',
  // @max 16
  'keyPage.col.key': 'Key',
  // @max 16
  'keyPage.col.location': 'Location',
  // @max 16
  'keyPage.col.master': 'Master',
  // @max 16
  'keyPage.col.status': 'Status',
  // @max 16
  'keyPage.col.heldBy': 'Held by',
  // @max 20
  'keyPage.unassigned': 'Unassigned',
  // @ph code: the master key's code
  'keyPage.master': 'Master {code}',
  // @ph name: who holds the key
  'keyPage.heldBy': 'Held by {name}',
  // @max 16
  'keyPage.checkOut': 'Check out',
  // @max 16
  'keyPage.checkIn': 'Check in',
  // @max 16
  'keyPage.history': 'History',
  // @max 16
  'keyPage.edit': 'Edit',
  // @max 16
  'keyPage.handOff': 'Hand off',
  // @ph action: "Check out" or "Hand off"; key: the key's name
  'keyPage.checkoutTitle': '{action}. {key}',
  'keyPage.handoffNote': 'Currently out. This records a new checkout to the next holder (no phantom check-in).',
  // @max 40
  'keyPage.whoTakes': 'Who is taking the key?',
  'keyPage.someoneElse': 'Someone else (client, contractor…)',
  // @max 30
  'keyPage.theirName': 'Their name',
  'keyPage.theirNamePlaceholder': 'e.g. Building manager. Bella Smiles',
  // @max 30
  'keyPage.noteOptional': 'Note (optional)',
  'keyPage.notePlaceholder': 'e.g. for Friday deep-clean',
  'keyPage.backInLockbox': 'Back in the lockbox',
  'keyPage.handOffSomeone': 'Hand off to someone else…',
  'keyPage.checkOutSomeone': 'Check out to someone…',
  'keyPage.whereaboutsUnclear': 'Whereabouts unclear…',
  'keyPage.confirmedLost': 'Confirmed lost…',
  'keyPage.setStatus': 'Set status',
  // @ph key: the key's name
  'keyPage.setStatusTitle': 'Set status · {key}',
  // @ph key: the key's name
  'keyPage.unknownTitle': 'Mark “{key}” as Unknown?',
  'keyPage.unknownBody': 'Use this when the key’s whereabouts are unclear. Missing from the lockbox or holder unconfirmed, but likely recoverable. Any current holder is cleared and the change is logged in the key’s history.',
  'keyPage.unknownPlaceholder': 'e.g. not in lockbox at Friday audit',
  // @max 20
  'keyPage.unknownConfirm': 'Mark Unknown',
  // @ph key: the key's name
  'keyPage.lostTitle': 'Report “{key}” as Lost?',
  'keyPage.lostBody': 'Use this when the key is confirmed lost. Any current holder is cleared, managers are alerted, and the change is logged in the key’s history. Recovering it later just means checking it back in.',
  'keyPage.lostPlaceholder': 'e.g. dropped off-site, not recovered after search',
  // @max 20
  'keyPage.lostConfirm': 'Report Lost',
  // @max 24
  'keyPage.editTitle': 'Edit key',
  // @max 24
  'keyPage.addTitle': 'Add key',
  // @max 20
  'keyPage.company': 'Company',
  'keyPage.companyHelp': 'Companies that already have keys are listed first. Pick one to file this key under the same group.',
  // @max 20
  'keyPage.location': 'Location',
  // @ph place: the customer's address
  'keyPage.filesAt': 'This key files at {place}.',
  'keyPage.theLocation': 'the customer’s location',
  'keyPage.noLocation': 'This company has no location yet. Add it on the account first; a key can’t be saved without one.',
  'keyPage.linkCompany': 'Link the company to a customer (above) to file this key at its location.',
  // @max 20
  'keyPage.label': 'Key label',
  'keyPage.labelPlaceholder': 'e.g. SU 9A',
  // @max 20
  'keyPage.masterCode': 'Master code',
  'keyPage.masterPlaceholder': 'e.g. SU 9',
  // @max 20
  'keyPage.notes': 'Notes',
  'keyPage.notesPlaceholder': 'e.g. front door + alarm',
  // @ph name: who has the key
  'keyPage.outWith': 'Out with <b>{name}</b>',
  'keyPage.inLockbox': 'In the lockbox',
  'keyPage.lostSummary': 'Reported lost',
  'keyPage.unknownSummary': 'Whereabouts unknown',
  // @ph date: when; ago: how long ago
  'keyPage.since': 'since {date} · {ago}',
  'keyPage.noHistory': 'No check-in/out history yet.',
  // @max 20
  'keyPage.evt.checkout': 'Checked out',
  // @max 20
  'keyPage.evt.checkin': 'Checked in',
  // @max 20
  'keyPage.evt.unknown': 'Marked Unknown',
  // @max 20
  'keyPage.evt.lost': 'Reported Lost',
  // @max 20
  'keyPage.evt.created': 'Added',
  // @max 20
  'keyPage.evt.edited': 'Edited',
  // @ph name: who the key went to
  'keyPage.toWhom': 'to <b>{name}</b>',
  // @ph name: who did it
  'keyPage.byWhom': 'by <b>{name}</b>',
  // @ph held: how long the key was out, like 3 hrs
  'keyPage.outFor': 'out {held}',
  // @ph count: minutes
  'keyPage.held.min': { one: '{count} min', other: '{count} min' },
  // @ph count: hours
  'keyPage.held.hr': { one: '{count} hr', other: '{count} hrs' },
  // @ph count: days
  'keyPage.held.day': { one: '{count} day', other: '{count} days' },

  // ── The owner's and manager's dashboard: the book's period ──────────────────────────────
  // @max 14
  // @note A period the profit & loss covers: on the period switch, and after "Revenue ·" on the tiles.
  'acctDash.range.day': 'Today',
  // @max 14
  'acctDash.range.d10': '10 days',
  // @max 14
  'acctDash.range.d15': '15 days',
  // @max 14
  'acctDash.range.d30': '30 days',
  // @max 14
  'acctDash.range.d60': '60 days',
  // @max 14
  'acctDash.range.d90': '90 days',
  // @max 14
  'acctDash.range.m12': '12 months',
  // @max 14
  'acctDash.range.all': 'All-time',
  // @max 14
  'acctDash.range.mtd': 'This month',
  // @note Spoken name of the period list (this month, 30 / 60 / 90 days, 12 months, then months by name), for screen readers.
  'acctDash.windowLabel': 'Period shown',
  // @max 16
  // @note In the period list when the reader typed their own first and last day.
  'acctDash.period.custom': 'Custom dates',
  // @note Spoken name of the period's first-day date field, for screen readers.
  'acctDash.period.from': 'From',
  // @note Spoken name of the period's last-day date field, for screen readers.
  'acctDash.period.to': 'To',
  // @max 20
  // @note Beside the period switch while the chosen period's figures are on their way.
  'acctDash.updating': 'Updating…',

  // ── The manager's Home (the manager view redesign, Builder B — UI_RULES §152) ───────────────
  // @max 28
  // @note The Home page's greeting when the signed-in person has no first name on file.
  'mgrHome.greet.morning': 'Good morning',
  // @max 28
  'mgrHome.greet.afternoon': 'Good afternoon',
  // @max 28
  'mgrHome.greet.evening': 'Good evening',
  // @max 40
  // @ph name: the signed-in person's first name
  'mgrHome.greet.morningName': 'Good morning, {name}',
  // @max 40
  // @ph name: the signed-in person's first name
  'mgrHome.greet.afternoonName': 'Good afternoon, {name}',
  // @max 40
  // @ph name: the signed-in person's first name
  'mgrHome.greet.eveningName': 'Good evening, {name}',
  // @ph count: how many buildings the manager looks after
  // @note Under the greeting: the reader's role and how many buildings are theirs.
  'mgrHome.sub.self': { one: 'Manager · {count} property', other: 'Manager · {count} properties' },
  // @ph count: how many buildings the company looks after
  // @note Under the greeting on the owner's Manager view with no manager picked.
  'mgrHome.sub.all': { one: 'All managers · {count} property', other: 'All managers · {count} properties' },
  // @ph name: the manager picked in the filter; count: how many buildings they look after
  'mgrHome.sub.named': { one: '{name} · {count} property', other: '{name} · {count} properties' },
  // @max 20
  // @note The filter that picks whose buildings the Home counts.
  'mgrHome.manager': 'Manager',
  // @max 24
  'mgrHome.allManagers': 'All managers',
  // @note Spoken name of the owner's switch between their own dashboard and the managers' Home, for screen readers.
  'mgrHome.switch.aria': 'Home view',
  // @max 20
  // @note The owner's own dashboard (their key figures), one side of the switch at the top of Home.
  'mgrHome.switch.owner': 'Owner cockpit',
  // @max 20
  // @note The managers' Home (inspections, hours, requests, supplies), the other side of the switch.
  'mgrHome.switch.manager': 'Manager view',
  // @max 20
  // @note A third side of the owner's switch: an Operations Manager's Home (their team of account managers), picked from a list.
  'mgrHome.switch.ops': 'Operations view',
  // @max 20
  // @note A fourth side of the owner's switch: the Supply Manager's Home (the queue of approved supply orders), as the owner.
  'mgrHome.switch.supply': 'Supply view',
  // @max 32
  'mgrHome.noProps.title': 'No buildings yet',
  'mgrHome.noProps.self': 'When the office makes you the manager of a building, its inspections, hours, requests and supplies show up here.',
  'mgrHome.noProps.named': 'This manager doesn’t look after any buildings yet.',
  // @note On a Home tile whose figures could not be read.
  'mgrHome.tile.error': 'Couldn’t load this.',
  // @max 16
  'mgrHome.tile.retry': 'Try again',
  // @note On a Home tile while the phone has no signal.
  'mgrHome.tile.offline': 'You’re offline. This updates when you’re back online.',
  // @max 24
  // @icon
  'mgrHome.insp.title': 'Inspections',
  // @max 16
  // @ph count: how many buildings are due an inspection
  'mgrHome.insp.due': { one: '{count} due', other: '{count} due' },
  // @max 24
  // @ph score: the last inspection's score, a whole-number percentage; date: the day it was done
  'mgrHome.insp.last': 'last {score}% {date, date}',
  // @max 28
  'mgrHome.insp.none': 'No inspections yet',
  // @max 20
  // @ph count: how many scores the little bar chart shows
  // @note Beside a small bar chart of the most recent inspection scores.
  'mgrHome.insp.trend': { one: 'last score', other: 'last {count} scores' },
  // @ph count: how many scores; scores: the scores, oldest first, like 88%, 74% and 92%
  'mgrHome.insp.trendAria': { one: 'The last score: {scores, list}', other: 'The last {count} scores, oldest first: {scores, list}' },
  // @max 24
  'mgrHome.insp.start': 'Start inspection →',
  // @max 24
  'mgrHome.insp.view': 'View inspections →',
  // @max 24
  // @icon
  'mgrHome.hours.title': 'Hours Approval',
  // @max 16
  // @ph count: how many people's timesheets (their clock-ins and clock-outs) wait for approval
  'mgrHome.hours.pending': { one: '{count} pending', other: '{count} pending' },
  // @max 16
  // @ph date: the last day of the current pay period
  'mgrHome.hours.due': 'due {date, date}',
  // @max 32
  // @ph count: how many overtime entries wait for approval
  'mgrHome.hours.ot': { one: '{count} flagged for overtime', other: '{count} flagged for overtime' },
  // @max 24
  'mgrHome.hours.cta': 'Review hours →',
  // @max 24
  // @icon
  'mgrHome.req.title': 'Client Requests',
  // @max 16
  // @ph count: how many customer requests are not finished
  'mgrHome.req.open': { one: '{count} open', other: '{count} open' },
  // @max 16
  // @ph count: how many of the open requests are urgent
  'mgrHome.req.urgent': { one: '{count} urgent', other: '{count} urgent' },
  // @max 16
  // @ph count: how many requests are past their time
  'mgrHome.req.overdue': { one: '{count} overdue', other: '{count} overdue' },
  // @max 24
  'mgrHome.req.cta': 'View requests →',
  // ── the Customer messages tile (HUB-24 (c), 2026-10-12): customers' messages waiting for the
  // office's reply — their own figure, not client requests ──
  // @max 24
  // @icon
  'mgrHome.msg.title': 'Customer messages',
  // @max 28
  // @ph count: how many customers' messages are waiting for the office's reply
  'mgrHome.msg.waiting': { one: '{count} message waiting', other: '{count} messages waiting' },
  // @max 20
  // @note How long the message that has waited longest has been waiting.
  // @ph time: how long, e.g. 1h 10m
  'mgrHome.msg.longest': 'longest {time, duration}',
  // @max 20
  // @ph count: how many days the longest-waiting message has waited
  'mgrHome.msg.longestDays': { one: 'longest {count} day', other: 'longest {count} days' },
  // @max 24
  'mgrHome.msg.cta': 'View messages →',
  // @max 24
  // @icon
  'mgrHome.sup.title': 'Supplies',
  // @max 36
  // @ph count: how many buildings have a supply request waiting for approval or are over their supply budget
  'mgrHome.sup.attention': { one: '{count} property needs attention', other: '{count} properties need attention' },
  // @max 24
  // @ph count: how many approved supply orders wait for the office
  'mgrHome.sup.placed': { one: '{count} order placed', other: '{count} orders placed' },
  // @max 24
  'mgrHome.sup.cta': 'View supplies →',
  // @max 24
  // @icon
  'mgrHome.pnl.title': 'Property P&L',
  'mgrHome.pnl.body': 'Profit and loss for each property, from QuickBooks.',
  // @max 24
  'mgrHome.pnl.cta': 'Open P&L →',
  // ── Wave B: the shift band, the Schedule and Checklists tiles, the "+" (Builder B) ──
  // @max 24
  // @note The small heading on the card at the top of the manager's Home about crews arriving at their buildings.
  'mgrHome.band.label': 'Shift check-in',
  // @max 40
  'mgrHome.band.labelAttention': 'Shift check-in · Attention needed',
  // @max 40
  // @ph count: how many crews are past their start time and nobody has clocked in
  'mgrHome.band.missing': { one: '{count} crew not yet checked in', other: '{count} crews not yet checked in' },
  // @max 40
  'mgrHome.band.allIn': 'All crews checked in',
  // @max 40
  // @note Today's visits have not started yet.
  'mgrHome.band.notYet': 'No crews due on site yet',
  // @max 40
  // @note Every visit today is done or was called out.
  'mgrHome.band.finished': 'Today’s visits are finished',
  // @max 40
  'mgrHome.band.none': 'No visits today',
  // @max 32
  // @ph onSite: crews clocked in and working now; due: crews that should be on site by now
  'mgrHome.band.onSite': '{onSite} of {due} on site',
  // @max 24
  // @ph count: how many visits are scheduled today
  'mgrHome.band.visits': { one: '{count} visit today', other: '{count} visits today' },
  // @max 24
  // @ph time: when these figures were read
  'mgrHome.band.asOf': 'as of {time, time}',
  // @max 24
  'mgrHome.band.cta': 'View check-in →',
  // @max 24
  // @icon
  'mgrHome.sched.title': 'Schedule',
  // @max 16
  // @ph count: how many visits are scheduled today
  'mgrHome.sched.visits': { one: '{count} visit', other: '{count} visits' },
  // @max 20
  // @ph count: how many buildings those visits are at
  'mgrHome.sched.properties': { one: '{count} property', other: '{count} properties' },
  // @max 48
  // @ph time: when the visit starts; customer: the building's name
  'mgrHome.sched.next': '{time, time} · {customer}',
  // @max 24
  'mgrHome.sched.cta': 'View schedule →',
  // @max 24
  // @icon
  'mgrHome.ckl.title': 'Checklists',
  // @max 40
  // @ph done: visits whose checklist is complete; count: visits that owe a checklist today
  'mgrHome.ckl.complete': { one: '{done} of {count} visit complete today', other: '{done} of {count} visits complete today' },
  // @max 20
  // @ph count: visits whose crew is working and has not saved the checklist yet
  'mgrHome.ckl.inProgress': { one: '{count} in progress', other: '{count} in progress' },
  // @max 32
  'mgrHome.ckl.none': 'No checklists due today',
  // @max 24
  'mgrHome.ckl.cta': 'View checklists →',
  // @note Read aloud for the round "+" button on the manager's phone Home.
  'mgrHome.fab': 'New inspection',

  // ── A customer's number ("0001 Ball Harbor Village"; the customer page and Add customer) ─
  // @max 22
  'custNumber.label': 'Customer number',
  // @note Under the number when editing a customer.
  'custNumber.help': 'Four digits, the same as in QuickBooks: 0001.',
  // @note Under the number in "Add customer", where the next free number is filled in.
  'custNumber.offered': 'The next free number. Use the building’s QuickBooks number if it has one.',
  // @note When what was typed is not a number of up to four digits.
  'custNumber.invalid': 'A customer number is four digits, like 0001.',
  // @ph number: the four-digit customer number that was typed
  // @ph customer: the name of the customer that already has it
  'custNumber.taken': '{number} is already {customer}’s number.',

  // ── Quotes: only a draft is deleted; a sent quote is voided and kept (CS-028; office) ────
  // @max 16
  'quoteList.delete': 'Delete',
  // @max 16
  'quoteList.void': 'Void',
  'quoteList.deleteTitle': 'Delete this draft?',
  'quoteList.deleteMessage': 'This permanently deletes the draft and its files. Nothing was sent to the customer.',
  'quoteList.deleted': 'Draft deleted',
  'quoteList.voidTitle': 'Void this quote?',
  'quoteList.voidSent': 'The customer’s signing link stops working and the quote can no longer be signed. It stays in the list as a record.',
  'quoteList.voidSigned': 'This marks the signed agreement void. The agreement and its signed PDF stay in the list as a record.',
  // @max 24
  'quoteList.voidConfirm': 'Void quote',
  'quoteList.voided': 'Quote voided',
  'quoteList.deleteFailed': 'Couldn’t delete the quote.',
  'quoteList.voidFailed': 'Couldn’t void the quote.',

  // ── Quotes: "Sent" only when an email went; otherwise the signing link to send yourself (CS-664; office) ──
  // @ph name: the contact the quote is for
  'quoteSend.emailed': 'Emailed to {name} for signature.',
  'quoteSend.title': 'Send the signing link yourself',
  // @ph name: the contact the quote is for
  'quoteSend.notSetUp': 'Email isn’t set up yet, so nothing was emailed to {name}. The quote is ready to sign: copy this link and send it to them yourself.',
  // @ph name: the contact the quote is for
  'quoteSend.noRecipient': '{name} has no email address on file, so nothing was emailed. The quote is ready to sign: copy this link and send it to them yourself.',
  // @ph name: the contact the quote is for
  'quoteSend.failed': 'The email to {name} didn’t go through. The quote is ready to sign: copy this link and send it to them yourself.',
  // @max 30
  'quoteSend.label': 'Signing link',
  // @max 16
  'quoteSend.copy': 'Copy link',
  'quoteSend.copied': 'Link copied.',
  'quoteSend.copyFailed': 'Couldn’t copy. Select the link and copy it.',
  // @note The contact the quote is for has no name on file.
  'quoteSend.theContact': 'the contact',

  // ── The customer's signing page (/quote/:token): what it says about their copy, in English (LANG-8; CS-664) ──
  'publicQuote.copyEmailed': 'A copy was emailed to you for your records.',
  'publicQuote.copyBelow': 'Download a copy of the signed document below for your records.',
  'publicQuote.signedBelow': 'The signed document is below.',
  // @ph company: the company's name
  'publicQuote.consent.copyEmailed': 'You consent to receive this agreement and related records electronically; a signed PDF copy will be emailed to the address you provide and retained by {company}.',
  // @ph company: the company's name
  'publicQuote.consent.copyKept': 'You consent to receive this agreement and related records electronically; the signed PDF is shown on this page to download, and retained by {company}.',
  'publicQuote.consent.needsEmail': 'To sign, you need a device with a modern web browser and access to the email address you provide.',
  'publicQuote.consent.needsBrowser': 'To sign, you need a device with a modern web browser.',
  // @max 30
  'publicQuote.emailForCopy': 'Email (for your copy)',
  // @max 30
  'publicQuote.emailOptional': 'Your email (optional)',

  // ── Quality → Templates: a saved draft of a live template is not live yet (CS-669; office) ──
  // @max 24
  // @note A badge beside "Published": the template has saved changes nobody has published yet.
  'tplList.unpublishedChanges': 'Unpublished changes',
  'tplEditor.liveNote': 'This template is live. Save draft keeps your changes, the name and pass mark included, out of new inspections until you publish.',

  // ── Customers are archived, never deleted (CS-663: Matt's "Never delete customers"; office) ─────
  // @max 16
  'custArchive.button': 'Archive',
  // @max 16
  'custArchive.restore': 'Restore',
  // @max 16
  // @note The status badge of an archived customer: its page, the Customers list and its Status filter.
  'custArchive.badge': 'Archived',
  // @ph customer: the customer's name
  'custArchive.confirmTitle': 'Archive {customer}?',
  // @ph customer: the customer's name
  'custArchive.confirmMessage': '{customer} leaves the customer list, the pickers, the reminders and the contracts book, and its customer hub logins stop working. Its page, number, contacts, invoices and history stay, and you can restore it at any time.',
  // @ph count: the customer's cleans that have not started yet
  'custArchive.confirmCleans': {
    one: 'Its {count} upcoming clean comes off the schedule, repeating cleans stop and the crew is told. Restoring does not put them back.',
    other: 'Its {count} upcoming cleans come off the schedule, repeating cleans stop and the crew is told. Restoring does not put them back.',
  },
  // @max 24
  'custArchive.confirm': 'Archive customer',
  // @ph customer: the customer's name
  'custArchive.archived': '{customer} archived',
  // @ph customer: the customer's name
  'custArchive.restored': '{customer} restored',
  // @ph customer: the customer's name
  'custArchive.restoreTitle': 'Restore {customer}?',
  'custArchive.restoreMessage': 'It comes back to the customer list, the pickers, the reminders and the contracts book, and its customer hub logins work again. Cleans taken off the schedule when it was archived are not put back.',
  // @max 24
  'custArchive.restoreConfirm': 'Restore customer',
  // @ph date: the day it was archived
  // @ph name: who archived it
  'custArchive.banner': 'Archived on {date} by {name}. It is out of the customer list, the pickers, the reminders and the customer hub. Its history stays here.',
  // @ph date: the day it was archived
  'custArchive.bannerNoName': 'Archived on {date}. It is out of the customer list, the pickers, the reminders and the customer hub. Its history stays here.',
  // @ph count: how many customers are selected
  'custArchive.bulkTitle': { one: 'Archive {count} customer?', other: 'Archive {count} customers?' },
  'custArchive.bulkMessage': 'They leave the customer list, the pickers, the reminders and the contracts book, their upcoming cleans come off the schedule and their customer hub logins stop working. Their pages and history stay, and each can be restored.',
  // @ph count: how many customers were archived
  'custArchive.bulkDone': { one: '{count} customer archived', other: '{count} customers archived' },
  // @ph count: archived customers the list is not showing
  'custArchive.hiddenNote': { one: '{count} archived customer is not shown.', other: '{count} archived customers are not shown.' },
  // @max 24
  'custArchive.showArchived': 'Show archived',
  // @note Where the reply box would be, in an archived customer's conversation (Messaging → Customers and the customer page's Messages tab).
  'custArchive.threadNotice': 'This customer is archived, so its hub logins can no longer read messages. Restore the customer to write to them.',
  // @max 24
  // @note Beside a contract's status on Contracts, when every building on it is archived.
  'custArchive.contractBadge': 'Customer archived',

  // ── QuickBooks (Settings → Integrations; office) ───────────────────────────────────────
  // @note Under the "QuickBooks dimension" switch in "Link a property", when the company's other properties already use one.
  'qbo.link.lockedCustomer': 'This company’s properties are linked to QuickBooks customers, so this one is too.',
  // @note As above, when the company links its properties to QuickBooks classes.
  'qbo.link.lockedClass': 'This company’s properties are linked to QuickBooks classes, so this one is too.',
  // @note As above, when the company links its properties to QuickBooks locations.
  'qbo.link.lockedLocation': 'This company’s properties are linked to QuickBooks locations, so this one is too.',
  // @max 16
  // @note A badge on a linked property whose money is left out of the dashboards.
  'qbo.links.notCounted': 'Not counted',
  // @note The badge's hover text.
  'qbo.links.notCountedHint': 'Linked on a different QuickBooks dimension from the other properties, so its money is not counted. Unlink it and link it again.',
  // @note Under the QuickBooks connection details: how often the figures are brought in.
  'qbo.status.nightly': 'Profit & loss is refreshed every night, the last 12 months included.',
  // @note Shown after "Last error:" when last night's refresh stopped part-way.
  'qbo.status.refreshIncomplete': 'last night’s refresh did not finish; it tries again before morning.',
  // @note A short confirmation after the owner presses "Refresh data".
  'qbo.refresh.done': 'Figures refreshed from QuickBooks.',
  // @ph number: the four-digit customer number QuickBooks has for it
  // @ph customer: the customer's name in the app
  // @note After linking a property to a QuickBooks customer whose name starts with a number.
  'qbo.number.applied': '{customer} now has its QuickBooks number, {number}.',
  // @ph number: the four-digit customer number QuickBooks has
  // @ph customer: the customer that already has that number, with its number
  'qbo.number.conflict': 'QuickBooks gives this customer {number}, but {customer} already has it. Change one of them on the customer page.',
  // @max 40
  // @note A button on the linked properties: give each linked customer the number its QuickBooks customer has.
  'qbo.number.applyAll': { one: 'Use {count} number from QuickBooks', other: 'Use {count} numbers from QuickBooks' },
  // @note After that button.
  'qbo.number.appliedMany': { one: '{count} customer now has its QuickBooks number.', other: '{count} customers now have their QuickBooks numbers.' },
  // @note Under the linked properties when some cannot take their QuickBooks number.
  'qbo.number.conflictNote': { one: '{count} linked customer has a QuickBooks number another customer already uses. Fix it on the customer page.', other: '{count} linked customers have a QuickBooks number another customer already uses. Fix them on the customer page.' },

  // ── QuickBooks: the "needs matching" list (Settings → Integrations; the office's analyst) ──
  // @max 30
  'qboMatch.title': 'Needs matching',
  // @note Under the title.
  'qboMatch.intro': 'QuickBooks customers with activity in the last 12 months that no customer here is linked to, and customers here with no QuickBooks customer.',
  // @max 18
  // @note The search box's hint: find a customer by name or by its four-digit number.
  'qboMatch.search': 'Name or number',
  // @ph shown: rows the search left; total: rows before the search
  'qboMatch.shownOf': '{shown} of {total}',
  // @note Spoken name of the switch between the two lists, for screen readers.
  'qboMatch.viewLabel': 'Which list',
  // @max 28
  // @ph count: how many QuickBooks customers need matching
  'qboMatch.viewQbo': 'Only in QuickBooks ({count})',
  // @max 28
  // @ph count: how many customers here have no QuickBooks customer
  'qboMatch.viewApp': 'Only here ({count})',
  // @note When the twelve months' activity could not all be read yet.
  'qboMatch.activityPending': 'Activity from the last 12 months is still being worked out, so every active QuickBooks customer is listed.',
  // @max 18
  'qboMatch.checkAgain': 'Check again',
  // @ph linked: QuickBooks customers already linked; covered: customers under a linked parent customer; quiet: active customers with nothing in 12 months; inactive: customers made inactive in QuickBooks
  'qboMatch.leftOut': 'Not listed: {linked} linked, {covered} under a linked customer, {quiet} with nothing in the last 12 months, {inactive} inactive in QuickBooks.',
  'qboMatch.ownerOnly': 'Only a Super Admin links a customer to QuickBooks.',
  'qboMatch.allMatchedQbo': 'Every active QuickBooks customer with activity is matched.',
  'qboMatch.allMatchedApp': 'Every active customer here is linked to QuickBooks.',
  'qboMatch.error': 'Could not load the matching list.',
  // @max 24
  'qboMatch.col.qbo': 'QuickBooks customer',
  // @max 18
  // @note The parent customer (a management company) a QuickBooks customer is a job under.
  'qboMatch.col.under': 'Under',
  // @max 24
  // @note The customer here that most likely is the same building.
  'qboMatch.col.suggested': 'Suggested match',
  // @max 18
  'qboMatch.col.customer': 'Customer',
  // @max 18
  'qboMatch.col.city': 'City',
  // @note Spoken name of the column that holds the Link button.
  'qboMatch.col.action': 'Action',
  // @max 14
  'qboMatch.link': 'Link…',
  // @note The rows in the list's pager: "Showing 1–20 of 85 customers".
  'pager.noun.customers': 'customers',

  // ── Changes a save could not keep (a blocking message, CS-008) ──────────────────────────
  // @note The title of a message that stays on screen until it is closed.
  'syncProblem.refusedTitle': 'Some changes weren’t saved',
  'syncProblem.refusedLead': 'These changes weren’t accepted, so they were undone. Everything else you did was saved.',
  'syncProblem.refusedNext': 'If one of them should have been allowed, ask a Super Admin.',
  // @max 16
  'syncProblem.ok': 'Got it',
  'syncProblem.change.pay': 'Change to {name}’s pay',
  'syncProblem.change.member': 'Change to {name}’s team record',
  'syncProblem.change.addMember': 'Adding {name} to the team',
  'syncProblem.change.removeMember': 'Removing {name} from the team',
  // @note Settings → Roles is the screen where the access levels are set.
  'syncProblem.change.roles': 'Change to the access levels (Settings → Roles)',
  'syncProblem.change.access': 'Change to {name}’s access',
  'syncProblem.change.payLine': 'A pay line for {name}',
  'syncProblem.change.reimbursement': 'A reimbursement for {name}',
  'syncProblem.change.timeOff': 'Time off for {name}',
  'syncProblem.change.newInvoice': 'A new invoice',
  // @ph number: an invoice number, e.g. INV-1042
  'syncProblem.change.invoice': 'Change to invoice {number}',
  // @ph number: an invoice number, e.g. INV-1042
  'syncProblem.change.payment': 'A payment on invoice {number}',
  'syncProblem.change.newCustomer': 'The new customer {customer}',
  'syncProblem.change.customer': 'Change to the customer {customer}',
  'syncProblem.change.archiveCustomer': 'Archiving the customer {customer}',
  'syncProblem.change.restoreCustomer': 'Restoring the customer {customer}',
  // @note One line for a whole spreadsheet import (Customers → Import customers).
  'syncProblem.change.import': {
    one: 'The import of {count} customer',
    other: 'The import of {count} customers',
  },
  // @note One line for a run of a spreadsheet import of team members (Settings → Team → Import team, up to 25 people).
  'syncProblem.change.importTeam': {
    one: 'The import of {count} team member',
    other: 'The import of {count, number} team members',
  },
  // @note One line for a whole run that places imported buildings on the map (up to 100).
  'syncProblem.change.locate': {
    one: 'Locating {count} building on the map',
    other: 'Locating {count, number} buildings on the map',
  },
  'syncProblem.change.opsSettings': 'Change to the operations settings',
  'syncProblem.change.company': 'Change to the company settings',
  'syncProblem.change.other': 'A change you made',
  // @note The title of a message that stays on screen until it is closed: the company's shared record is too big to save.
  'syncProblem.tooLargeTitle': 'Your changes can’t be saved right now',
  // @note The record can be refused because it is over its limit, or because this change would take it over (CS-671): "full" covers both.
  'syncProblem.tooLargeLead': 'The company’s shared record is full, so the server isn’t accepting changes that add to it. Your changes are kept on this device and will be saved once there is room.',
  'syncProblem.tooLargeNext': 'Tell a Super Admin. This needs fixing for everyone.',

  // ── Booking time off: taking the person off their cleans (CS-054) ───────────────────────
  // @note A checkbox on the time-off form (a team member's Time off card, and HR → PTO), on by default.
  // @ph name: the person's first name
  'timeOffBook.alsoRemove': {
    one: 'Also remove {name} from the {count} clean already scheduled in these days',
    other: 'Also remove {name} from the {count} cleans already scheduled in these days',
  },
  // @note Under the time-off form while the cleans on the picked days are still loading.
  'timeOffBook.loading': 'Still loading the cleans on these days — the ones already on the calendar can be cleared once that finishes.',
  // @note A short message after booking a call-out (an unplanned absence: sick, car trouble).
  'timeOffBook.savedCallOut': 'Call-out saved.',
  // @note A short message after booking planned time off (a vacation, an appointment).
  'timeOffBook.savedPlanned': 'Time off saved.',
  // @ph name: the person's first name
  'timeOffBook.savedCallOutRemoved': {
    one: 'Call-out saved — {name} was removed from {count} scheduled clean.',
    other: 'Call-out saved — {name} was removed from {count} scheduled cleans.',
  },
  // @ph name: the person's first name
  'timeOffBook.savedPlannedRemoved': {
    one: 'Time off saved — {name} was removed from {count} scheduled clean.',
    other: 'Time off saved — {name} was removed from {count} scheduled cleans.',
  },

  // ── HR warnings (Matt's HR-1..HR-5): the levels and states ─────────────────────────────────
  // @max 24
  // @note The first of three warning levels. Then "Last warning", then "Termination".
  'hrWarn.level.first': 'First warning',
  // @max 24
  'hrWarn.level.last': 'Last warning',
  // @max 24
  'hrWarn.level.termination': 'Termination',
  // ── HR warnings: MATT'S OWN FORM (HR-1 b, 2026-10-05), word for word ──────────────────────
  // The lines below are his form's words, without the paper form's blanks and colons.
  // es.js carries his team's Spanish for exactly these lines (the client's wording, not a
  // translation of ours); scripts/test-hr-warnings.mjs holds both to the form itself.
  // @max 40
  // @note The title of the company's own warning form. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.title': 'Warning Form',
  // @note A question on the warning form. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.employeeName': 'Employee’s Name',
  // @max 24
  // @note The date the warning is given. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.date': 'Date',
  // @note A question on the warning form. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.supervisorName': 'Manager/Supervisor’s Name',
  // @note Optional date on the warning form. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.previousMeeting': 'If previous discipline meeting occurred, enter date',
  // @note Above the ten reasons, several of which may be ticked. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.reasonsHeading': 'Reasons for Warning',
  // @note A question on the warning form. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.details': 'Details of actions that warranted this warning',
  // @note The question above the corrective action the supervisor writes. The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.corrective': 'The following immediate and sustained corrective action must be taken by the employee. Failure to do so will result in further disciplinary action up to and including termination',
  // @note Shown above every signature box and on the printed form, exactly as the company wrote it (no final period in the English). The Spanish is the client's own (from his form): keep it.
  'hrWarn.form.note': 'Note: Your signature on this form means that we have discussed the situation. It doesn’t necessarily mean you agree that the infraction occurred',
  // @note The ten reasons on the warning form, in its order. Their Spanish is the client's own (from his form): keep it.
  // @max 40
  'hrWarn.reason.absenteeism': 'Absenteeism',
  // @max 40
  'hrWarn.reason.procedure': 'Failure to follow procedure',
  // @max 40
  'hrWarn.reason.rudeness': 'Rudeness',
  // @max 40
  'hrWarn.reason.tardiness': 'Tardiness',
  // @max 40
  'hrWarn.reason.performance': 'Failure to meet performance',
  // @max 40
  'hrWarn.reason.overtime': 'Refusal to work overtime',
  // @max 40
  'hrWarn.reason.policy': 'Policy violation',
  // @max 40
  'hrWarn.reason.fighting': 'Fighting',
  // @max 40
  'hrWarn.reason.language': 'Language',
  // @max 40
  'hrWarn.reason.other': 'Other',

  // ── HR warnings: the states and the refusals ───────────────────────────────────────────
  // @max 24
  'hrWarn.status.awaiting': 'Awaiting signature',
  // @max 24
  'hrWarn.status.acknowledged': 'Acknowledged',
  // @max 24
  'hrWarn.status.refused': 'Refused to sign',
  // @max 24
  'hrWarn.status.voided': 'Voided',
  'hrWarn.refusal.employeeMissing': 'Pick the employee.',
  'hrWarn.refusal.supervisorMissing': 'Pick the supervisor.',
  'hrWarn.refusal.samePerson': 'The supervisor and the employee must be different people.',
  'hrWarn.refusal.levelBad': 'Pick the level.',
  'hrWarn.refusal.reasonsMissing': 'Tick at least one reason for the warning.',
  'hrWarn.refusal.reasonBad': 'One of the reasons is not on the form.',
  'hrWarn.refusal.reasonOtherMissing': 'Say what the other reason is.',
  'hrWarn.refusal.previousDateBad': 'The previous discipline meeting date is not a date.',
  'hrWarn.refusal.previousDateInFuture': 'The previous discipline meeting date cannot be in the future.',
  'hrWarn.refusal.whatHappenedMissing': 'Describe the actions that warranted this warning.',
  'hrWarn.refusal.whatMustChangeMissing': 'Write the corrective action the employee must take.',
  'hrWarn.refusal.signatureMissing': 'Sign in the box first.',
  'hrWarn.refusal.signatureBad': 'That signature could not be read. Clear it and sign again.',
  'hrWarn.refusal.signatureTooLarge': 'That signature is too large. Clear it and sign again.',
  'hrWarn.refusal.hrManagerMissing': 'Pick the HR manager who is signing.',
  'hrWarn.refusal.voidReasonMissing': 'Say why the warning is being voided.',
  'hrWarn.refusal.tooLong': 'One of the answers is too long. Shorten it and try again.',

  // ── HR warnings: the screens (HR → Warnings, an employee's HR card, My Day) ──────────────
  // @max 16
  // @note The tab on the HR page that lists written warnings given to employees.
  'hrWarn.tab': 'Warnings',
  // @max 24
  'hrWarn.card.title': 'Warnings',
  'hrWarn.card.none': 'No warnings on file.',
  // @note Under one warning in an employee's list: who issued it.
  'hrWarn.card.by': 'From {name}',
  'hrWarn.list.lead': 'Written warnings, who issued them and whether the employee has signed.',
  // @max 20
  'hrWarn.new.button': 'New warning',
  // @max 40
  'hrWarn.detail.title': 'Warning',
  'hrWarn.loading': 'Loading warnings…',
  'hrWarn.loadFailed': 'The warnings could not be loaded.',
  'hrWarn.saveFailed': 'That did not save.',
  'hrWarn.printBlocked': 'Allow pop-ups to print or save the warning as a PDF.',
  // @note What the rows of the list are called under the list ("Showing 1–20 of 45 warnings").
  'hrWarn.pagerNoun': 'warnings',
  // @max 24
  'hrWarn.field.employee': 'Employee',
  // @max 24
  'hrWarn.field.supervisor': 'Supervisor',
  // @max 24
  'hrWarn.field.level': 'Level',
  // @max 24
  'hrWarn.field.reasons': 'Reasons',
  'hrWarn.field.reasonOther': 'What is the other reason?',
  // @max 24
  'hrWarn.field.issued': 'Issued',
  // @max 24
  'hrWarn.field.status': 'Status',
  // @max 24
  'hrWarn.filter.allEmployees': 'All employees',
  // @max 24
  'hrWarn.filter.allSupervisors': 'All supervisors',
  // @max 24
  'hrWarn.filter.allStatuses': 'All statuses',
  // @max 24
  'hrWarn.filter.allLevels': 'All levels',
  // @max 24
  'hrWarn.filter.allReasons': 'All reasons',
  'hrWarn.empty.title': 'No warnings yet',
  'hrWarn.empty.message': 'Warnings you issue appear here, with whether the employee has signed.',
  'hrWarn.empty.filteredTitle': 'No warnings match these filters',
  'hrWarn.empty.filteredMessage': 'Clear a filter to see the rest.',
  // @note HR-4: an employee's warnings count over a 12-month period that starts at their first warning.
  'hrWarn.standing.none': 'No warnings in the current 12-month period.',
  // @ph since: the date the current 12-month period started; resets: the date it resets
  'hrWarn.standing.count': {
    one: '{count} warning in the current period, since {since}. Resets {resets}.',
    other: '{count} warnings in the current period, since {since}. Resets {resets}.',
  },
  'hrWarn.form.lockedNote': 'Once issued, a warning cannot be edited. A mistake can only be voided.',
  // @max 30
  'hrWarn.form.pickEmployee': 'Pick an employee',
  // @max 30
  'hrWarn.form.pickSupervisor': 'Pick a supervisor',
  'hrWarn.form.optional': 'Optional',
  'hrWarn.form.previousHelp': 'Filled in from their last warning. Change it or clear it.',
  'hrWarn.form.levelHelp': 'Chosen from where the employee stands. You can change it.',
  'hrWarn.form.howSign': 'How will the employee sign?',
  // @max 24
  'hrWarn.form.signPhone': 'On their phone',
  // @max 24
  'hrWarn.form.signInPerson': 'In person, now',
  'hrWarn.form.signPhoneHelp': 'They get a notification and sign on their phone. If they have not signed a day later, the supervisor is reminded.',
  'hrWarn.form.signInPersonHelp': 'After you issue it, hand this device to the employee to read and sign.',
  // @max 20
  'hrWarn.form.submit': 'Issue warning',
  'hrWarn.form.issued': 'Warning issued.',
  // @max 24
  'hrWarn.action.print': 'Print / Save as PDF',
  // @max 24
  'hrWarn.action.signInPerson': 'Sign in person',
  // @max 24
  'hrWarn.action.refused': 'Refused to sign',
  // @max 16
  'hrWarn.action.void': 'Void',
  // @max 20
  'hrWarn.action.translate': 'Translate',
  // @max 20
  'hrWarn.action.showOriginal': 'Show original',
  // @ph name: who voided it; when: when it was voided; reason: why, in their own words
  'hrWarn.detail.voided': 'Voided by {name} on {when, dateTime}: {reason}. It stays on file and no longer counts.',
  // @ph name: the employee's name; when: when they signed
  'hrWarn.detail.signedBy': 'Signed by {name} on {when, dateTime}',
  'hrWarn.detail.signedInPerson': 'Signed in person',
  // @ph name: the HR manager's name; when: when they signed
  'hrWarn.detail.refusedBy': 'The employee refused to sign. {name} (HR manager) signed on {when, dateTime}.',
  // @ph name: the employee's name
  'hrWarn.detail.awaiting': 'Waiting for {name} to sign.',
  'hrWarn.detail.comment': 'Employee comment',
  'hrWarn.detail.employeeSignatureAlt': 'The employee’s signature',
  'hrWarn.detail.hrSignatureAlt': 'The HR manager’s signature',
  'hrWarn.translate.off': 'Translation is not available yet.',
  'hrWarn.translate.failed': 'The translation did not come back. Try again in a moment.',
  'hrWarn.translate.note': 'Translated by Google. The supervisor’s own words are the record.',
  // @max 40
  'hrWarn.sign.title': 'Sign the warning',
  // @ph name: the employee's name
  'hrWarn.sign.inPersonNote': 'Hand this device to {name} to read and sign.',
  'hrWarn.sign.comment': 'Your comment (optional)',
  'hrWarn.sign.commentPlaceholder': 'Anything you want on file with this warning',
  // @max 16
  'hrWarn.sign.submit': 'Sign',
  'hrWarn.sign.signed': 'Signed. It is on file.',
  // @max 40
  'hrWarn.refuse.title': 'Refused to sign',
  'hrWarn.refuse.lead': 'The employee refused to sign. The HR manager signs that it was delivered, and the warning goes on file as refused.',
  // @max 24
  'hrWarn.refuse.hrManager': 'HR manager',
  // @max 30
  'hrWarn.refuse.pickHrManager': 'Pick the HR manager',
  // @max 30
  'hrWarn.refuse.submit': 'Put on file as refused',
  'hrWarn.refuse.done': 'On file as refused.',
  // @max 40
  'hrWarn.void.title': 'Void this warning',
  'hrWarn.void.lead': 'A voided warning stays on file and no longer counts toward the employee’s record. This cannot be undone.',
  'hrWarn.void.reason': 'Why is it being voided?',
  // @max 20
  'hrWarn.void.submit': 'Void warning',
  'hrWarn.void.done': 'Warning voided.',
  // @note A card on a cleaner's My Day: a supervisor gave them a written warning to read and sign.
  'hrWarn.mine.title': {
    one: 'You have a warning to review',
    other: 'You have {count} warnings to review',
  },
  // @ph name: the supervisor's name; date: the day it was issued
  'hrWarn.mine.lead': 'From {name}, issued {date}.',
  // @max 24
  'hrWarn.mine.open': 'Review and sign',
  // @max 12
  // @note Buttons above the signature box: draw a signature with a finger, or type your name.
  'hrWarn.pad.draw': 'Draw',
  // @max 12
  'hrWarn.pad.type': 'Type',
  // @max 12
  'hrWarn.pad.clear': 'Clear',
  'hrWarn.pad.drawHint': 'Draw your signature above',
  // @max 16
  'hrWarn.pad.signed': 'Signed',
  'hrWarn.pad.typePlaceholder': 'Type your full name',

  // ── HR incident reports (task #258): MATT'S OWN FORM, "ACCIDENT / INCIDENT REPORT", word for word ──
  // The lines below are his form's words, in his capitals, without the paper form's blank lines
  // and boxes. scripts/test-hr-incidents.mjs holds them to the form itself
  // (scripts/fixtures/hr-incident-form.json, pulled out of his PDF).
  // @note The title of the company's own accident / incident report form, in capitals as printed.
  'hrInc.form.title': 'ACCIDENT / INCIDENT REPORT',
  // @ph company: the company's name, e.g. "Clean Space"
  'hrInc.form.subtitle': '{company} | Internal Safety & Operations',
  'hrInc.form.lead': 'Complete as soon as possible, preferably within 24 hours. For emergencies, seek immediate help first.',
  // @note The page counter at the top of the printed form, in capitals as printed.
  // @ph page: this page's number; pages: how many pages the form has
  'hrInc.form.page': 'PAGE {page} OF {pages}',
  'hrInc.form.footer': 'CONFIDENTIAL | For authorized company use',
  // @note Section headings of the form, in capitals as printed. Each follows its number (01 to 07).
  'hrInc.form.s01': 'REPORT DETAILS',
  'hrInc.form.reportedOn': 'Date report completed',
  'hrInc.form.reportedBy': 'Reported by (full name)',
  'hrInc.form.reporterTitle': 'Job title / role',
  'hrInc.form.s02': 'INCIDENT INFORMATION',
  'hrInc.form.incidentDate': 'Incident date',
  'hrInc.form.incidentTime': 'Time (AM / PM)',
  'hrInc.form.property': 'Property / client name',
  'hrInc.form.exactLocation': 'Exact location (building, room, area)',
  'hrInc.form.cityState': 'City / state',
  'hrInc.form.types': 'Type of incident (check all that apply)',
  'hrInc.form.whatHappened': 'Describe what happened (facts only: events, people involved, equipment, conditions)',
  'hrInc.form.s03': 'PEOPLE INVOLVED & INJURIES',
  'hrInc.form.people': 'Name(s) of person(s) involved',
  'hrInc.form.personKind': 'Employee / visitor / other',
  'hrInc.form.injured': 'Was anyone injured?',
  'hrInc.form.injury': 'Describe injury / body part affected (if applicable)',
  'hrInc.form.treatment': 'Medical treatment',
  'hrInc.form.provider': 'Treatment provider / facility (if applicable)',
  'hrInc.form.s04': 'WITNESSES & NOTIFICATIONS',
  'hrInc.form.witnesses': 'Were there witnesses?',
  'hrInc.form.witnessNames': 'Witness name(s)',
  'hrInc.form.witnessContact': 'Contact information',
  'hrInc.form.police': 'Police / emergency services contacted?',
  'hrInc.form.policeDetails': 'Agency, report number, and responding officer (if applicable)',
  'hrInc.form.notified': 'Who was notified? (check all that apply)',
  'hrInc.form.s05': 'IMMEDIATE RESPONSE & DOCUMENTATION',
  'hrInc.form.actions': 'Actions taken immediately (first aid, area secured, cleanup, equipment removed, etc.)',
  'hrInc.form.docs': 'Supporting documentation attached',
  'hrInc.form.s06': 'SUBMITTED BY',
  'hrInc.form.printedName': 'Printed name',
  'hrInc.form.signature': 'Signature',
  'hrInc.form.signedOn': 'Date signed',
  'hrInc.form.contact': 'Phone / email',
  'hrInc.form.s07': 'OFFICE USE ONLY / FOLLOW-UP',
  'hrInc.form.reviewedBy': 'Received / reviewed by',
  'hrInc.form.receivedOn': 'Date received',
  'hrInc.form.caseNo': 'Case / reference no.',
  // @max 24
  // @note The form's tick boxes for "Type of incident", in his words.
  'hrInc.type.injury': 'Employee injury',
  // @max 24
  'hrInc.type.damage': 'Property damage',
  // @max 24
  'hrInc.type.nearMiss': 'Near miss',
  // @max 24
  'hrInc.type.vehicle': 'Vehicle / traffic',
  // @max 24
  'hrInc.type.medical': 'Medical emergency',
  // @max 24
  'hrInc.type.security': 'Security / theft',
  // @max 24
  'hrInc.type.slip': 'Slip / trip / fall',
  // @max 24
  'hrInc.type.other': 'Other',
  // @max 12
  // @note The answers to "Was anyone injured?", "Were there witnesses?" and the police question.
  'hrInc.answer.yes': 'Yes',
  // @max 12
  'hrInc.answer.no': 'No',
  // @max 12
  'hrInc.answer.unknown': 'Unknown',
  // @max 20
  // @note The form's tick boxes for "Medical treatment".
  'hrInc.treatment.none': 'None',
  // @max 20
  'hrInc.treatment.firstAid': 'First aid',
  // @max 20
  'hrInc.treatment.clinic': 'Clinic / hospital',
  // @max 20
  'hrInc.treatment.refused': 'Refused',
  // @max 16
  // @note Whether a person involved is an employee, a visitor or someone else (the form asks "Employee / visitor / other").
  'hrInc.person.employee': 'Employee',
  // @max 16
  'hrInc.person.visitor': 'Visitor',
  // @max 16
  'hrInc.person.other': 'Other',
  // @max 24
  // @note The form's tick boxes for "Who was notified?".
  'hrInc.notified.supervisor': 'Supervisor',
  // @max 24
  'hrInc.notified.accountManager': 'Account manager',
  // @max 24
  'hrInc.notified.hr': 'HR',
  // @max 24
  'hrInc.notified.client': 'Client / property',
  // @max 24
  'hrInc.notified.other': 'Other',
  // @max 24
  // @note The form's tick boxes for "Supporting documentation attached"; also what each uploaded file is.
  'hrInc.doc.photos': 'Photos',
  // @max 24
  'hrInc.doc.witnessStatement': 'Witness statement',
  // @max 24
  'hrInc.doc.policeReport': 'Police report',
  // @max 24
  'hrInc.doc.other': 'Other documents',

  // ── HR incident reports: the app's own words ───────────────────────────────────────────────
  // @max 16
  'hrInc.tab': 'Incidents',
  // @max 32
  'hrInc.card.title': 'Incident reports',
  'hrInc.card.none': 'No incident reports name this person.',
  'hrInc.list.lead': 'Accident and incident reports: what happened, who was involved, and whether the office has reviewed it.',
  // @max 24
  'hrInc.new.button': 'New incident report',
  'hrInc.loading': 'Loading incident reports…',
  'hrInc.loadFailed': 'The incident reports could not be loaded.',
  'hrInc.saveFailed': 'The report could not be saved. Try again.',
  'hrInc.empty.title': 'No incident reports yet',
  'hrInc.empty.message': 'A report filed here stays on file, with its review and any files added later.',
  'hrInc.empty.filteredTitle': 'No reports match',
  'hrInc.empty.filteredMessage': 'Try another filter.',
  // @max 24
  'hrInc.filter.allStatuses': 'All statuses',
  // @max 24
  'hrInc.filter.allTypes': 'All types',
  // @max 24
  'hrInc.filter.allProperties': 'All properties',
  // @max 24
  'hrInc.filter.allEmployees': 'All employees',
  // @max 16
  'hrInc.col.caseNo': 'Case no.',
  // @max 20
  'hrInc.col.property': 'Property',
  // @max 16
  'hrInc.col.type': 'Type',
  // @max 24
  'hrInc.col.people': 'People involved',
  // @max 16
  'hrInc.col.status': 'Status',
  // @max 16
  'hrInc.col.employee': 'Employee',
  // @note The noun the list's pager counts, e.g. "1–20 of 45 reports".
  'hrInc.pagerNoun': 'reports',
  // @max 24
  // @note A filed report waits for the office to mark it reviewed (the form's section 07).
  'hrInc.status.awaiting': 'Awaiting review',
  // @max 24
  'hrInc.status.reviewed': 'Reviewed',
  // @max 24
  'hrInc.status.voided': 'Voided',
  'hrInc.form.lockedNote': 'Once filed, a report can’t be edited or deleted. Files can be added to it later.',
  'hrInc.form.pickPerson': 'Choose a team member',
  'hrInc.form.notOnTeam': 'Someone not on the team',
  'hrInc.form.fullName': 'Full name',
  'hrInc.form.pickProperty': 'Choose a customer',
  'hrInc.form.elsewhere': 'Somewhere else',
  'hrInc.form.placeName': 'Where it happened',
  'hrInc.form.typeOtherWords': 'Other: say what',
  'hrInc.form.notifiedOtherWords': 'Other: who',
  // @max 24
  'hrInc.form.addPerson': 'Add a person',
  'hrInc.form.removePerson': 'Remove this person',
  'hrInc.form.noPeople': 'No one added yet.',
  'hrInc.form.pickSubmitter': 'Choose an office member',
  // @max 20
  'hrInc.form.attach': 'Add files',
  'hrInc.form.attachHint': 'Photos or PDFs, up to 10 MB each. Choose what each one is.',
  'hrInc.form.fileKind': 'What this file is',
  'hrInc.form.removeFile': 'Remove this file',
  // @max 20
  'hrInc.form.submit': 'File report',
  // @max 20
  'hrInc.form.filing': 'Filing…',
  'hrInc.form.filed': 'Incident report filed',
  // @note A retried filing found the first try had already gone through: the report stands as first sent.
  'hrInc.form.alreadyFiled': 'This report was already filed. It shows as first sent; any new files were added, other changes were not saved.',
  // @ph name: who voided it · when: the moment · reason: why, in their words
  'hrInc.detail.voided': 'Voided by {name} on {when, dateTime}: {reason}. It stays on file.',
  'hrInc.detail.awaitingReview': 'Not reviewed yet.',
  // @ph name: the person who signed
  'hrInc.detail.signatureAlt': 'Signature of {name}',
  'hrInc.detail.noFiles': 'No files attached.',
  // @ph when: the day the file was added
  'hrInc.detail.added': 'Added {when, date}',
  'hrInc.detail.openFailed': 'The file could not be opened.',
  // @max 24
  'hrInc.action.print': 'Print / Save as PDF',
  // @max 20
  'hrInc.action.review': 'Mark reviewed',
  // @max 16
  'hrInc.action.void': 'Void',
  // @max 20
  'hrInc.action.addFiles': 'Add files',
  'hrInc.printBlocked': 'Allow pop-ups for this site to print the report.',
  // @max 32
  'hrInc.review.title': 'Mark reviewed',
  'hrInc.review.lead': 'Who received and reviewed this report. Today is recorded as the date received. This is done once.',
  'hrInc.review.pick': 'Choose who reviewed it',
  // @max 20
  'hrInc.review.submit': 'Mark reviewed',
  'hrInc.review.done': 'Report marked reviewed',
  // @max 32
  'hrInc.void.title': 'Void this report',
  'hrInc.void.lead': 'A voided report stays on file, marked voided. Say why it is being voided.',
  // @max 24
  'hrInc.void.reason': 'Reason',
  // @max 20
  'hrInc.void.submit': 'Void report',
  'hrInc.void.done': 'Report voided',
  // @max 32
  'hrInc.addFiles.title': 'Add files to this report',
  'hrInc.addFiles.lead': 'Files added to a report stay on it: they can’t be removed.',
  // @max 20
  'hrInc.addFiles.submit': 'Add to report',
  'hrInc.addFiles.done': 'Files added',
  // @max 20
  'hrInc.addFiles.uploading': 'Uploading…',
  'hrInc.refusal.reportedByMissing': 'Say who reported it.',
  'hrInc.refusal.reporterMissing': 'That person is not on the team.',
  'hrInc.refusal.incidentDateMissing': 'Enter the incident date.',
  'hrInc.refusal.incidentDateInFuture': 'The incident date can’t be in the future.',
  'hrInc.refusal.incidentTimeBad': 'Enter the time as hours and minutes.',
  'hrInc.refusal.propertyMissing': 'Choose the property, or say where it happened.',
  'hrInc.refusal.typesMissing': 'Tick at least one type of incident.',
  'hrInc.refusal.typeBad': 'One of the incident types isn’t on the form.',
  'hrInc.refusal.typeOtherMissing': 'Say what the other type of incident was.',
  'hrInc.refusal.whatHappenedMissing': 'Describe what happened.',
  'hrInc.refusal.personBad': 'Each person involved needs a name, or a team member chosen.',
  'hrInc.refusal.peopleTooMany': 'That’s more people than one report can hold.',
  'hrInc.refusal.injuredMissing': 'Answer “Was anyone injured?”',
  'hrInc.refusal.injuryMissing': 'Describe the injury and the body part affected.',
  'hrInc.refusal.treatmentMissing': 'Choose the medical treatment.',
  'hrInc.refusal.witnessesMissing': 'Answer “Were there witnesses?”',
  'hrInc.refusal.witnessNamesMissing': 'Enter the witness names.',
  'hrInc.refusal.policeMissing': 'Answer whether police or emergency services were contacted.',
  'hrInc.refusal.notifiedBad': 'One of the people notified isn’t on the form.',
  'hrInc.refusal.notifiedOtherMissing': 'Say who else was notified.',
  'hrInc.refusal.submitterMissing': 'Choose who is submitting the report (an active office member).',
  'hrInc.refusal.signatureMissing': 'Sign the report.',
  'hrInc.refusal.signatureBad': 'The signature could not be read. Clear it and sign again.',
  'hrInc.refusal.signatureTooLarge': 'The signature is too large. Clear it and sign again.',
  'hrInc.refusal.fileBad': 'Use a PDF, PNG, JPEG or WebP file up to 10 MB, and choose what each file is.',
  'hrInc.refusal.filesTooMany': 'That’s more files than one report can hold.',
  'hrInc.refusal.filesMissing': 'Choose at least one file.',
  'hrInc.refusal.reviewerMissing': 'Choose who reviewed the report (an active office member).',
  'hrInc.refusal.voidReasonMissing': 'Say why the report is being voided.',
  'hrInc.refusal.tooLong': 'One of the answers is too long.',

  // ── HR → Terminations (Super Clippy's idea #513: Matt's termination form, his email "Clean
  //    Corner - Termination", 2026-11-05). His headings and his sixteen reasons are word for word
  //    from his picture (scripts/fixtures/hr-termination-form.json holds them); "Employee's Name"
  //    is his Warning Form's line, "Day of Termination" his email's words. ─────────────────────
  // @note HR's tab for terminations, beside Warnings and Incidents.
  // @max 16
  'hrTerm.tab': 'Terminations',
  // @note The form's and the read view's title.
  // @max 32
  'hrTerm.form.title': 'Termination',
  'hrTerm.form.employee': 'Employee’s Name',
  'hrTerm.form.date': 'Day of Termination',
  'hrTerm.form.reasons': 'Reason for Termination',
  'hrTerm.form.manager': 'Direct Account Manager',
  'hrTerm.reason.resignation': 'Resignation',
  'hrTerm.reason.insubordination': 'Insubordination',
  'hrTerm.reason.jobAbandonment': 'Job Abandonment',
  'hrTerm.reason.maternityLeave': 'Maternity Leave',
  'hrTerm.reason.absenteeism': 'Absenteeism / Tardiness',
  'hrTerm.reason.performance': 'Unsatisfactory Job Performance',
  'hrTerm.reason.policyViolation': 'Violation of Company Policy',
  'hrTerm.reason.temporaryEnded': 'Temporary Assignment Ended',
  'hrTerm.reason.requestedChange': 'Manager / Client Requested Change',
  'hrTerm.reason.anotherJob': 'Accepted Another Job',
  'hrTerm.reason.movedOutOfState': 'Moved Out of State',
  'hrTerm.reason.health': 'Health Reasons',
  'hrTerm.reason.personal': 'Personal Reasons',
  'hrTerm.reason.accountClosure': 'Account Closure',
  'hrTerm.reason.notEligibleForRehire': 'Not Eligible for Rehire',
  'hrTerm.reason.other': 'Other:',
  // @note The box "Other:" opens, for the reason in the office's words (its accessible name).
  'hrTerm.form.otherLabel': 'The other reason',
  'hrTerm.form.lead': 'Once filed, a termination is locked. The Super Admin can void a mistake, with a reason.',
  'hrTerm.form.pickEmployee': 'Choose the employee',
  'hrTerm.form.pickManager': 'Choose their manager',
  'hrTerm.form.noManagers': 'No Account Managers are on the team yet. Add one in Settings → Team first.',
  // @ph name: a team member whose login is already off
  'hrTerm.form.disabledMember': '{name} (Disabled)',
  // @ph brand: the app's name
  'hrTerm.form.endsNow': 'Their {brand} login turns off as soon as this is filed.',
  // @ph brand: the app's name · date: the termination day
  'hrTerm.form.endsOn': 'Their {brand} login turns off on {date}.',
  'hrTerm.form.alreadyOff': 'Their login is already off (Disabled on Team). Filing this keeps it off.',
  // @max 24
  'hrTerm.form.submit': 'File termination',
  // @max 20
  'hrTerm.form.filing': 'Filing…',
  'hrTerm.form.alreadyFiled': 'This termination was already filed. It shows as first sent; other changes were not saved.',
  // @max 24
  'hrTerm.new.button': 'New termination',
  // @max 32
  'hrTerm.card.title': 'Termination',
  'hrTerm.card.none': 'No termination on file.',
  // @ph brand: the app's name
  'hrTerm.list.lead': 'Terminations filed in HR. Each one turns the person’s {brand} login off on the termination day.',
  'hrTerm.loading': 'Loading terminations…',
  'hrTerm.loadFailed': 'The terminations could not be loaded.',
  'hrTerm.empty.title': 'No terminations yet',
  'hrTerm.empty.message': 'A termination filed here stays on file and turns the person’s login off on its day.',
  'hrTerm.empty.filteredTitle': 'No terminations match',
  'hrTerm.empty.filteredMessage': 'Try another filter.',
  // @max 20
  'hrTerm.col.employee': 'Employee',
  // @max 20
  'hrTerm.col.reasons': 'Reasons',
  // @note The column and filter for what happened to the person's login.
  // @max 20
  'hrTerm.col.login': 'Login',
  'hrTerm.filter.allStatuses': 'All',
  'hrTerm.filter.allEmployees': 'All employees',
  // @note The pager's noun: "1–20 of 45 terminations".
  'hrTerm.pagerNoun': 'terminations',
  // @note A termination whose day is still ahead: the login is still on.
  // @max 20
  'hrTerm.status.scheduled': 'Scheduled',
  // @note The day has come and the login is being turned off (within a few minutes).
  // @max 20
  'hrTerm.status.due': 'Turning off',
  // @max 20
  'hrTerm.status.ended': 'Login off',
  // @max 20
  'hrTerm.status.voided': 'Voided',
  // @ph brand: the app's name · date: the termination day
  'hrTerm.access.scheduled': 'Their {brand} login turns off on {date}.',
  // @ph brand: the app's name
  'hrTerm.access.due': 'Their {brand} login is being turned off. It finishes within a few minutes.',
  // @ph brand: the app's name · when: the moment it went off
  'hrTerm.access.ended': 'Their {brand} login was turned off on {when, dateTime}.',
  'hrTerm.access.alreadyOff': 'Their login was already off when the termination day came.',
  // @ph when: the moment it came back on
  'hrTerm.access.restored': 'Voided, so their login was turned back on ({when, dateTime}).',
  'hrTerm.access.kept': 'Voided. Their login was changed on Team after the termination turned it off, so it was left as it is.',
  'hrTerm.access.neverOff': 'Voided before the termination day, so their login never turned off.',
  'hrTerm.access.restoring': 'Voided. Their login is being turned back on. It finishes within a few minutes.',
  // @ph name: who voided it · when: the moment · reason: why, in their words
  'hrTerm.detail.voided': 'Voided by {name} on {when, dateTime}: {reason}. It stays on file.',
  // @ph name: who filed it · when: the moment
  'hrTerm.detail.filed': 'Filed by {name} on {when, dateTime}.',
  // @max 32
  'hrTerm.detail.stillOnTitle': 'Still on',
  'hrTerm.detail.stillOnLead': 'The termination turns off their login only. Reassign these:',
  // @max 32
  'hrTerm.detail.customers': 'Customers',
  // @note After a customer's name: this person is its Account Manager.
  'hrTerm.detail.asManager': 'Account Manager',
  // @note After a customer's name: this cleaner works at it.
  'hrTerm.detail.worksAt': 'Works at',
  // @ph date: the termination day, or today when that day has passed
  'hrTerm.detail.cleans': 'Cleans in the 60 days from {date}',
  // @ph date: the termination day, or today when that day has passed
  'hrTerm.detail.noneLeft': 'Not on any customer, or on any clean in the 60 days from {date}.',
  // @ph count: how many more cleans
  'hrTerm.detail.moreCleans': 'and {count, number} more',
  'hrTerm.detail.cleansLoading': 'Loading their cleans…',
  'hrTerm.detail.cleansFailed': 'Their cleans could not be loaded.',
  // @max 24
  'hrTerm.action.print': 'Print / Save as PDF',
  // @max 16
  'hrTerm.action.void': 'Void',
  'hrTerm.printBlocked': 'Allow pop-ups for this site to print the termination.',
  // @max 32
  'hrTerm.void.title': 'Void this termination',
  'hrTerm.void.lead': 'A voided termination stays on file, marked voided. If it already turned their login off, the login comes back on; if the day is still ahead, it never turns off. Say why it is being voided.',
  // @max 24
  'hrTerm.void.reason': 'Reason',
  // @max 24
  'hrTerm.void.submit': 'Void termination',
  'hrTerm.void.done': 'Termination voided',
  'hrTerm.void.doneRestored': 'Termination voided. Their login is back on.',
  'hrTerm.done.ended': 'Termination filed. Their login is off.',
  // @ph date: the termination day
  'hrTerm.done.scheduled': 'Termination filed. Their login turns off on {date}.',
  'hrTerm.done.pending': 'Termination filed. Their login turns off within a few minutes.',
  'hrTerm.done.alreadyOff': 'Termination filed. Their login was already off.',
  'hrTerm.refusal.employeeMissing': 'Choose the employee.',
  'hrTerm.refusal.employeeNotOnTeam': 'That person is not on the team.',
  'hrTerm.refusal.employeeOwner': 'A Super Admin can’t be terminated here. Change their access level on Team first.',
  'hrTerm.refusal.employeeSelf': 'You can’t file your own termination.',
  'hrTerm.refusal.employeeAdmin': 'Only an Admin or Super Admin can terminate an Admin.',
  'hrTerm.refusal.alreadyTerminated': 'This person already has a termination on file. Void it first to file another.',
  'hrTerm.refusal.dateMissing': 'Choose the day of termination.',
  'hrTerm.refusal.dateTooFar': 'The day of termination can be at most a year ahead.',
  'hrTerm.refusal.dateTooOld': 'The day of termination can be at most five years back.',
  'hrTerm.refusal.managerMissing': 'Choose their direct Account Manager.',
  'hrTerm.refusal.managerNotAccountManager': 'The direct manager must be an active Account Manager, and not the employee.',
  'hrTerm.refusal.reasonsMissing': 'Tick at least one reason for termination.',
  'hrTerm.refusal.reasonBad': 'One of the reasons is not on the form.',
  'hrTerm.refusal.reasonOtherMissing': 'Write the other reason.',
  'hrTerm.refusal.tooLong': 'The other reason is too long.',
  'hrTerm.refusal.notAllowed': 'Filing a termination turns a login off, so it needs both “Edit HR records” and “Invite / edit team”. Ask a Super Admin.',
  'hrTerm.refusal.voidReasonMissing': 'Say why the termination is being voided.',
  'hrTerm.refusal.alreadyVoided': 'That termination was already voided.',

  // ── Customers → Import customers (a spreadsheet, one row per building; office) ───────────
  // @note The title of the pop-up that brings in buildings from a spreadsheet.
  // @max 32
  'custImport.title': 'Import customers',
  'custImport.notPermitted': 'Importing customers needs “Create / edit customers”. Ask a Super Admin.',
  'custImport.lead': 'Bring in your buildings from a spreadsheet, one row per building. Each row becomes a customer with its location, and can name its supervisor and a contact. Nothing is saved until you check the preview.',
  // @max 32
  'custImport.template': 'Download the template',
  'custImport.templateHint': 'The columns this import reads, with example rows to replace.',
  // @max 40
  'custImport.drop': 'Choose a CSV file, or drop it here',
  // @ph size: a file size, e.g. 10 MB
  'custImport.dropHint': 'An Excel, Google Sheets or QuickBooks export · up to {size}',
  // @max 24
  'custImport.paste': 'Or paste rows',
  // @max 24
  'custImport.readPasted': 'Read pasted rows',
  'custImport.err.empty': 'No rows found. The file needs a header row and at least one row below it.',
  // @ph size: a file size, e.g. 10 MB
  'custImport.err.fileTooLarge': 'This file is larger than {size}.',
  'custImport.err.unreadable': 'This file couldn’t be read. Save it from your spreadsheet as CSV and try again.',
  // @note Above the list of the file's columns, each with a picker for what it holds.
  'custImport.mapLead': {
    one: '{count} row. Match each column to what it holds; a column left on Skip is not imported.',
    other: '{count, number} rows. Match each column to what it holds; a column left on Skip is not imported.',
  },
  // @note Windows-1252 and UTF-8 are names of text encodings; "CSV" and "CSV UTF-8" are Excel's own names for its save options.
  'custImport.readAs1252': 'This file wasn’t saved as UTF-8 (Excel’s plain “CSV” choice), so it was read as Windows-1252. Check accented names, like José, in the preview. Saving as “CSV UTF-8” avoids this.',
  'custImport.readSemicolon': 'The columns are separated by semicolons (a non-US Excel export).',
  'custImport.readTab': 'The columns are separated by tabs.',
  // @ph columns: column headers from the file, with a number added, e.g. Phone (2)
  'custImport.renamedHeaders': 'Two columns had the same header, so the second reads {columns, list}.',
  // @ph columns: column headers from the file
  'custImport.billingSkipped': 'Billing stays in QuickBooks, so these columns are skipped: {columns, list}.',
  'custImport.contactsNotAllowed': 'You can’t add or change contacts (“Create / edit contacts”), so contact columns are skipped.',
  'custImport.supervisorNotAllowed': 'Only a Super Admin or Admin assigns a customer’s supervisor, so the supervisor column is skipped.',
  // @max 16
  'custImport.emptyHeader': '(no header)',
  // @ph column: a column header from the file
  // @note Read aloud by a screen reader for the picker beside a column.
  'custImport.mapAria': 'What the column {column} holds',
  // @max 16
  'custImport.skip': 'Skip',
  'custImport.needName': 'Pick the column that holds the customer’s name.',
  // @max 16
  'custImport.back': 'Back',
  // @max 24
  'custImport.toPreview': 'Preview the import',
  // @max 24
  'custImport.field.number': 'Customer number',
  // @max 24
  'custImport.field.name': 'Customer name',
  // @max 32
  'custImport.field.type': 'Type (customer or vendor)',
  // @max 32
  // @note The customer's status: Active, Lead or Inactive (a blank or missing one imports Active).
  'custImport.field.status': 'Status (active, lead, inactive)',
  // @max 24
  'custImport.field.street': 'Street',
  // @max 24
  'custImport.field.street2': 'Suite or unit',
  // @max 24
  'custImport.field.city': 'City',
  // @max 24
  'custImport.field.state': 'State',
  // @max 24
  'custImport.field.zip': 'ZIP',
  // @max 24
  'custImport.field.supervisor': 'Supervisor',
  // @max 32
  'custImport.field.contactName': 'Contact: full name',
  // @max 32
  'custImport.field.contactFirstName': 'Contact: first name',
  // @max 32
  'custImport.field.contactLastName': 'Contact: last name',
  // @max 32
  'custImport.field.contactEmail': 'Contact: email',
  // @max 32
  'custImport.field.contactPhone': 'Contact: phone',
  // @max 32
  'custImport.field.contactRole': 'Contact: role',
  // @max 24
  'custImport.field.notes': 'Notes',
  // @max 16
  'custImport.stat.create': 'New',
  // @max 16
  'custImport.stat.update': 'Updated',
  // @max 16
  'custImport.stat.unchanged': 'Unchanged',
  // @max 16
  'custImport.stat.error': 'Not imported',
  // @max 16
  'custImport.stat.warning': 'With a note',
  // @ph added: how many contacts will be added; updated: how many will have blank details filled in
  'custImport.contactsPlanned': 'Contacts: {added, number} to add, {updated, number} to fill in.',
  // @note Shown when a spreadsheet lists a building on more than one row (e.g. one row per contact).
  'custImport.sameRows': {
    one: '{count} row adds to a customer an earlier row names: one building is one customer.',
    other: '{count, number} rows add to customers an earlier row names: one building is one customer.',
  },
  // @ph after: a size, e.g. 1.9 MB; limit: a size, e.g. 3.5 MB
  // @note "The shared record" is the company's one stored copy of its customers, team and settings.
  'custImport.size': 'The shared record will be {after} of its {limit} limit.',
  'custImport.sizeChecking': 'Checking the shared record’s size…',
  'custImport.tags': 'Add tags to every customer in this file',
  // @max 16
  'custImport.tagsHint': 'Optional.',
  // @note Read aloud by a screen reader for the row filters.
  'custImport.filterAria': 'Show rows',
  // @max 16
  'custImport.filter.all': 'All',
  // @max 16
  'custImport.filter.create': 'New',
  // @max 16
  'custImport.filter.update': 'Updated',
  // @max 16
  'custImport.filter.unchanged': 'Unchanged',
  // @max 16
  // @note A row for a building an earlier row of the file already named.
  'custImport.filter.same': 'Same customer',
  // @max 16
  'custImport.filter.problems': 'Problems',
  // @max 16
  'custImport.col.row': 'Row',
  // @max 16
  'custImport.col.customer': 'Customer',
  // @max 16
  'custImport.col.location': 'Location',
  // @max 16
  'custImport.col.result': 'Result',
  // @max 16
  'custImport.status.create': 'New',
  // @max 16
  'custImport.status.update': 'Update',
  // @max 16
  'custImport.status.unchanged': 'No change',
  // @max 16
  // @note Badge on a row for a building an earlier row already named: it adds to that customer.
  'custImport.status.same': 'Same customer',
  // @max 16
  'custImport.status.error': 'Not imported',
  // @note The rows in the list's pager: "Showing 1–20 of 750 rows".
  'custImport.rowsNoun': 'rows',
  // @max 32
  'custImport.download': 'Download problems (CSV)',
  // @max 24
  'custImport.nothingToImport': 'Nothing to import',
  // @max 32
  'custImport.importN': {
    one: 'Import {count} customer',
    other: 'Import {count, number} customers',
  },
  // @ph created: how many customers were added; updated: how many were updated
  'custImport.toastDone': 'Import finished: {created, number} new, {updated, number} updated.',
  'custImport.done': 'Imported. The customers are on the Customers list now.',
  // @ph added: how many contacts were added; updated: how many had blank details filled in
  'custImport.contactsDone': 'Contacts: {added, number} added, {updated, number} filled in.',
  'custImport.locating': {
    one: 'Locating {count} building on the map…',
    other: 'Locating {count, number} buildings on the map…',
  },
  'custImport.located': {
    one: '{count} building located.',
    other: '{count, number} buildings located.',
  },
  // @note The Access tab is the tab on a customer's page that holds its location.
  'custImport.notFound': {
    one: '{count} address couldn’t be found on the map. Its Access tab says so: check the address there.',
    other: '{count, number} addresses couldn’t be found on the map. Each Access tab says so: check the addresses there.',
  },
  'custImport.lookupUnavailable': 'Address lookup isn’t available right now, so these buildings aren’t located. Clock-ins there are allowed and flagged for review until they are.',
  // @note Shown when the server stops a run because this sign-in has looked up many addresses in the last hour (CS-083).
  'custImport.lookupLimited': 'Address lookups are paused for this sign-in: it has looked up a lot of addresses in the last hour. The buildings not located yet are still waiting.',
  // @note Follows custImport.lookupLimited. “Locate” is the button that locates the next buildings.
  'custImport.lookupRetry': {
    one: 'Press Locate again in about {count} minute.',
    other: 'Press Locate again in about {count, number} minutes.',
  },
  // @note Shown when the company's daily allowance of address lookups (set with the map provider) is used up.
  'custImport.lookupQuota': 'The company’s address lookups for today are used up, so the buildings not located yet are still waiting. Press Locate again tomorrow.',
  'custImport.notLocatedYet': {
    one: '{count} building isn’t located on the map yet.',
    other: '{count, number} buildings aren’t located on the map yet.',
  },
  // @max 28
  'custImport.locateNext': {
    one: 'Locate {count} building',
    other: 'Locate the next {count, number}',
  },
  'custImport.nothingToDo': 'Nothing to import: every row is unchanged or has a problem.',
  // @ph after: a size, e.g. 3.6 MB; allowed: a size, e.g. 3.1 MB; limit: a size, e.g. 3.5 MB
  'custImport.tooLarge': 'Nothing was imported: this import would make the company’s shared record {after}, and an import may take it to {allowed} at most (its limit is {limit}; everyday work needs the rest). Tell a Super Admin: the record needs to make room before this import can run.',
  // ── … each row's result in the preview, and in the problems file ──
  'custImport.err.notPermitted': 'You can’t add or change customers.',
  // @ph value: what the file says, as typed
  'custImport.err.numberInvalid': '“{value}” isn’t a customer number. Use four digits, like 0001.',
  // @ph number: a customer number, e.g. 0001; other: another customer number
  'custImport.err.numberConflict': 'The number column says {number}, but the name starts with {other}.',
  'custImport.err.noName': 'No customer name.',
  // @ph row: a row number in the file; number: a customer number, e.g. 0001
  'custImport.err.duplicateNumber': 'Row {row} already gives {number} to {customer}.',
  // @ph current: the customer number on file, e.g. 0001; number: the one the file gives
  'custImport.err.numberMismatch': '{customer} already has the number {current}, not {number}.',
  'custImport.err.ambiguousName': 'More than one customer is named {customer}. Add the customer number to choose one.',
  // @ph value: what the file says, as typed
  'custImport.warn.stateUnknown': '“{value}” isn’t a US state, so the state was left blank.',
  // @ph value: the ZIP as the file has it; zip: the ZIP code it was read as
  'custImport.warn.zipPadded': 'ZIP {value} was read as {zip}: spreadsheets drop leading zeros.',
  // @ph value: what the file says, as typed
  'custImport.warn.zipOdd': '“{value}” doesn’t look like a ZIP code. Check it before the building is located.',
  'custImport.warn.supervisorNotAllowed': 'Only a Super Admin or Admin assigns a customer’s supervisor, so it was left blank.',
  // @ph value: what the file says, as typed
  'custImport.warn.supervisorNotFound': 'No team member matches the supervisor “{value}”, so it was left blank.',
  // @ph value: what the file says, as typed
  'custImport.warn.supervisorAmbiguous': 'More than one team member is named “{value}”. Use their email instead.',
  'custImport.warn.supervisorNotEligible': '{name} can’t supervise a customer (only a Super Admin, Admin or Manager can), so it was left blank.',
  'custImport.warn.vendorNumber': 'Vendors have no customer number, so it was left out.',
  'custImport.warn.vendorAddress': 'Vendors have no location, so the address was left out.',
  'custImport.warn.noNumber': 'No customer number. Add it later on the customer page.',
  'custImport.warn.noAddress': 'No address, so this building can’t be located yet.',
  'custImport.warn.typeKept': 'The type on file is kept.',
  'custImport.warn.supervisorKept': 'The supervisor on file is kept: {name}.',
  // @ph value: what the file says, as typed
  'custImport.warn.statusUnknown': '“{value}” isn’t a status this import reads (Active, Lead or Inactive), so it was read as Active.',
  // @ph status: the status the customer already has, e.g. Inactive
  'custImport.warn.statusKept': 'The status on file is kept: {status}.',
  'custImport.warn.noLocation': 'This customer has no location to put the address on.',
  'custImport.warn.addressKept': 'The address on file is kept: {address}.',
  // @ph row: a row number in the file
  'custImport.warn.repeatKept': 'Row {row} already set this customer’s details, so only this row’s contact and notes were used.',
  'custImport.warn.contactNotAllowed': 'You can’t add or change contacts, so the contact was left out.',
  // @ph value: what the file says, as typed
  'custImport.warn.contactEmailInvalid': '“{value}” isn’t an email address, so the contact was left out.',
  'custImport.warn.contactEmpty': 'The contact has no name, email or phone, so it was left out.',
  // @ph email: an email address
  'custImport.warn.contactElsewhere': '{email} belongs to {name} at {customer}, so it wasn’t added here.',
  'custImport.chg.newVendor': 'Adds the vendor (a vendor has no location).',
  'custImport.chg.newCustomer': 'Adds the customer and its location.',
  'custImport.chg.supervisor': 'Supervisor: {name}.',
  // @ph status: the customer's status name, e.g. Active
  'custImport.chg.status': 'Status: {status}.',
  // @max 16
  'custImport.statusName.active': 'Active',
  // @max 16
  'custImport.statusName.lead': 'Lead',
  // @max 16
  'custImport.statusName.inactive': 'Inactive',
  'custImport.chg.matchedNumber': 'Matched by customer number.',
  'custImport.chg.matchedName': 'Matched by name.',
  // @ph number: a customer number, e.g. 0001
  'custImport.chg.fillNumber': 'Sets the customer number {number}.',
  'custImport.chg.fillAddress': 'Sets the address: {address}.',
  'custImport.chg.tags': 'Adds the tags.',
  // @ph row: a row number in the file
  'custImport.chg.sameAs': 'Same customer as row {row}.',
  'custImport.chg.note': 'Adds a note.',
  'custImport.chg.contactFill': 'Fills in {name}’s blank details.',
  'custImport.chg.contactNew': 'Adds the contact {name}.',
  // @note A column header in the downloaded problems file.
  // @max 24
  'custImport.csv.row': 'Row',
  // @note A column header in the downloaded problems file.
  // @max 24
  'custImport.csv.result': 'Import result',
  // @note A column header in the downloaded problems file.
  // @max 24
  'custImport.csv.problem': 'Problem',
  // @max 32
  'custImport.csv.notImported': 'Not imported',
  // @max 32
  'custImport.csv.withNote': 'Imported, with a note',

  // ── Settings → Team → Import team (task #466: a spreadsheet, one row per team member; office) ──
  // @note The title of the pop-up that brings in team members from a spreadsheet.
  // @max 32
  'teamImport.title': 'Import team',
  'teamImport.notPermitted': 'Importing team members needs “Edit team”. Ask a Super Admin.',
  'teamImport.lead': 'Bring in your team from a spreadsheet, one row per person. Every row needs an email: it’s how they sign in. Nothing is saved until you check the preview.',
  'teamImport.templateHint': 'The columns this import reads, with example rows to replace. Someone who works at more than one account gets them all in one cell, with a “;” between them.',
  // @ph size: a file size, e.g. 10 MB
  'teamImport.dropHint': 'An Excel, Google Sheets or payroll export · up to {size}',
  'teamImport.needName': 'Pick the column that holds the name (or the first and last name).',
  'teamImport.needEmail': 'Pick the column that holds the email. Every team member signs in with their email.',
  // @ph columns: column headers from the file
  'teamImport.privateSkipped': 'Private details stay out of the app, so these columns are skipped and left out of the problems file: {columns, list}.',
  'teamImport.payNotAllowed': 'You can’t set pay rates (“Edit pay rates”), so the pay rate column is skipped.',
  // @max 24
  'teamImport.field.firstName': 'First name',
  // @max 24
  'teamImport.field.lastName': 'Last name',
  // @max 24
  'teamImport.field.name': 'Full name',
  // @max 24
  'teamImport.field.employeeId': 'Employee ID',
  // @max 24
  'teamImport.field.email': 'Email (sign-in)',
  // @max 24
  'teamImport.field.phone': 'Phone',
  // @max 24
  'teamImport.field.role': 'Role',
  // @max 24
  'teamImport.field.pay': 'Pay rate (hourly)',
  // @max 24
  // @note The customer (building) a cleaner works at, by its customer number or its name.
  'teamImport.field.account': 'Account (customer)',
  // @max 16
  'teamImport.stat.create': 'New',
  // @max 16
  'teamImport.stat.update': 'Filled in',
  // @max 16
  'teamImport.stat.unchanged': 'Unchanged',
  // @max 16
  'teamImport.stat.error': 'Not imported',
  // @max 16
  'teamImport.stat.warning': 'With a note',
  'teamImport.runNote': 'Each new person gets a login, and an email with a link to set their password, as the import runs. It adds 25 people at a time: keep this window open until it says it’s finished.',
  // @max 16
  'teamImport.filter.update': 'Filled in',
  // @max 16
  'teamImport.col.member': 'Team member',
  // @max 16
  'teamImport.col.worksAt': 'Works at',
  // @max 16
  'teamImport.col.pay': 'Pay',
  // @max 16
  'teamImport.col.notes': 'Notes',
  // @ph line: the spreadsheet's row number; email: the person's sign-in email
  'teamImport.rowEmail': 'Row {line, number} · {email}',
  // @ph rate: the hourly pay rate the import sets
  // @note The pay column of the preview: an hourly rate, "/hr" in grey after it.
  'teamImport.payHourly': '{rate, money}<muted>/hr</muted>',
  // @max 16
  // @note A team member already on file whose pay the import leaves as it is.
  'teamImport.payOnFile': 'On file',
  // @max 16
  'teamImport.status.create': 'New',
  // @max 16
  'teamImport.status.update': 'Fill in',
  // @max 16
  'teamImport.status.unchanged': 'No change',
  // @max 16
  'teamImport.status.error': 'Not imported',
  // @max 32
  'teamImport.importN': {
    one: 'Import {count} person',
    other: 'Import {count, number} people',
  },
  // @ph done: how many people the import has got through; total: how many it will add
  'teamImport.running': 'Adding team members: {done, number} of {total, number}…',
  // @max 24
  'teamImport.stop': 'Stop after this run',
  'teamImport.stopping': 'Stopping once this run of 25 is saved…',
  'teamImport.closeNote': 'Closing this window stops the import after the run it’s on. Everyone already added stays added.',
  'teamImport.done': 'Imported. The new team members are on the Team list now.',
  'teamImport.stopped': {
    one: 'Stopped. {count} person wasn’t added: import the same file again to add them. The rows already in read “No change”.',
    other: 'Stopped. {count, number} people weren’t added: import the same file again to add them. The rows already in read “No change”.',
  },
  // @max 16
  'teamImport.stat.added': 'Added',
  // @max 16
  'teamImport.stat.invited': 'Emailed',
  // @max 16
  'teamImport.stat.refused': 'Not added',
  'teamImport.attention': 'These need a look:',
  // @max 24
  'teamImport.col.outcome': 'What happened',
  // @ph why: the server's own reason, as it gave it
  'teamImport.outcome.refused': 'Not added: {why}',
  'teamImport.outcome.skipped': 'Not added: someone added this email to the team since the preview.',
  // @note "Send password-reset link" is the button on the member's own page.
  'teamImport.outcome.notSetUp': 'Added, but email isn’t set up, so no sign-in link went. Open their page and use Send password-reset link.',
  // @note "Send password-reset link" is the button on the member's own page.
  'teamImport.outcome.failed': 'Added, but the sign-in email didn’t go through. Open their page and use Send password-reset link.',
  // @note "Send password-reset link" is the button on the member's own page.
  'teamImport.outcome.noLink': 'Added, but their sign-in link couldn’t be made. Open their page and use Send password-reset link.',
  'teamImport.outcome.withheld': 'Added, but email isn’t set up, and their sign-in link can’t be shown to you: their access includes permissions you don’t have. Ask a Super Admin.',
  'teamImport.outcome.adopted': 'They already had a login here, from an invite that never finished. It’s now joined to their team record.',
  // @ph id: an employee ID, e.g. EMP-0042
  'teamImport.outcome.idChanged': 'Added with employee ID {id}: the one in the file was taken since the preview.',
  'teamImport.outcome.idDropped': 'Added without an employee ID: the one in the file was taken since the preview. Set it on their page.',
  // @ph added: how many people were added; filled: how many people on file had blanks filled in
  'teamImport.toastDone': 'Import finished: {added, number} added, {filled, number} filled in.',
  // @ph added: how many people were added; left: how many were not reached
  'teamImport.toastStopped': 'Import stopped: {added, number} added, {left, number} not reached.',
  'teamImport.nothingToDo': 'Nothing to import: every row is unchanged or has a problem.',
  // @ph after: a size, e.g. 3.6 MB; allowed: a size, e.g. 3.1 MB; limit: a size, e.g. 3.5 MB
  'teamImport.tooLarge': 'Nothing was imported: this import would make the company’s shared record {after}, and an import may take it to {allowed} at most (its limit is {limit}; everyday work needs the rest). Tell a Super Admin: the record needs to make room before this import can run.',
  // ── … each row's result in the preview, and in the problems file ──
  'teamImport.err.notPermitted': 'You can’t add team members.',
  'teamImport.err.noName': 'No name.',
  'teamImport.err.noEmail': 'No email. Every team member signs in with their email.',
  // @ph value: what the file says, as typed
  'teamImport.err.emailInvalid': '“{value}” isn’t an email address.',
  // @ph row: a row number in the file
  'teamImport.err.duplicateEmail': 'Row {row} already has this email.',
  // @ph row: a row number in the file; id: an employee ID, as the file has it
  'teamImport.err.duplicateEmployeeId': 'Row {row} already has employee ID {id}.',
  // @ph id: an employee ID; name: a team member's name; email: their email address
  'teamImport.err.idOtherMember': 'Employee ID {id} belongs to {name}, whose email is {email}, not this one.',
  // @ph name: a team member's name; current: the employee ID on file; id: the one the file gives
  'teamImport.err.idMismatch': '{name} is on the team with employee ID {current}, not {id}.',
  // @note A Super Admin is the top access level; it is only ever given on Settings → Team, one person at a time.
  'teamImport.err.roleSuperAdmin': 'A file can’t make someone a Super Admin.',
  // @ph value: what the file says, as typed
  'teamImport.err.roleUnknown': '“{value}” isn’t a role this import reads: Crew, Account Manager, Operations Manager, Supply Manager or Admin.',
  // @ph role: an access level's name, e.g. Admin
  'teamImport.err.roleNotAllowed': 'You can’t give someone the {role} access level: it includes permissions you don’t have.',
  // @ph value: what the file says, as typed
  'teamImport.err.payInvalid': '“{value}” isn’t an hourly pay rate. Use a number, like 15.50.',
  // @ph id: an employee ID, e.g. EMP-0042
  'teamImport.warn.idMinted': 'No employee ID, so they get {id}. Change it on their page to match payroll.',
  // @ph role: an access level's name, e.g. Crew
  'teamImport.warn.roleKept': 'Their access level on file is kept: {role}.',
  'teamImport.warn.payNotAllowed': 'You can’t set pay rates, so the pay rate was left out.',
  'teamImport.warn.ownPay': 'You can’t set your own pay, so the pay rate was left out.',
  // @ph rate: an hourly pay rate in dollars
  'teamImport.warn.payHigh': '{rate, money} an hour is high for an hourly rate. Check it.',
  'teamImport.warn.payKept': 'The pay on file is kept.',
  'teamImport.warn.hrNotAllowed': 'You can’t edit HR records, so their employee ID was left blank.',
  'teamImport.warn.ownHr': 'You can’t edit your own HR record, so your employee ID was left blank.',
  // @ph value: what the file says, as typed
  'teamImport.warn.accountNotFound': 'No customer matches “{value}”, so it wasn’t linked.',
  // @ph value: what the file says, as typed
  'teamImport.warn.accountAmbiguous': 'More than one customer is named “{value}”. Use the customer number instead.',
  // @ph value: what the file says, as typed, e.g. 0042 Harbor View
  'teamImport.warn.accountMismatch': '“{value}”: that number belongs to another customer, so it wasn’t linked.',
  'teamImport.warn.accountInactive': '{customer} isn’t a building you clean now (it’s inactive, archived or a vendor), so it wasn’t linked.',
  // @note "Service setup" is the card on a customer's page where its supervisor (an Account Manager) is set.
  'teamImport.warn.accountNotCrew': 'Only Crew are linked to an account here, so the account was left out. A manager’s customers are set on each customer’s Service setup.',
  // @ph customers: customer names
  'teamImport.warn.accountKept': 'They already work at {customers, list}, so that was kept.',
  // @ph role: an access level's name, e.g. Crew
  'teamImport.chg.new': 'Adds them as {role}.',
  // @ph id: an employee ID, e.g. EMP-0042
  'teamImport.chg.employeeId': 'Employee ID: {id}.',
  // @ph rate: an hourly pay rate in dollars
  'teamImport.chg.pay': 'Pay: {rate, money} an hour.',
  // @ph customers: customer names
  'teamImport.chg.worksAt': 'Works at: {customers, list}.',
  // @ph email: an email address
  'teamImport.chg.invite': 'Emails {email} a link to set their password.',
  'teamImport.chg.matchedId': 'Already on the team: matched by employee ID.',
  'teamImport.chg.matchedEmail': 'Already on the team: matched by email.',
  'teamImport.chg.fillPhone': 'Sets their phone.',
  // @note A column header in the downloaded problems file.
  // @max 24
  'teamImport.csv.row': 'Row',
  // @note A column header in the downloaded problems file.
  // @max 24
  'teamImport.csv.result': 'Import result',
  // @note A column header in the downloaded problems file.
  // @max 24
  'teamImport.csv.problem': 'Problem',
  // @max 32
  'teamImport.csv.notImported': 'Not imported',
  // @max 32
  'teamImport.csv.withNote': 'Imported, with a note',
  // ── The customers a cleaner works at (users[].worksAt, task #466): a link the office keeps, never access ──
  // @max 16
  // @note A column on Settings → Team and a field on a cleaner's page: the customers (buildings) they work at.
  'worksAt.label': 'Works at',
  // @ph count: how many more customers, beyond the one shown
  // @max 8
  'worksAt.more': '+{count, number}',
  'worksAt.hint': 'The customers this cleaner works at. It doesn’t change what they see in the app: that still comes from the cleans they’re on.',
  'worksAt.empty': 'No customers yet.',
  // @note Beside a cleaner linked to this customer who isn't on any of its upcoming cleans.
  // @max 24
  'worksAt.notOnClean': 'not on a clean yet',
  // @note Under the cleaners on a customer's Service setup while it is being edited. "Works at" is the field on a cleaner's own page under Settings → Team.
  'worksAt.svcNote': 'From upcoming cleans, and the cleaners who work here (Works at, on each cleaner’s Team page). Not editable here.',
  // @note A small tag in the cleaner picker beside a cleaner who works at this clean's customer.
  // @max 16
  'worksAt.tag': 'Works here',
  // ── Supplies → Catalog → Import items (task 257, components/SupplyCatalogImport): the supply
  // catalog from a spreadsheet, one row per product, six columns: Photo, SKU, Item, Category, How it
  // comes, Price. "The catalog" is the company's list of products its buildings order from. ──
  // @max 18
  // @note The button beside "Add item" on the catalog that opens the import.
  'supplyImport.open': 'Import items',
  // @max 32
  // @note The title of the pop-up that brings in supply products from a spreadsheet.
  'supplyImport.title': 'Import supply items',
  'supplyImport.notPermitted': 'Importing items needs “Fulfill requests & manage approved items”. Ask a Super Admin.',
  'supplyImport.lead': 'Bring in your supply catalog from a spreadsheet, one row per product: Photo, SKU, Item, Category, How it comes and Price. Nothing is saved until you check the preview.',
  // @max 32
  'supplyImport.template': 'Download the template',
  'supplyImport.templateHint': 'An Excel file with the six columns, in this order.',
  'supplyImport.howPicture': 'Photo: in Excel, put a picture in the Photo cell (Insert › Pictures › Place in Cell), or paste it onto the row.',
  'supplyImport.howLink': 'Or put the picture’s web address in the Photo cell, as a link or as =IMAGE("…").',
  'supplyImport.howUpdate': 'A row whose SKU (or name, if it has no SKU) is already in the catalog updates that item: filled cells replace what it has, blank cells leave it as it is.',
  // @max 40
  'supplyImport.drop': 'Choose or drop an Excel or CSV file',
  // @ph size: a whole number of megabytes, e.g. 100
  'supplyImport.dropHint': 'Excel (.xlsx) carries pictures; a CSV carries links only · up to {size, number} MB',
  // @max 24
  'supplyImport.reading': 'Reading the file…',
  // @ph size: a whole number of megabytes, e.g. 100
  'supplyImport.err.fileTooLarge': 'This file is larger than {size, number} MB.',
  // @note .xls is the file type of Excel 2003 and older; .xlsx is today's.
  'supplyImport.err.oldExcel': 'This is an old Excel file (.xls). Open it in Excel and save it as an Excel Workbook (.xlsx), then try again.',
  'supplyImport.err.empty': 'No rows found. The file needs a header row and at least one row below it.',
  // @ph count: the most rows one import reads, e.g. 5,000
  'supplyImport.err.tooManyRows': 'This file has more than {count, number} rows. Split it into smaller files and import each one.',
  'supplyImport.err.unreadable': 'This file couldn’t be read. Save it from your spreadsheet as an Excel Workbook (.xlsx) or as CSV and try again.',
  // @note Above the list of the file's columns, each with a picker for what it holds.
  'supplyImport.mapLead': {
    one: '{count} row. Match each column to what it holds; a column left on Skip is not imported.',
    other: '{count, number} rows. Match each column to what it holds; a column left on Skip is not imported.',
  },
  'supplyImport.picturesFound': {
    one: '{count} picture found in the file.',
    other: '{count, number} pictures found in the file.',
  },
  // @note Shown in the column list as the sample of a column that holds pictures.
  'supplyImport.pictureCount': {
    one: '{count} picture',
    other: '{count, number} pictures',
  },
  'supplyImport.csvNoPictures': 'A CSV file can’t hold pictures. A photo comes in only as a web address in the Photo column; use an Excel file (.xlsx) to bring pictures in.',
  // @note Windows-1252 and UTF-8 are names of text encodings; "CSV" and "CSV UTF-8" are Excel's own names for its save options.
  'supplyImport.readAs1252': 'This file wasn’t saved as UTF-8 (Excel’s plain “CSV” choice), so it was read as Windows-1252. Check accented names in the preview. Saving as “CSV UTF-8” avoids this.',
  'supplyImport.readSemicolon': 'The columns are separated by semicolons (a non-US Excel export).',
  'supplyImport.readTab': 'The columns are separated by tabs.',
  // @ph columns: column headers from the file, with a number added, e.g. Price (2)
  'supplyImport.renamedHeaders': 'Two columns had the same header, so the second reads {columns, list}.',
  // @max 16
  'supplyImport.emptyHeader': '(no header)',
  // @ph column: a column header from the file
  // @note Read aloud by a screen reader for the picker beside a column.
  'supplyImport.mapAria': 'What the column {column} holds',
  // @max 16
  'supplyImport.skip': 'Skip',
  'supplyImport.needName': 'Pick the column that holds the item’s name.',
  // @max 16
  'supplyImport.back': 'Back',
  // @max 24
  'supplyImport.toPreview': 'Preview the import',
  // @max 24
  'supplyImport.field.photo': 'Photo',
  // @max 24
  // @note A product's stock code.
  'supplyImport.field.sku': 'SKU',
  // @max 24
  'supplyImport.field.name': 'Item',
  // @max 24
  'supplyImport.field.category': 'Category',
  // @max 24
  // @note How the product is packed, e.g. "Case of 12".
  'supplyImport.field.unit': 'How it comes',
  // @max 24
  'supplyImport.field.price': 'Price',
  // @max 40
  'supplyImport.checking': 'Checking the file against the catalog…',
  'supplyImport.catalogFailed': 'The catalog couldn’t be read, so the preview can’t be checked. Try again.',
  // @max 16
  'supplyImport.stat.create': 'New',
  // @max 16
  'supplyImport.stat.update': 'Updated',
  // @max 16
  'supplyImport.stat.unchanged': 'Unchanged',
  // @max 16
  'supplyImport.stat.error': 'Not imported',
  // @max 16
  'supplyImport.stat.photos': 'With a photo',
  'supplyImport.notesCount': {
    one: '{count} row has a note: see Problems.',
    other: '{count, number} rows have a note: see Problems.',
  },
  // @note Read aloud by a screen reader for the row filters.
  'supplyImport.filterAria': 'Show rows',
  // @max 16
  'supplyImport.filter.all': 'All',
  // @max 16
  'supplyImport.filter.create': 'New',
  // @max 16
  'supplyImport.filter.update': 'Updated',
  // @max 16
  'supplyImport.filter.unchanged': 'Unchanged',
  // @max 16
  'supplyImport.filter.problems': 'Problems',
  // @max 16
  'supplyImport.col.row': 'Row',
  // @max 16
  'supplyImport.col.item': 'Item',
  // @max 16
  // @note The item's category, how it comes and its price, on one line.
  'supplyImport.col.details': 'Details',
  // @max 16
  'supplyImport.col.result': 'Result',
  // @max 16
  'supplyImport.status.create': 'New',
  // @max 16
  'supplyImport.status.update': 'Update',
  // @max 16
  'supplyImport.status.unchanged': 'No change',
  // @max 16
  'supplyImport.status.error': 'Not imported',
  // @note The rows in the list's pager: "Showing 1–20 of 500 rows".
  'supplyImport.rowsNoun': 'rows',
  // @max 32
  'supplyImport.download': 'Download problems (CSV)',
  // @max 24
  'supplyImport.nothingToImport': 'Nothing to import',
  // @max 32
  'supplyImport.importN': {
    one: 'Import {count} item',
    other: 'Import {count, number} items',
  },
  // ── … the import running, and done ──
  // @ph done: how many items are saved so far; total: how many there are
  'supplyImport.savingItems': 'Saving items: {done, number} of {total, number}',
  // @ph done: how many photos are stored so far; total: how many there are
  'supplyImport.savingPhotos': 'Saving photos: {done, number} of {total, number}',
  'supplyImport.keepOpen': 'Keep this open until it finishes. Stopping keeps what is already saved.',
  // @max 16
  'supplyImport.stop': 'Stop',
  'supplyImport.done': 'Imported. The items are in the catalog now.',
  'supplyImport.donePartly': 'Imported, except the rows in the problems file. The rest are in the catalog now.',
  'supplyImport.doneNone': 'Nothing was imported. The problems file says why.',
  // @max 16
  'supplyImport.stat.added': 'Added',
  // @max 16
  'supplyImport.stat.updated': 'Updated',
  // @max 16
  'supplyImport.stat.notImported': 'Not imported',
  // @max 16
  'supplyImport.stat.photosSaved': 'Photos saved',
  'supplyImport.photosFailed': {
    one: '{count} photo couldn’t be saved; its item is saved without it. The problems file says why. Import the file again to try it again.',
    other: '{count, number} photos couldn’t be saved; their items are saved without them. The problems file says why. Import the file again to try them again.',
  },
  // @ph added: how many items were added; updated: how many were updated
  'supplyImport.toastDone': 'Import finished: {added, number} new, {updated, number} updated.',
  // ── … each row's result in the preview, and in the problems file ──
  'supplyImport.err.nameRequired': 'No item name.',
  'supplyImport.err.nameTooLong': 'The item name is over 200 characters.',
  'supplyImport.err.skuTooLong': 'The SKU is over 40 characters.',
  'supplyImport.err.categoryTooLong': 'The category is over 60 characters.',
  'supplyImport.err.unitTooLong': '“How it comes” is over 80 characters.',
  'supplyImport.err.badPrice': 'The price isn’t a number above zero, like 12.50.',
  'supplyImport.err.invalid': 'This row can’t be saved as it is.',
  // @ph name: an item name from the file
  'supplyImport.err.ambiguousName': 'More than one item is named “{name}”. Add the SKU to choose one.',
  // @ph row: a row number in the file
  'supplyImport.err.duplicate': 'Row {row} already has this item.',
  'supplyImport.warn.manyPicturesColumn': {
    one: 'This row has {count} picture; the one in the Photo column is used.',
    other: 'This row has {count, number} pictures; the one in the Photo column is used.',
  },
  'supplyImport.warn.manyPictures': {
    one: 'This row has {count} picture; the first is used.',
    other: 'This row has {count, number} pictures; the first is used.',
  },
  // @ph name: a picture's file name inside the spreadsheet, e.g. image3.emf
  'supplyImport.warn.photoUnreadable': 'This row’s picture {name} is a kind a browser can’t show (such as EMF). Paste it as a JPG or PNG; the item imports without a photo.',
  'supplyImport.warn.photoText': 'The Photo cell holds text, not a picture or a web address, so the item imports without a photo.',
  // @ph from: the item's SKU now; to: the SKU the file gives
  'supplyImport.change.sku': 'SKU: {from} → {to}',
  // @ph from: the item's name now; to: the name the file gives
  'supplyImport.change.name': 'Name: {from} → {to}',
  // @ph from: the item's category now; to: the category the file gives
  'supplyImport.change.category': 'Category: {from} → {to}',
  // @ph from: how the item comes now; to: what the file gives
  'supplyImport.change.unit': 'How it comes: {from} → {to}',
  // @ph from: the item's price now; to: the price the file gives
  'supplyImport.change.price': 'Price: {from, money} → {to, money}',
  'supplyImport.change.photoAdded': 'Adds its photo.',
  'supplyImport.change.photoReplaced': 'Replaces its photo.',
  'supplyImport.run.stale': 'Someone changed this item while the import ran, so it was left as they saved it. Import the file again to apply it.',
  'supplyImport.run.gone': 'This item was deleted from the catalog while the import ran.',
  // @ph item: the name of the item that has the SKU
  'supplyImport.run.skuTaken': 'This SKU is already on “{item}”.',
  'supplyImport.run.invalid': 'The server refused this row as it is.',
  'supplyImport.run.demoFull': 'This row wasn’t saved: this demo’s storage on this device is full.',
  'supplyImport.run.failed': 'This row couldn’t be saved: the server didn’t answer. Import the file again to try it again.',
  'supplyImport.photo.unreadable': 'Its photo couldn’t be read on this device. Use a JPG or PNG.',
  'supplyImport.photo.tooLarge': 'Its photo is too large to store, even made smaller.',
  'supplyImport.photo.stale': 'Its photo wasn’t saved: someone changed the item at the same time.',
  'supplyImport.photo.demoFull': 'Its photo wasn’t saved: this demo’s storage is full.',
  'supplyImport.photo.demoLink': 'Its photo is a web address, and the demo doesn’t download pictures. The live app does.',
  'supplyImport.photo.limited': 'Its photo wasn’t downloaded: this sign-in has downloaded many pictures in the last hour. Import the file again later.',
  'supplyImport.photo.badLink': 'Its photo’s web address isn’t one the app downloads from.',
  'supplyImport.photo.linkGone': 'Nothing is at its photo’s web address any more.',
  'supplyImport.photo.notPicture': 'Its photo’s web address isn’t a JPG, PNG, GIF or WebP picture.',
  'supplyImport.photo.linkTooLarge': 'The picture at its photo’s web address is over 3 MB.',
  'supplyImport.photo.unreachable': 'Its photo’s web address couldn’t be reached.',
  'supplyImport.photo.failed': 'Its photo couldn’t be saved.',
  // @note A column header in the downloaded problems file.
  // @max 24
  'supplyImport.csv.row': 'Row',
  // @note A column header in the downloaded problems file.
  // @max 24
  'supplyImport.csv.result': 'Import result',
  // @note A column header in the downloaded problems file.
  // @max 24
  'supplyImport.csv.problem': 'Problem',
  // @max 32
  'supplyImport.csv.notImported': 'Not imported',
  // @max 32
  'supplyImport.csv.withNote': 'Imported, with a note',

  // ── A customer's Location card (the Access tab): an address lookup the server refused (CS-083) ──
  // @note “Locate address” is the button under the location's Geofence line.
  'geocode.limited': 'Address lookups are paused right now, so this address wasn’t located. Try “Locate address” again later.',
  // @note Shown after Save. “Locate address” is the button under the location's Geofence line.
  'geocode.limitedSave': 'Address lookups are paused right now, so the clock-in area wasn’t placed. The location is saved; use “Locate address” on it later.',

  // ── A location's cleaning areas (the customer page's Cleaning instructions card, and the read-only
  // list a cleaner reads on a clean's page). QR-8 (QR Wave 2): the office ticks areas from a standard
  // list or adds its own. The standard names themselves stay English (they print on the QR labels). ──
  'areaEditor.empty': 'No cleaning instructions yet.',
  // @max 24
  'areaEditor.untitled': 'Untitled area',
  // @ph when: the date and time of the area's last finished clean, already written out
  'areaEditor.lastCleaned': 'Last cleaned {when}',
  'areaEditor.notRecorded': 'Last cleaned: not recorded yet',
  // @ph area: the cleaning area's name, e.g. "Lobby"
  'areaEditor.photoAlt': 'Most recent photo of {area}',
  'areaEditor.photoAltUnnamed': 'Most recent photo of this area',
  'areaEditor.none': 'No areas yet. Tick them from the standard list below, or add your own.',
  // @note Placeholder in an empty area-name field; “First floor” is an example name.
  'areaEditor.namePlaceholder': 'Area name. E.g. First floor',
  'areaEditor.nameLabel': 'Area name',
  'areaEditor.instructionsPlaceholder': 'What to do in this area…',
  'areaEditor.instructionsLabel': 'What to do in this area',
  'areaEditor.moveUp': 'Move up',
  'areaEditor.moveDown': 'Move down',
  'areaEditor.remove': 'Remove area',
  // @note Heading over ten tick boxes of common area names (Lobby, Restrooms, Pool…).
  'areaEditor.stdLegend': 'Add from the standard list',
  // @max 12
  // @note Beside a name on the standard list that this building already has.
  'areaEditor.stdAdded': 'Added',
  'areaEditor.stdHint': 'Tick the areas this building has, then add them. The names print on the QR labels as written.',
  'areaEditor.stdAllAdded': 'Every area on the standard list is on this building.',
  // @ph count: how many ticked areas the button adds
  // @max 20
  'areaEditor.stdAdd': {
    one: 'Add {count} area',
    other: 'Add {count} areas',
  },
  // @max 20
  // @note The same button with nothing ticked yet (it is switched off).
  'areaEditor.stdAddNone': 'Add ticked areas',
  // @max 20
  // @note Adds one blank area to type a name the standard list doesn't have.
  'areaEditor.addOwn': 'Add your own',
  // The card around them (a customer's Notes tab, and the QR codes page's pop-up, UI_RULES §183).
  // @max 32
  'areaEditor.cardTitle': 'Cleaning instructions',
  // @max 12
  'areaEditor.edit': 'Edit',
  'areaEditor.cardHint': 'Break the clean down by area. Crew see these on their schedule for this account.',
  // @note The same line for the office, who also print each area's QR code.
  'areaEditor.cardHintCodes': 'Break the clean down by area. Crew see these on their schedule for this account, and each area gets its own QR code to print.',
  'areaEditor.emptyCodes': 'No cleaning areas yet. Add each area (the lobby, each restroom, a floor) and it gets its own QR code here, ready to print.',
  // @max 16
  // @note Opens the areas editor on a location that has none yet.
  'areaEditor.addAreas': 'Add areas',
  'areaEditor.editing': 'Editing cleaning instructions',
  // @max 16
  'areaEditor.save': 'Save Changes',
  'areaEditor.saved': 'Cleaning instructions updated',

  // ── …and their QR codes: Print label, ONE area's label to replace a damaged one, on the position
  // the office picks on a partly used label sheet (QR-9, QR Wave 2; office) ──
  // @max 16
  // @note A button on each area's row of the QR codes panel.
  'qrLabel.print': 'Print label',
  // @ph area: the cleaning area's name, e.g. "Lobby"
  'qrLabel.printAria': 'Print a label for {area}',
  'qrLabel.printAriaUnnamed': 'Print a label for this area',
  // @ph area: the cleaning area's name, e.g. "Lobby"
  'qrLabel.title': 'One label for {area}',
  'qrLabel.titleUnnamed': 'One label for this area',
  // @ph sheet: the label sheet's product name and size, e.g. "Avery 5163 / 8163 · 2″ × 4″"
  // @ph count: how many labels the sheet holds
  'qrLabel.sheet': {
    one: 'On {sheet} · {count} label a sheet',
    other: 'On {sheet} · {count} labels a sheet',
  },
  'qrLabel.position': 'Position on the sheet',
  'qrLabel.positionHelp': 'Pick the label it prints on, so a sheet that’s partly used isn’t wasted. Labels count across, then down.',
  // @ph n: the label's number on the sheet
  // @ph row: which row of labels it is in, from the top
  // @ph col: which column it is in, from the left
  'qrLabel.positionAria': 'Label {n}: row {row}, column {col}',
  // @ph n: the label's number on the sheet
  // @max 24
  'qrLabel.go': 'Print on label {n}',
  // @max 24
  // @note On the print button while the label's PDF is made.
  'qrLabel.preparing': 'Preparing the label…',
  'qrLabel.failed': 'The label couldn’t be printed. Try again.',
  'qrLabel.actualSize': 'Print at 100% (“Actual size”) so the code lands on its label.',

  // ── Customer documents (the client hub redesign: a customer's Documents tab, Settings → Company) ──
  // @note The tab on a customer's page that holds the documents the customer downloads from their portal.
  // @max 16
  'custDocs.tab': 'Documents',
  // @max 32
  'custDocs.title': 'Documents',
  // @max 40
  'custDocs.companyTitle': 'Documents for every customer',
  'custDocs.buildingHint': 'The customer downloads these from their portal when “Visible to the customer” is on. PDF, JPG or PNG, up to 10 MB.',
  'custDocs.companyHint': 'Every customer sees these in their portal, on every building. Your W-9 goes here.',
  // @max 16
  'custDocs.upload': 'Upload',
  // @max 16
  'custDocs.uploadSave': 'Upload',
  // @note Short name of a document type, on a small badge. COI is a certificate of insurance.
  // @max 8
  'custDocs.kind.coi': 'COI',
  // @note A US tax form (Form W-9). Keep the form's name.
  // @max 8
  'custDocs.kind.w9': 'W-9',
  // @max 8
  'custDocs.kind.other': 'Other',
  // @max 32
  'custDocs.kindLong.coi': 'Certificate of insurance',
  // @note A US tax form (Form W-9). Keep the form's name.
  // @max 32
  'custDocs.kindLong.w9': 'W-9',
  // @max 32
  'custDocs.kindLong.other': 'Other document',
  // @note Saved as the document's title when the office leaves the title blank; shown to customers in English.
  'custDocs.defaultTitle.coi': 'Certificate of Insurance',
  // @note Saved as the document's title when the office leaves the title blank; shown to customers in English.
  'custDocs.defaultTitle.w9': 'W-9',
  // @note Saved as the document's title when the office leaves the title blank; shown to customers in English.
  'custDocs.defaultTitle.other': 'Document',
  // @max 20
  'custDocs.col.document': 'Document',
  // @max 20
  'custDocs.col.validThrough': 'Valid through',
  // @max 20
  'custDocs.col.visible': 'Customer sees it',
  'custDocs.col.actions': 'Actions',
  // @note A badge beside a date that has passed: the certificate no longer covers today.
  // @max 12
  'custDocs.expired': 'Expired',
  // @max 20
  'custDocs.noExpiry': 'No end date',
  // @max 12
  'custDocs.visibleYes': 'Visible',
  // @max 12
  'custDocs.visibleNo': 'Hidden',
  // @max 32
  'custDocs.visibleLabel': 'Visible to the customer',
  // @max 14
  'custDocs.view': 'View',
  // @max 14
  'custDocs.replace': 'Replace',
  // @max 14
  'custDocs.edit': 'Edit',
  // @max 14
  'custDocs.delete': 'Delete',
  // @max 40
  'custDocs.sharedTitle': 'For every customer',
  'custDocs.sharedHint': 'The customer sees these too. Change them in Settings → Company.',
  // @max 40
  'custDocs.emptyTitle': 'No documents yet',
  'custDocs.emptyBuilding': 'Upload this building’s certificate of insurance so the customer can download it from their portal.',
  'custDocs.emptyCompany': 'Upload your W-9 once and every customer can download it from their portal.',
  // @max 40
  'custDocs.loadFailed': 'Documents couldn’t be loaded',
  'custDocs.loadFailedHint': 'Check your connection and try again.',
  // @ph title: the document's title, e.g. Certificate of Insurance
  'custDocs.confirmDelete.title': 'Delete “{title}”?',
  'custDocs.confirmDelete.message': 'This removes the document and its file. The customer stops seeing it at once. This can’t be undone.',
  // @max 40
  'custDocs.modal.uploadTitle': 'Upload a document',
  // @max 40
  'custDocs.modal.replaceTitle': 'Replace the file',
  // @max 40
  'custDocs.modal.editTitle': 'Edit the document',
  // @max 24
  'custDocs.field.kind': 'Kind',
  // @max 24
  'custDocs.field.title': 'Title',
  'custDocs.field.titleHelp': 'What the customer sees. Left blank, the kind’s own name is used.',
  // @max 24
  'custDocs.field.validUntil': 'Valid through',
  'custDocs.field.validUntilHelp': 'The last day it covers (a certificate of insurance). It shows “Expired” from the next day. Leave blank for a W-9.',
  'custDocs.field.visibleHelp': 'Off keeps it here for the office only.',
  // @max 24
  'custDocs.field.file': 'File',
  'custDocs.field.fileHelp': 'PDF, JPG or PNG, up to 10 MB.',
  'custDocs.error.fileType': 'Upload a PDF, JPG or PNG.',
  'custDocs.error.fileSize': 'That file is too large. The limit is 10 MB.',
  'custDocs.error.noFile': 'Choose a file to upload.',
  'custDocs.error.kind': 'Choose what kind of document this is.',
  'custDocs.error.title': 'Give the document a title (up to 120 characters).',
  'custDocs.error.validUntil': 'The valid-through date isn’t a date.',
  'custDocs.error.stale': 'Someone else just changed this document. Close this and try again.',
  'custDocs.error.gone': 'This document is no longer here. Refresh the page.',
  'custDocs.error.save': 'That didn’t save.',
  'custDocs.error.open': 'The file couldn’t be opened.',
  'custDocs.toast.uploaded': 'Document uploaded',
  'custDocs.toast.replaced': 'File replaced',
  'custDocs.toast.saved': 'Document saved',
  'custDocs.toast.deleted': 'Document deleted',
  'custDocs.toast.shown': 'The customer can see it now',
  'custDocs.toast.hidden': 'Hidden from the customer',
  // @max 32
  'custDocs.agreement.title': 'Service agreement',
  // @max 24
  'custDocs.agreement.open': 'Open the contract',
  // @note What the agreement is called when the contract has no name of its own.
  'custDocs.agreement.fallbackName': 'Service Agreement',
  // @ph date: the day the contract started, already written out, e.g. Jan 6, 2026
  'custDocs.agreement.started': 'Started {date}',
  // @max 24
  'custDocs.agreement.fileOnFile': 'Signed copy on file',
  // @max 24
  'custDocs.agreement.noFile': 'No signed copy yet',
  'custDocs.agreement.hint': 'The customer sees this agreement in their portal, with the signed copy to download. Never its price.',
  'custDocs.agreement.none': 'No active contract. Add one on the Contract tab and the customer sees their agreement in their portal.',
  // @note The rows a list is counting, after "Showing 1–20 of 34".
  'pager.noun.documents': 'documents',

  // ── The Operations Manager's team (S131, Builder R): the Home's account managers, the Accounts page, the team card ──
  // @max 24
  // @note The first choice of an Operations Manager's Manager filter: every building of theirs and of their account managers.
  'mgrTeam.allMyTeam': 'All my team',
  // @max 24
  // @note The filter on an Operations Manager's Home that picks one of their account managers, or all of them.
  'mgrTeam.picker': 'Account manager',
  // @max 24
  // @note The owner's Operations view: the filter that picks which Operations Manager's Home to show.
  'mgrTeam.opsPicker': 'Operations manager',
  // @max 32
  // @note A choice in a page's Manager filter when the owner opened the page from an Operations Manager's Home: every building of that Operations Manager and of their account managers.
  // @ph name: the Operations Manager's name
  'mgrTeam.teamOf': '{name}’s team',
  'mgrTeam.noOps.title': 'No operations managers yet',
  'mgrTeam.noOps.body': 'Make a manager an Operations Manager on their Team page (Settings → Team), then assign account managers to them.',
  // @ph count: how many buildings the Operations Manager's team looks after
  // @note Under the greeting on an Operations Manager's Home.
  'mgrTeam.sub.team': { one: 'Operations Manager · {count} property across your team', other: 'Operations Manager · {count} properties across your team' },
  // @ph name: the Operations Manager whose Home the owner is looking at; count: how many buildings their team looks after
  'mgrTeam.sub.ops': { one: '{name}’s team · {count} property', other: '{name}’s team · {count} properties' },
  // @max 40
  'mgrTeam.ams.title': 'Your account managers',
  // @max 40
  // @ph name: the Operations Manager's first name
  'mgrTeam.ams.titleNamed': '{name}’s account managers',
  // @note Under the heading: tapping an account manager's card opens the Home filtered to their buildings.
  'mgrTeam.ams.hint': 'Today, by account manager. Tap one to see the Home for their buildings.',
  // @ph count: how many crews have not checked in at that account manager's buildings
  'mgrTeam.ams.notIn': { one: '{count} crew not checked in', other: '{count} crews not checked in' },
  // @ph count: how many client requests are open at their buildings
  'mgrTeam.ams.requests': { one: '{count} open request', other: '{count} open requests' },
  // @ph count: how many of those requests are past their deadline
  'mgrTeam.ams.overdue': { one: '{count} overdue', other: '{count} overdue' },
  // @ph count: how many people's hours are waiting for approval at their buildings
  'mgrTeam.ams.hours': { one: '{count} timesheet waiting', other: '{count} timesheets waiting' },
  // @ph count: how many supply orders at their buildings wait for approval
  'mgrTeam.ams.supplies': { one: '{count} supply order to approve', other: '{count} supply orders to approve' },
  'mgrTeam.ams.allClear': 'Nothing waiting',
  // @ph name: the account manager's name
  'mgrTeam.ams.open': 'Open the Home for {name}’s buildings',
  'mgrTeam.ams.none': 'No account managers report to you yet.',
  'mgrTeam.ams.noneHint': 'A Super Admin or Admin assigns them on your Team page.',
  // @max 40
  'mgrTeam.card.title': 'Account manager assignment',
  // @ph name: the Operations Manager's first name
  'mgrTeam.card.desc': 'The account managers who report to {name}. Their buildings are part of {name}’s team: the Home, hours approval and requests cover them.',
  'mgrTeam.card.readOnly': 'Only a Super Admin or an Admin who can edit account operations assigns account managers.',
  // @ph count: how many account managers report to no Operations Manager
  'mgrTeam.card.needsFlag': { one: '{count} account manager still needs an operations manager', other: '{count} account managers still need an operations manager' },
  'mgrTeam.card.allCovered': 'Every account manager reports to an operations manager',
  // @max 30
  'mgrTeam.card.pool': 'Account managers',
  'mgrTeam.card.searchPool': 'Search account managers',
  // @max 30
  'mgrTeam.card.needs': 'Needs an operations manager',
  // @max 20
  'mgrTeam.card.needsTag': 'Unassigned',
  // @max 30
  'mgrTeam.card.others': 'Already assigned',
  'mgrTeam.card.noMatches': 'No matches',
  'mgrTeam.card.noneNeed': 'Every account manager has an operations manager.',
  'mgrTeam.card.none': 'None',
  // @max 30
  // @ph name: the Operations Manager's first name
  'mgrTeam.card.mine': 'Reports to {name}',
  'mgrTeam.card.searchMine': 'Search assigned',
  // @max 20
  'mgrTeam.card.assigned': 'Assigned',
  // @ph name: the Operations Manager's first name
  'mgrTeam.card.emptyMine': 'No account managers report to {name} yet.',
  // @ph name: the Operations Manager's first name
  'mgrTeam.card.emptyMineEdit': 'No account managers report to {name} yet. Click one on the left to add them.',
  // @ph count: how many buildings that account manager looks after
  'mgrTeam.card.buildings': { one: '{count} building', other: '{count} buildings' },
  // @max 16
  'mgrTeam.card.assign': 'Assign',
  // @max 16
  'mgrTeam.card.remove': 'Remove',
  // @max 30
  'mgrTeam.line.title': 'Operations manager',
  // @max 24
  'mgrTeam.line.label': 'Reports to',
  // @max 30
  'mgrTeam.line.none': 'No operations manager',
  // @ph name: the Operations Manager this account manager reports to
  'mgrTeam.line.reportsTo': 'Reports to {name}',
  'mgrTeam.line.noneYet': 'Doesn’t report to an operations manager yet.',
  'mgrTeam.line.hint': 'Their buildings join that operations manager’s team: the Home, hours approval and requests.',
  // @max 24
  'mgrTeam.accounts.title': 'Accounts',
  // @ph count: how many accounts (customers) the team looks after
  'mgrTeam.accounts.subTeam': { one: '{count} account across your team', other: '{count} accounts across your team' },
  // @ph count: how many accounts (customers) the company has
  'mgrTeam.accounts.subAll': { one: '{count} account, by operations manager and account manager', other: '{count} accounts, by operations manager and account manager' },
  // @max 24
  'mgrTeam.accounts.filter.am': 'Account manager',
  // @max 24
  'mgrTeam.accounts.filter.om': 'Operations manager',
  // @max 30
  'mgrTeam.accounts.allAms': 'All account managers',
  // @max 30
  'mgrTeam.accounts.allOms': 'All operations managers',
  // @max 30
  // @note The filter choice for accounts nobody looks after yet.
  'mgrTeam.accounts.unassigned': 'Unassigned',
  // @max 30
  'mgrTeam.accounts.noOm': 'No operations manager',
  'mgrTeam.accounts.search': 'Search customers',
  // @max 20
  'mgrTeam.accounts.col.customer': 'Customer',
  // @max 24
  'mgrTeam.accounts.col.om': 'Operations manager',
  // @max 24
  'mgrTeam.accounts.col.am': 'Account manager',
  // @max 16
  'mgrTeam.accounts.col.buildings': 'Buildings',
  // @max 16
  'mgrTeam.accounts.col.status': 'Status',
  // @max 30
  'mgrTeam.accounts.change': 'Change account manager',
  // @max 30
  'mgrTeam.accounts.noAm': 'No account manager',
  'mgrTeam.accounts.empty': 'No accounts yet',
  'mgrTeam.accounts.emptyTeam': 'When your account managers are assigned buildings, their accounts show up here.',
  'mgrTeam.accounts.noMatch': 'No accounts match',
  'mgrTeam.accounts.noMatchHint': 'Try another search or filter.',
  'mgrTeam.accounts.readOnly': 'Only someone who can edit account operations changes an account manager.',
  // @ph customer: the account's name; name: the account manager it now belongs to
  'mgrTeam.accounts.moved': '{customer} now belongs to {name}',
  // @ph customer: the account's name
  'mgrTeam.accounts.unassignedNow': '{customer} has no account manager now',
  // @note What a list's rows are, after "Showing 1–20 of 34".
  'mgrTeam.accounts.noun': 'accounts',
  // @max 16
  // @note An account's status badge: not a customer yet.
  'mgrTeam.accounts.status.lead': 'Lead',
  // @max 16
  'mgrTeam.accounts.status.active': 'Active',
  // @max 16
  'mgrTeam.accounts.status.inactive': 'Inactive',

  // ── Manager view · today (Builder A, 2026-10-09): Shift check-in, the Schedule's Today view, Checklists today ──
  // @max 24
  // @icon
  // @note The office menu row for today's clock-ins, building by building: who arrived, who is late, who hasn't checked in.
  'nav.shiftCheckIn': 'Shift Check-in',
  // @max 20
  // @icon
  // @note The office menu row for today's checklists, visit by visit.
  'nav.checklistsToday': 'Checklists',
  // @note The line under a today screen's title. time: when the list on screen was read.
  'mgrToday.asOf': 'Today · as of {time, time}',
  // @max 16
  'mgrToday.manager': 'Manager',
  // @max 24
  'mgrToday.allManagers': 'All managers',
  // @ph name: the signed-in manager's own name, in the list of managers
  'mgrToday.me': '{name} (you)',
  // @max 24
  'mgrToday.noManager': 'No manager',
  // @ph count: how many visits (scheduled cleans) today
  'mgrToday.visitCount': { one: '{count} visit', other: '{count} visits' },
  // @ph count: how many buildings
  'mgrToday.propertyCount': { one: '{count} property', other: '{count} properties' },
  'mgrToday.loading': 'Loading today’s visits…',
  'mgrToday.loadFailed': 'Today’s visits didn’t load.',
  // @max 16
  'mgrToday.tryAgain': 'Try again',
  'mgrToday.offlineTitle': 'No connection',
  'mgrToday.offline': 'Today’s visits load when you’re back online.',
  // @ph time: when the list still on screen was read
  'mgrToday.offlineStale': 'No connection. Showing the visits as of {time, time}.',
  // @ph time: when the list still on screen was read
  'mgrToday.refreshFailed': 'The latest refresh didn’t load. Showing the visits as of {time, time}.',
  'mgrToday.noBuildings': 'No buildings in view',
  'mgrToday.noBuildingsHint': 'A building shows here once a manager is set on its customer.',
  'mgrToday.noVisits': 'No visits today',
  'mgrToday.noVisitsHint': 'Nothing is scheduled today in these buildings.',
  'mgrToday.groupEmpty': 'No visits here today.',
  // @max 16
  'mgrToday.status.done': 'Done',
  // @max 16
  'mgrToday.status.inProgress': 'In progress',
  // @max 16
  // @note Past the start time and nobody has clocked in yet, but not yet a missed shift.
  'mgrToday.status.late': 'Late',
  // @max 16
  // @note Nobody clocked in, and the missed-shift time has passed.
  'mgrToday.status.noCheckIn': 'No check-in',
  // @max 16
  'mgrToday.status.upcoming': 'Upcoming',
  // @max 16
  'mgrToday.status.calledOut': 'Called out',
  // @max 16
  'mgrToday.status.timeOff': 'Time off',
  // @ph name: the first cleaner on the visit, shortened, e.g. Carlos M.
  'mgrToday.andTeam': '{name} and team',
  'mgrToday.noCrew': 'No one scheduled',
  // @note The visit has no customer name on record.
  'mgrToday.noCustomer': 'Unnamed customer',
  // @max 16
  // @note A group heading: the visits that start before 3 PM.
  'mgrToday.group.day': 'Day',
  // @max 16
  // @note A group heading: the visits that start at 3 PM or later.
  'mgrToday.group.evening': 'Evening',
  // @note What a list's rows are, after "Showing 1–20 of 34".
  'pager.noun.visits': 'visits',
  // @max 24
  'shiftCheck.title': 'Shift Check-in',
  // @max 16
  'shiftCheck.tile.onSite': 'On site',
  // @max 16
  'shiftCheck.tile.late': 'Late',
  // @max 16
  'shiftCheck.tile.noCheckIn': 'No check-in',
  // @max 20
  'shiftCheck.col.property': 'Property',
  // @max 20
  'shiftCheck.col.crew': 'Crew',
  // @max 20
  'shiftCheck.col.status': 'Status',
  // @max 12
  'shiftCheck.col.call': 'Call',
  // @ph time: when the first cleaner clocked in
  'shiftCheck.status.onSite': 'On site · arrived {time, time}',
  // @ph count: minutes past the start time with nobody clocked in
  'shiftCheck.status.late': { one: 'Late · {count} min overdue', other: 'Late · {count} min overdue' },
  'shiftCheck.status.noCheckIn': 'Not checked in',
  // @ph time: when the first cleaner clocked in
  'shiftCheck.status.done': 'Done · arrived {time, time}',
  // @note The office marked the visit done; nobody clocked in on it.
  'shiftCheck.status.doneMarked': 'Done',
  // @ph time: the visit's start time
  'shiftCheck.status.upcoming': 'Starts {time, time}',
  // @ph name: the cleaner the button phones, shortened, e.g. Carlos M.
  'shiftCheck.call': 'Call {name}',
  // @ph name: the cleaner, shortened, e.g. Carlos M.
  'shiftCheck.noPhone': 'No phone on file for {name}',
  // @max 12
  // @note A view tab on the Schedule: today's visits and where each stands.
  'schedToday.tab': 'Today',
  'schedToday.title': 'Today’s Schedule',
  // ── Cleans loaded when a screen needs them (CS-676) ──────────────────────────────────────
  // The app holds the cleans from 45 days back to 100 days ahead; anything else loads when a
  // screen asks for it (a past week, a whole series, a customer's history).
  // @note Above the Schedule while the cleans for the days on screen load (a week or month outside the recent ones).
  'jobsLoad.range': 'Loading the cleans for these days…',
  // @note Above the Schedule (or a report) when the cleans for the days on screen could not be loaded. A Retry button follows.
  'jobsLoad.rangeFailed': 'Couldn’t load the cleans for these days. Check your connection.',
  // @note On a clean's page opened from a link, while that clean loads.
  'jobsLoad.job': 'Loading this clean…',
  // @note A customer's page, above their list of cleans, while the older ones load.
  'jobsLoad.history': 'Loading this customer’s earlier cleans…',
  // @note A customer's page when their earlier cleans could not be loaded. A Retry button follows.
  'jobsLoad.historyFailed': 'Couldn’t load this customer’s earlier cleans. The list shows the recent ones.',
  // @note Invoices: beside "Completed work to invoice" — which done cleans the list covers.
  // @ph days: how many days back the list reaches
  'invoiceList.uninvoicedSince': 'Done jobs from the last {days} days not yet on an invoice',
  // @note The "just this one, or all future?" prompt on a recurring clean, while the series' other visits load.
  'seriesScope.loading': 'This job is part of a recurring series. Its other visits are still loading. The “all future” option appears here as soon as they’re ready (usually a few seconds). You can change just this occurrence now.',
  // @note The same prompt when the series' other visits could not be loaded.
  'seriesScope.loadFailed': 'This job is part of a recurring series, but its other visits couldn’t be loaded, so series-wide changes aren’t available right now. You can change just this occurrence, or try again in a moment.',
  // @note Quality hub › Checklists, above the list when it holds only the newest submissions (CS-335).
  // @ph shown: how many the list shows; total: how many checklists there are in all
  'checklistList.capped': 'Showing the newest {shown, number} of {total, number} checklists. An older one opens from its clean’s page.',
  // @max 24
  'cklToday.title': 'Checklists',
  // @max 24
  'cklToday.all': 'All checklists',
  'cklToday.rule': 'A cleaner with a checklist can’t clock out until it’s complete. The office can turn this off for one cleaner in their profile.',
  // @ph count: how many cleaners on today's visits have the office's override on
  'cklToday.ruleOff': { one: '{count} cleaner on today’s visits has it turned off.', other: '{count} cleaners on today’s visits have it turned off.' },
  // @max 16
  'cklToday.tile.complete': 'Complete',
  // @max 16
  'cklToday.tile.inProgress': 'In progress',
  // @max 16
  'cklToday.tile.notStarted': 'Not started',
  // @max 16
  'cklToday.tile.notFinished': 'Not finished',
  // @ph count: how many day checklists there are today
  'cklToday.allDayComplete': { one: 'The day checklist is complete', other: 'All {count} day checklists complete' },
  // @ph done: items done on the saved checklist; total: items on it
  'cklToday.ofTotal': '{done} of {total}',
  // @max 16
  'cklToday.state.complete': 'Complete',
  // @max 16
  'cklToday.state.notFinished': 'Not finished',
  // @max 16
  'cklToday.state.inProgress': 'In progress',
  // @max 16
  'cklToday.state.notStarted': 'Not started',
  'cklToday.note.noCheckIn': 'Crew not checked in · the checklist can’t start',
  'cklToday.note.late': 'Crew is late · the checklist starts when they clock in',
  // @ph time: the visit's start time
  'cklToday.note.upcoming': 'Starts {time, time}',
  'cklToday.note.leftUnsaved': 'Clocked out with no checklist saved',
  // @ph count: minutes after the start time the crew clocked in
  'cklToday.note.arrivedLate': { one: 'Crew arrived {count} min late', other: 'Crew arrived {count} min late' },
  // @ph count: minutes after the start time the crew clocked in
  'cklToday.note.arrivedLateBlocked': { one: 'Crew arrived {count} min late · can’t clock out until it’s complete', other: 'Crew arrived {count} min late · can’t clock out until it’s complete' },
  // @max 24
  'cklToday.open': 'Open checklist',
  // @ph name: the cleaner who saved it, shortened, e.g. Carlos M.
  'cklToday.openFor': 'Open {name}’s checklist',
  'cklToday.openFailed': 'That checklist didn’t open.',
  'cklToday.noneOwed': 'No checklists on today’s visits',
  'cklToday.noneOwedHint': 'A checklist is assigned per cleaner on each customer, in Quality › Assignments.',
  // @ph count: how many of today's visits owe no checklist
  'cklToday.withoutChecklist': { one: '{count} visit today has no checklist.', other: '{count} visits today have no checklist.' },

  // ── A sign-in link the app couldn't email: the office sends it themselves (CS-661, GO-10; office) ──
  // @max 40
  // @note The title of a pop-up showing a one-time link to copy.
  'signInLink.title': 'Send the link yourself',
  // @ph name: the person the link is for (a team member or a customer contact)
  // @ph count: how many hours the link keeps working
  // @note The app has no mailbox to send from yet. The reader copies the link and sends it by text or any message.
  'signInLink.notEmailed': { one: 'Email isn’t set up yet. Copy this link and send it to {name} yourself; it works once and expires in {count} hour.', other: 'Email isn’t set up yet. Copy this link and send it to {name} yourself; it works once and expires in {count} hours.' },
  // @ph name: the person the link is for
  // @ph count: how many hours the link keeps working
  'signInLink.sendFailed': { one: 'The email to {name} didn’t go through. Copy this link and send it to them yourself; it works once and expires in {count} hour.', other: 'The email to {name} didn’t go through. Copy this link and send it to them yourself; it works once and expires in {count} hours.' },
  'signInLink.replaces': 'The link sent before has stopped working; only this one works now.',
  // @max 32
  'signInLink.label': 'Set-password link',
  // @max 20
  'signInLink.copy': 'Copy link',
  'signInLink.copied': 'Link copied.',
  'signInLink.copyFailed': 'Couldn’t copy. Select the link and copy it.',
  // @ph name: the team member whose login it is
  'signInLink.withheld': 'Email isn’t set up yet, so the link couldn’t be emailed to {name}, and it can’t be shown to you: their access includes permissions you don’t have. Ask a Super Admin.',
  // @ph name: the new team member
  'signInLink.noLink': 'The login was created, but its set-password link couldn’t be made. Open {name}’s page and use Send password-reset link.',
  // @max 32
  // @note A button on a team member's page.
  'signInLink.resetButton': 'Send password-reset link',
  // @max 32
  'signInLink.sending': 'Sending…',
  // @ph name: the team member's first name
  // @ph email: the team member's sign-in email address
  'signInLink.resetHint': 'Send {name} a secure link to set a new password. It’s emailed to {email}; if email isn’t set up yet, you get the link to send them yourself. A new link replaces any sent before.',
  // @ph email: the team member's sign-in email address
  'signInLink.resetEmailed': 'Reset link emailed to {email}.',
  // @ph name: the team member's first name
  'signInLink.noLogin': '{name} doesn’t have a login yet. Create one before sending a reset.',
  'signInLink.resetFailed': 'Couldn’t send the reset link.',
  // ── Customer logins: what an invite, a Remove and a Disable did (S128; office) ───────────────
  // @ph name: the customer contact
  'clientLogins.reinvite.title': 'Send {name} a new sign-in link?',
  'clientLogins.reinvite.message': 'The link sent before stops working as soon as the new one is made.',
  // @max 24
  'clientLogins.reinvite.confirm': 'Send new link',
  // @ph email: the customer contact's sign-in email address
  'clientLogins.inviteEmailed': 'Invite emailed to {email}.',
  'clientLogins.noLink': 'The login is ready, but its sign-in link couldn’t be made. Use Re-invite to try again.',
  'clientLogins.removed': 'Customer login removed.',
  // @ph name: the customer contact
  'clientLogins.removedKept': '{name} was removed. Their email address also belongs to another login, which was left alone.',
  'clientLogins.disabled': 'Access disabled.',
  'clientLogins.disabledKept': 'Access disabled. Their email address belongs to another login, which was left alone.',
  'clientLogins.banFailed': 'Access disabled, but their sign-in couldn’t be blocked. Try again.',
  'clientLogins.enabled': 'Access restored.',
  'clientLogins.unbanFailed': 'Access restored, but their sign-in couldn’t be unblocked. Try again.',
  'clientLogins.stale': 'Someone changed this since you opened it. It has been reloaded; make your change again.',
  // ── Team: a member who never signed in (CS-661; office) ────────────────────────────────────
  // @max 20
  // @note A status badge: their login exists but they have never signed in.
  'teamSignIns.never': 'Hasn’t signed in',
  // @max 20
  // @note A status badge: no login was ever made for them.
  'teamSignIns.noLogin': 'No login yet',
  // ── The Cleaner Hub: Client Requests (Builder C, 2026-10-13; the cleaner's phone app) ──────────
  // @note What the office asked a cleaner to take care of for a customer. The cleaner reads the
  // list, opens one, adds a photo of the finished work and marks it complete.
  // @max 24
  'crewRequests.title': 'Client Requests',
  // @max 24
  'crewRequests.detailTitle': 'Request Details',
  // @ph count: how many open requests are on the cleaner's list
  'crewRequests.count': { one: '{count} request assigned to you', other: '{count} requests assigned to you' },
  // @max 20
  // @note A badge on a request card.
  'crewRequests.assigned': 'Assigned to you',
  // @max 20
  // @note A badge on a request card that is past its deadline.
  'crewRequests.overdue': 'Overdue',
  // @max 20
  // @note A badge on a request the cleaner already completed.
  'crewRequests.completedChip': 'Completed',
  // @max 30
  // @note The heading over the requests completed in the last week.
  'crewRequests.doneHeading': 'Done this week',
  // @ph at: when the request came in
  'crewRequests.when.today': 'Today, {at, time}',
  // @ph at: when the request came in
  'crewRequests.when.yesterday': 'Yesterday, {at, time}',
  // @ph at: when the request came in
  'crewRequests.when.earlier': '{at, weekday}, {at, time}',
  // @note The building a request is for: the customer, then the location, as the office named them.
  // @ph customer: the customer (building) name
  // @ph site: the location's name
  'crewRequests.place': '{customer} · {site}',
  // @ph name: the account manager's first name and last initial, e.g. "Dana K."
  'crewRequests.from': 'From {name}, your account manager',
  // @max 26
  // @icon an arrow follows
  'crewRequests.view': 'View & complete',
  // @max 26
  // @icon an arrow follows
  'crewRequests.viewDone': 'View',
  'crewRequests.empty': 'New requests from your account manager will show up here.',
  'crewRequests.loadFailed': 'Couldn’t load your requests.',
  // @max 20
  'crewRequests.tryAgain': 'Try again',
  // @ph at: when this phone last read the list
  'crewRequests.offlineKept': 'No signal. Showing what this phone last saw at {at, time}.',
  'crewRequests.offlineNone': 'No signal. Your requests will show up when you’re back online.',
  'crewRequests.notFound': 'This request isn’t on your list anymore.',
  'crewRequests.notFoundHint': 'It may have been completed, or moved to someone else.',
  // @max 30
  'crewRequests.backToList': 'Back to Client Requests',
  // @max 30
  'crewRequests.complete.heading': 'Mark as complete',
  // @max 40
  'crewRequests.complete.addPhoto': 'Add photo of completed work',
  // @max 40
  'crewRequests.complete.addAnother': 'Add another photo',
  // @max 40
  'crewRequests.complete.photoRequired': 'Required before marking complete',
  // @note A text box. Only the office reads what is written in it, never the customer.
  'crewRequests.complete.notePlaceholder': 'Add a note for your account manager (optional)',
  'crewRequests.complete.noteHint': 'Only the office sees this note.',
  // @max 24
  'crewRequests.complete.button': 'Mark Complete',
  // @max 24
  'crewRequests.complete.working': 'Saving…',
  // @ph name: the account manager's first name and last initial, e.g. "Dana K."
  'crewRequests.complete.notify': '{name} will be notified as soon as this is marked complete.',
  'crewRequests.complete.notifyNoName': 'Your account manager will be notified as soon as this is marked complete.',
  'crewRequests.complete.needPhoto': 'Add a photo of the completed work first.',
  'crewRequests.complete.offline': 'No signal — you can complete this when you’re back online.',
  // @ph name: the person whose app the owner is viewing
  'crewRequests.complete.preview': 'Viewing as {name}. Completing is turned off.',
  'crewRequests.complete.noLocation': 'This request has no location yet, so no photo can be added. Ask the office to set it.',
  'crewRequests.complete.notYours': 'This building isn’t on your schedule, so this can’t be completed from your phone. Ask the office.',
  'crewRequests.complete.failed': 'Couldn’t mark this complete. Try again.',
  'crewRequests.complete.noteFailed': 'Your note didn’t send, so the request wasn’t marked complete. Try again.',
  // @max 30
  'crewRequests.complete.doneTitle': 'Marked complete',
  // @ph name: the account manager's first name and last initial, e.g. "Dana K."
  'crewRequests.complete.doneTold': '{name} has been told.',
  'crewRequests.complete.doneToldNoName': 'Your account manager has been told.',
  // @ph at: when it was completed
  'crewRequests.complete.doneAt': 'Completed {at, dateTime}',
  // The office's side: who is on a ticket (the work-order drawer). New lines on a screen not yet converted.
  'crewRequests.routing.none': 'No cleaners on this ticket yet.',
  'crewRequests.routing.hint': 'Each cleaner you add sees this ticket on their phone and is told about it.',
  // @max 40
  // @note Above a row of names to tap: each adds that cleaner to the ticket.
  'crewRequests.routing.building': 'Add from this building’s cleans',
  // @ph name: a cleaner
  'crewRequests.routing.addAria': 'Add {name} to this ticket',
  // @ph name: a cleaner
  'crewRequests.routing.removeAria': 'Take {name} off this ticket',
  // @max 40
  'crewRequests.routing.search': 'Add another cleaner…',
  'crewRequests.routing.searchPlaceholder': 'Search cleaners…',
  // @max 40
  // @note Beside a cleaner in the search: they are not on this building's cleans. They can still
  // complete the ticket once they are put on it.
  'crewRequests.routing.notOnBuilding': 'Doesn’t usually clean here',
  // @max 30
  'crewRequests.routing.left': 'No longer active',
  // @ph name: a cleaner
  'crewRequests.routing.added': 'Added {name}. They’ve been told.',
  // @ph name: a cleaner
  'crewRequests.routing.removed': 'Took {name} off this ticket.',
  'crewRequests.routing.failed': 'Couldn’t change the cleaners on this ticket.',
  'crewRequests.routing.officeOnly': 'Only the office can choose the cleaners on a ticket.',
  'crewRequests.routing.notCrew': 'Only active cleaners can be put on a ticket.',
  // @ph max: the most cleaners a ticket can hold
  'crewRequests.routing.tooMany': 'A ticket can hold at most {max} cleaners.',
  // ── The Cleaner Hub: My Hours (Builder C, 2026-10-13; view only) ─────────────────────────────
  // @max 24
  'myHours.title': 'My Hours',
  // @ph from: the first day of the pay period
  // @ph to: the last day of the pay period
  'myHours.period': 'Pay period {from, date} – {to, date}',
  // @max 30
  'myHours.summary.current': 'This period so far',
  // @max 30
  'myHours.summary.past': 'Total for the period',
  // @ph hours: hours, one decimal place
  'myHours.summary.hours': '{hours} hrs',
  // @ph count: days whose hours are all approved
  'myHours.summary.approvedDays': { one: '{count} day approved', other: '{count} days approved' },
  // @ph count: days whose hours are all approved
  'myHours.summary.approvedDaysToday': { one: '{count} day approved · today in progress', other: '{count} days approved · today in progress' },
  // @max 30
  'myHours.days.current': 'This period',
  // @max 30
  'myHours.days.past': 'Days worked',
  // @ph day: a day worked
  'myHours.day': '{day, dateLong}',
  // @ph day: today
  'myHours.dayToday': '{day, dateLong} · Today',
  // @ph hours: hours, one decimal place
  'myHours.dayHours': '{hours} hrs',
  // @ph at: when the cleaner clocked in today
  'myHours.clockedIn': 'Clocked in {at, time}',
  // @max 20
  'myHours.status.approved': 'Approved',
  // @max 20
  'myHours.status.pending': 'Pending approval',
  // @max 20
  'myHours.status.inProgress': 'In progress',
  'myHours.footer': 'Hours are reviewed and approved by your account manager.',
  // @max 22
  'myHours.previous': 'Previous period',
  // @max 22
  'myHours.next': 'Next period',
  'myHours.empty': 'No hours in this period.',
  'myHours.loadFailed': 'Couldn’t load your hours.',
  // @ph at: when this phone last read the hours
  'myHours.offlineKept': 'No signal. Showing what this phone last saw at {at, time}.',
  'myHours.offlineNone': 'No signal. Your hours will show up when you’re back online.',
  // @max 30
  // @note Home's My Hours tile.
  // @ph hours: hours so far this pay period, one decimal place
  'myHours.tile': '{hours} hrs this period',
  // ── The Cleaner Hub: the bells about a client request (Builder C, 2026-10-13) ────────────────
  // @max 70
  // @note To a cleaner: the office put a client's request on their list.
  // @ph customer: the customer (building) name
  // @ph title: the request's own title, as written
  'alerts.crewRequest.assigned': 'New request at {customer}: {title}',
  // @max 70
  // @ph title: the request's own title, as written
  'alerts.crewRequest.assignedNoPlace': 'New request: {title}',
  // @max 90
  // @note To the account manager: a cleaner marked a client's request complete.
  // @ph cleaner: the cleaner's name
  // @ph title: the request's own title, as written
  // @ph customer: the customer (building) name
  'alerts.crewRequest.completed': '{cleaner} completed {title} at {customer}',
  // @max 90
  // @ph cleaner: the cleaner's name
  // @ph title: the request's own title, as written
  'alerts.crewRequest.completedNoPlace': '{cleaner} completed {title}',
  // @note Stands in for a cleaner's name when the roster no longer has it.
  'alerts.crewRequest.aCleaner': 'A cleaner',
  'notifPrefs.crewRequestAssigned': 'A client request is put on my list',
  'notifPrefs.crewRequestAssigned.desc': 'When your account manager asks you to take care of a customer’s request, so you can open it from the alert.',
  'notifPrefs.crewRequestCompleted': 'A cleaner completes a client request',
  'notifPrefs.crewRequestCompleted.desc': 'When a cleaner marks a request complete with a photo. Goes to the person the ticket is assigned to, else the building’s manager, else the office.',

  // ── The Cleaner Hub: Request Supplies (Builder D, 2026-10-13; rebuilt to Matt's board by S131 Builder C: order by quantity, the last order, the history — no prices, no "Other") ──
  // @max 24
  'crewSupplies.title': 'Request Supplies',
  // @max 18
  // @note Names the row of buttons that switch between the buildings of today's stops.
  'crewSupplies.building': 'Building',
  'crewSupplies.off': 'Supply requests are turned off for you. Ask your account manager.',
  'crewSupplies.noStops': 'You have no stops today, so there’s no building to ask for. Open this from one of your stops.',
  'crewSupplies.noList': 'This building has no supply list yet. Message your account manager.',
  'crewSupplies.notYours': 'You can ask for supplies only for a building you clean.',
  'crewSupplies.loadFailed': 'The supply list couldn’t load.',
  'crewSupplies.offlineRead': 'No signal — the list loads when you’re back online.',
  'crewSupplies.offline': 'No signal — send this when you’re back online',
  // @max 16
  'crewSupplies.tryAgain': 'Try again',
  // @note The heading of the card with the cleaner's newest supply order at this building (the board shows it in capitals).
  // @ph no: the order's number, e.g. SO-1047
  'crewSupplies.last.title': 'Your last order · #{no}',
  // @note The same heading for an order with no number.
  'crewSupplies.last.titleNoNumber': 'Your last order',
  // @max 24
  // @note A link from the last-order card to that order's own page.
  'crewSupplies.last.open': 'View order',
  // @note A supply item and how many were ordered, e.g. "Paper towels (3)".
  // @ph item: the supply item's name; qty: how many were ordered
  'crewSupplies.itemQty': '{item} ({qty})',
  // @ph items: the items of an order, e.g. "Paper towels (3) and Trash liners (2)"
  'crewSupplies.itemList': '{items, list}',
  // @note One line of an order: everything ordered has come.
  // @ph item: a supply item and how many were ordered, e.g. "Paper towels (3)"
  'crewSupplies.line.delivered': '{item} delivered',
  // @note One line of an order: the supplier is out of it for now.
  // @ph item: a supply item and how many were ordered, e.g. "Trash liners (2)"; eta: the day the supplier expects to deliver it
  'crewSupplies.line.backordered': '{item} backordered — ETA {eta, date}',
  // @ph item: a supply item and how many were ordered, e.g. "Trash liners (2)"
  'crewSupplies.line.backorderedNoEta': '{item} backordered',
  // @note One line of an order: ordered from the supplier, not here yet.
  // @ph item: a supply item and how many were ordered, e.g. "Hand soap (2)"
  'crewSupplies.line.onOrder': '{item} on order',
  // @note One line of an order: the supplier could not provide it, so it is not coming.
  // @ph item: a supply item and how many were ordered, e.g. "Glass cleaner (1)"
  'crewSupplies.line.notAvailable': '{item} not available',
  // @note The same line with the office's reason — the words the cleaner's notification already carried.
  // @ph item: a supply item and how many were ordered, e.g. "Glass cleaner (1)"; reason: the office's reason, as they wrote it
  'crewSupplies.line.notAvailableReason': '{item} not available — {reason}',
  // @note Under a line part of which has come.
  // @ph delivered: how many have come; qty: how many were ordered
  'crewSupplies.line.partly': '{delivered} of {qty} delivered so far',
  // @max 28
  'crewSupplies.orderTitle': 'Order Supplies',
  'crewSupplies.orderHint': 'Only products approved for this property are shown',
  // @note A heading for items the office left without a category.
  'crewSupplies.noCategory': 'Other items',
  // @ph item: the supply item's name
  // @note A screen reader's name for the minus button beside a quantity.
  'crewSupplies.qtyLess': 'Fewer {item}',
  // @ph item: the supply item's name
  // @note A screen reader's name for the plus button beside a quantity.
  'crewSupplies.qtyMore': 'More {item}',
  // @note Under an item whose quantity is at the most a cleaner can order.
  // @ph max: the most of one item a cleaner can order, e.g. 20
  'crewSupplies.maxReached': '{max} is the most you can order of one item',
  'crewSupplies.notes': 'Notes (optional)',
  'crewSupplies.notesPlaceholder': 'Anything specific your account manager should know...',
  // @max 28
  'crewSupplies.submit': 'Submit for Approval',
  // @max 24
  'crewSupplies.sending': 'Sending…',
  // @note Under Submit for Approval while no item has a quantity.
  'crewSupplies.pickOne': 'Set a quantity on at least one item.',
  // @note Always under Submit for Approval (Matt's board).
  'crewSupplies.reviewNote': 'Your account manager reviews every request before it’s sent to the Supply Manager',
  // @ph name: the cleaner whose app the office is viewing
  'crewSupplies.previewOff': 'Sending is turned off while you view as {name}.',
  // @max 28
  'crewSupplies.sent.title': 'Order sent for approval',
  // @ph name: who approves, as first name and last initial
  'crewSupplies.sent.body': '{name} approves it next.',
  'crewSupplies.sent.bodyNoName': 'Your account manager approves it next.',
  // @max 28
  'crewSupplies.sent.more': 'Order something else',
  // @max 24
  'crewSupplies.sent.home': 'Back to Home',
  'crewSupplies.error.unknownItem': 'One of these items is no longer on this building’s list. Check the list and send again.',
  // @ph max: the most of one item a cleaner can order, e.g. 20
  'crewSupplies.error.overCap': 'You can order at most {max} of one item.',
  'crewSupplies.error.failed': 'The order didn’t send. Try again.',
  // @max 28
  'crewSupplies.history.title': 'Order History',
  // @note One row of the order history.
  // @ph no: the order's number, e.g. SO-1047; date: the day it was ordered
  'crewSupplies.history.row': '#{no} · {date, date}',
  // @ph date: the day it was ordered
  'crewSupplies.history.rowNoNumber': 'Order · {date, date}',

  // ── The Cleaner Hub: one supply order (S131 Builder C: the cleaner's own, opened from Request Supplies and from their supply bells; no prices) ──
  // @max 28
  // @ph no: the order's number, e.g. SO-1047
  'crewSupplyOrder.title': 'Order #{no}',
  // @max 28
  'crewSupplyOrder.titleNoNumber': 'Supply order',
  // @max 24
  'crewSupplyOrder.items': 'Items',
  // @max 24
  // @note The heading over who asked for the order and who approved or declined it.
  'crewSupplyOrder.approval': 'Approval',
  // @ph day: the day it came; time: when it came
  'crewSupplyOrder.deliveredOn': 'Delivered {day, weekday} at {time, time}',
  // @note Under a line part of which has come: when the last part came.
  // @ph day: the day the last part came; time: when the last part came
  'crewSupplyOrder.lastDeliveryOn': 'Last delivery {day, weekday} at {time, time}',
  // @ph name: who asked for it, as first name and last initial
  'crewSupplyOrder.requested': 'Requested by {name} · {day, weekday} at {time, time}',
  'crewSupplyOrder.requestedNoName': 'Requested {day, weekday} at {time, time}',
  // @ph name: who approved it, as first name and last initial
  'crewSupplyOrder.approved': 'Approved by {name} · {day, weekday} at {time, time}',
  'crewSupplyOrder.approvedNoName': 'Approved {day, weekday} at {time, time}',
  // @ph name: who declined it, as first name and last initial
  'crewSupplyOrder.declined': 'Declined by {name} · {day, weekday} at {time, time}',
  'crewSupplyOrder.declinedNoName': 'Declined {day, weekday} at {time, time}',
  // @ph reason: the account manager's reason, as they wrote it
  'crewSupplyOrder.declineReason': 'Reason: “{reason}”',
  'crewSupplyOrder.waiting': 'Waiting for your account manager to approve it',
  'crewSupplyOrder.notFound': 'This order isn’t one you can open.',
  // @max 32
  'crewSupplyOrder.backToSupplies': 'Back to Request Supplies',
  'crewSupplyOrder.loadFailed': 'This order couldn’t load.',
  'crewSupplyOrder.offline': 'No signal — open this order again when you’re back online.',

  // ── The Cleaner Hub: Scan Site QR Code (Builder D, 2026-10-13; the cleaner's camera) ──────────
  // @max 28
  'qrScan.title': 'Scan Site QR Code',
  'qrScan.hint': 'Point your camera at the QR code posted at this site',
  'qrScan.starting': 'Starting the camera…',
  'qrScan.noCamera': 'This phone’s camera can’t be used here.',
  'qrScan.noCameraHelp': 'Take a photo of the code instead, or open your stop from Today’s Stops.',
  'qrScan.denied': 'The camera is turned off for this app.',
  'qrScan.deniedHelp': 'Allow the camera for this app in your phone’s settings, then come back. Or take a photo of the code.',
  'qrScan.failed': 'The camera didn’t start.',
  'qrScan.failedHelp': 'Try again, or take a photo of the code.',
  // @max 16
  'qrScan.retry': 'Try again',
  // @max 28
  'qrScan.photo': 'Take a photo of the code',
  'qrScan.reading': 'Reading the photo…',
  'qrScan.photoNone': 'No code found in that photo. Hold the phone closer and try again.',
  'qrScan.checking': 'Checking the code…',
  'qrScan.notACode': 'That isn’t a site code.',
  'qrScan.inactive': 'This code is no longer active. Tell your account manager.',
  'qrScan.rateLimited': 'Too many scans in a row. Wait a minute and try again.',
  'qrScan.failedCheck': 'The code couldn’t be checked just now. Try again.',
  'qrScan.offline': 'No signal — scan again when you’re back online, or open your stop from Today’s Stops',
  // @max 20
  'qrScan.scanAgain': 'Scan again',
  // @max 20
  'qrScan.openStops': 'Today’s Stops',
  // @max 16
  'qrScan.lastScan': 'Last scan',
  // @ph time: when the code was scanned
  'qrScan.scannedAt': 'Scanned {time, time}',
  // @max 24
  'qrScan.openChecklist': 'Open Checklist',
  // @max 32
  // @note a scan that leads nowhere for this cleaner (no clean to fill in, or everyone is in): opens the page anyone who scans the code sees
  'qrScan.publicPage': 'Open this area’s public page',

  // ── QR Wave 2 (builder C, 2026-10-17): a cleaner's scan where they aren't on today's clean — filling
  // in for someone — and the cleaner's view of an area when they have no checklist there ────────────
  // @ph site: the building's name
  // @note under it, one button for each cleaner on today's clean there who hasn't clocked in
  'qrScan.fillIn.offer': 'You’re not on today’s schedule at {site}. Filling in for someone?',
  // @ph time: when that cleaner's clean starts today
  'qrScan.fillIn.cleanAt': 'Today’s {time, time} clean',
  // @ph name: the cleaner they would fill in for
  'qrScan.fillIn.buttonAria': 'Fill in for {name}',
  'qrScan.fillIn.working': 'Adding you to the clean…',
  'qrScan.fillIn.everyoneIn': 'Everyone on today’s schedule here is already clocked in. Ask your manager to add you to this clean.',
  // @ph site: the building's name
  'qrScan.fillIn.noClean': 'There’s no clean scheduled at {site} today.',
  // @ph site: the building's name
  'qrScan.fillIn.done': 'Today’s clean at {site} is already done.',
  // @ph site: the building's name
  // @note the only clean waiting here can't be changed from a phone (it holds the series' schedule)
  'qrScan.fillIn.askManager': 'Ask your manager to add you to today’s clean at {site}.',
  'qrScan.fillIn.changed': 'Today’s clean changed while you were choosing. Scan again to see who’s still needed.',
  'qrScan.fillIn.failed': 'You couldn’t be added to the clean just now. Try again.',
  // @ph name: the cleaner whose app is being viewed
  'qrScan.fillIn.preview': 'Viewing as {name}. Filling in is turned off.',
  // @note a person's name the phone doesn't have
  'qrScan.fillIn.someone': 'A cleaner',
  // @note the cleaner has no checklist at this building; below it, the building's last inspection and open tickets
  'qrScan.area.noChecklist': 'You don’t have a checklist here. Here’s how this building is doing.',
  // @max 28
  'qrScan.area.lastInspection': 'Last inspection',
  // @ph at: the day of the inspection
  'qrScan.area.inspectedOn': '{at, date}',
  'qrScan.area.noInspection': 'No inspection here yet.',
  // @max 18
  'qrScan.area.result.pass': 'Pass',
  // @max 18
  'qrScan.area.result.fail': 'Fail',
  // @max 18
  'qrScan.area.result.needsFollowUp': 'Needs follow-up',
  // @max 28
  'qrScan.area.openTickets': 'Open tickets',
  'qrScan.area.noTickets': 'No open tickets here.',
  // @max 18
  'qrScan.area.type.complaint': 'Complaint',
  // @max 18
  'qrScan.area.type.request': 'Request',
  // @max 18
  'qrScan.area.type.issue': 'Issue',
  // @max 18
  'qrScan.area.type.failedInspection': 'Failed inspection',
  // @ph area: the area of the building the ticket is about
  'qrScan.area.inArea': 'In {area}',
  // @ph ago: how long ago, already in the reader's language ("3 days ago")
  'qrScan.area.opened': 'Opened {ago}',
  // @ph shown: how many tickets are listed; total: how many are open
  'qrScan.area.shown': 'Showing the newest {shown} of {total, number}.',
  // ── The office's Scan (QR Wave 2, 2026-10-17; Matt's QR-17..QR-21): the office's own scanner
  // (/areas/scan — the manager's Home, the phone menu, the desktop sidebar) ─────────────────────
  // @max 28
  'officeScan.title': 'Scan a site QR code',
  // @max 28
  // @icon
  // @note the dashed button on the manager's Home; opens the camera
  'officeScan.button': 'Scan a site QR code',
  // @max 22
  // @icon
  // @note a row in the phone's menu and in the desktop sidebar's footer; opens the camera
  'officeScan.menu': 'Scan a QR code',
  'officeScan.intro': 'Opens the page for the area on the code: its last clean, open requests and who’s on site.',
  'officeScan.introSupply': 'Opens that building’s supply orders.',
  // @note the office's own scanner words; the sentences every scan page shares are the cleaner
  // scanner's qrScan.* lines (Starting the camera…, Take a photo of the code, Scan again, …)
  'officeScan.hint': 'Point the camera at the QR code posted in the area',
  'officeScan.noCamera': 'The camera can’t be used on this device.',
  'officeScan.noCameraHelp': 'Take a photo of the QR code instead.',
  'officeScan.denied': 'The camera is turned off for this app.',
  'officeScan.deniedHelp': 'Allow the camera for this app in the device’s settings, then come back. Or take a photo of the code.',
  'officeScan.photoNone': 'No code found in that photo. Hold the camera closer and try again.',
  'officeScan.inactive': 'This code is no longer active. It may have been replaced by a new label.',
  'officeScan.offline': 'No signal — scan again when you’re back online.',

  // ── The area page (QR Wave 2, UI_RULES §175; Matt's QR-17): one area of one location, as the
  // office sees it after a scan (/areas/:siteId/:areaId) ─────────────────────────────────────────
  // @max 16
  // @note the back button's word on a page opened from an area's page
  'areaPage.backLabel': 'Area',
  'areaPage.notFound': 'Area not found',
  'areaPage.notFoundHint': 'This area is no longer on its location. Its code may have been replaced.',
  // @ph customer: the customer's name
  // @ph location: the location's own name
  'areaPage.where': '{customer} · {location}',
  // @max 22
  'areaPage.startInspection': 'Start inspection',
  // @max 22
  'areaPage.newRequest': 'New request',
  'areaPage.lastClean.title': 'Last clean',
  // @ph at: when the area was last cleaned
  'areaPage.lastClean.when': '{at, dateTime}',
  // @ph time: how long ago the area was cleaned
  'areaPage.lastClean.ago': '{time, duration} ago',
  // @ph name: the cleaner's name
  'areaPage.lastClean.by': 'Cleaned by {name}',
  'areaPage.lastClean.byUnknown': 'Cleaned by someone no longer on the team list',
  // @ph name: the checklist's name, as the office wrote it
  'areaPage.lastClean.checklist': 'Checklist: {name}',
  'areaPage.lastClean.none': 'No clean recorded yet',
  'areaPage.lastClean.noneHint': 'The last clean shows here once a checklist covering this area is finished.',
  'areaPage.lastClean.loadFailed': 'The last clean couldn’t load.',
  // @max 28
  'areaPage.lastClean.openFull': 'Open the full checklist',
  'areaPage.lastClean.openFailed': 'That checklist couldn’t be opened just now. Try again.',
  // @max 12
  'areaPage.item.done': 'Done',
  // @max 12
  'areaPage.item.na': 'N/A',
  // @max 16
  'areaPage.item.notCompleted': 'Not completed',
  // @ph reason: the cleaner's reason, as they wrote it
  'areaPage.item.reason': 'Reason: “{reason}”',
  // @max 12
  'areaPage.item.notDone': 'Not done',
  // @ph area: the area's name
  'areaPage.photo.alt': 'The latest checklist photo of {area}',
  // @ph at: when the photo was taken
  'areaPage.photo.taken': 'Photo taken {at, dateTime}',
  // @ph area: the area's name
  // @note the pop-up that shows the photo large
  'areaPage.photo.title': 'Photo of {area}',
  // @ph area: the area's name
  'areaPage.photo.enlarge': 'Show the photo of {area} large',
  'areaPage.requests.title': 'Open requests here',
  'areaPage.requests.none': 'No open requests',
  'areaPage.requests.loadFailed': 'The requests couldn’t load.',
  // @ph title: the request's title, as written
  'areaPage.requests.openAria': 'Open the request “{title}”',
  'areaPage.onSite.title': 'On site now',
  'areaPage.onSite.none': 'Nobody is clocked in here',
  // @ph at: when they clocked in
  'areaPage.onSite.since': 'Since {at, time}',
  'areaPage.onSite.loadFailed': 'Who’s on site couldn’t load.',
  'areaPage.offline': 'No signal — this page reads again when you’re back online.',

  // ── The customer hub's Scan Site QR Code (Builder D, 2026-10-13). ENGLISH ONLY: everything a
  // customer reads stays English (LANG-8) — rendered with english(), never translated (i18n-lib
  // ENGLISH_ONLY_PREFIXES). ─────────────────────────────────────────────────────────────────────
  'hubScan.button': 'Scan site QR code',
  'hubScan.title': 'Scan Site QR Code',
  'hubScan.back': 'Back to Dashboard',
  'hubScan.hint': 'Point your camera at the QR code posted at your building',
  'hubScan.starting': 'Starting the camera…',
  'hubScan.noCamera': 'This device’s camera can’t be used here.',
  'hubScan.noCameraHelp': 'Take a photo of the code instead.',
  'hubScan.denied': 'The camera is turned off for this site.',
  'hubScan.deniedHelp': 'Allow the camera for this site in your browser’s settings, then come back. Or take a photo of the code.',
  'hubScan.failed': 'The camera didn’t start.',
  'hubScan.failedHelp': 'Try again, or take a photo of the code.',
  'hubScan.retry': 'Try again',
  'hubScan.photo': 'Take a photo of the code',
  'hubScan.reading': 'Reading the photo…',
  'hubScan.photoNone': 'No code found in that photo. Hold the device closer and try again.',
  'hubScan.checking': 'Checking the code…',
  'hubScan.notACode': 'That isn’t a site code.',
  'hubScan.inactive': 'This code is no longer active. Let your account manager know.',
  'hubScan.notYours': 'That code is for a building that isn’t one of yours.',
  'hubScan.rateLimited': 'Too many scans in a row. Wait a minute and try again.',
  'hubScan.failedCheck': 'The code couldn’t be checked just now. Try again.',
  'hubScan.offline': 'No connection — scan again when you’re back online.',
  'hubScan.scanAgain': 'Scan again',
  'hubScan.publicPage': 'See this area’s public page',

  // ── QR code links (QR Wave 1, 2026-10-16): each code's link, for the office's own label
  // software — Copy link and Download links on a building's QR codes panel, and the
  // all-buildings "QR code links" spreadsheet on the Customers list. ──────────────────────────
  // @max 16
  'qrLinks.copy': 'Copy link',
  // @ph area: the cleaning area's name, e.g. "Lobby"
  'qrLinks.copyAria': 'Copy the link for {area}',
  'qrLinks.copyAriaUnnamed': 'Copy this area’s link',
  'qrLinks.copied': 'Link copied',
  'qrLinks.copyFailed': 'The link couldn’t be copied. Open the code and copy its address instead.',
  // @max 20
  'qrLinks.download': 'Download links',
  'qrLinks.downloaded': 'Links downloaded',
  // @max 20
  // @note the Customers list's button: a spreadsheet (CSV) of every building's QR code links
  'qrLinks.button': 'QR code links',
  'qrLinks.buttonHint': 'A spreadsheet of every building’s QR code links, for your label software',
  // @max 20
  'qrLinks.preparing': 'Preparing the file…',
  // @ph count: how many buildings the file covers
  // @ph links: how many links (one per cleaning area) the file holds
  'qrLinks.done': {
    one: 'Downloaded the QR code links for {count} building · {links, number} in all.',
    other: 'Downloaded the QR code links for {count} buildings · {links, number} in all.',
  },
  'qrLinks.none': 'No QR codes yet.',
  // @ph count: how many buildings have no cleaning areas entered yet
  'qrLinks.withoutAreas': {
    one: '{count} building has no areas yet: add its areas on the customer’s page.',
    other: '{count} buildings have no areas yet: add their areas on the customer’s page.',
  },
  'qrLinks.failed': 'The QR code links couldn’t be prepared. Try again.',
  // ── The QR codes page (Matt, 2026-10-30: "How do I create them? I'm not able to find that";
  // UI_RULES §183): every building, its cleaning areas, and its codes a click away. ─────────────
  // @max 32
  'qrPage.title': 'QR codes',
  'qrPage.sub': 'Every building’s QR codes, one for each cleaning area.',
  'qrPage.how': 'A building’s codes come from its cleaning areas: add the lobby, each restroom or a floor, and each area gets its own code to print as a label. Open a building to add its areas or print its labels.',
  // @max 20
  'qrPage.filter.show': 'Show',
  // @max 24
  'qrPage.show.all': 'All buildings',
  // @max 24
  'qrPage.show.noAreas': 'No areas yet',
  // @max 24
  'qrPage.show.withAreas': 'With codes',
  // @max 24
  'qrPage.search': 'Search',
  // @ph count: how many buildings have no cleaning areas yet, so no QR codes
  'qrPage.withoutAreas': {
    one: '{count} building has no areas yet, so no codes.',
    other: '{count} buildings have no areas yet, so no codes.',
  },
  'qrPage.empty': 'No buildings yet',
  'qrPage.emptyHint': 'Add a customer and its locations, and each location’s codes show here.',
  'qrPage.noMatch': 'No buildings match',
  'qrPage.noMatchHint': 'Try another search or show all buildings.',
  // @max 20
  'qrPage.col.customer': 'Customer',
  // @max 20
  'qrPage.col.location': 'Location',
  // @max 20
  'qrPage.col.areas': 'Areas',
  // @max 20
  'qrPage.col.codes': 'QR codes',
  'qrPage.unnamedLocation': 'Unnamed location',
  // @ph count: how many cleaning areas the location has (one QR code each)
  'qrPage.areaCount': { one: '{count} area', other: '{count} areas' },
  // @max 16
  'qrPage.noAreas': 'No areas yet',
  // @max 16
  // @note Opens one building's QR codes (its labels to print).
  'qrPage.openCodes': 'Open codes',
  // @max 16
  // @note Opens one building's cleaning areas to add them; each area then gets a QR code.
  'qrPage.addAreas': 'Add areas',
  // @note The word the page counter uses, as in "1–20 of 45 buildings".
  'qrPage.noun': 'buildings',
  // @ph customer: the customer's name
  // @ph location: the building's name
  'qrPage.modalTitle': '{customer} · {location}',
  // @ph location: the building's name
  // @note Read aloud for a row's Open codes button.
  'qrPage.openCodesFor': 'Open codes for {location}',
  // @ph location: the building's name
  // @note Read aloud for a row's Add areas button.
  'qrPage.addAreasFor': 'Add areas for {location}',
  // @note Asked when the pop-up is closed while cleaning areas added or changed in it aren't saved yet.
  'qrPage.discardTitle': 'Discard these changes?',
  'qrPage.discardMessage': 'The cleaning areas you added or changed here aren’t saved yet. To keep them, keep editing and click Save Changes.',
  // @max 20
  // @note Goes back to the open pop-up without closing it.
  'qrPage.keepEditing': 'Keep editing',
  // ── A deal's walkthrough (the pipeline: the deal editor, the prompt after a move, the card) ──
  // @max 24
  // @note a section heading in a sales deal's editor: the visit to walk a prospect's building before a quote
  'walkthrough.heading': 'Walkthrough',
  // @max 16
  'walkthrough.date': 'Date',
  // @max 16
  'walkthrough.time': 'Time',
  // @max 24
  'walkthrough.where': 'Where to meet',
  // @note the example inside the "Where to meet" field; it completes the email's "We will meet you at …"
  'walkthrough.wherePlaceholder': 'e.g. Main lobby, Suite 400',
  // @note shown in the deal editor when the deal is in the walkthrough stage with no date yet
  'walkthrough.ask': 'When is the walkthrough? Add the date and time.',
  'walkthrough.error.date': 'Add the date.',
  'walkthrough.error.time': 'Add a time, like 10:00 AM.',
  // @ph name: the person the deal runs through (the prospect's contact)
  'walkthrough.notice.sends': 'Saving a date emails {name} a confirmation, and an update if it changes.',
  'walkthrough.notice.off': 'The walkthrough confirmation email is turned off in Settings, Customer Reminders.',
  // @ph name: the person the deal runs through (the prospect's contact)
  'walkthrough.notice.noEmail': '{name} has no email address, so no confirmation goes.',
  'walkthrough.notice.noContact': 'Pick a primary contact so a confirmation can go.',
  // @note the title of the question that opens after a deal is moved into the walkthrough stage
  'walkthrough.prompt.title': 'When is the walkthrough?',
  // @ph company: the prospect company the deal is with
  // @ph stage: the pipeline stage's name, as the office wrote it (e.g. Walkthrough Scheduled)
  'walkthrough.prompt.lead': '{company} is now in {stage}.',
  // @max 16
  'walkthrough.prompt.notNow': 'Not now',
  // @max 20
  'walkthrough.prompt.save': 'Save walkthrough',
  'walkthrough.saved': 'Walkthrough saved',
  // @max 34
  // @ph at: the walkthrough's date and time
  'walkthrough.card.when': 'Walkthrough {at, weekday} · {at, time}',
  // @max 34
  'walkthrough.card.notSet': 'Walkthrough time not set',

  // ── New-customer onboarding (task 471, UI_RULES §190; components/OnboardingBar.jsx, Add customer) ──
  // @max 16
  // @note The status badge of a new customer whose onboarding isn't finished: its page, the Customers list and its Status filter.
  'onboarding.badge': 'Onboarding',
  // @max 30
  'onboarding.title': 'Onboarding',
  // @max 30
  'onboarding.finishedTitle': 'Onboarding finished',
  // @max 20
  // @ph done: the steps done; total: how many steps there are
  'onboarding.count': '{done} of {total} done',
  // @ph customer: the customer's name
  'onboarding.finished': '{customer} has finished onboarding',
  // @max 12
  // @note A short name for each part of the onboarding bar, under its coloured fill (three to a row on a phone).
  'onboarding.seg.company': 'Company',
  // @max 12
  'onboarding.seg.contact': 'Contact',
  // @max 12
  'onboarding.seg.schedule': 'Schedule',
  // @max 12
  'onboarding.seg.cleaners': 'Cleaners',
  // @max 12
  'onboarding.seg.supplies': 'Supplies',
  // @max 12
  'onboarding.seg.documents': 'Documents',
  // @max 12
  'onboarding.seg.special': 'Special',
  // @max 30
  // @note Each step's full name, over the open step.
  'onboarding.step.company': 'Company',
  // @max 30
  'onboarding.step.contact': 'Primary contact',
  // @max 30
  'onboarding.step.schedule': 'Cleaning schedule',
  // @max 30
  'onboarding.step.cleaners': 'Assigned cleaners',
  // @max 30
  'onboarding.step.supplies': 'Supplies',
  // @max 30
  'onboarding.step.documents': 'Documents & contracts',
  // @max 30
  'onboarding.step.special': 'Special services',
  // @max 16
  'onboarding.state.done': 'Done',
  // @max 16
  'onboarding.state.skipped': 'Skipped',
  // @max 16
  'onboarding.state.todo': 'To do',
  // @max 16
  'onboarding.state.unknown': 'Checking…',
  // @max 16
  'onboarding.state.noAccess': 'Can’t check',
  // @note The fields named in "Still needed: …" (lowercase, in a list).
  'onboarding.field.name': 'company name',
  'onboarding.field.customerNumber': 'customer number',
  'onboarding.field.street': 'street address',
  'onboarding.field.city': 'city',
  'onboarding.field.state': 'state',
  'onboarding.field.zip': 'ZIP',
  'onboarding.field.firstName': 'first name',
  'onboarding.field.lastName': 'last name',
  'onboarding.field.title': 'title',
  'onboarding.field.email': 'email',
  'onboarding.field.phone': 'phone',
  // @ph fields: the missing fields, as a list
  'onboarding.needs': 'Still needed: {fields, list}.',
  // @ph name: the primary contact's name; fields: the missing fields, as a list
  'onboarding.needsFor': 'Still needed for {name}: {fields, list}.',
  'onboarding.checking': 'Checking…',
  'onboarding.checkFailed': 'This step couldn’t be checked.',
  'onboarding.company.done': 'Company name, customer number and address are in.',
  'onboarding.contact.none': 'Add the primary contact: first name, last name, title, email and phone.',
  // @ph name: the primary contact's name; title: their title
  'onboarding.contact.done': '{name}, {title}.',
  // @ph count: the customer's upcoming cleans
  'onboarding.schedule.done': { one: '{count} upcoming clean on the schedule.', other: '{count} upcoming cleans on the schedule.' },
  'onboarding.schedule.todo': 'Add this building’s cleans: the days, times and crew.',
  // @ph count: the cleaners assigned; names: up to three of their names, as a list
  'onboarding.cleaners.done': { one: '{count} cleaner: {names, list}.', other: '{count} cleaners: {names, list}.' },
  // @ph count: how many more cleaners than the three named
  'onboarding.cleaners.more': { one: '{count} more', other: '{count} more' },
  'onboarding.cleaners.todo': 'Choose the cleaners who work here, or add a new one.',
  'onboarding.cleaners.noTeam': 'Choosing cleaners takes access to edit the team.',
  // @ph count: the items switched on for the building
  'onboarding.supplies.done': { one: '{count} item on its supply list.', other: '{count} items on its supply list.' },
  'onboarding.supplies.todo': 'Switch on the items this building gets from the supply list.',
  'onboarding.supplies.noAccess': 'Only someone who can see supplies can check this step.',
  'onboarding.documents.done': 'Signed contract on file.',
  'onboarding.documents.todo': 'Add this building’s contract and upload its signed copy.',
  'onboarding.documents.noAccess': 'Only someone who can see contracts can check this step.',
  'onboarding.special.todo': 'Add this building’s recurring special services, like carpet cleaning or strip and wax, or mark that it has none.',
  // @ph count: the building's special services; names: up to three of them, as a list
  'onboarding.special.done': { one: '{count} special service: {names, list}.', other: '{count} special services: {names, list}.' },
  // @ph count: how many more services than the three named
  'onboarding.special.more': { one: '{count} more', other: '{count} more' },
  'onboarding.special.none': 'No special services at this building.',
  // @ph name: who skipped it; date: when; note: their note
  'onboarding.skippedBy': 'Skipped by {name} on {date}: {note}',
  // @ph date: when; note: the note
  'onboarding.skippedOn': 'Skipped on {date}: {note}',
  // @max 24
  'onboarding.action.company': 'Edit details',
  // @max 24
  'onboarding.action.contactAdd': 'Add contact',
  // @max 24
  'onboarding.action.contactEdit': 'Edit contact',
  // @max 24
  'onboarding.action.schedule': 'Add a clean',
  // @max 24
  'onboarding.action.cleaners': 'Choose cleaners',
  // @max 24
  'onboarding.action.supplies': 'Set up the supply list',
  // @max 24
  'onboarding.action.documents': 'Open the contract',
  // @max 24
  'onboarding.action.special': 'Add a special service',
  // @max 24
  'onboarding.action.specialNone': 'None at this building',
  // @max 24
  'onboarding.skip': 'Skip with a note',
  // @max 24
  'onboarding.unskip': 'Undo skip',
  // @ph step: the step's name
  'onboarding.skipTitle': 'Skip {step}?',
  'onboarding.skipLead': 'It stays amber on the onboarding bar, with your note, until it’s filled in. The customer reads Onboarding until then.',
  // @max 30
  'onboarding.skipNote': 'Why is it skipped?',
  'onboarding.skipPlaceholder': 'e.g. The customer hasn’t chosen their schedule yet.',
  // @max 16
  'onboarding.skipConfirm': 'Skip step',
  // @ph step: the step's name
  'onboarding.skippedToast': '{step} skipped',
  // @ph step: the step's name
  'onboarding.unskipped': '{step} is open again',
  'onboarding.cleaners.lead': 'Pick the cleaners who work at this building. It’s the Works at on their Team page: it puts no one on a clean, and what each cleaner sees still comes from their cleans.',
  // @max 24
  'onboarding.cleaners.pick': 'Cleaners',
  // @max 24
  'onboarding.cleaners.addNew': 'Add a new team member',
  // @max 16
  'onboarding.cleaners.save': 'Save Changes',
  'onboarding.cleaners.saved': 'Cleaners saved',
  // @ph fields: the missing fields, as a list
  'onboarding.add.missing': 'Fill in the {fields, list} to add the customer.',
  'onboarding.add.contactHelp': 'Their first name, last name, title, email and phone finish the onboarding’s contact step. You can add them later.',
  'onboarding.add.next': 'Once it’s added, the customer’s page shows its onboarding: the cleaning schedule, cleaners, supplies, documents and contracts, and special services.',

  // ── A building's special services (task #507, UI_RULES §192; components/SpecialServicesCard.jsx, SpecialServiceModal.jsx) ──
  // @max 30
  'specialSvc.title': 'Special services',
  // @max 16
  'specialSvc.addButton': 'Add service',
  // @ph days: how many days ahead the reminder goes (14)
  'specialSvc.lead': 'Recurring work outside the cleaning schedule. The account manager and their operations manager are reminded {days} days before each date.',
  'specialSvc.empty': 'No special services entered yet.',
  'specialSvc.none': 'No special services at this building.',
  // @max 24
  'specialSvc.noneButton': 'None at this building',
  // @max 16
  'specialSvc.noneUndo': 'Undo',
  'specialSvc.noneSet': 'Marked as no special services',
  'specialSvc.noneCleared': 'Special services are open again',
  // @ph date: the next scheduled date, with its year
  'specialSvc.next': 'Next {date}',
  // @ph date: the day it was last marked done, with its year
  'specialSvc.lastDone': 'Last done {date}',
  // @ph date: the day it was last marked done, with its year; name: who marked it
  'specialSvc.lastDoneBy': 'Last done {date} by {name}',
  // @max 16
  'specialSvc.due.overdue': 'Overdue',
  // @max 16
  'specialSvc.due.soon': 'Due soon',
  // @max 16
  'specialSvc.due.later': 'Scheduled',
  // @max 16
  'specialSvc.markDone': 'Mark done',
  // @max 16
  'specialSvc.edit': 'Edit',
  // @max 24
  // @note How often a special service is done: the choices in its Frequency menu, and how it reads on the card.
  'specialSvc.freq.monthly': 'Monthly',
  // @max 24
  'specialSvc.freq.bimonthly': 'Every 2 months',
  // @max 24
  'specialSvc.freq.quarterly': 'Quarterly',
  // @max 24
  'specialSvc.freq.semiannual': 'Semi-annually',
  // @max 24
  'specialSvc.freq.annual': 'Annually',
  // @max 24
  'specialSvc.freq.biennial': 'Every 2 years',
  // @max 24
  // @note The menu's last choice: a number of months typed in a box beside it.
  'specialSvc.freq.custom': 'Every … months',
  // @max 24
  // @ph count: the number of months
  'specialSvc.freq.every': { one: 'Every month', other: 'Every {count} months' },
  // @max 30
  'specialSvc.addTitle': 'Add a special service',
  // @max 30
  'specialSvc.editTitle': 'Edit special service',
  'specialSvc.modalLead': 'Recurring work at this building that isn’t on its cleaning schedule. Its account manager and their operations manager are reminded before each date.',
  // @max 30
  'specialSvc.field.type': 'Type of service',
  'specialSvc.field.typePlaceholder': 'e.g. Carpet cleaning',
  // @max 30
  'specialSvc.field.frequency': 'Frequency',
  // @max 30
  'specialSvc.field.months': 'Every how many months?',
  // @max 30
  'specialSvc.field.nextDate': 'Next scheduled date',
  'specialSvc.err.type': 'Enter the type of service.',
  'specialSvc.err.frequency': 'Choose how often it’s done.',
  'specialSvc.err.months': 'Enter a number of months from 1 to 36.',
  'specialSvc.err.date': 'Choose the next scheduled date.',
  // @max 16
  'specialSvc.add': 'Add service',
  // @max 16
  'specialSvc.save': 'Save Changes',
  // @ph service: the service's name
  'specialSvc.added': '{service} added',
  // @ph service: the service's name
  'specialSvc.saved': '{service} saved',
  // @max 16
  'specialSvc.remove': 'Remove',
  // @ph service: the service's name
  'specialSvc.removeTitle': 'Remove {service}?',
  'specialSvc.removeLead': 'It comes off this building’s special services, and no more reminders go out for it.',
  // @max 16
  'specialSvc.removeConfirm': 'Remove',
  // @ph service: the service's name
  'specialSvc.removed': '{service} removed',
  // @ph service: the service's name
  'specialSvc.doneTitle': 'Mark {service} done?',
  // @ph date: the date it moves to, with its year
  'specialSvc.doneLead': 'Its next date moves to {date}.',
  // @ph service: the service's name; date: its next date, with its year
  'specialSvc.doneToast': '{service} done. Next: {date}',
  // @note Matt's two examples, offered as suggestions in the Type of service box.
  'specialSvc.example.carpet': 'Carpet cleaning',
  'specialSvc.example.stripWax': 'Strip and wax',
};
