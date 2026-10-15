'use client';

import * as React from 'react';

export interface Command {
  /** Unique id, e.g. `nav.search` or `sites.publish`. */
  readonly id: string;
  /** Already-translated label shown in the palette. */
  readonly label: string;
  /** Palette group (already translated). */
  readonly group: string;
  /** Extra words matched by the palette's search (e.g. the other language's name). */
  readonly keywords?: readonly string[];
  readonly shortcut?: readonly string[];
  readonly icon?: React.ReactNode;
  run(): void;
}

interface CommandRegistry {
  readonly commands: readonly Command[];
  register(command: Command): () => void;
}

const CommandRegistryContext = React.createContext<CommandRegistry | null>(null);

/**
 * Registry the command palette reads from. Features add commands while mounted with `useRegisterCommands`, so
 * the palette always offers what makes sense on the current screen.
 */
export function CommandRegistryProvider({ children }: { readonly children: React.ReactNode }) {
  const [commands, setCommands] = React.useState<readonly Command[]>([]);
  const register = React.useCallback((command: Command) => {
    setCommands((current) => [...current.filter((c) => c.id !== command.id), command]);
    return () => setCommands((current) => current.filter((c) => c !== command));
  }, []);
  const value = React.useMemo(() => ({ commands, register }), [commands, register]);
  return <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>;
}

export function useCommandRegistry(): CommandRegistry {
  const registry = React.useContext(CommandRegistryContext);
  if (!registry) throw new Error('useCommandRegistry must be used inside CommandRegistryProvider');
  return registry;
}

/**
 * Registers commands for as long as the calling component is mounted. Callers may pass a new array on every render:
 * commands are re-registered only when what the palette shows changes (ids, labels, groups), and `run` always
 * calls the latest version. (Re-registering on every render looped: registering re-renders every consumer.)
 */
export function useRegisterCommands(commands: readonly Command[]): void {
  const { register } = useCommandRegistry();
  const latest = React.useRef(commands);
  React.useLayoutEffect(() => {
    latest.current = commands;
  });
  const signature = commands
    .map((command) =>
      [
        command.id,
        command.label,
        command.group,
        ...(command.keywords ?? []),
        ...(command.shortcut ?? []),
      ].join('\u0000'),
    )
    .join('\u0001');
  // `signature` stands for `commands` (see above); `latest` is a ref.
  React.useEffect(() => {
    const unregister = latest.current.map((command) =>
      register({
        ...command,
        run: () => (latest.current.find((c) => c.id === command.id) ?? command).run(),
      }),
    );
    return () => {
      for (const fn of unregister) fn();
    };
  }, [signature, register]);
}
