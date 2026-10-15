'use client';

import type { AreaCandidate, ParseSearchIntentResponse } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { cn } from '@bf/ui/lib/utils';
import { Loader2Icon, SearchIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { useParseIntent, useSearchState } from './hooks.tsx';
import { intentToState, locationOf } from './url-state.ts';

export interface ParsedIntent {
  readonly response: ParseSearchIntentResponse;
  readonly prompt: string;
}

/**
 * The prompt (BF-023): a sentence in English or French becomes the search. Parsing replaces the filters; editing
 * chips afterwards never re-parses. Enter searches, Shift+Enter adds a line.
 */
export function PromptBar({
  inputRef,
  onParsed,
}: {
  readonly inputRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly onParsed: (parsed: ParsedIntent | null) => void;
}) {
  const t = useTranslations('search.prompt');
  const errorMessage = useErrorMessage();
  const [state, setState] = useSearchState();
  const [text, setText] = React.useState(state.prompt ?? '');
  const parse = useParseIntent();
  const [clarification, setClarification] = React.useState<ParsedIntent | null>(null);

  // Another search loaded from the URL (back/forward, a saved search) shows its own prompt.
  React.useEffect(() => setText(state.prompt ?? ''), [state.prompt]);

  const submit = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || parse.isPending) return;
    const response = await parse.mutateAsync(trimmed).catch(() => null);
    if (!response) return;
    await setState(intentToState(response.intent, trimmed, response.resolvedArea));
    const parsed = { response, prompt: trimmed };
    setClarification(response.intent.needsClarification ? parsed : null);
    onParsed(parsed);
  };

  const choose = async (option: string) => {
    if (!clarification) return;
    const area = clarification.response.alternatives.find((a: AreaCandidate) => a.label === option);
    if (area) {
      // A place question: take that place, keep everything else.
      await setState(locationOf(area));
      setClarification(null);
      return;
    }
    // Any other question: answer it in the prompt and read it again.
    const next = `${clarification.prompt} (${option})`;
    setText(next);
    await submit(next);
  };

  const examples = [t('example1'), t('example2'), t('example3')];
  const question = clarification?.response.intent.needsClarification;

  return (
    <div className="space-y-2">
      <form
        className={cn(
          'flex items-start gap-2 rounded-xl border-2 border-border bg-surface p-2 transition-colors',
          'focus-within:border-lagoon',
          parse.isPending && 'animate-pulse',
        )}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(text);
        }}
      >
        <SearchIcon aria-hidden className="mt-2.5 ml-1 size-5 shrink-0 text-muted-foreground" />
        <label htmlFor="search-prompt" className="sr-only">
          {t('label')}
        </label>
        <textarea
          id="search-prompt"
          ref={inputRef}
          rows={1}
          value={text}
          maxLength={500}
          placeholder={t('placeholder')}
          aria-describedby="search-prompt-hint"
          className="field-sizing-content max-h-40 min-h-10 flex-1 resize-none bg-transparent py-2 text-lg leading-snug outline-none placeholder:text-muted-foreground"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit(text);
            }
          }}
        />
        <Button type="submit" size="lg" disabled={!text.trim() || parse.isPending}>
          {parse.isPending ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
          {parse.isPending ? t('reading') : t('submit')}
        </Button>
      </form>
      <p id="search-prompt-hint" className="sr-only">
        {t('hint')}
      </p>
      {parse.isError ? (
        <p role="alert" className="text-sm text-reef">
          {errorMessage(parse.error)}
        </p>
      ) : null}
      {question ? (
        <section aria-label={question.question} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{question.question}</span>
          {(question.options ?? []).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void choose(option)}
            >
              {option}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => setClarification(null)}>
            {t('dismiss')}
          </Button>
        </section>
      ) : null}
      {!state.prompt && !text ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{t('try')}</span>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="rounded-full border border-border px-3 py-1 hover:border-lagoon hover:text-foreground"
              onClick={() => {
                setText(example);
                void submit(example);
              }}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
