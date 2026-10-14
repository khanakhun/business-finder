/** True when the key event comes from a place where typing should not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** `mod` = ⌘ on Apple platforms, Ctrl elsewhere (either is accepted so remote desktops work). */
export function isModKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}
