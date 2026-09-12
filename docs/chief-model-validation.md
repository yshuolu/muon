# Chief model browser validation

Passed 2026-09-12T06:26:04.174Z.

Dedicated headless Chromium with isolated SQLite and real HTTP. Provider responses are controlled; this does not test authenticated Claude execution. No project commands, user browser tabs, or user database were used.

- Model controls and runtime information appear in the prompt’s bottom toolbar.
- The model dropdown includes the configured default, Opus, Sonnet, and Haiku immediately when opened.
- A failed save retains the draft and current model; retry saves sonnet across reload and SQLite reopen.
- The toolbar and model dialog fit a 390px mobile viewport; Escape restores focus to the model control.
- The selected model reaches the Chief provider request, and the model control is disabled until the request completes.
- Custom model entry remains available; a saved model ID survives reload and appears beside the standard choices when reopened.
- Use default clears the saved override and restores the configured model after reload.
- No browser page errors were observed.

## Evidence

Type checking, all 237 automated tests, the production build, and all eight focused browser checks passed. [Test and browser log](/Users/yshuolu/Develop/muon-chief-model-dropdown/.muon/validation/chief-dropdown-checks.log). The build retains its existing bundle-size warning.

- [Run log](/Users/yshuolu/Develop/muon-chief-model-dropdown/.muon/validation/chief-model-ckXDpc/run.log)
- [JSON report](/Users/yshuolu/Develop/muon-chief-model-dropdown/.muon/validation/chief-model-ckXDpc/report.json)
- [01-chief-model-toolbar-desktop.png](/Users/yshuolu/Develop/muon-chief-model-dropdown/.muon/validation/chief-model-ckXDpc/01-chief-model-toolbar-desktop.png)
- [02-chief-model-toolbar-mobile.png](/Users/yshuolu/Develop/muon-chief-model-dropdown/.muon/validation/chief-model-ckXDpc/02-chief-model-toolbar-mobile.png)
- [03-chief-model-dialog-mobile.png](/Users/yshuolu/Develop/muon-chief-model-dropdown/.muon/validation/chief-model-ckXDpc/03-chief-model-dialog-mobile.png)

Rerun: `pnpm run build && pnpm exec tsx scripts/chief-model-browser-check.ts`. Install Chromium once with `pnpm exec playwright install chromium`.
