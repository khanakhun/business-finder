import { formatSpan, groupDays, WEEKDAYS, type Weekly, weekdayName } from '../format/hours.ts';
import { openNowLabels } from '../i18n/strings.ts';
import { OpenNow } from '../islands/open-now.tsx';
import type { BlockProps, RenderContext } from '../renderer/types.ts';
import { cx, Section, SectionHead } from './shared.tsx';

/** The spans of a day as text (`09:00–12:30, 14:00–19:00`), or "closed". */
const spansText = (spans: Weekly[keyof Weekly], ctx: RenderContext) =>
  spans.length === 0 ? ctx.strings.closed : spans.map((span) => formatSpan(span, ctx.locale)).join(', ');

/** The week as a table of days (every day on its row). */
export function HoursTable({
  weekly,
  ctx,
  caption,
}: {
  weekly: Weekly;
  ctx: RenderContext;
  caption?: string | undefined;
}) {
  return (
    <table className="w-full border-collapse text-left">
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <tbody className="bf-divided">
        {WEEKDAYS.map((day) => (
          <tr key={day} className={cx(weekly[day].length === 0 && 'bf-muted')}>
            <th scope="row" className="py-3 pr-6 font-medium capitalize">
              {weekdayName(day, ctx.locale)}
            </th>
            <td className="bf-num py-3 text-right">{spansText(weekly[day], ctx)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The week grouped by identical days (`Monday–Friday 09:00–18:00`). */
export function HoursCompact({ weekly, ctx }: { weekly: Weekly; ctx: RenderContext }) {
  return (
    <dl className="flex flex-col gap-2">
      {groupDays(weekly).map((group) => (
        <div key={group.from} className="flex flex-wrap justify-between gap-x-6">
          <dt className="font-medium capitalize">
            {group.from === group.to
              ? weekdayName(group.from, ctx.locale)
              : `${weekdayName(group.from, ctx.locale)}–${weekdayName(group.to, ctx.locale)}`}
          </dt>
          <dd className={cx('bf-num', group.spans.length === 0 && 'bf-muted')}>
            {spansText(group.spans, ctx)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Opening hours from `contact.hours`, with whether it is open now (computed in the browser, in the business's zone). */
export function Hours({ block, ctx, tone }: BlockProps<'hours'>) {
  const { props, variant } = block;
  const hours = ctx.spec.contact.hours;
  if (!hours) return null;
  const heading = props.heading ?? undefined;
  // The block's note and the hours' own note, once each.
  const notes = [
    ...new Set([props.note, hours.note].filter((note) => note !== undefined).map((note) => ctx.t(note))),
  ];
  return (
    <Section id={block.id} type="hours" variant={variant} tone={tone} labelled>
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={heading} fallback={ctx.strings.hours} ctx={ctx} />
        <div className={cx('mx-auto flex flex-col gap-6', variant === 'table' ? 'max-w-xl' : 'max-w-md')}>
          {ctx.timeZone ? (
            <OpenNow
              weekly={hours.weekly}
              timeZone={ctx.timeZone}
              locale={ctx.locale}
              labels={openNowLabels(ctx.locale)}
            />
          ) : null}
          {variant === 'table' ? (
            <HoursTable weekly={hours.weekly} ctx={ctx} />
          ) : (
            <HoursCompact weekly={hours.weekly} ctx={ctx} />
          )}
          {notes.map((note) => (
            <p key={note} className="bf-muted text-sm">
              {note}
            </p>
          ))}
        </div>
      </div>
    </Section>
  );
}
