import { DOMRenderer } from "./DOMRenderer";
import { Composer, vscode } from "./Composer";
import { AutoScroller } from "./AutoScroller";

/**
 * Frontend entry point. Initializes classes and wires them together.
 * Components do not know about each other directly, they communicate through callbacks here.
 */
const renderer = new DOMRenderer();
const scroller = new AutoScroller();

const composer = new Composer(() => {
  scroller.scrollToBottom(true); // force scroll to bottom when sending a message
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
  }
});

// Notify the backend that the UI is ready to receive state
vscode.postMessage({ type: "intent:ready" });
