'use client';

import { HOLIDAY_CALENDARS, type SendWindow, WEEKDAYS } from '@bf/contracts';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { cn } from '@bf/ui/lib/utils';
import { useTranslations } from 'next-intl';

// The sending window (BF-050): days, hours, whose clock (the recipient's by default), the mailbox's zone and holiday
// calendars, with a sentence previewing what it means.

export function WindowEditor({
  value,
  onChange,
  disabled,
}: {
  readonly value: SendWindow;
  readonly onChange: (next: SendWindow) => void;
  readonly disabled?: boolean;
}) {
  const t = useTranslations('mailboxes.window');
  const day = useTranslations('mailboxes.days');
  const toggleDay = (weekday: (typeof WEEKDAYS)[number]) => {
    const days = value.days.includes(weekday)
      ? value.days.filter((d) => d !== weekday)
      : [...value.days, weekday];
    if (days.length > 0) onChange({ ...value, days: WEEKDAYS.filter((d) => days.includes(d)) });
  };
  const toggleCalendar = (calendar: (typeof HOLIDAY_CALENDARS)[number]) =>
    onChange({
      ...value,
      holidayCalendars: value.holidayCalendars.includes(calendar)
        ? value.holidayCalendars.filter((c) => c !== calendar)
        : [...value.holidayCalendars, calendar],
    });
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">{t('title')}</legend>
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">{t('days')}</legend>
        {WEEKDAYS.map((weekday) => (
          <button
            key={weekday}
            type="button"
            aria-pressed={value.days.includes(weekday)}
            onClick={() => toggleDay(weekday)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs',
              value.days.includes(weekday)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'text-muted-foreground',
            )}
          >
            {day(weekday)}
          </button>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="window-start">{t('start')}</Label>
          <Input
            id="window-start"
            type="time"
            value={value.start}
            onChange={(event) => onChange({ ...value, start: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="window-end">{t('end')}</Label>
          <Input
            id="window-end"
            type="time"
            value={value.end}
            onChange={(event) => onChange({ ...value, end: event.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="window-mode">{t('clock')}</Label>
          <Select
            value={value.timezoneMode}
            onValueChange={(mode) => onChange({ ...value, timezoneMode: mode as SendWindow['timezoneMode'] })}
          >
            <SelectTrigger id="window-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recipient">{t('recipient')}</SelectItem>
              <SelectItem value="mailbox">{t('mailbox')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="window-zone">{t('zone')}</Label>
          <Input
            id="window-zone"
            value={value.mailboxTimezone}
            maxLength={64}
            onChange={(event) => onChange({ ...value, mailboxTimezone: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-sm">{t('holidays')}</p>
        <div className="flex flex-wrap gap-3">
          {HOLIDAY_CALENDARS.map((calendar) => (
            <Label key={calendar} className="flex items-center gap-1.5 font-normal">
              <Checkbox
                checked={value.holidayCalendars.includes(calendar)}
                onCheckedChange={() => toggleCalendar(calendar)}
              />
              {t(`calendar.${calendar}`)}
            </Label>
          ))}
        </div>
      </div>
      <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
        {t(value.timezoneMode === 'recipient' ? 'previewRecipient' : 'previewMailbox', {
          days: value.days.map((d) => day(d)).join(', '),
          start: value.start,
          end: value.end,
          zone: value.mailboxTimezone,
        })}
      </p>
    </fieldset>
  );
}
