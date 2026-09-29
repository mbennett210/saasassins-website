// Build decisions — Matt's 123 build-decision questions across 13 sections, the
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
//                   noteHint?, options?: [{ id, label, detail?, rec?, needsNote? }] }
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
      }
    ]
  },
  {
    "id": "qr",
    "title": "QR codes: “last cleaned”",
    "blurb": "The codes in restrooms and common areas.",
    "settled": [
      "One code per restroom or common area; scanning shows when that area was last cleaned.",
      "We provide the codes; your team prints and places them."
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
        "added": "2026-09-25",
        "needs": true,
        "q": "Which payroll company do you use? Please also send a sample of the file it imports.",
        "type": "text"
      },
      {
        "id": "PAY-2",
        "added": "2026-09-25",
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
        "added": "2026-09-25",
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
