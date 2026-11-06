// The mockups a Review design question draws (UI_RULES §179). A question names one by id
// (`mockup: 'sidebar-directions'` in data/buildDecisions.js) and pages/review/MockupFrame.jsx draws
// it inside the question, in an iframe, with the app's own theme, logo and names filled in.
//
//   file   the template beside this file. It holds no colour and no name of its own, and it is
//          never a page of its own or a file in public/ (CS-202).
//   views  its views (the template's VIEWS), in order. An answer whose id is a view switches the
//          mockup to it; an answer with no view of its own ("another way") leaves it where it is.
//   today  the view that draws the app as it is now, so "keep it as it is" can be seen and chosen.
//   load   the template's text, fetched only when a question draws it (its own chunk).
//
// test-review-mockups.mjs holds this list, the templates and the questions to each other.
export const REVIEW_MOCKUPS = {
  'sidebar-directions': {
    file: 'sidebar-directions.html',
    views: ['a', 'b', 'c', 'd', 'e'],
    today: 'e',
    load: () => import('./sidebar-directions.html?raw').then((m) => m.default),
  },
};
