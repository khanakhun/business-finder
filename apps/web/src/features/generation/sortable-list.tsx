'use client';

import { Button } from '@bf/ui/components/button';
import { cn } from '@bf/ui/lib/utils';
import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type * as React from 'react';

// A list ordered by priority (BF-046): the pointer drags a row onto another; the keyboard uses "move up" and "move
// down" (dnd-kit's keyboard drag announces positions poorly in a plain list). Rows that cannot move stay put.

export interface SortableItem {
  readonly id: string;
  /** For the announcements and the buttons' labels. */
  readonly label: string;
  /** Not draggable and not a drop target (e.g. a running job). */
  readonly locked?: boolean;
}

export function SortableList<T extends SortableItem>({
  items,
  label,
  onMove,
  renderItem,
  disabled = false,
}: {
  readonly items: readonly T[];
  readonly label: string;
  /** `id` goes to the position of `to` (an index in `items`). */
  readonly onMove: (id: string, to: number) => void;
  readonly renderItem: (item: T, index: number) => React.ReactNode;
  readonly disabled?: boolean;
}) {
  const t = useTranslations('generation.order');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const name = (id: unknown) => items.find((item) => item.id === id)?.label ?? '';
  const position = (id: unknown) => items.findIndex((item) => item.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('picked', { name: name(active.id) }),
    onDragOver: ({ over }) => (over ? t('over', { position: position(over.id) }) : undefined),
    onDragEnd: ({ active, over }) =>
      over ? t('dropped', { name: name(active.id), position: position(over.id) }) : t('cancelled'),
    onDragCancel: () => t('cancelled'),
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.over.id === event.active.id) return;
    const to = items.findIndex((item) => item.id === event.over?.id);
    if (to >= 0) onMove(String(event.active.id), to);
  };
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} accessibility={{ announcements }}>
      <ol aria-label={label} className="space-y-2">
        {items.map((item, index) => (
          <Row
            key={item.id}
            item={item}
            index={index}
            disabled={disabled || Boolean(item.locked)}
            first={index === 0 || Boolean(items[index - 1]?.locked)}
            last={index === items.length - 1}
            onMove={onMove}
          >
            {renderItem(item, index)}
          </Row>
        ))}
      </ol>
    </DndContext>
  );
}

function Row({
  item,
  index,
  disabled,
  first,
  last,
  onMove,
  children,
}: {
  readonly item: SortableItem;
  readonly index: number;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly onMove: (id: string, to: number) => void;
  readonly children: React.ReactNode;
}) {
  const t = useTranslations('generation.order');
  const drag = useDraggable({ id: item.id, disabled });
  const drop = useDroppable({ id: item.id, disabled });
  return (
    <li
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      data-item-id={item.id}
      className={cn(
        'flex items-start gap-2 rounded-lg border bg-card p-3',
        drag.isDragging && 'opacity-40',
        drop.isOver && !drag.isDragging && 'border-lagoon bg-lagoon-wash',
      )}
    >
      {disabled ? (
        <span className="w-6 pt-1 text-center text-sm tabular-nums text-muted-foreground">{index + 1}</span>
      ) : (
        <div className="flex flex-col items-center gap-0.5">
          <span
            {...drag.listeners}
            {...drag.attributes}
            tabIndex={-1}
            role="presentation"
            className="cursor-grab text-muted-foreground"
          >
            <GripVerticalIcon aria-hidden className="size-4" />
          </span>
          <span className="text-sm tabular-nums text-muted-foreground" aria-hidden>
            {index + 1}
          </span>
        </div>
      )}
      <div className="min-w-0 flex-1">{children}</div>
      {disabled ? null : (
        <div className="flex flex-col gap-0.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={first}
            aria-label={t('up', { name: item.label })}
            onClick={() => onMove(item.id, index - 1)}
          >
            <ArrowUpIcon aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={last}
            aria-label={t('down', { name: item.label })}
            onClick={() => onMove(item.id, index + 1)}
          >
            <ArrowDownIcon aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}
