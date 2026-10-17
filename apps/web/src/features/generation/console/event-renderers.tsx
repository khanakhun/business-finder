'use client';

import type { EngineEvent } from '@bf/contracts';
import {
  CameraIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CoinsIcon,
  FilePenIcon,
  FileTextIcon,
  FlagIcon,
  InfoIcon,
  type LucideIcon,
  PencilIcon,
  SearchIcon,
  ShieldCheckIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type * as React from 'react';
import type { LoggedEvent } from './event-log.ts';

// One renderer per engine event type (BF-046): a registry, so a new event type is one entry here. Every renderer
// shows untrusted text (an agent's logs and summaries) as plain text, never as markup.

type Of<T extends EngineEvent['type']> = Extract<LoggedEvent, { type: T }>;
type Renderer<T extends EngineEvent['type']> = (props: { readonly event: Of<T> }) => React.ReactNode;

const TOOL_ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/sitekit/i, ShieldCheckIcon],
  [/^(read|view|cat)/i, FileTextIcon],
  [/^(edit|write|apply|patch)/i, PencilIcon],
  [/^(grep|glob|search|find)/i, SearchIcon],
  [/^(bash|shell|exec|command)/i, TerminalIcon],
];

export function toolIcon(tool: string): LucideIcon {
  return TOOL_ICONS.find(([pattern]) => pattern.test(tool))?.[1] ?? WrenchIcon;
}

function Line({
  icon: Icon,
  tone,
  children,
}: {
  readonly icon: LucideIcon;
  readonly tone?: 'muted' | 'warn' | 'error' | 'ok' | undefined;
  readonly children: React.ReactNode;
}) {
  const color =
    tone === 'error'
      ? 'text-destructive'
      : tone === 'warn'
        ? 'text-amber-800 dark:text-amber-200'
        : tone === 'ok'
          ? 'text-emerald-800 dark:text-emerald-200'
          : tone === 'muted'
            ? 'text-muted-foreground'
            : '';
  return (
    <span className={`flex min-w-0 items-start gap-2 ${color}`}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

const Status: Renderer<'status'> = ({ event }) => {
  const t = useTranslations('generation.console.events');
  return (
    <Line icon={FlagIcon} tone="muted">
      {t(`phase.${event.phase}`)}
    </Line>
  );
};

const Progress: Renderer<'progress'> = ({ event }) => (
  <Line icon={InfoIcon} tone="muted">
    {Math.round(event.pct)}% · {event.label}
  </Line>
);

const Log: Renderer<'log'> = ({ event }) => (
  <Line
    icon={event.level === 'error' ? CircleAlertIcon : event.level === 'warn' ? TriangleAlertIcon : InfoIcon}
    tone={event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : undefined}
  >
    {event.message}
  </Line>
);

const ToolCall: Renderer<'tool_call'> = ({ event }) => (
  <Line icon={toolIcon(event.tool)}>
    <span className="font-mono text-xs">{event.tool}</span> {event.summary}
  </Line>
);

const FileChange: Renderer<'file_change'> = ({ event }) => (
  <Line icon={FilePenIcon} tone="muted">
    <span className="font-mono text-xs">{event.path}</span>
  </Line>
);

const Usage: Renderer<'usage'> = ({ event }) => {
  const t = useTranslations('generation.console.events');
  const format = useFormatter();
  return (
    <Line icon={CoinsIcon} tone="muted">
      {t('usage', {
        tokens: format.number(event.inputTokens + event.outputTokens),
        cost: format.number(event.costUsd, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }),
      })}
    </Line>
  );
};

const Artifact: Renderer<'artifact'> = ({ event }) => {
  const t = useTranslations('generation.console.events');
  return (
    <Line icon={event.kind === 'screenshot' ? CameraIcon : FileTextIcon} tone="muted">
      {t(`artifact.${event.kind}`)}
    </Line>
  );
};

const ErrorEvent: Renderer<'error'> = ({ event }) => {
  const t = useTranslations('generation.console.events');
  const known = t.has(`errors.${event.code}` as never);
  return (
    <Line icon={CircleAlertIcon} tone="error">
      <span className="font-mono text-xs">{event.code}</span> {event.message}
      <span className="block text-xs text-muted-foreground">
        {known ? t(`errors.${event.code}` as never) : null}{' '}
        {event.retryable ? t('retryable') : t('notRetryable')}
      </span>
    </Line>
  );
};

const Done: Renderer<'done'> = () => {
  const t = useTranslations('generation.console.events');
  return (
    <Line icon={CircleCheckIcon} tone="ok">
      {t('done')}
    </Line>
  );
};

export const EVENT_RENDERERS: { readonly [T in EngineEvent['type']]: Renderer<T> } = {
  status: Status,
  progress: Progress,
  log: Log,
  tool_call: ToolCall,
  file_change: FileChange,
  usage: Usage,
  artifact: Artifact,
  error: ErrorEvent,
  heartbeat: () => null,
  done: Done,
};

export function EventRow({ event }: { readonly event: LoggedEvent }) {
  const Render = EVENT_RENDERERS[event.type] as Renderer<typeof event.type>;
  return <Render event={event as never} />;
}
