import { z } from 'zod';
import { normalizePublicationDate } from './publication-date.js';

const dateSchema = z.iso.date();
const normalizedTimestampSchema = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value),
  'normalized timestamps cannot silently discard submillisecond precision',
);
const exactTimeSchemas = {
  minute: z.iso.datetime({ offset: true, precision: -1 }),
  second: z.iso.datetime({ offset: true, precision: 0 }),
  millisecond: z.iso.datetime({ offset: true, precision: 3 }),
};

export const socialPublicationTimeSchema = z.object({
  original: z.object({
    value: z.string().min(1),
    representation: z.enum(['text', 'iso8601', 'unix-seconds', 'unix-milliseconds']),
  }).strict().nullable(),
  precision: z.enum(['unknown', 'day', 'minute', 'second', 'millisecond']),
  timezone: z.string().min(1).nullable(),
  normalizedAt: normalizedTimestampSchema.nullable(),
  publishedOn: dateSchema.nullable(),
}).strict().superRefine((time, context) => {
  if (time.original === null) {
    if (time.precision !== 'unknown' || time.normalizedAt !== null ||
        time.publishedOn !== null || time.timezone !== null) {
      context.addIssue({ code: 'custom', message: 'missing original time cannot acquire inferred precision' });
    }
    return;
  }

  let instant: number | null = null;
  let calendarDay: string | null = null;
  const { value, representation } = time.original;
  if (representation === 'text') {
    if (time.normalizedAt !== null || (time.precision !== 'unknown' && time.precision !== 'day')) {
      context.addIssue({ code: 'custom', path: ['precision'], message: 'opaque text cannot assert exact time' });
    }
    if (time.precision === 'day') {
      calendarDay = normalizePublicationDate(value);
      if (calendarDay === null) {
        context.addIssue({ code: 'custom', path: ['original'], message: 'day precision needs a recognized calendar date' });
      }
    } else if (time.publishedOn !== null) {
      context.addIssue({ code: 'custom', path: ['publishedOn'], message: 'opaque text cannot invent a calendar day' });
    }
  } else if (representation === 'iso8601') {
    if (dateSchema.safeParse(value).success) {
      calendarDay = value;
      if (time.precision !== 'day' || time.normalizedAt !== null) {
        context.addIssue({ code: 'custom', path: ['precision'], message: 'ISO date-only originals have day precision, not an instant' });
      }
    } else if ((time.precision === 'minute' || time.precision === 'second' || time.precision === 'millisecond') &&
        exactTimeSchemas[time.precision].safeParse(value).success) {
      instant = Date.parse(value);
      calendarDay = value.slice(0, 10);
    } else {
      context.addIssue({ code: 'custom', path: ['original'], message: 'invalid ISO timestamp or contradictory precision; an explicit offset is required' });
      return;
    }
  } else {
    const numeric = Number(value);
    const milliseconds = representation === 'unix-seconds' ? numeric * 1000 : numeric;
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(numeric) ||
        !Number.isSafeInteger(milliseconds) || milliseconds > 253402300799999) {
      context.addIssue({ code: 'custom', path: ['original'], message: 'Unix timestamps must be canonical nonnegative integers within years 1970–9999' });
      return;
    }
    instant = milliseconds;
    const expectedPrecision = representation === 'unix-seconds' ? 'second' : 'millisecond';
    if (time.precision !== expectedPrecision) {
      context.addIssue({ code: 'custom', path: ['precision'], message: 'precision must agree with the original Unix unit' });
    }
    if (time.timezone === null && time.publishedOn !== null) {
      context.addIssue({ code: 'custom', path: ['publishedOn'], message: 'Unix calendar days require a known source timezone' });
    }
  }

  if (time.normalizedAt !== null && (instant === null || Date.parse(time.normalizedAt) !== instant)) {
    context.addIssue({ code: 'custom', path: ['normalizedAt'], message: 'normalized time must represent the original instant exactly' });
  }

  let offsetMinutes: number | null = null;
  let formatter: Intl.DateTimeFormat | null = null;
  if (time.timezone !== null) {
    const offset = /^([+-])([01]\d|2[0-3]):([0-5]\d)$/.exec(time.timezone);
    if (time.timezone === 'UTC' || time.timezone === 'Z') {
      offsetMinutes = 0;
    } else if (offset) {
      offsetMinutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
    } else {
      try {
        formatter = new Intl.DateTimeFormat('en', {
          timeZone: time.timezone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
        });
      } catch {
        context.addIssue({ code: 'custom', path: ['timezone'], message: 'expected IANA timezone, UTC, Z, or explicit numeric offset' });
      }
    }
  }

  if (instant !== null) {
    if (offsetMinutes !== null) {
      calendarDay = new Date(instant + offsetMinutes * 60_000).toISOString().slice(0, 10);
    } else if (formatter !== null) {
      const parts = formatter.formatToParts(instant);
      const year = Number(parts.find((part) => part.type === 'year')!.value);
      const isoYear = parts.find((part) => part.type === 'era')?.value === 'BC' ? 1 - year : year;
      calendarDay = `${String(isoYear).padStart(4, '0')}-${parts.find((part) => part.type === 'month')!.value}-${parts.find((part) => part.type === 'day')!.value}`;
    }
  }
  if (calendarDay !== null && time.publishedOn !== null && time.publishedOn !== calendarDay) {
    context.addIssue({ code: 'custom', path: ['publishedOn'], message: 'calendar day disagrees with the original time and source timezone' });
  }
});
