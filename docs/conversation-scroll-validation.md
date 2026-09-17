# Conversation scrolling

Implemented the approved [scroll behavior contract](conversation-scroll-audit.md)
for Chief of Staff, Quick Chat / Planning thread, task Comments, and RFC discussion.

All four views now share one scroll controller:

- An accepted send reveals the outgoing message. A later deliberate scroll takes
  priority, including when polling delivers the message before the POST response.
  Exact message IDs prevent repeated acknowledgements from repeating a scroll.
- Incoming replies follow the latest edge only while the reader is following.
  Reading history preserves the visible message and its offset. A compact
  new-message control opens the first unseen reply; **Jump to latest** resumes
  following. These controls do not add a permanent header.
- Returning to a conversation restores its position and task tab within the open
  app page. A reader who was following returns to the first reply received while
  the conversation or document was hidden. Read indicators are local to the page;
  task Attention records are unchanged.
- Window/composer resizing, delayed images, and status changes preserve the
  current follow or reading state. Rapid shrink/grow changes are distinguished
  from user scrolling. Expanding a long reply preserves its context.
- Transcripts are labeled and keyboard-focusable. End goes to latest and
  Cmd/Ctrl+J goes to first unread while focus is in the transcript. Buttons expose
  the same actions. Automatic positioning is immediate, including reduced-motion
  mode; receiving never moves focus.

Comments uses the available height with the composer below its transcript. Mobile
Plan provides **RFC** and **Discussion** views with independent positions. The app
also follows the browser's VisualViewport when a software keyboard reduces the
visible area, retaining the composer, task status, and approval controls.

Positions are kept for up to 100 conversations during the lifetime of the open app
page. Reload clears this view state. Quick Chat's existing discard/restart
lifecycle is unchanged. Sandboxed HTML RFC iframe scroll survives tab/pane hiding;
its internal scroll cannot be restored after task unmount without changing its
sandbox. The outer RFC document position is restored.

## Validation

All 122 scroll checks passed across the eight desktop/mobile scenarios, with no
browser errors and a maximum measured reading-anchor drift of 0.5px. All 303
automated tests and type checking passed. The production build passed with its
existing bundle-size warning.

The browser fixture uses the production bundle, real HTTP and SQLite, controlled
providers, and isolated Chromium contexts at 1440×1000 and 390×844. It does not
send real model requests or mutate the owner's data.

The scroll matrix checks outgoing messages at latest/from history, delayed
acknowledgements and later user intent, failed-send draft preservation and retry,
short/long/batched incoming replies, unread navigation, reconnects, delayed media,
composer/window resizing, reply expansion, conversation/task/tab restoration,
keyboard actions, and focus. Reading anchors and bottom alignment must settle
within 2px. The matrix also tests explicitly simulated document visibility and
software-keyboard viewport changes; no physical phone keyboard was exercised.

- [Scroll matrix report](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/conversation-scroll-4oxeAn/report.json)
- [Independent mobile keyboard and RFC pane checks](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/task-viewport-layout/report.json)
- [Existing task workflow regression: 11 checks passed](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/browser-jW6sSI/report.json)
- [Planning model, compact header, and expired-chat regression: 19 checks passed](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/planning-chat-model-971zCU/report.json)
- [Automated tests](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/scroll-tests.log)
- [Type checking](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/scroll-typecheck.log)
- [Production build](/Users/yshuolu/Develop/muon-conversation-scroll/.muon/validation/scroll-build.log)

The existing task workflow fixture was updated for the initial planning-chat turn,
URL-based task reopening/browser Back, and the current Changes tab name. It still
verifies RFC approval gates, stale-revision rejection, repair, persisted evidence,
media playback, immutable dependency inputs, and Chief task links.

Run `pnpm run test:browser:scroll`. To narrow a failed scenario, set
`MUON_SCROLL_BROWSER_PROFILE=desktop|mobile` and/or
`MUON_SCROLL_BROWSER_SURFACE=chief|planning|comments|plan` when running
`node --import tsx scripts/conversation-scroll-browser-check.ts` after building.
Install Chromium with `pnpm exec playwright install chromium` if needed.
