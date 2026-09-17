# Planning chat model validation

Validated the model selector with real Chromium, HTTP, and SQLite using controlled providers. No authenticated model calls were made.

All 12 browser checks passed, including:

- Default, Opus, Sonnet, Haiku, and custom model choices in the composer.
- Recovery from a simulated Fable usage limit with the conversation retained.
- Failed and pending model saves preserve drafts and prevent accidental sends.
- The selected model reaches the chat request and survives reload of the same chat.
- Model changes are disabled during a reply; custom Enter/Escape behavior and default reset work.
- Slow and stale polling responses cannot leave the selector stuck or replace a saved model.
- New chats reset editor and draft state; desktop and mobile layouts have no horizontal overflow.

Type checking, all 303 automated tests, and the production build passed. The build retains the existing bundle-size warning. Adapter tests verify model arguments under both configured permission policies; HTTP and service tests cover validation, owner access, defaults, failed turns, and concurrent submission.

## Retained evidence

- [Browser report](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/planning-chat-model-whBz97/report.json)
- [Browser run log](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/planning-chat-model-whBz97/run.log)
- [Desktop selector](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/planning-chat-model-whBz97/02-planning-chat-switched-desktop.png)
- [Mobile custom model editor](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/planning-chat-model-whBz97/04-planning-chat-custom-mobile.png)
- [Automated tests](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/quick-chat-tests.log)
- [Type checking](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/quick-chat-typecheck.log)
- [Production build](/Users/yshuolu/Develop/muon-quick-chat-model/.muon/validation/quick-chat-build.log)

Rerun with `pnpm run build && pnpm exec tsx scripts/planning-chat-model-browser-check.ts`. Install Chromium with `pnpm exec playwright install chromium` if needed.
