'use client';

import { CheckIcon, ChevronsUpDownIcon, XIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils.ts';
import { Badge } from './badge.tsx';
import { Button } from './button.tsx';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';

/** A category with its label already in the viewer's locale (the caller picks EN or FR). */
export interface CategoryPickerNode {
  readonly id: string;
  readonly label: string;
  /** Extra words to match while typing (synonyms, the label in the other language). */
  readonly keywords?: readonly string[];
  readonly children: readonly CategoryPickerNode[];
}

export interface CategoryPickerLabels {
  readonly placeholder: string;
  readonly searchPlaceholder: string;
  readonly emptyText: string;
  /** Accessible name of the "remove" button on a selected category, e.g. `(label) => \`Remove ${label}\``. */
  readonly remove: (label: string) => string;
  /** Trigger text when more categories are selected than shown, e.g. `(n) => \`+${n} more\``. */
  readonly more: (count: number) => string;
  /** Screen-reader text on chosen options (e.g. "selected"); cmdk's `aria-selected` marks the highlighted one. */
  readonly selected: string;
}

export interface CategoryPickerProps {
  readonly tree: readonly CategoryPickerNode[];
  /** Selected category ids. */
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  /** Several categories (default) or one. */
  readonly multiple?: boolean;
  readonly labels: CategoryPickerLabels;
  readonly className?: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

interface FlatNode {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  /** Ancestor labels, root first. */
  readonly trail: readonly string[];
  readonly keywords: readonly string[];
  readonly rootId: string;
}

/** Depth-first flattening: top-level groups become headings, descendants are indented under them. */
export function flattenCategories(tree: readonly CategoryPickerNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (node: CategoryPickerNode, depth: number, trail: readonly string[], rootId: string) => {
    out.push({ id: node.id, label: node.label, depth, trail, keywords: node.keywords ?? [], rootId });
    for (const child of node.children) walk(child, depth + 1, [...trail, node.label], rootId);
  };
  for (const root of tree) walk(root, 0, [], root.id);
  return out;
}

const MAX_BADGES = 3;
const ID_SEPARATOR = '\u0000';

/**
 * Tree combobox for the category taxonomy (BF-015): type to search labels and keywords (accent-insensitive, via
 * cmdk), browse groups otherwise; multi-select by default. Keyboard: arrows to move, Enter to toggle, Escape to close.
 */
export function CategoryPicker({
  tree,
  value,
  onChange,
  multiple = true,
  labels,
  className,
  id,
  disabled,
}: CategoryPickerProps) {
  const [open, setOpen] = React.useState(false);
  const flat = React.useMemo(() => flattenCategories(tree), [tree]);
  const byId = React.useMemo(() => new Map(flat.map((node) => [node.id, node])), [flat]);
  const selected = value.map((v) => byId.get(v)).filter((node): node is FlatNode => node !== undefined);
  const groups = React.useMemo(() => {
    const map = new Map<string, FlatNode[]>();
    for (const node of flat) {
      const list = map.get(node.rootId) ?? [];
      list.push(node);
      map.set(node.rootId, list);
    }
    return [...map.entries()].map(([rootId, nodes]) => ({ root: byId.get(rootId) as FlatNode, nodes }));
  }, [flat, byId]);

  const toggle = (nodeId: string) => {
    if (!multiple) {
      onChange(value.includes(nodeId) ? [] : [nodeId]);
      setOpen(false);
      return;
    }
    onChange(value.includes(nodeId) ? value.filter((v) => v !== nodeId) : [...value, nodeId]);
  };

  return (
    <div className={cn('grid gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>
              {selected.length === 0
                ? labels.placeholder
                : selected.length <= MAX_BADGES
                  ? selected.map((node) => node.label).join(', ')
                  : `${selected
                      .slice(0, MAX_BADGES)
                      .map((node) => node.label)
                      .join(', ')} ${labels.more(selected.length - MAX_BADGES)}`}
            </span>
            <ChevronsUpDownIcon aria-hidden className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command
            filter={(itemValue, search, keywords) => {
              // Values are `label␀id`: ids must stay unique for cmdk but never match a search ("ab" in a UUID).
              const label = itemValue.split(ID_SEPARATOR)[0] ?? '';
              const haystack = fold([label, ...(keywords ?? [])].join(' '));
              return fold(search)
                .split(' ')
                .filter(Boolean)
                .every((word) => haystack.includes(word))
                ? 1
                : 0;
            }}
          >
            <CommandInput placeholder={labels.searchPlaceholder} />
            <CommandList className="max-h-80" aria-multiselectable={multiple || undefined}>
              <CommandEmpty>{labels.emptyText}</CommandEmpty>
              {groups.map(({ root, nodes }) => (
                <CommandGroup key={root.id} heading={root.label}>
                  {nodes.map((node) => {
                    const checked = value.includes(node.id);
                    return (
                      <CommandItem
                        key={node.id}
                        value={`${node.label}${ID_SEPARATOR}${node.id}`}
                        keywords={[...node.trail, ...node.keywords]}
                        onSelect={() => toggle(node.id)}
                        data-checked={checked}
                      >
                        <CheckIcon aria-hidden className={cn(checked ? 'opacity-100' : 'opacity-0')} />
                        <span style={{ paddingInlineStart: `${node.depth * 0.75}rem` }} className="truncate">
                          {node.label}
                        </span>
                        {checked ? <span className="sr-only">{labels.selected}</span> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {multiple && selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((node) => (
            <li key={node.id}>
              <Badge variant="secondary" className="gap-1 pe-1">
                <span title={[...node.trail, node.label].join(' › ')}>{node.label}</span>
                <button
                  type="button"
                  className="rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-2"
                  aria-label={labels.remove(node.label)}
                  onClick={() => onChange(value.filter((v) => v !== node.id))}
                  disabled={disabled}
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Lowercase without accents, so "quincaillerie" finds "Quincaillerie" and "cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
