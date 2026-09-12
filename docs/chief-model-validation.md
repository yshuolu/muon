# Chief model browser validation

Passed 2026-09-12T06:33:34.376Z.

Dedicated headless Chromium with isolated SQLite and real HTTP. Provider responses are controlled; this does not test authenticated Claude execution. No project commands, user browser tabs, or user database were used.

- The model dropdown and runtime information appear directly in the prompt’s bottom toolbar without a dialog.
- The toolbar dropdown includes the configured default, Opus, Sonnet, and Haiku.
- A pending model save disables sending; completing it preserves the focused prompt draft without sending a message.
- Choosing a model saves immediately; failure restores the previous selection, and retry saves sonnet across reload and SQLite reopen.
- The dropdown and inline custom editor fit a 390px viewport; editing disables sending and Escape cancels with focus restored.
- The selected model reaches the Chief provider request, and the model control is disabled until the request completes.
- Custom model IDs save inline with Enter, survive reload beside standard choices, and can be canceled without changing the saved model.
- Selecting the configured default clears the saved override and restores that model after reload.
- No browser page errors were observed.

## Evidence

Type checking, all 237 automated tests, the production build, and all nine focused browser checks passed. [Automated test log](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-inline-checks.log) · [Final browser check log](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-inline-browser-final.log). The build retains its existing bundle-size warning.

- [Run log](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-model-HNlkf1/run.log)
- [JSON report](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-model-HNlkf1/report.json)
- [01-chief-model-toolbar-desktop.png](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-model-HNlkf1/01-chief-model-toolbar-desktop.png)
- [02-chief-model-toolbar-mobile.png](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-model-HNlkf1/02-chief-model-toolbar-mobile.png)
- [03-chief-model-inline-edit-mobile.png](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-model-HNlkf1/03-chief-model-inline-edit-mobile.png)
- [04-chief-model-inline-edit-desktop.png](/Users/yshuolu/Develop/muon-chief-inline-model/.muon/validation/chief-model-HNlkf1/04-chief-model-inline-edit-desktop.png)

Rerun: `pnpm run build && pnpm exec tsx scripts/chief-model-browser-check.ts`. Install Chromium once with `pnpm exec playwright install chromium`.
