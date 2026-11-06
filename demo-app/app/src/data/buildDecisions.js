// Build decisions — Matt's 199 build-decision questions across 15 sections (127 answered
// 2026-09-29; the 26 follow-ups added that day come from docs/plans/2026-09-29-phase-2-plan.md §5;
// HUB-19, cleaner photos in the Client Hub, added 2026-10-03; HR-1..HR-5, employee warnings,
// and SUP-11..SUP-13, who approves / shared lists / how far back, added 2026-10-04; HUB-20..HUB-23,
// the redesigned Client Hub's open points, added 2026-10-08; WO-19 and SUP-14, the manager
// view redesign's two open points, added 2026-10-09; HUB-24, WO-20, WO-21 and SUP-15..SUP-17,
// the follow-ups to Matt's Account Manager Hub email, the same day; QR-7..QR-28 (20: QR-11 and
// QR-29 held, QR-22 decided by Daniel) and QR-30/QR-31 (rating an area, a line about the company),
// one printed code with a view for each person, added
// 2026-10-16 — docs/plans/2026-10-16-qr-codes-by-role.md §5; MISC-7 and MISC-8, the app's Quotes
// page beside PandaDoc and where replies to the app's email go, added 2026-10-17; DES-1, the menu down
// the left side, the first DESIGN question, written 2026-10-23 in its own `design` section: a question
// with `mockup` draws that mockup above its answers, UI_RULES §179. DES-1 is filed under the 2026-10-20
// update ON PURPOSE (Daniel, 2026-10-23, "Keep all 14 on New"): "New" shows only the latest update, and
// Matt had not yet answered the 13 emails updated that day, so a 2026-10-23 date would have taken them
// off his New list), the
// living questionnaire behind the Review section (see brain/modules/client-review.md and
// UI_RULES §130). Ported faithfully from the September build-decisions questionnaire.
//
// This is a LIVING document: we add questions over time, in code (there is no in-app
// "add question" UI). To add questions:
//   • APPEND them (to the right section's `questions`, or a new section) with
//     `added: '<YYYY-MM-DD>'` = the date of that update. "New" keys off the LATEST
//     `added` date across the catalogs, so a new batch surfaces as New for everyone.
//   • NEVER reuse or renumber an id — answers in state.clientReview.decisions are keyed
//     by question id, so a renumber silently strands an existing answer.
//   • NEVER change an existing option's id — a choice is stored as the option id, so
//     changing it orphans every answer that picked it. (Relabel freely; keep the id.)
//   • Keep `app/src/data/buildDecisionIds.js` (BUILD_DECISION_INDEX) in LOCKSTEP — same
//     ids, order and `added`. It is the heavy-import-free index the sidebar + provider
//     count from, so the full question text stays out of the common chunk (the same
//     reason emailDraftIds.js exists). test-build-decisions.mjs fails on any drift.
//   • Append the new question to the FROZEN manifest `app/src/data/reviewManifest.json`
//     too (its id → type + option ids), in the SAME change. It is the anti-orphan freeze
//     (CS-402, §130): test-review-additive.mjs fails if the catalog drops a manifest id,
//     changes a published question's type or option ids, loses an option, or ADDS an id
//     the manifest doesn't list — so a renumber or option-id change can't silently strand
//     an answer. Never edit an existing manifest entry to match a renumber; that defeats
//     the freeze. Answers in state.clientReview.decisions are keyed by these ids.
//
// Question shape: { id, added, key?, needs?, q, why?, type: 'single'|'multi'|'text',
//                   noteHint?, mockup?, options?: [{ id, label, detail?, rec?, needsNote? }] }
//   mockup: a review-mockups/index.js id. Each answer whose id is one of its views shows that view;
//           it keeps a "keep today's" answer and a needs-a-note "another way" answer (§179,
//           test-review-mockups.mjs).
// Section shape:  { id, title, blurb, settled: string[], questions: [...] }
//
// Generated once from the questionnaire by a scratchpad conversion script; hand-edited
// thereafter by appending, per the rules above.

export const DECISION_SECTIONS = [
  {
    "id": "hub",
    "title": "Client Hub",
    "blurb": "What your clients see and do when they log in.",
    "settled": [
      "Clients see who’s on site now, their checklist history and their inspection history.",
      "The QR codes, and a hub to submit work orders and reach you, live there too."
    ],
    "questions": [
      {
        "id": "HUB-1",
        "added": "2026-09-25",
        "q": "Who gets a login on the client side?",
        "why": "This decides how client accounts are set up and removed.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Each client contact gets their own login",
            "detail": "You can see who did what, and remove one person without affecting the rest.",
            "rec": true
          },
          {
            "id": "b",
            "label": "One shared login per account",
            "detail": "Simpler to hand out, but you can’t tell who did what."
          }
        ]
      },
      {
        "id": "HUB-2",
        "added": "2026-09-25",
        "key": true,
        "q": "Management companies with several of your buildings (Graystar, for example): how should their logins work?",
        "why": "In the app today each building is its own account, and nothing links buildings that share a management company.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One login covers all of that company’s buildings",
            "detail": "Their property managers see every building they oversee in one place. We add a “management company” link between accounts.",
            "rec": true
          },
          {
            "id": "b",
            "label": "A separate login for each building",
            "detail": "Simplest to set up; a manager with five buildings has five logins."
          }
        ]
      },
      {
        "id": "HUB-3",
        "added": "2026-09-25",
        "q": "Inside a management company, should every user see all of its buildings?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — everyone at that company sees all their buildings",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — we assign buildings to each person",
            "detail": "For example, a regional manager sees only their region."
          }
        ]
      },
      {
        "id": "HUB-4",
        "added": "2026-09-25",
        "q": "Who adds and removes client users?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Your office",
            "detail": "Full control, and the simplest way to start.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Each client’s main contact can add and remove their own colleagues"
          }
        ]
      },
      {
        "id": "HUB-5",
        "added": "2026-09-25",
        "q": "On “who’s on site now,” what should clients see?",
        "why": "Exact locations are never shown to clients.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Just a count",
            "detail": "“2 cleaners on site since 6:02 pm”"
          },
          {
            "id": "b",
            "label": "First name and last initial, time on site, and a location check",
            "detail": "“Maria R. · on site since 6:02 pm · location confirmed”",
            "rec": true
          },
          {
            "id": "c",
            "label": "Everything in b, plus each cleaner’s photo"
          }
        ]
      },
      {
        "id": "HUB-6",
        "added": "2026-09-25",
        "key": true,
        "q": "How much of each inspection should clients see?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Score and pass/fail only"
          },
          {
            "id": "b",
            "label": "Score, pass/fail and photos — the inspector’s comments stay internal",
            "rec": true
          },
          {
            "id": "c",
            "label": "The full report, including the inspector’s comment on each item"
          }
        ]
      },
      {
        "id": "HUB-7",
        "added": "2026-09-25",
        "q": "When an inspection fails, when should the client see it?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Right away, with what you’re doing to fix it",
            "detail": "Shows the oversight you promise your clients.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only once it’s been corrected"
          },
          {
            "id": "c",
            "label": "Never — clients see passed inspections only"
          }
        ]
      },
      {
        "id": "HUB-8",
        "added": "2026-09-25",
        "q": "How much of each checklist should clients see?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Done or not done, and the percentage completed"
          },
          {
            "id": "b",
            "label": "Every item, checked or not, with the cleaner’s notes",
            "rec": true
          },
          {
            "id": "c",
            "label": "Every item, the notes, and photos"
          }
        ]
      },
      {
        "id": "HUB-9",
        "added": "2026-09-25",
        "q": "How far back should clients see their history?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "90 days"
          },
          {
            "id": "b",
            "label": "1 year",
            "rec": true
          },
          {
            "id": "c",
            "label": "Everything since go-live"
          }
        ]
      },
      {
        "id": "HUB-10",
        "added": "2026-09-25",
        "q": "Can clients download an inspection report as a PDF?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "HUB-11",
        "added": "2026-09-25",
        "q": "Which updates should clients get by email?",
        "why": "Everything also shows in the hub. Text messages to clients can come later, once texting is registered with the phone carriers.",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "A ticket they sent changes status or gets a reply",
            "rec": true
          },
          {
            "id": "b",
            "label": "A new inspection is posted",
            "rec": true
          },
          {
            "id": "c",
            "label": "A clean is finished (checklist completed)"
          },
          {
            "id": "d",
            "label": "Cleaners arrive or leave"
          }
        ]
      },
      {
        "id": "HUB-12",
        "added": "2026-09-25",
        "q": "Your September 1 answers mention clients calling or texting you from the app. Who should those buttons reach?",
        "type": "single",
        "noteHint": "Which phone number(s) should we use?",
        "options": [
          {
            "id": "a",
            "label": "Your office’s main number",
            "rec": true
          },
          {
            "id": "b",
            "label": "The account’s supervisor directly"
          },
          {
            "id": "c",
            "label": "No call or text buttons — tickets and messages only"
          }
        ]
      },
      {
        "id": "HUB-13",
        "added": "2026-09-25",
        "q": "Is every message a client sends a trackable ticket?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — every message opens a ticket with its own conversation",
            "detail": "Nothing gets lost. A “question” ticket type covers general messages.",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — a general chat, plus a separate “submit a request” button"
          }
        ]
      },
      {
        "id": "HUB-14",
        "added": "2026-09-25",
        "q": "Rollout: hub logins for every account at go-live, or a handful first?",
        "type": "single",
        "noteHint": "Which accounts would you pilot, and who sends the invites?",
        "options": [
          {
            "id": "a",
            "label": "Start with a few accounts, then everyone",
            "rec": true
          },
          {
            "id": "b",
            "label": "Every account at go-live"
          }
        ]
      },
      {
        "id": "HUB-15",
        "added": "2026-09-29",
        "q": "Checklist photos: where should clients see them?",
        "why": "You chose item-by-item checklists without photos in the hub (HUB-8), and asked for the checklist pictures on the QR scan page (QR-2), which anyone can open.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "In the hub, and the newest photo for each area on the public scan page",
            "rec": true
          },
          {
            "id": "b",
            "label": "In the hub only — the public scan page shows no photos"
          },
          {
            "id": "c",
            "label": "Nowhere — photos stay with your team"
          }
        ]
      },
      {
        "id": "HUB-16",
        "added": "2026-09-29",
        "q": "Clients will see each inspection item’s comment (HUB-6). Should inspectors also have a note that clients never see?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — add an internal note for your team only",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — the comments are enough"
          }
        ]
      },
      {
        "id": "HUB-17",
        "added": "2026-09-29",
        "q": "Client logins: each person sees only the buildings you assign them, and you can assign a whole group at once. Is that right?",
        "why": "For example, a property manager sees their one building, and a city’s facility director sees every building in that city (your HUB-2 note).",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — buildings assigned per person, with groups for a management company or a city",
            "rec": true
          },
          {
            "id": "b",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "HUB-18",
        "added": "2026-09-29",
        "q": "The client’s call and text buttons reach the account’s supervisor (HUB-12). Which number should they use?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Each supervisor’s own phone number, from their profile",
            "rec": true
          },
          {
            "id": "b",
            "label": "A different number",
            "needsNote": true
          }
        ]
      },
      {
        "id": "HUB-19",
        "added": "2026-10-03",
        "q": "Team members are getting profile photos in the app. Should your clients see the cleaners’ photos for their building in the Client Hub?",
        "why": "Photos help a property manager recognize who is in the building. Some companies prefer to keep staff photos internal.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, a photo next to each cleaner’s name"
          },
          {
            "id": "b",
            "label": "Only the supervisor’s photo"
          },
          {
            "id": "c",
            "label": "No, names only"
          }
        ]
      },
      {
        "id": "HUB-20",
        "added": "2026-10-08",
        "q": "On the client’s crew-status card, what should it say when the crew hasn’t arrived by the scheduled time, or a visit is marked missed?",
        "why": "Your design shows “On site now”, “Arriving today” and “No visit today”. This decides whether clients ever see that a crew is running late.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Stay neutral: “Expected at 6:00 PM” until someone arrives, and a missed visit shows the next visit. Never say late.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Say “Running late” 15 minutes after the start, and “Visit missed” when it’s marked missed"
          }
        ]
      },
      {
        "id": "HUB-21",
        "added": "2026-10-08",
        "q": "A client sends a request from the Client Hub and their building has no manager assigned. Who should be alerted?",
        "why": "For client messages you said: the building’s manager, and the Admins when there is none. Requests today go to the manager, or to the whole office when there is none.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The Admins, the same as messages",
            "rec": true
          },
          {
            "id": "b",
            "label": "The whole office (Super Admin, Admins and Managers), as today"
          }
        ]
      },
      {
        "id": "HUB-22",
        "added": "2026-10-08",
        "q": "One contract can cover several buildings (a master agreement). Who in the Client Hub can open it?",
        "why": "The Documents page shows each building’s service agreement. A master agreement is shared by every building it covers.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Anyone who can see one of the buildings it covers",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only people who can see every building it covers"
          }
        ]
      },
      {
        "id": "HUB-23",
        "added": "2026-10-08",
        "q": "Which invoices should a client see on a building’s Invoices page?",
        "why": "Invoices come from QuickBooks and are view-only. Some invoices may be billed to a parent company rather than to the building itself.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The last 12 months billed to that building’s own QuickBooks customer",
            "rec": true
          },
          {
            "id": "b",
            "label": "Also invoices billed to the parent company, shown on every building under it"
          }
        ]
      },
      {
        "id": "HUB-24",
        "added": "2026-10-09",
        "q": "Your email says the Client Hub’s “Message Account Manager” and the Client Requests queue should be the same data. Is this what you meant?",
        "why": "A client’s message and a client’s request are stored separately today. We’re building it so Client Requests also lists every client message still waiting for a reply, with the 30-minute first-reply countdown, and answering there replies in the same thread the client sees.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes: one queue showing requests and unanswered messages, the same records the client sees",
            "rec": true
          },
          {
            "id": "b",
            "label": "No: every message should become a request, with no separate chat"
          },
          {
            "id": "c",
            "label": "Something else",
            "needsNote": true
          }
        ]
      }
    ]
  },
  {
    "id": "qr",
    "title": "QR codes",
    "blurb": "The codes in each building’s areas, and what each person sees when they scan one.",
    "settled": [
      "One code per restroom or common area; scanning shows when that area was last cleaned.",
      "We provide the codes; your team prints and places them.",
      "One printed code per spot. Anyone who scans without signing in (tenants, guests, your client’s staff) sees the area’s public page: when it was last cleaned and what was done. A signed-in cleaner, manager or customer sees their own view instead.",
      "Anyone who scans a code can report a problem from it, and the report opens a ticket.",
      "You print the labels in your own label software, from the list of links the app gives you.",
      "Before an area’s first recorded clean, its page says “Cleaning records start soon”, with no warning.",
      "The page shows the last clean only, not a log of earlier cleans."
    ],
    "questions": [
      {
        "id": "QR-1",
        "added": "2026-09-25",
        "key": true,
        "q": "How should the app know that an area was cleaned?",
        "why": "Today the app records when the whole building’s clean is finished, not each area. This decides whether cleaners get an extra step.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "When the cleaner completes that area’s part of the checklist",
            "detail": "No extra step for cleaners. Works when your checklists are organized by area.",
            "rec": true
          },
          {
            "id": "b",
            "label": "When the cleaner clocks out of the building",
            "detail": "Every area shows the same time."
          },
          {
            "id": "c",
            "label": "Cleaners scan each area’s code as they finish it",
            "detail": "The most precise, but an extra step in every restroom on every visit."
          }
        ]
      },
      {
        "id": "QR-2",
        "added": "2026-09-25",
        "q": "What should someone see when they scan?",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "When the area was last cleaned",
            "rec": true
          },
          {
            "id": "b",
            "label": "When it’s next scheduled",
            "rec": true
          },
          {
            "id": "c",
            "label": "The checklist items done for that area"
          },
          {
            "id": "d",
            "label": "The cleaner’s first name"
          }
        ]
      },
      {
        "id": "QR-3",
        "added": "2026-09-25",
        "q": "Who can scan?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Anyone — tenants, visitors, your client’s staff",
            "detail": "They see only the cleaning status for that area.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only people with a client login"
          }
        ]
      },
      {
        "id": "QR-4",
        "added": "2026-09-25",
        "q": "Should a scan let someone report a problem, like “out of paper towels”?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Not at first — the scan shows status only",
            "detail": "We can add it once the basics are running.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes — anyone who scans can report a problem, which opens a ticket"
          },
          {
            "id": "c",
            "label": "Yes, but only people with a client login"
          }
        ]
      },
      {
        "id": "QR-5",
        "added": "2026-09-25",
        "q": "Should the scan page warn when an area hasn’t been serviced in a while?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, after 24 hours",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes, after a different amount of time",
            "needsNote": true
          },
          {
            "id": "c",
            "label": "No"
          }
        ]
      },
      {
        "id": "QR-6",
        "added": "2026-09-25",
        "q": "How should the codes be laid out for printing?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One PDF per building with all its area codes, sized for standard label sheets",
            "detail": "Each label shows the area, the building and your logo.",
            "rec": true
          },
          {
            "id": "b",
            "label": "One code per page"
          },
          {
            "id": "c",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "QR-7",
        "added": "2026-10-16",
        "key": true,
        "q": "What should get a code?",
        "why": "Each code points at one spot, and a printed code stays up for good.",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "Each cleaning area: restrooms, lobby, fitness center and so on",
            "detail": "How it works today.",
            "rec": true
          },
          {
            "id": "b",
            "label": "One main code per building, by the entrance or the janitor’s closet",
            "detail": "For things that aren’t one area, like clocking in."
          },
          {
            "id": "c",
            "label": "The supply closet",
            "detail": "Opens supply ordering for that building."
          },
          {
            "id": "d",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "QR-8",
        "added": "2026-10-16",
        "q": "When your team adds a building’s areas, should they pick from a standard list?",
        "why": "A building’s codes are made from its areas. With about 750 buildings, a list makes setup faster and keeps the names the same everywhere.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes: tick from a list (Lobby, Restrooms, Fitness center, Clubroom, Pool, Trash room, Mail room, Elevators, Hallways, Stairwells) and add your own",
            "rec": true
          },
          {
            "id": "b",
            "label": "No: type each area"
          }
        ]
      },
      {
        "id": "QR-9",
        "added": "2026-10-16",
        "q": "Which label software and printer will you print the codes with?",
        "why": "The app gives you a spreadsheet with every code’s link: customer, customer number, location, address, area and the link. We’ll check it loads cleanly in your software. One tip: opening the file in Excel first turns customer number 0001 into 1; importing it straight into the label software keeps it.",
        "type": "text"
      },
      {
        "id": "QR-10",
        "added": "2026-10-16",
        "q": "How big will the printed codes be?",
        "why": "Each link is about 60 characters long.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "1¼ inches square or larger",
            "detail": "Scans easily from about a foot away.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Smaller than 1¼ inches",
            "detail": "We’d shorten the links first, before anything is printed."
          }
        ]
      },
      {
        "id": "QR-12",
        "added": "2026-10-16",
        "q": "A cleaner scans a code before clocking in. What should happen?",
        "why": "Today the scan opens their checklist at that area, whether or not they’ve clocked in.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Show Clock In for that stop first, then the checklist",
            "rec": true
          },
          {
            "id": "b",
            "label": "Clock them in automatically"
          },
          {
            "id": "c",
            "label": "Just open the checklist; they clock in separately"
          }
        ]
      },
      {
        "id": "QR-13",
        "added": "2026-10-16",
        "q": "Should a scan count as proof the cleaner was at the building?",
        "why": "Phone GPS can be off by a block inside big buildings. Today an off-site clock-in is allowed but held for approval (PAY-17).",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes: the scan shows next to their clock-in, so a punch the GPS flagged as off-site can be approved with confidence",
            "rec": true
          },
          {
            "id": "b",
            "label": "No: GPS only"
          }
        ]
      },
      {
        "id": "QR-14",
        "added": "2026-10-16",
        "q": "A cleaner scans at a building they’re not scheduled at today. What should happen?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Tell them they’re not scheduled there, and show the area’s public page (what anyone sees without signing in)",
            "rec": true
          },
          {
            "id": "b",
            "label": "The same, and also tell their manager"
          },
          {
            "id": "c",
            "label": "Let them start a visit there (covering for someone)"
          }
        ]
      },
      {
        "id": "QR-15",
        "added": "2026-10-16",
        "q": "Do day porters check the same area several times a day (for example, restrooms every hour)?",
        "why": "Today an area counts as cleaned only when its part of the checklist is finished (QR-1).",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No: the checklist is enough"
          },
          {
            "id": "b",
            "label": "Yes: each scan logs a check, and the public page shows “Last checked 2:15 PM”"
          }
        ]
      },
      {
        "id": "QR-16",
        "added": "2026-10-16",
        "key": true,
        "q": "A customer scans a code at one of their buildings. What should open?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "That area’s own page: when it was last cleaned, the photo, what was done, and a button to make a request about it",
            "rec": true
          },
          {
            "id": "b",
            "label": "The building’s Checklists page",
            "detail": "What it opens today."
          },
          {
            "id": "c",
            "label": "The building’s Home page"
          }
        ]
      },
      {
        "id": "QR-17",
        "added": "2026-10-16",
        "key": true,
        "q": "An Account Manager or Operations Manager scans a code. What should open?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A page for that area: the last clean with the cleaner’s name and checklist, the photo, open requests at the building, who’s on site now, and buttons for Start inspection, New request and Open customer",
            "rec": true
          },
          {
            "id": "b",
            "label": "An inspection of that building, started right away"
          },
          {
            "id": "c",
            "label": "The customer’s page in the office app",
            "detail": "What it opens until you answer."
          },
          {
            "id": "d",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "QR-18",
        "added": "2026-10-16",
        "q": "Should a manager’s scan be saved as a site visit?",
        "why": "It would also feed the oversight view you mentioned for Carol.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes: who scanned where and when, so Operations Managers can see their Account Managers’ visits",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "QR-19",
        "added": "2026-10-16",
        "q": "A Supply Manager scans a code. What should open?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "That building’s supply orders and deliveries",
            "rec": true
          },
          {
            "id": "b",
            "label": "The same page as managers (QR-17)"
          },
          {
            "id": "c",
            "label": "Supply Managers won’t scan codes"
          }
        ]
      },
      {
        "id": "QR-20",
        "added": "2026-10-16",
        "q": "An Admin or the Super Admin scans a code. What should open?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The same page as managers (QR-17)",
            "rec": true
          },
          {
            "id": "b",
            "label": "The customer’s page in the office app"
          }
        ]
      },
      {
        "id": "QR-21",
        "added": "2026-10-16",
        "q": "Should managers and the office get a Scan button in the app, like cleaners and customers have?",
        "why": "Until the app is in the App Store, an iPhone’s camera opens a code in Safari, where they sign in once. The in-app button keeps them in the app.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No: they’ll use the phone’s camera"
          }
        ]
      },
      {
        "id": "QR-23",
        "added": "2026-10-16",
        "q": "What can a visitor report when they scan?",
        "why": "A visitor is anyone who scans without signing in: tenants, guests, your client’s staff. Their report opens a ticket for the building’s Account Manager, with your 30-minute first reply.",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "Out of supplies (paper towels, toilet paper, soap)",
            "rec": true
          },
          {
            "id": "b",
            "label": "Needs cleaning (a spill, a mess, a full trash can)",
            "rec": true
          },
          {
            "id": "c",
            "label": "Something broken or damaged",
            "rec": true
          },
          {
            "id": "d",
            "label": "Something else, in their own words",
            "rec": true
          },
          {
            "id": "e",
            "label": "A photo, if they want to add one",
            "rec": true
          },
          {
            "id": "f",
            "label": "Their name and a phone or email, if they want a reply"
          }
        ]
      },
      {
        "id": "QR-24",
        "added": "2026-10-16",
        "q": "What kind of ticket should a visitor’s report open?",
        "why": "Your deadlines: first reply in 30 minutes, a complaint fixed in 2 hours, a request in 24 hours.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "By what’s reported: out of supplies opens a request (24 hours); needs cleaning or broken opens a complaint (2 hours)",
            "rec": true
          },
          {
            "id": "b",
            "label": "Always a request"
          },
          {
            "id": "c",
            "label": "Always a complaint"
          }
        ]
      },
      {
        "id": "QR-25",
        "added": "2026-10-16",
        "q": "Should a visitor’s report go straight to the Account Manager?",
        "why": "Anyone can scan, so some reports will be jokes. Either way, we limit how many reports one phone can send.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, like any other ticket",
            "rec": true
          },
          {
            "id": "b",
            "label": "No: the office checks visitors’ reports first"
          }
        ]
      },
      {
        "id": "QR-26",
        "added": "2026-10-16",
        "q": "Should the building’s customer see the reports visitors make?",
        "why": "They didn’t make the report, and it would count toward their ticket volume.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, in their Requests, marked “Reported by a visitor”"
          },
          {
            "id": "b",
            "label": "No, office only",
            "rec": true
          }
        ]
      },
      {
        "id": "QR-27",
        "added": "2026-10-16",
        "q": "You stop servicing a building and archive the customer. What should its codes do?",
        "why": "Labels left on their walls would otherwise keep showing your company’s name and, after a day, “Not cleaned in the last 24 hours.”",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Stop working: they say “This code is no longer active”",
            "rec": true
          },
          {
            "id": "b",
            "label": "Keep showing the last clean"
          }
        ]
      },
      {
        "id": "QR-28",
        "added": "2026-10-16",
        "key": true,
        "q": "Some areas aren’t cleaned every day. What should their page say on the days in between?",
        "why": "With the 24-hour warning (QR-5), an area cleaned three times a week tells the public “Not cleaned in the last 24 hours” on every day off, even when it’s on schedule.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Warn only when a scheduled clean was missed, and show when the next one is",
            "rec": true
          },
          {
            "id": "b",
            "label": "Keep the 24-hour warning for every area"
          },
          {
            "id": "c",
            "label": "Never warn; show the next scheduled clean instead"
          }
        ]
      },
      {
        "id": "QR-30",
        "added": "2026-10-16",
        "q": "Should visitors be able to rate an area with a thumbs up or down when they scan?",
        "why": "A quick tap on the public page, separate from reporting a problem. It shows how each building’s cleaning lands with the people who use it.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, and only the office sees the results, by building",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes, and the building’s customer sees them too"
          },
          {
            "id": "c",
            "label": "No"
          }
        ]
      },
      {
        "id": "QR-31",
        "added": "2026-10-16",
        "q": "Should the public page include a line about your company?",
        "why": "Everyone who scans sees the page, including people from other buildings. It’s a place to invite new business, or to give a number for urgent problems.",
        "type": "single",
        "noteHint": "Which phone number or contact should it show?",
        "options": [
          {
            "id": "a",
            "label": "Yes: “Want this for your building? Contact us”"
          },
          {
            "id": "b",
            "label": "Yes: a phone number for urgent problems"
          },
          {
            "id": "c",
            "label": "Both"
          },
          {
            "id": "d",
            "label": "No, keep the page as it is"
          }
        ]
      }
    ]
  },
  {
    "id": "wo",
    "title": "Work orders & tickets",
    "blurb": "Requests and complaints from clients and from your team.",
    "settled": [
      "Clients submit trackable tickets.",
      "An urgent notification repeats every 5–10 minutes until someone replies.",
      "The client is told right away what stage it’s at: being worked on, or complete.",
      "You close it with a completion photo.",
      "Ticket volume shows which accounts are “complaining too much.”"
    ],
    "questions": [
      {
        "id": "WO-1",
        "added": "2026-09-25",
        "q": "Are complaints and work orders one list?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One list — a complaint is a type of ticket",
            "detail": "This is how the app works today.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Two separate lists"
          }
        ]
      },
      {
        "id": "WO-2",
        "added": "2026-09-25",
        "key": true,
        "q": "What should stop the repeating urgent alert?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Someone taps “I’m on it”"
          },
          {
            "id": "b",
            "label": "Someone replies to the client",
            "detail": "Matches your words: “until somebody replies.”",
            "rec": true
          },
          {
            "id": "c",
            "label": "Someone is assigned to it"
          },
          {
            "id": "d",
            "label": "The ticket is completed"
          }
        ]
      },
      {
        "id": "WO-3",
        "added": "2026-09-25",
        "q": "Which tickets repeat until answered?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Urgent ones only",
            "rec": true
          },
          {
            "id": "b",
            "label": "Every new ticket"
          }
        ]
      },
      {
        "id": "WO-4",
        "added": "2026-09-25",
        "q": "Who decides a ticket is urgent?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The client can mark it urgent; your office can change it",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only your office"
          }
        ]
      },
      {
        "id": "WO-5",
        "added": "2026-09-25",
        "q": "How often should it repeat, and when should it go up the chain?",
        "why": "You can adjust these later in Settings.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Every 10 minutes; after 30 minutes you’re alerted too",
            "rec": true
          },
          {
            "id": "b",
            "label": "Every 5 minutes; after 15 minutes you’re alerted too"
          },
          {
            "id": "c",
            "label": "Repeat only — never go up the chain"
          }
        ]
      },
      {
        "id": "WO-6",
        "added": "2026-09-25",
        "key": true,
        "q": "Who should a new ticket go to first?",
        "why": "Today a new ticket alerts every manager at once, while shift alerts go to the account’s supervisor first.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The account’s supervisor; the office if there’s no supervisor or no reply",
            "rec": true
          },
          {
            "id": "b",
            "label": "Every manager at once (as today)"
          },
          {
            "id": "c",
            "label": "A dispatcher",
            "detail": "Tell us who in a note.",
            "needsNote": true
          }
        ]
      },
      {
        "id": "WO-7",
        "added": "2026-09-25",
        "q": "Overnight, should ticket alerts wake people up?",
        "type": "single",
        "noteHint": "What are your office hours?",
        "options": [
          {
            "id": "a",
            "label": "Urgent tickets alert any time; the rest wait until morning",
            "rec": true
          },
          {
            "id": "b",
            "label": "Everything alerts any time"
          },
          {
            "id": "c",
            "label": "Nothing alerts overnight"
          }
        ]
      },
      {
        "id": "WO-8",
        "added": "2026-09-25",
        "q": "Which stages should the client be told about?",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "We received it",
            "rec": true
          },
          {
            "id": "b",
            "label": "Someone is working on it",
            "rec": true
          },
          {
            "id": "c",
            "label": "We need more information from you",
            "rec": true
          },
          {
            "id": "d",
            "label": "Completed, with the photo",
            "rec": true
          }
        ]
      },
      {
        "id": "WO-9",
        "added": "2026-09-25",
        "q": "Can clients see your team’s internal notes on a ticket?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — internal notes stay separate from replies to the client",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes — they see everything"
          }
        ]
      },
      {
        "id": "WO-10",
        "added": "2026-09-25",
        "q": "Is a completion photo required to close a ticket?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Required for complaints and problems; optional for simple requests",
            "rec": true
          },
          {
            "id": "b",
            "label": "Always required"
          },
          {
            "id": "c",
            "label": "Always optional (as today)"
          },
          {
            "id": "d",
            "label": "Required, with a before and an after photo"
          }
        ]
      },
      {
        "id": "WO-11",
        "added": "2026-09-25",
        "q": "After a ticket is marked complete, can the client reopen it?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, within 7 days",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — complete means closed"
          },
          {
            "id": "c",
            "label": "The client must confirm before it closes"
          }
        ]
      },
      {
        "id": "WO-12",
        "added": "2026-09-25",
        "q": "Beyond complaint, request and problem, do you want categories for reporting?",
        "type": "single",
        "noteHint": "Edit the list if yours differ.",
        "options": [
          {
            "id": "a",
            "label": "Yes: restock, spill, missed area, extra service, other",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — the three types are enough"
          }
        ]
      },
      {
        "id": "WO-13",
        "added": "2026-09-25",
        "q": "Response-time targets are set to: urgent 2 hours, high 8 hours, medium 1 day, low 3 days. Keep them?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep them",
            "rec": true
          },
          {
            "id": "b",
            "label": "Change them",
            "needsNote": true
          }
        ]
      },
      {
        "id": "WO-14",
        "added": "2026-09-25",
        "q": "How should “complaining too much” show up?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A flag on the account when it passes a set number of tickets in 30 days",
            "detail": "You pick the number.",
            "rec": true
          },
          {
            "id": "b",
            "label": "One company-wide number on the dashboard (as today)"
          }
        ]
      },
      {
        "id": "WO-15",
        "added": "2026-09-25",
        "q": "When a request turns into extra paid work, what happens?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Complete it and bill it the way you do today, outside the app",
            "rec": true
          },
          {
            "id": "b",
            "label": "Turn the ticket into a quote inside the app",
            "detail": "A later option."
          }
        ]
      },
      {
        "id": "WO-16",
        "added": "2026-09-29",
        "q": "After someone replies to a ticket, how often should the reminders repeat until it’s completed?",
        "why": "Your WO-2 note: alert until someone replies, and keep alerting until the ticket is completed.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Every hour during office hours, then escalate when the response time runs out",
            "rec": true,
            "detail": "Response times: urgent 2 hours, high 8 hours, medium 1 day."
          },
          {
            "id": "b",
            "label": "Every 10 minutes, the same as before the reply"
          },
          {
            "id": "c",
            "label": "Once a day"
          }
        ]
      },
      {
        "id": "WO-17",
        "added": "2026-09-29",
        "needs": true,
        "q": "What are your office hours and days? Non-urgent ticket alerts wait for them (WO-7).",
        "type": "text"
      },
      {
        "id": "WO-18",
        "added": "2026-09-29",
        "q": "Your WO-13 note says to keep urgent, high and medium. Should we remove the “low” priority?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — three priorities: urgent, high, medium",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — keep low as well"
          }
        ]
      },
      {
        "id": "WO-19",
        "added": "2026-10-09",
        "q": "When an inspection fails, should the app open a request for that building on its own, so it shows in Client Requests until the fixes are done?",
        "why": "Your manager design lists a failed inspection among the client requests. Today a failed inspection sends the cleaners back to redo the failed areas, but nothing shows in the requests list.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, at medium priority (fixed within 1 day)",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes, as urgent (fixed within 2 hours)"
          },
          {
            "id": "c",
            "label": "No, keep failed inspections out of the requests list"
          }
        ]
      },
      {
        "id": "WO-20",
        "added": "2026-10-09",
        "q": "Your email’s response standards: first reply within 30 minutes, a complaint fixed within 2 hours, a request within 24 hours, a failed inspection fixed within 48 hours. Should the TYPE of request set its deadline, with urgency used only for sorting and after-hours alerts?",
        "why": "Today the deadline comes from urgency (urgent 2 hours, medium 1 day, low 3 days), from your earlier answers. We’re switching to your standards now. Your WO-19 pick said a failed inspection is fixed within 1 day and your email says 48 hours; we’re using 48 hours.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes: the type sets the deadline; urgency only sorts the list and decides who gets alerted after hours",
            "rec": true
          },
          {
            "id": "b",
            "label": "The type sets it, but an urgent request of any type is due within 2 hours"
          },
          {
            "id": "c",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "WO-21",
        "added": "2026-10-09",
        "q": "Problems your office or crew log themselves (“issues”, not from a client): what deadline should they get?",
        "why": "Your standards cover client requests. Issues are logged internally, for example a broken vacuum or a door that won’t lock.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep the urgency clock for them: urgent 2 hours, medium 1 day, low 3 days",
            "rec": true
          },
          {
            "id": "b",
            "label": "24 hours, like a request"
          },
          {
            "id": "c",
            "label": "No deadline"
          }
        ]
      }
    ]
  },
  {
    "id": "sup",
    "title": "Supplies",
    "blurb": "Approved supply lists, requests and usage.",
    "settled": [
      "Each location has an approved supply list.",
      "The location’s supervisor requests by item and quantity, and the office is notified.",
      "Marking a request complete clears it and notifies the requester.",
      "Usage is tracked by quantity per site."
    ],
    "questions": [
      {
        "id": "SUP-1",
        "added": "2026-09-25",
        "q": "Do supply requests need an approval step before they’re filled?",
        "why": "The agreement lists “request, approve, fulfill, close.” Your September 1 answer described no separate approval, which is how the app works today.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — the office fills them directly",
            "detail": "Your September 1 answer.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes — someone approves, then the office fills"
          },
          {
            "id": "c",
            "label": "Only above a dollar amount",
            "detail": "Tell us the amount in a note.",
            "needsNote": true
          }
        ]
      },
      {
        "id": "SUP-2",
        "added": "2026-09-25",
        "q": "Can a request be partly filled, with the rest to follow?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — a request is completed all at once",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes — keep track of what’s still owed"
          }
        ]
      },
      {
        "id": "SUP-3",
        "added": "2026-09-25",
        "q": "Can supervisors ask for items that aren’t on the approved list?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — approved list only",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes, as an “other” item the office reviews"
          }
        ]
      },
      {
        "id": "SUP-4",
        "added": "2026-09-25",
        "q": "Should supervisors see item prices when they request?",
        "why": "On September 1 you said “maybe.”",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, where a price has been entered",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — prices are for the office only"
          }
        ]
      },
      {
        "id": "SUP-5",
        "added": "2026-09-25",
        "q": "For usage (“how many boxes of toilet paper in 30 days”), when does an item count?",
        "why": "The app records quantities per request today, but there’s no usage report yet. We’ll build it.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "When it’s delivered (the request is marked complete)",
            "rec": true
          },
          {
            "id": "b",
            "label": "When it’s requested"
          }
        ]
      },
      {
        "id": "SUP-6",
        "added": "2026-09-25",
        "q": "Should clients see their building’s supply usage in the hub?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — your office answers those questions",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes"
          }
        ]
      },
      {
        "id": "SUP-7",
        "added": "2026-09-25",
        "q": "Budgets per building, with an over-budget warning?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Not now",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes"
          }
        ]
      },
      {
        "id": "SUP-8",
        "added": "2026-09-25",
        "key": true,
        "q": "Supply-order reminders: how often should each building order?",
        "why": "The agreement includes reminders so supply orders aren’t missed. The app needs each building’s ordering rhythm.",
        "type": "single",
        "noteHint": "Who gets reminded? We suggest the building’s supervisor, then the office if nothing’s submitted by the due day.",
        "options": [
          {
            "id": "a",
            "label": "Monthly on a set day, adjustable per building",
            "rec": true
          },
          {
            "id": "b",
            "label": "Every two weeks"
          },
          {
            "id": "c",
            "label": "Weekly"
          },
          {
            "id": "d",
            "label": "No schedule — they order when they run low"
          }
        ]
      },
      {
        "id": "SUP-9",
        "added": "2026-09-29",
        "q": "Who approves a supply request before the office fills it (SUP-1)?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The building’s supervisor",
            "rec": true
          },
          {
            "id": "b",
            "label": "An operations manager",
            "needsNote": true,
            "detail": "Tell us who in a note."
          },
          {
            "id": "c",
            "label": "You"
          }
        ]
      },
      {
        "id": "SUP-10",
        "added": "2026-09-29",
        "q": "Supply budgets (SUP-7): over what period, and what happens when a building goes over?",
        "why": "Your note mentions a monthly period.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A calendar month; the account is flagged over budget and the approver is alerted",
            "rec": true
          },
          {
            "id": "b",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "SUP-11",
        "added": "2026-10-04",
        "q": "Who can approve a building’s supply request?",
        "why": "You chose the building’s supervisor (SUP-9). Today the request goes to that supervisor, but anyone with approval rights can approve any building’s request.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Only that building’s supervisor"
          },
          {
            "id": "b",
            "label": "The building’s supervisor, and the office can step in",
            "detail": "For when the supervisor is out.",
            "rec": true
          },
          {
            "id": "c",
            "label": "Anyone with approval rights, as today"
          }
        ]
      },
      {
        "id": "SUP-12",
        "added": "2026-10-04",
        "q": "Do your buildings use the same supply list?",
        "why": "Each building has its own approved list, entered one item at a time. With about 750 buildings, a shared starting list would save your team a lot of typing.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Mostly the same: one standard list every building starts with, changed per building where needed"
          },
          {
            "id": "b",
            "label": "They vary: let us copy one building’s list to another, then adjust it"
          },
          {
            "id": "c",
            "label": "Every building is different: keep each list separate"
          }
        ]
      },
      {
        "id": "SUP-13",
        "added": "2026-10-04",
        "q": "How far back should supply usage and spend go?",
        "why": "Usage and spend cover the last 90 days today. Tell us if you need to look back further, for example to compare this year with last.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "90 days is enough"
          },
          {
            "id": "b",
            "label": "12 months"
          },
          {
            "id": "c",
            "label": "Everything, kept for good"
          }
        ]
      },
      {
        "id": "SUP-14",
        "added": "2026-10-09",
        "q": "Your manager design shows supplies as stock levels per building (Stocked, Low, Out), with a delivery date and a Reorder button. Which should the manager’s Supplies screen show?",
        "why": "Your supplies answer asked for an approved list per building and requests by item and quantity, with no stock counts. That is how the app works today: a supervisor requests, the approver approves, the office fills it. Stock levels would need someone to count each item at each building.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Requests, laid out like the design: a building needs attention when a request is waiting for approval or it is over budget, “order placed” means approved and waiting for the office, and Reorder starts a new request for that building",
            "rec": true
          },
          {
            "id": "b",
            "label": "Stock levels: track what is on hand at each building, mark items low or out, and reorder from there",
            "detail": "A new part of the app. Each building’s items would need a count and a low-stock level, and someone to keep them up to date."
          }
        ]
      },
      {
        "id": "SUP-15",
        "added": "2026-10-09",
        "q": "Your email asks for Stocked / Low / Out per building, but your SUP-14 note says not to track stock. Which should we follow?",
        "why": "We’ve built your SUP-14 note: what was asked for, what was delivered and how much went to each building each month, with no stock levels.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No stock levels: follow my SUP-14 note",
            "rec": true
          },
          {
            "id": "b",
            "label": "A simple Low / Out flag on items, marked by the cleaner on the visit"
          },
          {
            "id": "c",
            "label": "A simple Low / Out flag on items, marked by the building’s supervisor"
          }
        ]
      },
      {
        "id": "SUP-16",
        "added": "2026-10-09",
        "q": "Your SUP-14 note describes the supply manager packing two boxes and the delivery person marking it delivered. Should those be two separate steps in the app?",
        "why": "Today one step does both: the office marks a request complete, and the quantity requested counts as what was sent. With two steps, the office records how many were actually packed (it can differ from what was asked), then the delivery is marked delivered at the building.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes: the office records how many were sent, then the delivery is marked delivered",
            "rec": true
          },
          {
            "id": "b",
            "label": "Record how many were sent, but keep one step"
          },
          {
            "id": "c",
            "label": "Keep it as today: one step, and the requested quantity counts as sent"
          }
        ]
      },
      {
        "id": "SUP-17",
        "added": "2026-10-09",
        "q": "If deliveries are their own step, who marks a delivery as delivered?",
        "why": "Only matters if you choose two steps in SUP-16.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Whoever drives it: we add a “Deliveries” permission you can give anyone in Settings → Roles",
            "rec": true
          },
          {
            "id": "b",
            "label": "The building’s supervisor"
          },
          {
            "id": "c",
            "label": "The office"
          }
        ]
      }
    ]
  },
  {
    "id": "alr",
    "title": "Late, missed & reminders",
    "blurb": "How the app catches problems with shifts, checklists and inspections.",
    "settled": [
      "Alerts when a cleaner is late, hasn’t arrived, or misses a shift.",
      "Reminders for checklists and inspections.",
      "Every threshold is adjustable in Settings."
    ],
    "questions": [
      {
        "id": "ALR-1",
        "added": "2026-09-25",
        "q": "A cleaner is “late” when there’s no clock-in 10 minutes after the scheduled start. Keep 10 minutes?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep 10 minutes",
            "rec": true
          },
          {
            "id": "b",
            "label": "A different time",
            "needsNote": true
          }
        ]
      },
      {
        "id": "ALR-2",
        "added": "2026-09-25",
        "q": "The agreement names three triggers: late, hasn’t arrived, and missed shift. The app has two today, late and missed. Add a separate “still not here” alert?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — “late” at 10 minutes, then “still not here” at 45 minutes",
            "detail": "The second alert also goes to the office, so you can send a replacement.",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — late and missed are enough"
          }
        ]
      },
      {
        "id": "ALR-3",
        "added": "2026-09-25",
        "q": "A shift is “missed” when nobody has clocked in 15 minutes after the scheduled end. Keep that rule?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep it",
            "rec": true
          },
          {
            "id": "b",
            "label": "A different rule",
            "needsNote": true
          }
        ]
      },
      {
        "id": "ALR-4",
        "added": "2026-09-25",
        "q": "Who gets late and missed alerts?",
        "why": "Today: the account’s supervisor, or every manager when the account has no supervisor.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "As today, and always copy one operations manager",
            "detail": "Tell us who in a note.",
            "rec": true
          },
          {
            "id": "b",
            "label": "As today — the supervisor only"
          },
          {
            "id": "c",
            "label": "The supervisor and you, every time"
          }
        ]
      },
      {
        "id": "ALR-5",
        "added": "2026-09-25",
        "q": "Should cleaners get a reminder before each shift?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, 30 minutes before",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "ALR-6",
        "added": "2026-09-25",
        "q": "Who records a call-out?",
        "why": "It feeds your “cleaners who called out today” report.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The supervisor marks it on that day’s clean",
            "detail": "It stops the missed-shift alert and appears on the report.",
            "rec": true
          },
          {
            "id": "b",
            "label": "The office records it"
          },
          {
            "id": "c",
            "label": "Cleaners report it themselves in the app"
          }
        ]
      },
      {
        "id": "ALR-7",
        "added": "2026-09-25",
        "q": "Call-out reasons: pick from a list, or type freely?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A short list: sick, family, transportation, other",
            "rec": true
          },
          {
            "id": "b",
            "label": "Free text (as today)"
          }
        ]
      },
      {
        "id": "ALR-8",
        "added": "2026-09-25",
        "q": "Checklist reminders: the cleaner is reminded if the checklist isn’t done an hour after the start, and the supervisor is alerted an hour after the scheduled end. Keep these?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep them",
            "rec": true
          },
          {
            "id": "b",
            "label": "Change them",
            "needsNote": true
          }
        ]
      },
      {
        "id": "ALR-9",
        "added": "2026-09-25",
        "q": "How often should each account be inspected? It’s every 14 days for every account today.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Every 14 days by default, adjustable per account",
            "detail": "For example, medical buildings weekly.",
            "rec": true
          },
          {
            "id": "b",
            "label": "The same for every account",
            "detail": "Tell us how often in a note.",
            "needsNote": true
          }
        ]
      },
      {
        "id": "ALR-10",
        "added": "2026-09-28",
        "q": "Now that a cleaner can’t clock out until their checklist is done, when should the cleaner’s checklist reminder go out?",
        "why": "Today the cleaner is reminded an hour after the clean starts, and the supervisor is alerted an hour after the scheduled end. With the clock-out lock, cleaners tick items off as they work and have to finish before they can clock out — so a reminder an hour in reaches almost every longer clean while the cleaner is still working on it. The supervisor alert stays an hour after the scheduled end either way.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "30 minutes before the scheduled end",
            "detail": "A heads-up while there’s still time to finish.",
            "rec": true
          },
          {
            "id": "b",
            "label": "An hour after the start (as today)"
          },
          {
            "id": "c",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "ALR-11",
        "added": "2026-09-29",
        "key": true,
        "q": "Late and missed shifts: which did you mean?",
        "why": "Your answers set “late” at 30 minutes and “missed” at 30 minutes, and your ALR-2 note reads as one moment, 30 minutes after the start. A missed alert 30 minutes after the end of a shift comes too late to send someone.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One alert 30 minutes after the start with no clock-in: that’s a missed shift, and the supervisor gets a notification and a text",
            "rec": true,
            "detail": "Anyone who clocks in after the start shows as late on the reports."
          },
          {
            "id": "b",
            "label": "Two alerts: late 30 minutes after the start, and missed 30 minutes after the scheduled end"
          },
          {
            "id": "c",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "ALR-12",
        "added": "2026-09-29",
        "needs": true,
        "q": "Who is the operations manager copied on every late and missed alert (ALR-4)?",
        "type": "text"
      }
    ]
  },
  {
    "id": "ntf",
    "title": "How alerts reach people",
    "blurb": "Phone notifications, texts and quiet hours.",
    "settled": [],
    "questions": [
      {
        "id": "NTF-1",
        "added": "2026-09-25",
        "key": true,
        "q": "A missed shift at 2 a.m.: how should the supervisor find out?",
        "why": "Today alerts arrive in the app and as phone notifications only.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A phone notification (as today)"
          },
          {
            "id": "b",
            "label": "A phone notification, plus a text message for missed shifts and urgent tickets",
            "detail": "Needs texting set up through your Twilio account.",
            "rec": true
          },
          {
            "id": "c",
            "label": "Also a phone call",
            "detail": "Not included today."
          }
        ]
      },
      {
        "id": "NTF-2",
        "added": "2026-09-25",
        "q": "Can managers set quiet hours?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — but late and missed alerts and urgent tickets always come through",
            "rec": true
          },
          {
            "id": "b",
            "label": "No quiet hours"
          },
          {
            "id": "c",
            "label": "Yes, and quiet hours silence everything"
          }
        ]
      },
      {
        "id": "NTF-3",
        "added": "2026-09-25",
        "q": "Can cleaners mute a message conversation?",
        "why": "Cleaners can’t turn off their alerts, but today they can still mute a conversation.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — cleaners can’t mute",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes"
          }
        ]
      }
    ]
  },
  {
    "id": "log",
    "title": "Activity log",
    "blurb": "A record of who did what, and when, across the system.",
    "settled": [],
    "questions": [
      {
        "id": "LOG-1",
        "added": "2026-09-25",
        "key": true,
        "q": "Who is the activity log for?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Both: a full internal log, plus a proof-of-service trail in each client’s hub",
            "detail": "Clients would see service events only — arrivals and departures, checklist completion, inspection results, ticket progress. Never pay, internal notes or codes.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Your team only"
          }
        ]
      },
      {
        "id": "LOG-2",
        "added": "2026-09-25",
        "q": "What should be logged?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A set list of important actions",
            "detail": "Inspections closed or edited, schedule changes, time-clock edits, pay-rate and role changes, customers added or archived, ticket and supply status changes, door and alarm code views.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Every change to anything"
          }
        ]
      },
      {
        "id": "LOG-3",
        "added": "2026-09-25",
        "q": "Should changes show the before and after?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, for money, roles, schedules and inspections",
            "detail": "For example: “pay rate $15.00 → $16.00.”",
            "rec": true
          },
          {
            "id": "b",
            "label": "Who, what and when only"
          }
        ]
      },
      {
        "id": "LOG-4",
        "added": "2026-09-25",
        "q": "Who in your company can see the log?",
        "why": "Your rule: admins don’t see financials.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "You see everything; admins see everything except pay and money changes; managers see their own accounts",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only you"
          },
          {
            "id": "c",
            "label": "You and admins"
          }
        ]
      },
      {
        "id": "LOG-5",
        "added": "2026-09-25",
        "q": "How long should entries be kept? Nobody can edit or delete them.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "3 years",
            "rec": true
          },
          {
            "id": "b",
            "label": "1 year"
          },
          {
            "id": "c",
            "label": "Forever"
          }
        ]
      },
      {
        "id": "LOG-6",
        "added": "2026-09-25",
        "q": "For a dispute, how do you pull records out?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A PDF for one customer over a date range, plus a spreadsheet",
            "rec": true
          },
          {
            "id": "b",
            "label": "A spreadsheet only"
          },
          {
            "id": "c",
            "label": "On screen only"
          }
        ]
      },
      {
        "id": "LOG-7",
        "added": "2026-09-25",
        "q": "Log automatic actions too, like alerts sent and escalations?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "LOG-8",
        "added": "2026-09-25",
        "q": "Log sign-ins?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Not now",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes"
          }
        ]
      },
      {
        "id": "LOG-9",
        "added": "2026-09-29",
        "q": "The activity log itself is for your team only, and clients see service events in their hub. Is that right?",
        "why": "Service events are arrivals and departures, checklists done, inspection results and ticket progress (LOG-1). Your LOG-2 note: “Internal teams see this only.”",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — clients also see the full log for their buildings"
          }
        ]
      }
    ]
  },
  {
    "id": "con",
    "title": "Contract tracking",
    "blurb": "Multi-year agreements, price increases and renewals, with reminders before each.",
    "settled": [],
    "questions": [
      {
        "id": "CON-1",
        "added": "2026-09-25",
        "q": "What goes on a contract record?",
        "type": "multi",
        "noteHint": "Anything else you track today?",
        "options": [
          {
            "id": "a",
            "label": "Start and end dates",
            "rec": true
          },
          {
            "id": "b",
            "label": "Term length",
            "rec": true
          },
          {
            "id": "c",
            "label": "Monthly price",
            "rec": true
          },
          {
            "id": "d",
            "label": "Price-increase schedule",
            "rec": true
          },
          {
            "id": "e",
            "label": "Cancellation notice period",
            "rec": true
          },
          {
            "id": "f",
            "label": "Auto-renew, yes or no",
            "rec": true
          },
          {
            "id": "g",
            "label": "Service frequency"
          },
          {
            "id": "h",
            "label": "Square footage"
          },
          {
            "id": "i",
            "label": "Special terms (free text)"
          }
        ]
      },
      {
        "id": "CON-2",
        "added": "2026-09-25",
        "q": "One contract per building, or one master agreement for several buildings?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One per building",
            "rec": true
          },
          {
            "id": "b",
            "label": "A master agreement can cover several buildings"
          }
        ]
      },
      {
        "id": "CON-3",
        "added": "2026-09-25",
        "q": "Can a building have more than one contract, like nightly cleaning plus separate floor care?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One contract per building; extra services are lines on it",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes — separate contracts, each with its own dates and increases"
          }
        ]
      },
      {
        "id": "CON-4",
        "added": "2026-09-25",
        "q": "Which term types do you use?",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "Fixed multi-year, for example 3 years",
            "rec": true
          },
          {
            "id": "b",
            "label": "Renews automatically each year",
            "rec": true
          },
          {
            "id": "c",
            "label": "Month-to-month after the first term",
            "rec": true
          }
        ]
      },
      {
        "id": "CON-5",
        "added": "2026-09-25",
        "key": true,
        "q": "How do price increases work?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A fixed percent each year, for example 3%",
            "rec": true
          },
          {
            "id": "b",
            "label": "A set dollar amount each year"
          },
          {
            "id": "c",
            "label": "Tied to inflation (CPI)"
          },
          {
            "id": "d",
            "label": "Different for each contract — enter each year’s price"
          }
        ]
      },
      {
        "id": "CON-6",
        "added": "2026-09-25",
        "q": "When an increase date arrives, what should the app do?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Remind the account’s AE; someone updates the billing",
            "rec": true
          },
          {
            "id": "b",
            "label": "Remind, and update the price in the app automatically"
          },
          {
            "id": "c",
            "label": "Also draft a price-increase letter to the client"
          }
        ]
      },
      {
        "id": "CON-7",
        "added": "2026-09-25",
        "q": "How far ahead should renewal and increase reminders come?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "60 days",
            "rec": true
          },
          {
            "id": "b",
            "label": "90 days"
          },
          {
            "id": "c",
            "label": "30 days"
          },
          {
            "id": "d",
            "label": "Three reminders: 90, 60 and 30 days"
          }
        ]
      },
      {
        "id": "CON-8",
        "added": "2026-09-25",
        "q": "Who gets contract reminders?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The account’s AE and you",
            "rec": true
          },
          {
            "id": "b",
            "label": "The AE only"
          },
          {
            "id": "c",
            "label": "You only"
          }
        ]
      },
      {
        "id": "CON-9",
        "added": "2026-09-25",
        "q": "If a contract requires notice to cancel, should the app track that window and remind you before it passes?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "CON-10",
        "added": "2026-09-25",
        "q": "When a reminder arrives, what can someone do with it?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Mark it done, snooze it or add a note; renewals also land on the Renewals board",
            "detail": "The board already exists in the app.",
            "rec": true
          },
          {
            "id": "b",
            "label": "It’s just a notification"
          }
        ]
      },
      {
        "id": "CON-11",
        "added": "2026-09-25",
        "q": "Attach the signed contract PDF to the account?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "CON-12",
        "added": "2026-09-25",
        "q": "Show contract value: each account’s annual value and your total book?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "CON-13",
        "added": "2026-09-25",
        "needs": true,
        "q": "Your existing contracts: roughly how many are active, where do they live today, and who will enter them?",
        "type": "text"
      },
      {
        "id": "CON-14",
        "added": "2026-09-29",
        "q": "Contracts: one building each, or a master agreement over several? Your CON-2 note says both.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Either: a contract covers one building or is a master agreement over several, and a building is on one active contract at a time",
            "rec": true
          },
          {
            "id": "b",
            "label": "Something else",
            "needsNote": true
          }
        ]
      }
    ]
  },
  {
    "id": "qb",
    "title": "QuickBooks & account profitability",
    "blurb": "Per-account gross profit, read from your books.",
    "settled": [
      "Each account mirrors its numbers from QuickBooks: revenue minus expenses equals gross profit, nothing more.",
      "Read-only: we never change anything in your books.",
      "Per account: revenue for today, 10, 15 and 30 days and all-time; invoice counts and amounts; amounts past due; gross profit margin.",
      "AE bonuses depend on gross profit clearing a threshold."
    ],
    "questions": [
      {
        "id": "QB-1",
        "added": "2026-09-25",
        "needs": true,
        "q": "Which QuickBooks do you use?",
        "why": "The kickoff notes say “QuickBooks Online Enterprise,” but Intuit sells QuickBooks Online (Advanced, Plus, Essentials) and QuickBooks Desktop Enterprise. This decides how we connect.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "QuickBooks Online Advanced"
          },
          {
            "id": "b",
            "label": "QuickBooks Online Plus or Essentials"
          },
          {
            "id": "c",
            "label": "QuickBooks Desktop Enterprise"
          },
          {
            "id": "d",
            "label": "Not sure — check it with the access you gave us"
          }
        ]
      },
      {
        "id": "QB-2",
        "added": "2026-09-25",
        "q": "How does each building show up in QuickBooks?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "As a customer, like “0001 Ball Harbor Village”",
            "rec": true
          },
          {
            "id": "b",
            "label": "As a class"
          },
          {
            "id": "c",
            "label": "As a project or job"
          },
          {
            "id": "d",
            "label": "As a location"
          },
          {
            "id": "e",
            "label": "As a sub-customer under its management company"
          }
        ]
      },
      {
        "id": "QB-3",
        "added": "2026-09-25",
        "needs": true,
        "q": "Are your expenses tagged to each customer in QuickBooks?",
        "why": "Gross profit per account depends on this.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — bills and expenses carry the customer"
          },
          {
            "id": "b",
            "label": "Yes — by class or location"
          },
          {
            "id": "c",
            "label": "Only some, for example supplies but not payroll"
          },
          {
            "id": "d",
            "label": "No — work out labor cost in the app from clocked hours × pay rates"
          }
        ]
      },
      {
        "id": "QB-4",
        "added": "2026-09-25",
        "q": "Where should labor cost come from?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "QuickBooks if payroll is tagged per customer; otherwise the app’s clocked hours × pay rates",
            "rec": true
          },
          {
            "id": "b",
            "label": "Always the app"
          },
          {
            "id": "c",
            "label": "Always QuickBooks"
          }
        ]
      },
      {
        "id": "QB-5",
        "added": "2026-09-25",
        "q": "Which period do bonuses use?",
        "type": "single",
        "noteHint": "Cash or accrual? We’ll match your P&L.",
        "options": [
          {
            "id": "a",
            "label": "Monthly",
            "rec": true
          },
          {
            "id": "b",
            "label": "Quarterly"
          },
          {
            "id": "c",
            "label": "Rolling 12 months"
          }
        ]
      },
      {
        "id": "QB-6",
        "added": "2026-09-25",
        "key": true,
        "q": "What is the bonus threshold?",
        "why": "The dashboard preview uses 35% as a placeholder.",
        "type": "single",
        "noteHint": "What’s the number?",
        "options": [
          {
            "id": "a",
            "label": "A margin percent, the same for every account",
            "rec": true
          },
          {
            "id": "b",
            "label": "A margin percent that varies by account"
          },
          {
            "id": "c",
            "label": "A dollar amount of gross profit"
          }
        ]
      },
      {
        "id": "QB-7",
        "added": "2026-09-25",
        "key": true,
        "q": "Who can see profitability?",
        "why": "You said your internal team should see whether an account makes money, and that admins don’t see financials.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "You see everything; each AE sees only their own accounts",
            "rec": true
          },
          {
            "id": "b",
            "label": "You and all managers see everything"
          },
          {
            "id": "c",
            "label": "Only you"
          }
        ]
      },
      {
        "id": "QB-8",
        "added": "2026-09-25",
        "q": "Is each account’s AE the same person as its supervisor in the app?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — add a separate AE on each account"
          }
        ]
      },
      {
        "id": "QB-9",
        "added": "2026-09-25",
        "q": "How fresh should the numbers be?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Updated every night",
            "rec": true
          },
          {
            "id": "b",
            "label": "Updated when you open the page"
          },
          {
            "id": "c",
            "label": "Close to live"
          }
        ]
      },
      {
        "id": "QB-10",
        "added": "2026-09-25",
        "q": "How much history should load when we connect?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The last 12 months",
            "rec": true
          },
          {
            "id": "b",
            "label": "From go-live only"
          }
        ]
      },
      {
        "id": "QB-11",
        "added": "2026-09-25",
        "key": true,
        "q": "Does invoicing stay where it is?",
        "why": "On September 1 you said not to worry about SmartSuite’s invoice billing.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — billing stays in QuickBooks and SmartSuite; the app shows the numbers read-only",
            "rec": true
          },
          {
            "id": "b",
            "label": "The app takes over invoicing later",
            "detail": "Invoices would then sync back into QuickBooks."
          }
        ]
      },
      {
        "id": "QB-12",
        "added": "2026-09-25",
        "q": "When a QuickBooks customer doesn’t match an account in the app?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Put it on a “needs matching” list for your analyst",
            "rec": true
          },
          {
            "id": "b",
            "label": "Ignore it"
          }
        ]
      },
      {
        "id": "QB-13",
        "added": "2026-09-29",
        "needs": true,
        "q": "Is payroll posted to QuickBooks by customer, so labor shows per building?",
        "why": "You chose labor cost from QuickBooks (QB-4). If payroll isn’t posted per customer, each building’s gross profit shows its revenue minus supplies only.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — payroll is posted per customer"
          },
          {
            "id": "b",
            "label": "No — payroll is posted as one company total"
          },
          {
            "id": "c",
            "label": "Not sure — check it with the access you gave us"
          }
        ]
      },
      {
        "id": "QB-14",
        "added": "2026-09-29",
        "needs": true,
        "q": "Should the bonus numbers use cash or accrual?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Cash"
          },
          {
            "id": "b",
            "label": "Accrual"
          },
          {
            "id": "c",
            "label": "Not sure — match my profit and loss report"
          }
        ]
      }
    ]
  },
  {
    "id": "lang",
    "title": "Languages",
    "blurb": "English, Spanish and Haitian Creole.",
    "settled": [
      "The app in English, Spanish and Haitian Creole, per the agreement.",
      "Your cleaners need it most."
    ],
    "questions": [
      {
        "id": "LANG-1",
        "added": "2026-09-25",
        "key": true,
        "q": "Which parts of the app come first?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Everything cleaners and supervisors use, then the office screens",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only what cleaners and supervisors use — the office stays in English"
          },
          {
            "id": "c",
            "label": "The whole app at once"
          }
        ]
      },
      {
        "id": "LANG-2",
        "added": "2026-09-25",
        "key": true,
        "q": "Spanish and Haitian Creole both at go-live?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Both at go-live",
            "rec": true
          },
          {
            "id": "b",
            "label": "Spanish at go-live, Creole shortly after"
          }
        ]
      },
      {
        "id": "LANG-3",
        "added": "2026-09-25",
        "q": "Who sets each person’s language?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The office sets it when adding someone; they can change it",
            "rec": true
          },
          {
            "id": "b",
            "label": "Each person picks it in their settings"
          },
          {
            "id": "c",
            "label": "Follow their phone’s language"
          }
        ]
      },
      {
        "id": "LANG-4",
        "added": "2026-09-25",
        "q": "Should alerts and notifications arrive in each person’s language?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "One language for everyone"
          }
        ]
      },
      {
        "id": "LANG-5",
        "added": "2026-09-25",
        "key": true,
        "q": "Who translates the app’s wording?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "A professional translator we arrange, checked by your bilingual staff",
            "rec": true
          },
          {
            "id": "b",
            "label": "Your bilingual staff"
          },
          {
            "id": "c",
            "label": "Machine translation",
            "detail": "Not recommended for Creole."
          }
        ]
      },
      {
        "id": "LANG-6",
        "added": "2026-09-25",
        "q": "Your checklist and inspection items: who translates them?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Translated along with the app; your staff checks them",
            "rec": true
          },
          {
            "id": "b",
            "label": "Your team writes the Spanish and Creole versions (we send a spreadsheet)"
          },
          {
            "id": "c",
            "label": "Checklists stay in English"
          }
        ]
      },
      {
        "id": "LANG-7",
        "added": "2026-09-25",
        "q": "When a cleaner and the office write in different languages?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Messages stay as written",
            "rec": true
          },
          {
            "id": "b",
            "label": "Show an automatic translation under each message",
            "detail": "A later option."
          }
        ]
      },
      {
        "id": "LANG-8",
        "added": "2026-09-25",
        "q": "Documents for clients, like quotes and inspection reports?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "English only",
            "rec": true
          },
          {
            "id": "b",
            "label": "In each client’s language"
          }
        ]
      },
      {
        "id": "LANG-9",
        "added": "2026-09-25",
        "q": "For Creole especially: short labels with icons, or full sentences?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Short labels with icons and photos wherever possible",
            "rec": true
          },
          {
            "id": "b",
            "label": "Full sentences"
          }
        ]
      },
      {
        "id": "LANG-10",
        "added": "2026-09-29",
        "q": "Your own checklists and inspection items in Spanish and Creole: how should they be translated (LANG-6)?",
        "why": "The app’s wording goes to the professional translator either way; your checklists can run to hundreds.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Machine translation as a first draft, checked by your bilingual staff",
            "rec": true
          },
          {
            "id": "b",
            "label": "The professional translator does them too",
            "detail": "Costs more as your checklists grow."
          },
          {
            "id": "c",
            "label": "Your team writes them"
          }
        ]
      },
      {
        "id": "LANG-11",
        "added": "2026-09-29",
        "q": "Each person’s language follows their phone (LANG-3). Should they also be able to change it in their settings?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — follow the phone, with a switch in settings",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — always follow the phone"
          }
        ]
      }
    ]
  },
  {
    "id": "pay",
    "title": "Time clock & payroll",
    "blurb": "Clocking in, pay rules and the payroll file.",
    "settled": [
      "Cleaners use their own phones, and clock-in is checked against each building’s GPS area.",
      "Payroll reports by date range for your payroll company."
    ],
    "questions": [
      {
        "id": "PAY-1",
        "added": "2026-09-27",
        "needs": true,
        "q": "Which payroll company do you use? Please also send a sample of the file it imports.",
        "type": "text"
      },
      {
        "id": "PAY-2",
        "added": "2026-09-27",
        "needs": true,
        "q": "How often do you run payroll?",
        "why": "The app is set to twice a month today.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Weekly"
          },
          {
            "id": "b",
            "label": "Every two weeks"
          },
          {
            "id": "c",
            "label": "Twice a month"
          }
        ]
      },
      {
        "id": "PAY-3",
        "added": "2026-09-25",
        "q": "Overtime rule?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Over 40 hours a week",
            "detail": "The federal rule, which Florida follows.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Also over 8 hours in a day"
          }
        ]
      },
      {
        "id": "PAY-4",
        "added": "2026-09-25",
        "q": "Round clock-in and clock-out times?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — pay to the minute",
            "rec": true
          },
          {
            "id": "b",
            "label": "7-minute rule"
          },
          {
            "id": "c",
            "label": "Nearest 15 minutes"
          }
        ]
      },
      {
        "id": "PAY-5",
        "added": "2026-09-25",
        "q": "Unpaid breaks?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "None",
            "rec": true
          },
          {
            "id": "b",
            "label": "Deduct automatically after a number of hours",
            "needsNote": true
          },
          {
            "id": "c",
            "label": "Cleaners clock their breaks"
          }
        ]
      },
      {
        "id": "PAY-6",
        "added": "2026-09-25",
        "needs": true,
        "q": "Should drive time between buildings be paid?",
        "why": "The app adds drive time between buildings to paid hours today. Please confirm this matches your policy.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — pay drive time"
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "PAY-7",
        "added": "2026-09-25",
        "q": "How do pay rates work?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "One rate per cleaner (as today)",
            "rec": true
          },
          {
            "id": "b",
            "label": "Rates vary by building"
          },
          {
            "id": "c",
            "label": "Rates vary by type of service"
          }
        ]
      },
      {
        "id": "PAY-8",
        "added": "2026-09-25",
        "q": "Approve timesheets before payroll?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Supervisors approve each week; the export flags anything not yet approved",
            "rec": true
          },
          {
            "id": "b",
            "label": "No approval step (as today)"
          },
          {
            "id": "c",
            "label": "Payroll can’t be exported until everything is approved"
          }
        ]
      },
      {
        "id": "PAY-9",
        "added": "2026-09-25",
        "q": "Put each person’s payroll-system employee ID in the file?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "Names only"
          }
        ]
      },
      {
        "id": "PAY-10",
        "added": "2026-09-25",
        "q": "Forgotten clock-outs: the app closes the shift 2 hours after its scheduled end and records the scheduled end time. Keep that?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep it",
            "rec": true
          },
          {
            "id": "b",
            "label": "Change the window",
            "needsNote": true
          },
          {
            "id": "c",
            "label": "Leave it open for a manager to fix"
          }
        ]
      },
      {
        "id": "PAY-11",
        "added": "2026-09-27",
        "q": "When a manager edits someone’s time, must they give a reason?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "Optional (as today)"
          }
        ]
      },
      {
        "id": "PAY-12",
        "added": "2026-09-25",
        "q": "Clocking in outside the building’s area, or with location turned off?",
        "why": "Today it’s allowed and flagged for the manager.",
        "type": "single",
        "noteHint": "Any buildings that need a hard block?",
        "options": [
          {
            "id": "a",
            "label": "Allow it, tell the cleaner, and flag it for the manager",
            "rec": true
          },
          {
            "id": "b",
            "label": "Block it"
          },
          {
            "id": "c",
            "label": "Block it unless a supervisor approves"
          }
        ]
      },
      {
        "id": "PAY-13",
        "added": "2026-09-25",
        "q": "Can a cleaner be clocked in to two cleans at once?",
        "why": "Today it’s allowed.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — a manager can override",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes"
          }
        ]
      },
      {
        "id": "PAY-14",
        "added": "2026-09-25",
        "q": "How long should exact clock-in locations be kept?",
        "why": "Today they’re kept indefinitely.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "90 days, then only “on site / off site” and the distance",
            "rec": true
          },
          {
            "id": "b",
            "label": "1 year"
          },
          {
            "id": "c",
            "label": "Keep them indefinitely"
          }
        ]
      },
      {
        "id": "PAY-15",
        "added": "2026-09-27",
        "q": "When payroll is run and some hours are still waiting for a manager’s approval, what should happen?",
        "why": "Only approved hours are paid. The app is set to pay the approved hours now and the rest on a later payroll once they’re approved.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Pay the approved hours now; the rest are paid on the next payroll after they’re approved",
            "detail": "Nobody waits on someone else’s missing approval, and no hours are lost.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Payroll can’t be run until every hour is approved",
            "detail": "Everyone is paid in one go, but one missing approval holds up the whole payroll."
          }
        ]
      },
      {
        "id": "PAY-16",
        "added": "2026-09-27",
        "q": "Who enters expense reimbursements?",
        "why": "Today the office enters each one with its receipt, and a manager approves it. A manager’s own goes to a Super Admin.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The office enters them (as today)"
          },
          {
            "id": "b",
            "label": "Cleaners send them from their phone with a photo of the receipt, and their manager approves"
          },
          {
            "id": "c",
            "label": "Managers enter them for their cleaners"
          }
        ]
      },
      {
        "id": "PAY-17",
        "added": "2026-09-29",
        "key": true,
        "q": "Clocking in or out outside the building’s area: how should the supervisor’s approval work?",
        "why": "You chose to block it unless a supervisor approves (PAY-12), with every clock-in and clock-out recorded at the site.",
        "type": "single",
        "noteHint": "Any buildings that need a hard block?",
        "options": [
          {
            "id": "a",
            "label": "The cleaner can clock in or out; the time is held until the supervisor approves it, and the supervisor is alerted right away",
            "rec": true,
            "detail": "Nobody is stuck outside at 2 a.m., and held time isn’t paid until it’s approved."
          },
          {
            "id": "b",
            "label": "The cleaner can’t start until the supervisor approves in the app"
          },
          {
            "id": "c",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "PAY-18",
        "added": "2026-09-29",
        "q": "Pay rates by building: how should they work?",
        "why": "Your PAY-7 note: one cleaner might earn $15 at one building and $17 at another.",
        "type": "single",
        "noteHint": "Does Paychex need each rate on its own line?",
        "options": [
          {
            "id": "a",
            "label": "Each cleaner has a main rate, and you can set a different rate for a building",
            "rec": true,
            "detail": "Overtime then uses the week’s blended rate, as the federal rule requires."
          },
          {
            "id": "b",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "PAY-19",
        "added": "2026-09-29",
        "q": "Overtime is weekly, and your pay periods are the 1st–15th and the 16th–end. What day does your workweek start?",
        "type": "single",
        "noteHint": "Which Paychex product do you use (Flex?)",
        "options": [
          {
            "id": "a",
            "label": "Sunday",
            "rec": true
          },
          {
            "id": "b",
            "label": "Monday"
          },
          {
            "id": "c",
            "label": "Another day",
            "needsNote": true
          }
        ]
      },
      {
        "id": "PAY-20",
        "added": "2026-09-29",
        "q": "Exact clock-in locations: how long should the GPS point saved with each clock-in be kept?",
        "why": "This is the point recorded at each clock-in, not the geofence, which never changes by itself. Your PAY-14 note was about the geofence.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Keep them indefinitely (as today)"
          },
          {
            "id": "b",
            "label": "90 days, then only “on site / off site” and the distance",
            "rec": true
          }
        ]
      },
      {
        "id": "PAY-21",
        "added": "2026-09-29",
        "q": "You don’t pay drive time (PAY-6). Should we switch it off and hide the drive-time report?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — switch it off and hide the report",
            "rec": true
          },
          {
            "id": "b",
            "label": "Switch it off, but keep the report"
          }
        ]
      }
    ]
  },
  {
    "id": "hr",
    "title": "HR: warnings",
    "blurb": "A new Warnings tab in HR. The supervisor answers a short set of questions and issues the warning, and the employee reads and signs it in the app.",
    "settled": [
      "Warnings get their own tab in HR, next to Employees, Special services, Reimbursements and PTO.",
      "Each warning stays on the employee’s profile with the date, reason, supervisor and the employee’s acknowledgment."
    ],
    "questions": [
      {
        "id": "HR-1",
        "added": "2026-10-04",
        "q": "Which questions should the supervisor answer when writing a warning?",
        "why": "Our draft: the employee, the building (if it relates to one), the warning level, the reason (attendance or no-call/no-show, lateness, quality of work, conduct, safety or policy, uniform, other), the date of the incident, what happened, what has to change, and what happens if it repeats. The reason is picked from a list so you can count reasons later.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Use these questions as they are"
          },
          {
            "id": "b",
            "label": "We’ll send you our current paper form to match"
          },
          {
            "id": "c",
            "label": "Change them (tell us how in a note)",
            "needsNote": true
          }
        ]
      },
      {
        "id": "HR-2",
        "added": "2026-10-04",
        "q": "Which warning levels do you use?",
        "why": "The supervisor picks one level on each warning, and the employee’s earlier warnings show while they fill it in.",
        "type": "multi",
        "options": [
          {
            "id": "a",
            "label": "Verbal warning"
          },
          {
            "id": "b",
            "label": "Written warning"
          },
          {
            "id": "c",
            "label": "Final warning"
          },
          {
            "id": "d",
            "label": "Suspension"
          },
          {
            "id": "e",
            "label": "Other (tell us in a note)",
            "needsNote": true
          }
        ]
      },
      {
        "id": "HR-3",
        "added": "2026-10-04",
        "q": "If an employee refuses to sign a warning, what should happen?",
        "why": "Signing only confirms they received it, not that they agree. The warning stays on file either way.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "The supervisor marks it “Refused to sign”"
          },
          {
            "id": "b",
            "label": "The supervisor marks it “Refused to sign” and adds a witness’s name"
          },
          {
            "id": "c",
            "label": "Something else (tell us in a note)",
            "needsNote": true
          }
        ]
      },
      {
        "id": "HR-4",
        "added": "2026-10-04",
        "q": "How long should a warning count toward the next level (for example, a second warning becoming a final one)?",
        "why": "This only decides which earlier warnings the supervisor sees as still active. Every warning stays on the employee’s profile for good.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "6 months"
          },
          {
            "id": "b",
            "label": "12 months"
          },
          {
            "id": "c",
            "label": "They always count"
          },
          {
            "id": "d",
            "label": "Something else (tell us in a note)",
            "needsNote": true
          }
        ]
      },
      {
        "id": "HR-5",
        "added": "2026-10-04",
        "q": "If the employee hasn’t signed a warning yet, when should the supervisor get a reminder?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "After 1 day"
          },
          {
            "id": "b",
            "label": "After 3 days"
          },
          {
            "id": "c",
            "label": "After a week"
          },
          {
            "id": "d",
            "label": "No reminder"
          }
        ]
      }
    ]
  },
  {
    "id": "go",
    "title": "Go-live, data & training",
    "blurb": "Getting your buildings, people and schedules in, and switching over.",
    "settled": [
      "Your team enters clients, cleaners and schedules; only your financial analyst adds or removes customers.",
      "Customers are never deleted — a returning customer keeps its ID.",
      "The platform starts fresh; your history stays in your current tools."
    ],
    "questions": [
      {
        "id": "GO-1",
        "added": "2026-09-25",
        "needs": true,
        "q": "Your ~750 buildings: how do they get into the app?",
        "why": "Each building needs its address (sets the GPS area), expected cleaning time (drives variance), schedule, crew and checklist.",
        "type": "single",
        "noteHint": "What can Swept and SmartSuite export?",
        "options": [
          {
            "id": "a",
            "label": "Your team enters them"
          },
          {
            "id": "b",
            "label": "You send spreadsheets from Swept or SmartSuite and we import them"
          }
        ]
      },
      {
        "id": "GO-2",
        "added": "2026-09-25",
        "q": "Customer IDs: confirm the format.",
        "why": "The app numbers customers #1001, #1002… today. We’ll switch to your format.",
        "type": "single",
        "noteHint": "Are these IDs already on your QuickBooks customers?",
        "options": [
          {
            "id": "a",
            "label": "Four digits plus the name, like “0001 Ball Harbor Village”",
            "detail": "The app assigns the next number, and a returning customer keeps its number.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "GO-3",
        "added": "2026-09-25",
        "key": true,
        "q": "Switch everyone at once, or pilot first?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Pilot a few accounts for two weeks, then everyone",
            "rec": true
          },
          {
            "id": "b",
            "label": "Everyone at once"
          }
        ]
      },
      {
        "id": "GO-4",
        "added": "2026-09-25",
        "q": "Running alongside Swept?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Pilot accounts switch fully; the rest stay on Swept until they move",
            "rec": true
          },
          {
            "id": "b",
            "label": "Everyone uses both for two weeks"
          },
          {
            "id": "c",
            "label": "Everyone switches on day one"
          }
        ]
      },
      {
        "id": "GO-5",
        "added": "2026-09-25",
        "q": "Swept history?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Start fresh, per the agreement",
            "rec": true
          },
          {
            "id": "b",
            "label": "Bring history over",
            "detail": "Outside the agreement; we’d scope it separately."
          }
        ]
      },
      {
        "id": "GO-6",
        "added": "2026-09-25",
        "needs": true,
        "q": "What go-live date are you aiming for?",
        "why": "The agreement’s schedule puts go-live around week 8 — early November.",
        "type": "text"
      },
      {
        "id": "GO-7",
        "added": "2026-09-25",
        "q": "How should cleaners get their login?",
        "type": "single",
        "noteHint": "Do most cleaners have an email address they check?",
        "options": [
          {
            "id": "a",
            "label": "A text message with a link",
            "detail": "Needs texting set up.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Email"
          },
          {
            "id": "c",
            "label": "A supervisor sets it up with them in person"
          }
        ]
      },
      {
        "id": "GO-8",
        "added": "2026-09-25",
        "q": "Training for admins and supervisors: what format?",
        "type": "multi",
        "noteHint": "About how many admins and supervisors?",
        "options": [
          {
            "id": "a",
            "label": "Live sessions, on site or by video call",
            "rec": true
          },
          {
            "id": "b",
            "label": "Short recorded videos to rewatch",
            "rec": true
          },
          {
            "id": "c",
            "label": "Sessions in Spanish or Creole for supervisors who train crews",
            "rec": true
          }
        ]
      },
      {
        "id": "GO-9",
        "added": "2026-09-29",
        "key": true,
        "q": "Is December 1 the day every account switches over, or the day the pilot starts?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "December 1 every account switches; the pilot starts about November 16",
            "rec": true
          },
          {
            "id": "b",
            "label": "December 1 the pilot starts"
          }
        ]
      },
      {
        "id": "GO-10",
        "added": "2026-09-29",
        "needs": true,
        "q": "Which accounts should pilot first (cleaners and the client hub), and who sends the client hub invites?",
        "type": "text"
      },
      {
        "id": "GO-11",
        "added": "2026-09-29",
        "needs": true,
        "q": "About how many admins and supervisors need training?",
        "type": "text"
      }
    ]
  },
  {
    "id": "misc",
    "title": "A few smaller calls",
    "blurb": "Loose ends from the build so far.",
    "settled": [],
    "questions": [
      {
        "id": "MISC-1",
        "added": "2026-09-25",
        "q": "Sales pipeline: when a deal is marked won or lost, should it leave the board?",
        "why": "Today the pipeline total counts open deals only, but won and lost deals can still sit in open columns, so the total and the board disagree.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes — won and lost deals move off automatically, and the total is labeled “open deals”",
            "rec": true
          },
          {
            "id": "b",
            "label": "No — keep them on the board and just relabel the total"
          }
        ]
      },
      {
        "id": "MISC-2",
        "added": "2026-09-25",
        "q": "Can cleaners add office notes on a customer?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes",
            "rec": true
          },
          {
            "id": "b",
            "label": "No"
          }
        ]
      },
      {
        "id": "MISC-3",
        "added": "2026-09-25",
        "q": "Can admins see the “Hours by cleaner” report? Its hours match payroll.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "No — you and managers only",
            "rec": true
          },
          {
            "id": "b",
            "label": "Yes"
          }
        ]
      },
      {
        "id": "MISC-4",
        "added": "2026-09-25",
        "q": "On the Reviews page, who can update the Indeed review count?",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Whoever manages reviews",
            "rec": true
          },
          {
            "id": "b",
            "label": "Only you"
          }
        ]
      },
      {
        "id": "MISC-5",
        "added": "2026-09-28",
        "q": "Should cleaners have to take a photo on some checklist items?",
        "why": "When the office builds a checklist, each item has a “photo” box, but today it does nothing: the cleaner is never asked for a photo, and the checklist can be finished without one. Since a cleaner can’t clock out until their checklist is done, a required photo would have to be taken before they can clock out.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Yes, on the items the office marks",
            "detail": "The cleaner can’t tick that item off without a photo. You choose which items need one, like restrooms, trash, or anything you’d want proof of.",
            "rec": true
          },
          {
            "id": "b",
            "label": "Optional",
            "detail": "Cleaners can add a photo to any item, but none is required."
          },
          {
            "id": "c",
            "label": "No photos on checklists",
            "detail": "We remove the box. Photos stay on inspections and work orders."
          },
          {
            "id": "d",
            "label": "Something else",
            "needsNote": true
          }
        ]
      },
      {
        "id": "MISC-6",
        "added": "2026-09-29",
        "needs": true,
        "q": "Which Google account should the app send its email from (invites, client emails, reminders), and which mailboxes should connect to the app’s inbox?",
        "why": "The app sends its email through Google.",
        "type": "text"
      },
      {
        "id": "MISC-7",
        "added": "2026-10-17",
        "q": "You do proposals and e-signatures in PandaDoc. Should the app’s own Quotes page stay?",
        "why": "The app has a Quotes page too: you build a proposal there, the customer gets an email with a link to review and e-sign it, then a signed copy by email. Your notes on the quote drafts say this is done in PandaDoc, so the two do the same job.",
        "type": "single",
        "options": [
          {
            "id": "a",
            "label": "Hide it — we use PandaDoc",
            "rec": true
          },
          {
            "id": "b",
            "label": "Keep it — we may move quotes into the app later"
          },
          {
            "id": "c",
            "label": "Keep it — we’ll use it instead of PandaDoc"
          }
        ]
      },
      {
        "id": "MISC-8",
        "added": "2026-10-17",
        "q": "When someone replies to an email from the app, where should the reply go?",
        "why": "The app sends its email from your alerts@ address. Today a reply to a Client Hub email comes back to alerts@ and shows up in the app’s Messaging, while a reply to an account setup, password reset, quote or signed-agreement email goes to office@. Your website lists contact@.",
        "type": "single",
        "noteHint": "Which address?",
        "options": [
          {
            "id": "a",
            "label": "alerts@ — every reply shows up in Messaging",
            "rec": true
          },
          {
            "id": "b",
            "label": "office@"
          },
          {
            "id": "c",
            "label": "contact@ — the address on your website"
          },
          {
            "id": "d",
            "label": "Another address",
            "needsNote": true
          }
        ]
      }
    ]
  },
  {
    "id": "design",
    "title": "Design choices",
    "blurb": "Ways a part of the app could look. Each view is a working mockup: try them, then pick one, keep things as they are, or tell us you have another way in mind.",
    "settled": [
      "The menu is now the Launcher (D), built October 30."
    ],
    "questions": [
      {
        "id": "DES-1",
        "added": "2026-10-20",
        "mockup": "sidebar-directions",
        "q": "The menu down the left side is getting long. Which way should it go?",
        "why": "It holds 25 pages today, 13 of them under Operations, so on a laptop it scrolls. Each view below is a working menu with all 25 pages: click through them, then pick one under the views.",
        "type": "single",
        "noteHint": "Your idea, or anything you’d change in the one you picked",
        "options": [
          {
            "id": "a",
            "label": "Folders",
            "detail": "One menu as today, in five big sections that fold, with smaller groups inside them."
          },
          {
            "id": "b",
            "label": "Rail + panel",
            "detail": "A slim strip of section icons, with the chosen section’s pages in a panel beside it that can hide."
          },
          {
            "id": "c",
            "label": "Pinned + Jump",
            "detail": "Type to jump to any page; each person pins the pages they use every day."
          },
          {
            "id": "d",
            "label": "Launcher",
            "detail": "The menu holds only the sections; a click opens a wide panel with every page in it."
          },
          {
            "id": "e",
            "label": "Keep the old menu",
            "detail": "The menu as it was before October 30 (view E)."
          },
          {
            "id": "f",
            "label": "I’ll think of another way",
            "detail": "None of these: tell us your idea in a note.",
            "needsNote": true
          }
        ]
      }
    ]
  }
];

// Flat list of every question, each carrying its `sectionId` (catalog order preserved).
export const DECISIONS = DECISION_SECTIONS.flatMap((s) => s.questions.map((q) => ({ ...q, sectionId: s.id })));

// id -> question (with sectionId). Answers are keyed by these ids.
export const DECISION_BY_ID = Object.fromEntries(DECISIONS.map((q) => [q.id, q]));

// id -> section. For the focus header's blurb / settled list.
export const DECISION_SECTION_BY_ID = Object.fromEntries(DECISION_SECTIONS.map((s) => [s.id, s]));
