# Conversation scrolling: gaps and proposed behavior

Audited 2026-09-17 against `3abde77`. This is the gap definition and implementation
proposal; it does not change product behavior.

Scope: Chief of Staff, Quick Chat / Planning thread, task Comments, and RFC Plan
discussion. These are the four send/receive conversation surfaces in the current
web app. RFC documents, asset previews, and activity/evidence lists are not message
threads, but their surrounding layout must not interfere with conversation scrolling.

## Slack reference and limits

Official Slack documentation establishes unread navigation, returning to a prior
reading point, and consistent keyboard navigation within threads:

- [Navigate Slack with your keyboard](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard): End goes to the most recent message; unread navigation is available; the same message navigation works inside threads.
- [Use Slack with a screen reader](https://slack.com/help/articles/360000411963-Use-Slack-with-a-screen-reader): the default starts at the first unread message, or the last focused message when everything is read. Newest-message preferences also exist. This specifically describes focus, not the visual scrolling implementation.
- [Use threads to organize discussions](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions): threads track unread replies and support marking replies unread.

The contract below is Muon's proposed Slack-style behavior. Slack's exact pixel
thresholds, animation timing, resize anchoring, and long-message policy are not
specified by these public documents; those are explicit product choices here.

## Gaps

P1 means a normal send, receipt, or navigation loses the user's place or hides the
message/composer. P2 means inconsistent recovery, accessibility, or an unverified
edge case. “Reproduced” means measured in Chromium against the production bundle,
using isolated HTTP/SQLite fixtures and controlled providers.

| ID | Priority | Gap and evidence | Required outcome |
| --- | --- | --- | --- |
| G1 | P1 | **Chief scrolls toward the oldest message on every send/receipt.** Reproduced: a reply moves `scrollTop` from 2,262 to 0, replacing message 10 with message 0. An own send also moves away from the latest message. [ChiefView](../src/web/components/chief.tsx), message-count effect, explicitly targets `top: 0`; messages are chronological. | Own sends reveal the sent message; incoming messages follow only while the user is following latest. |
| G2 | P1 | **Quick Chat pulls readers out of history on receipt.** Reproduced: a reply moves from 2,235 to 4,526, at the bottom. [PlanningChatView](../src/web/components/planning-chat.tsx) unconditionally scrolls on message count. | Preserve the visible message and offset while reading history; show that replies arrived below. |
| G3 | P1 | **RFC discussion loses position across tabs.** Reproduced: Plan → Comments → Plan moves from 3,059 to 6,364 (bottom). [TaskDetail](../src/web/components/task-detail.tsx) unmounts PlanDiscussion; its follow flag resets on mount. Comments correctly preserves its position across these tabs. Chief/task reopening also has no stored reading anchor, confirmed in [App](../src/web/App.tsx). | Restore each surviving conversation independently when returning; do not reset another conversation's position. |
| G4 | P1 | **Layout changes break following.** Reproduced: shrinking the viewport by 300px leaves Quick Chat 300px above bottom; shrinking by 200px leaves RFC discussion 200px above bottom. Comments loses bottom position after responsive reflow. All four effects react to message count/status, not geometry. Lazy images, async assets, and reply expansion share this risk, but were not reproduced in this audit. | Preserve bottom affinity during automatic layout changes and preserve a reading anchor when detached. Treat deliberate expansion separately. |
| G5 | P1 | **Message area and composer do not form a stable conversation viewport.** Reproduced at 390×844: Comments has a 164px message region inside a separately scrolling task page; Plan's textarea starts at y=972, below the viewport. See [styles](../src/web/styles.css), `.task-comments-messages` and mobile `.plan-review-workspace`. | Messages take the available height; composer and send action remain accessible without scrolling the outer page. Mobile RFC/document switching must preserve both reading positions. |
| G6 | P1 | **Own-send scrolling depends on request timing.** Reproduced by holding the successful POST response until polling delivered the message: Comments stays 2,290px above bottom and Plan stays 3,357px above bottom, even after acknowledgement. Both [TaskComments](../src/web/components/task-comments.tsx) and [PlanDiscussion](../src/web/components/plan-discussion.tsx) set their follow flag only after awaiting the POST; the scroll effect depends on separate polling updates. A normal Plan send also left the view 186px above bottom after its status/layout changed. | Associate scroll intent with the accepted outgoing message ID; polling before the POST response must not leave that message hidden. A later deliberate user scroll takes precedence. |
| G7 | P2 | **No conversation has a new-message indicator, unread boundary, or Jump to latest.** Confirmed in all four components. Comments/Plan preserve the reading anchor on incoming text, but give no indication that new replies are below. | One compact catch-up control; local unread tracking by message identity; no extra permanent header. |
| G8 | P2 | **Keyboard, focus, and motion rules differ.** Comments has an explicit focusable log; Plan has a log without explicit keyboard focus; Chief/Quick Chat lack equivalent log labels. Chief/Quick Chat hard-code smooth automatic scrolling, including initial positioning. Reproduced with reduced motion enabled: Chief animates from 4,523 through 559 to 0 after a receipt. | Consistent labeled, keyboard-operable regions and catch-up controls; incoming updates never move focus; reduced motion disables scripted animation. |

Already working: oldest-to-newest ordering; normal near-bottom incoming following
in Comments/Plan; unchanged first visible message and offset for incoming plain
text while reading history in those two views; Comments position across tab
switches; drafts retained on rejected requests. Preserve these behaviors.

## Shared behavior contract

| Event/state | Defined behavior on all four surfaces |
| --- | --- |
| First open | Empty thread stays ready for input. With history, start at first locally known unread message; otherwise latest. Position without an animated trip through history. |
| Return to a conversation | Restore the same message ID, offset, follow state, and relevant task tab within this workspace session. If previously following but replies arrived while hidden, show the first unseen reply and enter detached catch-up mode until the user reaches latest. Key state by workspace, project, conversation kind, and conversation ID. If an anchor disappeared, use its nearest surviving neighbor, then first unread/latest; never reuse another conversation's offset. |
| Following latest | Use the existing 80px proximity threshold as Muon's initial tolerance. Appends and automatic layout changes keep the latest edge visible. Determine affinity before content/viewport changes; geometry alone must not detach the user. |
| Reading history | Deliberate scrolling more than 80px above bottom suspends following. Incoming messages preserve the first visible message and its offset. Scrolling back to the end resumes following. |
| Send from either position | Once the accepted outgoing row renders, reveal it and resume following. Handle POST-before-poll and poll-before-POST equally. If the user deliberately scrolls away after submitting, preserve that newer intent. Optimistic pending rows are optional, not required by this scroll change. |
| Failed send/retry | Preserve draft and reading position. Do not repeat a scroll event for the same accepted message ID across retries/polls. Preserve existing request-idempotency behavior; redesigning endpoint delivery guarantees is outside this scroll change. Do not clear the draft until acceptance is known. |
| Incoming while detached | Keep the reading anchor. Show a compact “N new messages” control near the bottom of the message region, with a first-unread boundary in the transcript. Count unique incoming message IDs, not polling responses, progress updates, or own messages. |
| Catch up | The control reveals the first unseen message; provide Jump to latest to resume following. With no unseen messages but the user above the end, show only Jump to latest. These controls should appear only when needed and never add a permanent header row. |
| Read state | Mark visible incoming messages seen only while the conversation is selected and the browser document is visible; hidden conversation/browser tabs do not mark replies seen. Jump to latest acknowledges the current catch-up batch locally. Do not change task Attention records or introduce server/global read receipts. |
| Long agent reply | While following, keep the newest edge visible, even if the reply exceeds the viewport; while reading history, preserve the old anchor. Do not automatically place the beginning of every new reply at the top. Preserve existing collapsed replies; deliberate expansion enters detached reading mode and keeps the clicked reply's context. Resume following only when the user reaches latest or invokes Jump to latest. Restore expansion state with the anchor where needed, and clamp offsets to surviving content. |
| Resize/content growth | Window resize, responsive wrapping, composer growth, status/error changes, and delayed media retain the current follow/reading state. When reading history, compensate for growth above the visible anchor. On deliberate reply expansion, keep the expansion control/context visible. |
| Navigation/reconnect | Unchanged polls cause no scrolling. Reconnection and batched receipts use the same incoming-message rules. Hidden views do not scroll or steal focus. Restore state only for conversations that still exist. |
| Keyboard/focus/motion | Label and expose each transcript as a keyboard-accessible region. Keyboard navigation to latest/unread stays scoped to it and never intercepts textarea editing. Receiving never steals focus. Successful send keeps/restores composer focus unless the user has moved it. Initial positioning, restoration, and automatic following are immediate; any optional user-initiated animation respects reduced motion. |
| Desktop/mobile layout | Each visible conversation has one primary message scroller and a reachable composer. Use available vertical space and contain scroll chaining. At narrow widths, give RFC and discussion a compact switch or equivalent layout that preserves their independent positions. Validate the mobile software keyboard separately from viewport emulation. |

For this proposal, a workspace session is the lifetime of the open app page;
persisting positions through reloads or restarts is a separate extension.
Quick Chat currently discards its session on explicit sidebar departure. This
proposal preserves that lifecycle: restoring a discarded conversation would be a
separate persistence change. It does cover returning to a still-existing chat,
such as browser navigation. Cross-restart scroll persistence is not required.

Agent responses currently arrive as completed messages, with separate progress
text. Streaming is not an existing failing surface; the same geometry rules
should support it if it is added later.

## Implementation proposal and acceptance

1. Introduce one conversation scroll controller, with explicit follow/read/send
   intent, stable message anchors, and a session cache. Use it in all four views.
   Observe transcript and viewport geometry; do not depend only on array length.
2. Add the conditional catch-up control and unread boundary with keyboard/focus
   support. Keep them compact and within the message area.
3. Give Comments and mobile Plan a stable message/composer layout; preserve RFC
   and discussion anchors when switching. Keep current approval gates intact.
4. Validate against the production bundle, then verify the running app uses that
   bundle. This audit has not changed or refreshed the user's live conversations.

Before implementation is considered complete, run the following on **each of the
four surfaces**, at 1440×1000 and 390×844, with overflowing history:

- Send at latest and from history, using Enter and the button. Test slow POST,
  polling before acknowledgement, failure/retry, and scrolling during submission.
- Receive short, viewport-tall, and multiple replies both at latest and while
  reading. Detached reading anchors must remain within 2px after layout settles;
  followers must settle within 2px of bottom. No delayed second jump.
- Verify unseen counts/boundaries, first-unread navigation, Jump to latest,
  unchanged polls, reconnect batches, and updates while the view is hidden.
- Switch tabs, tasks, and surviving conversations; verify independent anchors.
- Resize height/width; grow the composer/status; load delayed images; expand and
  collapse replies. Verify both following and detached reading states.
- Test keyboard-only scrolling/catch-up, send focus, and reduced motion. Check
  mobile touch/overscroll and a real software keyboard in addition to emulation.

This is a cross-view implementation proposal for owner review before code changes,
as required by the repository's larger-change plan gate.

## Validation evidence

Chromium, isolated HTTP/SQLite, production build, controlled providers; no paid
agent calls or user task/chat mutations. The primary run measured all four
surfaces on send and receipt, tab navigation, and responsive geometry. It is an
audit, not a claim that the acceptance matrix already passes.

- [Primary browser measurements](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-Y9ITq5/report.json)
- [Send-race and reduced-motion measurements](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-ZGb5ka/report.json)
- [Primary audit script](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit.ts)
- [Send-race and reduced-motion script](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-edge-cases.ts)
- [Primary browser run log](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-browser.log)
- [Automated tests](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-tests.log): 303 passed in 24 files.
- [Type checking](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-typecheck.log): passed.
- [Production build](/Users/yshuolu/Develop/muon-conversation-scroll-audit/.muon/validation/scroll-audit-build.log): passed; existing bundle-size warning remains.

The retained local evidence lives in the isolated audit worktree. Delayed media,
expansion, actual touch/software-keyboard behavior, reconnect, and the complete
accessibility matrix remain implementation acceptance cases, not browser-verified
claims from this audit.
