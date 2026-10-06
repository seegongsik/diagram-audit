# Contributing

Bug reports with a minimal HTML page that reproduces the problem are the most useful thing you
can send. A false positive (something reported that a person can read fine) and a false
negative (a defect it missed) are both bugs.

Every change to a verdict needs a test in `test/self-test.mjs`:

- a **positive** case that must be reported, and
- a **negative** case that must stay quiet,

and the test should fail before your change and pass after it. Run `npm test` before opening a
pull request; it needs Chromium (`npx playwright install chromium`) and, for stable font
measurements, Liberation Sans (`fonts-liberation` on Debian/Ubuntu).

Keep `src/instrument.js` free of anything that changes how the page behaves. It may record, it
may not draw, reorder or swallow the page's own errors.
