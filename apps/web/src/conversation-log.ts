import type { PageEvent } from "../../../packages/contracts/src/conversation-log.ts";
import { api } from "./lib.tsx";

export const pageId = crypto.randomUUID();
const pending: PageEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let writing = false;

async function flush() {
  timer = undefined;
  if (writing || !pending.length) return;
  writing = true;
  const events = pending.splice(0, 64);
  try {
    await api("/conversation/log", { page: pageId, events });
  } catch {
    // The service may be offline. Keep a bounded backlog until the next event.
    pending.unshift(...events);
    if (pending.length > 256) pending.splice(0, pending.length - 256);
    return;
  } finally {
    writing = false;
  }
  if (pending.length) schedule();
}
function schedule() {
  if (!timer && !writing) timer = setTimeout(flush, 150);
}
export function logPage(stage: PageEvent["stage"], detail: Pick<PageEvent,"version"|"message"> = {}) {
  if (pending.length === 256) pending.shift();
  pending.push({ stage, at: new Date().toISOString(), ...detail });
  schedule();
}

// A list update can be off-screen in a virtualized or hidden conversation.
const seen = new WeakMap<Element,string>();
const visibleRows = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting || document.hidden) continue;
    const id = entry.target.getAttribute("data-message-id");
    if (id && seen.get(entry.target) !== id) {
      seen.set(entry.target, id);
      logPage("on_screen", { message: id });
    }
    visibleRows.unobserve(entry.target);
  }
});
export function observeMessage(el: HTMLElement) {
  if (seen.get(el) !== el.dataset.messageId) visibleRows.observe(el);
  return () => visibleRows.unobserve(el);
}
