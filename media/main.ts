import { DOMRenderer } from "./DOMRenderer";
import { Composer, vscode } from "./Composer";
import { AutoScroller } from "./AutoScroller";

/**
 * Frontend entry point. Initializes classes and wires them together.
 * Components do not know about each other directly; this file wires their events together.
 */
const renderer = new DOMRenderer();
const scroller = new AutoScroller();

const composer = new Composer(() => {
  scroller.scrollToBottom(true); // force scroll to bottom when sending a message
});

// Forward turn-level UI actions from the renderer to the backend.
window.addEventListener("turn:edit", (event) => {
  const { turnId } = (event as CustomEvent<{ turnId: string }>).detail;
  vscode.postMessage({ type: "intent:editUserTurn", turnId });
});

window.addEventListener("turn:retry", (event) => {
  const { turnId } = (event as CustomEvent<{ turnId: string }>).detail;
  vscode.postMessage({
    type: "intent:retryAssistantTurn",
    turnId,
    model: composer.selectedModel(),
    effort: composer.selectedEffort(),
  });
});

window.addEventListener("message", (ev: MessageEvent) => {
  const m = ev.data;
  switch (m.type) {
    case "state:update":
      renderer.render(m.state);
      composer.syncState(m.state);
      scroller.scrollToBottom();
      break;
    case "ui:suggestions":
      composer.showSuggestions(m.query, m.items);
      break;
    case "ui:addDraftAttachments":
      composer.addDraftAttachments(m.attachments);
      break;
    case "ui:setDraft":
      composer.setDraft(m.draft.text, m.draft.attachments);
      break;
  }
});

// Notify the backend that the UI is ready to receive state
vscode.postMessage({ type: "intent:ready" });
