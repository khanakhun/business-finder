/**
 * A plug-in registry (BF-024): pages render whatever is registered, so later tickets add tabs, actions or renderers
 * by registering them — never by editing the page. Registering an id again replaces the earlier entry.
 */
export interface Registry<T extends { readonly id: string; readonly order: number }> {
  /** Registers (or replaces, by id); returns an unregister function. */
  register(entry: T): () => void;
  get(id: string): T | undefined;
  /** Every entry, lower `order` first (then by id). */
  list(): T[];
  /** Test helper: forget every registration. */
  reset(): void;
}

export function createRegistry<T extends { readonly id: string; readonly order: number }>(): Registry<T> {
  const entries = new Map<string, T>();
  return {
    register(entry) {
      entries.set(entry.id, entry);
      return () => {
        if (entries.get(entry.id) === entry) entries.delete(entry.id);
      };
    },
    get: (id) => entries.get(id),
    list: () => [...entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    reset: () => entries.clear(),
  };
}
