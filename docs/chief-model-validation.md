# Chief model browser validation

Passed 2026-09-12T06:21:39.365Z.

Dedicated headless Chromium with isolated SQLite and real HTTP. Provider responses are controlled; this does not test authenticated Claude execution. No project commands, user browser tabs, or user database were used.

- Model controls and runtime information appear in the prompt’s bottom toolbar.
- A failed save retains the draft and current model; retry saves sonnet across reload and SQLite reopen.
- The toolbar and model dialog fit a 390px mobile viewport; Escape restores focus to the model control.
- The selected model reaches the Chief provider request, and the model control is disabled until the request completes.
- Use default clears the saved override and restores the configured model after reload.
- No browser page errors were observed.

## Evidence

After integration with `main`, type checking, all 237 automated tests, and the production build passed. The build reports its existing bundle-size warning. [Integrated check log](/Users/yshuolu/Develop/muon-chief-model-toolbar/.muon/validation/chief-model-integrated-checks.log).

The broader browser fixture could not complete because of existing provider-call indexing and task-navigation assumptions. This focused check verifies the Chief model workflow independently.

- [Run log](/Users/yshuolu/Develop/muon-chief-model-toolbar/.muon/validation/chief-model-xijaeC/run.log)
- [JSON report](/Users/yshuolu/Develop/muon-chief-model-toolbar/.muon/validation/chief-model-xijaeC/report.json)
- [01-chief-model-toolbar-desktop.png](/Users/yshuolu/Develop/muon-chief-model-toolbar/.muon/validation/chief-model-xijaeC/01-chief-model-toolbar-desktop.png)
- [02-chief-model-toolbar-mobile.png](/Users/yshuolu/Develop/muon-chief-model-toolbar/.muon/validation/chief-model-xijaeC/02-chief-model-toolbar-mobile.png)
- [03-chief-model-dialog-mobile.png](/Users/yshuolu/Develop/muon-chief-model-toolbar/.muon/validation/chief-model-xijaeC/03-chief-model-dialog-mobile.png)

Rerun: `pnpm run build && pnpm exec tsx scripts/chief-model-browser-check.ts`. Install Chromium once with `pnpm exec playwright install chromium`.
