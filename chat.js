// chat.js — Model gateway integration (Tokenrouter / GLM 5.3)
// Handles tool-calling, RRULE recurrence parsing, slot-filling state, and conversation history.

const OpenAI = require('openai');
const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// 1. API Client — Tokenrouter endpoint, GLM 5.3 model
// ---------------------------------------------------------------------------
const client = new OpenAI({
  apiKey: process.env.TOKENROUTER_API_KEY,
  baseURL: process.env.TOKENROUTER_BASE_URL || 'https://tokenrouter.me/v1',
});

const MODEL = 'glm-5.3';

// ---------------------------------------------------------------------------
// 2. Slot-Filling State — accumulates extracted fields across turns
// ---------------------------------------------------------------------------

/**
 * Returns a blank event state object. Every field starts as null so we
 * can distinguish "user hasn't told us yet" from "user said none / empty".
 */
function blankEventState() {
  return {
    title: null,
    startDateTime: null,
    endDateTime: null,
    timezone: null,
    recurrenceRule: null,   // raw RRULE string, e.g. "FREQ=WEEKLY;BYDAY=MO"
    recurrenceText: null,   // human-readable, e.g. "every Monday"
    location: null,
    description: null,
  };
}

/** Check whether a value is populated (non-null, non-empty string). */
function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

/** Check if the mandatory slots are all filled. */
function allMandatoryFilled(state) {
  return hasValue(state.title)
    && hasValue(state.startDateTime)
    && hasValue(state.endDateTime);
}

// ---------------------------------------------------------------------------
// 3. Entity Extraction — regex + heuristic parser for user messages
// ---------------------------------------------------------------------------

// Words that are NOT event titles when they appear at the start of a sentence.
// These are common sentence-starting pronouns / determiners / verbs.
const STOP_WORDS = new Set([
  'it', 'the', 'a', 'an', 'my', 'your', 'his', 'her', 'our', 'their',
  'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'he', 'she', 'they',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'please', 'hey', 'hi', 'hello', 'ok', 'okay', 'yes', 'no', 'sure',
  'what', 'when', 'where', 'who', 'how', 'why', 'which',
  'add', 'create', 'make', 'set', 'schedule', 'book', 'plan', 'put',
  'delete', 'remove', 'cancel',
  'on', 'at', 'in', 'for', 'from', 'to', 'every', 'each',
  'morning', 'afternoon', 'evening', 'night',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'tomorrow', 'today', 'next', 'this',
]);

// Day name → ISO day code
const DAY_MAP = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const DAY_RRULE = {
  0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA',
};

// Timezone aliases
const TZ_ALIASES = {
  'est': 'America/New_York', 'eastern': 'America/New_York',
  'cst': 'America/Chicago', 'central': 'America/Chicago',
  'mst': 'America/Denver', 'mountain': 'America/Denver',
  'pst': 'America/Los_Angeles', 'pacific': 'America/Los_Angeles',
  'uk': 'Europe/London', 'gmt': 'Europe/London',
  'ist': 'Asia/Kolkata', 'india': 'Asia/Kolkata',
  'jst': 'Asia/Tokyo', 'japan': 'Asia/Tokyo',
  'aest': 'Australia/Sydney', 'australia': 'Australia/Sydney',
  'nzst': 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland',
  'utc': 'UTC',
};

/**
 * Normalise a time string into 24-hour HH:MM format.
 * Handles "6:30 PM", "6:30pm", "6:30 pm", "18:30", "6pm", etc.
 * CRITICAL: If the raw text has NO am/pm marker, we leave it ambiguous
 * (return the raw string) so the caller can resolve from context.
 *
 * @param {string} raw
 * @returns {{ hours: number, minutes: number, raw: string } | null}
 */
function parseTime(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();

  // Match patterns like "6:30 pm", "6:30pm", "6 pm", "18:30"
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2] || '0', 10);
  const ampm = m[3];

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  // If no ampm and hours <= 12, we can't disambiguate — caller must resolve.

  return { hours, minutes, raw: raw.trim() };
}

/**
 * Build an ISO 8601 datetime string from a date portion + time portion.
 * Uses the given timezone offset or defaults to the system assumption.
 *
 * @param {string} dateStr  - "YYYY-MM-DD" or relative ref
 * @param {{ hours, minutes }} time
 * @param {string} tz       - IANA timezone (used for offset lookup)
 * @returns {string} ISO 8601 datetime
 */
function toISO(dateStr, time, tz) {
  // Construct ISO string directly — no Date objects, no local timezone drift.
  // Google Calendar interprets this as the literal time in the given timezone.
  const pad = (n) => String(n).padStart(2, '0');
  return `${dateStr}T${pad(time.hours)}:${pad(time.minutes)}:00`;
}

/**
 * Parse a user message and merge extracted entities into the current state.
 * Returns a NEW state object (does not mutate the input).
 *
 * Extraction strategy:
 *   1. Detect explicit datetime strings ("6:30 PM", "tomorrow at 3pm")
 *   2. Detect timezone mentions ("EST", "in New York time")
 *   3. Detect recurrence ("every Monday", "daily", "weekly")
 *   4. Detect title — last resort, use remaining noun phrase after removing
 *      time/date/timezone/recurrence tokens.
 *   5. Merge: only overwrite a field if the new message provides a value
 *      for it; otherwise keep the existing state.
 */
function extractEntities(userMessage, currentState) {
  const state = { ...currentState };
  const msg = userMessage.trim();
  const lower = msg.toLowerCase();

  // ── 0. Structured field extraction ("Key: Value" pairs) ──
  //    Handles messages like "Title: SOM AT shift\nTime: Fridays from 6:30 PM..."
  const structuredFields = {};
  const fieldPatterns = [
    { key: 'title',       re: /\btitle\s*:\s*(.+?)(?=(?:\s+(?:time|date|first|repeat|location|description|every|weekly|daily|until|\d{1,2}:\d{2}))|$)/i },
    { key: 'time',        re: /\btime\s*:\s*(.+?)(?=(?:\s+(?:date|first|repeat|location|description|every|weekly|daily|until))|$)/i },
    { key: 'date',        re: /\b(?:date|first\s+occurrence)\s*:\s*(.+?)(?=(?:\s+(?:time|repeat|location|description|every|weekly|daily|until))|$)/i },
    { key: 'repeat',      re: /\b(?:repeat|recurrence|recurring)\s*:\s*(.+?)(?=(?:\s+(?:date|time|location|description))|$)/i },
    { key: 'location',    re: /\blocation\s*:\s*(.+?)(?=(?:\s+(?:description|time|date|repeat|every|weekly|daily|until))|$)/i },
    { key: 'description', re: /\bdescription\s*:\s*(.+?)$/i },
  ];
  for (const { key, re } of fieldPatterns) {
    const m = msg.match(re);
    if (m) {
      const val = m[1].trim().replace(/\s*\.?\s*$/, '');
      if (val && !/^(none|n\/a|nothing|no)$/i.test(val)) {
        structuredFields[key] = val;
      }
    }
  }

  // Apply structured fields to state (only if not already set)
  if (structuredFields.title && !hasValue(state.title)) {
    state.title = structuredFields.title.charAt(0).toUpperCase() + structuredFields.title.slice(1);
  }
  if (structuredFields.location && !hasValue(state.location)) {
    state.location = structuredFields.location;
  }
  if (structuredFields.description && !hasValue(state.description)) {
    state.description = structuredFields.description;
  }

  // ── Parse structured time/date/recurrence fields ──
  // Structured time: "Fridays from 6:30 PM to 8:30 PM" → extract time range + day recurrence
  const structTime = structuredFields.time || null;
  const structDate = structuredFields.date || null;
  const structRepeat = structuredFields.repeat || null;

  // Parse structured time for time range
  let structTimeRangeMatch = null;
  let structSingleTimeMatch = null;
  if (structTime) {
    structTimeRangeMatch = structTime.match(
      /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
    );
    if (!structTimeRangeMatch) {
      structSingleTimeMatch = structTime.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    }
    // Also extract day-of-week recurrence from structured time (e.g., "Fridays")
    if (!hasValue(state.recurrenceRule) && !hasValue(state.recurrenceText)) {
      const dayMatches = [...structTime.toLowerCase().matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day)?s?\b/g)];
      if (dayMatches.length > 0) {
        const days = [...new Set(dayMatches.map(m => DAY_MAP[m[1]]))];
        if (days.length > 0) {
          state.recurrenceRule = `FREQ=WEEKLY;BYDAY=${days.map(d => DAY_RRULE[d]).join(',')}`;
          state.recurrenceText = `every ${days.map(d => Object.entries(DAY_MAP).find(([,v]) => v === d)?.[0]).join(' and ')}`;
        }
      }
    }
  }

  // Parse structured date: "Friday, September 4, 2026" → dateRef
  let structDateRef = null;
  if (structDate) {
    const MONTH_RE = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';
    const m = structDate.match(new RegExp(`((?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?)`, 'i'));
    if (m) {
      const parsed = Date.parse(m[1].replace(/(st|nd|rd|th)/gi, ''));
      if (!isNaN(parsed)) {
        structDateRef = new Date(parsed).toISOString().slice(0, 10);
      }
    }
    // Also try ISO date
    if (!structDateRef) {
      const isoM = structDate.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoM) structDateRef = isoM[1];
    }
    // Also try "next Friday" style
    if (!structDateRef) {
      const nextDay = structDate.toLowerCase().match(/\bnext\s+(sun|mon|tue|wed|thu|fri|sat)(?:day)?\b/);
      if (nextDay) {
        const targetDow = DAY_MAP[nextDay[1]];
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        let diff = targetDow - d.getDay();
        if (diff <= 0) diff += 7;
        d.setDate(d.getDate() + diff);
        structDateRef = d.toISOString().slice(0, 10);
      }
    }
  }

  // Parse structured repeat: "Weekly on Friday until June 20, 2027" → recurrence rule
  if (structRepeat && !hasValue(state.recurrenceRule)) {
    const repeatLower = structRepeat.toLowerCase();
    const rrule = parseRecurrenceText(repeatLower);
    if (rrule) {
      // Check for "until <date>" in the repeat field
      const untilMatch = repeatLower.match(/until\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{4})?)/);
      if (untilMatch) {
        const parsed = Date.parse(untilMatch[1].replace(/(st|nd|rd|th)/gi, ''));
        if (!isNaN(parsed)) {
          const until = new Date(parsed);
          const untilStr = until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
          rrule.until = untilStr;
        }
      }
      state.recurrenceRule = buildRRule(rrule);
      state.recurrenceText = structRepeat;
    }
  }

  // ── Detect explicit timezone ──
  if (!hasValue(state.timezone)) {
    // Check alias map first
    for (const [alias, tz] of Object.entries(TZ_ALIASES)) {
      const re = new RegExp(`\\b${alias}\\b`, 'i');
      if (re.test(lower)) {
        state.timezone = tz;
        break;
      }
    }
    // Also look for "in <City>" patterns after time mentions
    if (!hasValue(state.timezone)) {
      const tzMatch = lower.match(/\b(?:in|at)\s+([a-z\s]+?)\s+time\b/);
      if (tzMatch) {
        const cityGuess = tzMatch[1].trim();
        const mapped = TZ_ALIASES[cityGuess];
        if (mapped) state.timezone = mapped;
      }
    }
  }

  // ── Detect recurrence ──
  if (!hasValue(state.recurrenceRule) && !hasValue(state.recurrenceText)) {
    // Explicit day patterns: "every monday", "on tuesdays and thursdays"
    const dayPattern = /\b(?:every|on)\s+(?:each\s+)?((?:sun|mon|tue|wed|thu|fri|sat)(?:day)?s?(?:\s+and\s+(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?s?)*)\b/gi;
    const dayMatches = [...lower.matchAll(dayPattern)];
    if (dayMatches.length > 0) {
      const allDays = dayMatches.flatMap(m => {
        const dayChunk = m[1];
        return [...dayChunk.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day)?s?\b/gi)]
          .map(d => DAY_MAP[d[1].toLowerCase()]);
      });
      const uniqueDays = [...new Set(allDays)];
      if (uniqueDays.length > 0) {
        state.recurrenceRule = `FREQ=WEEKLY;BYDAY=${uniqueDays.map(d => DAY_RRULE[d]).join(',')}`;
        state.recurrenceText = `every ${uniqueDays.map(d => Object.entries(DAY_MAP).find(([,v]) => v === d)?.[0]).join(' and ')}`;
      }
    }

    // "daily" / "every day"
    if (!hasValue(state.recurrenceRule) && /\b(daily|every\s*day|each\s*day)\b/.test(lower)) {
      state.recurrenceRule = 'FREQ=DAILY';
      state.recurrenceText = 'daily';
    }

    // "weekly" / "every week"
    if (!hasValue(state.recurrenceRule) && /\b(weekly|every\s*week|each\s*week)\b/.test(lower)) {
      state.recurrenceRule = 'FREQ=WEEKLY';
      state.recurrenceText = 'weekly';
    }

    // "monthly" / "every month"
    if (!hasValue(state.recurrenceRule) && /\b(monthly|every\s*month|each\s*month)\b/.test(lower)) {
      state.recurrenceRule = 'FREQ=MONTHLY';
      state.recurrenceText = 'monthly';
    }

    // "biweekly" / "every other week"
    if (!hasValue(state.recurrenceRule) && /\b(biweekly|every\s+other\s+week)\b/.test(lower)) {
      state.recurrenceRule = 'FREQ=WEEKLY;INTERVAL=2';
      state.recurrenceText = 'every other week';
    }

    // "every N weeks/days/months"
    if (!hasValue(state.recurrenceRule)) {
      const intervalMatch = lower.match(/\bevery\s+(\d+)\s+(day|week|month|year)s?\b/);
      if (intervalMatch) {
        const freqMap = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
        const unitMap = { day: 'days', week: 'weeks', month: 'months', year: 'years' };
        state.recurrenceRule = `FREQ=${freqMap[intervalMatch[2]]};INTERVAL=${intervalMatch[1]}`;
        state.recurrenceText = `every ${intervalMatch[1]} ${unitMap[intervalMatch[2]]}`;
      }
    }

    // Count: "for the next N weeks/days"
    if (hasValue(state.recurrenceRule)) {
      const countMatch = lower.match(/for\s+the\s+next\s+(\d+)\s+(day|week|month|year)s?\b/);
      if (countMatch) {
        state.recurrenceRule += `;COUNT=${countMatch[1]}`;
      }
      // Until: "until June 2027", "until 2027-06-17"
      const untilMatch = lower.match(/until\s+(\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/);
      if (untilMatch) {
        const parsed = Date.parse(untilMatch[1]);
        if (!isNaN(parsed)) {
          const d = new Date(parsed);
          const until = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
          state.recurrenceRule += `;UNTIL=${until}`;
        }
      }
    }
  }

  // ── Detect time mentions ──
  // Pattern: "at 6:30 PM", "from 6pm to 8pm", "6:30-8:30", "at 3pm"
  const timeRangeMatch = msg.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
  );
  const singleTimeMatch = msg.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
    || msg.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);

  // ── Detect date references ──
  let dateRef = null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    dateRef = d.toISOString().slice(0, 10);
  } else if (/\btoday\b/.test(lower)) {
    dateRef = today.toISOString().slice(0, 10);
  } else {
    // "next monday", "next tuesday", etc.
    const nextDayMatch = lower.match(/\bnext\s+(sun|mon|tue|wed|thu|fri|sat)(?:day)?\b/);
    if (nextDayMatch) {
      const targetDow = DAY_MAP[nextDayMatch[1]];
      const d = new Date(today);
      const currentDow = d.getDay();
      let diff = targetDow - currentDow;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      dateRef = d.toISOString().slice(0, 10);
    }

    // Explicit date: "on June 15", "June 15th", "September 4, 2026"
    // Requires a month name to avoid false matches like "from 6"
    if (!dateRef) {
      const MONTH_RE = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';
      const explicitDate = msg.match(
        new RegExp(`\\b(?:on\\s+)?((?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?)\\b`, 'i')
      );
      if (explicitDate) {
        const parsed = Date.parse(explicitDate[1].replace(/(st|nd|rd|th)/gi, ''));
        if (!isNaN(parsed)) {
          dateRef = new Date(parsed).toISOString().slice(0, 10);
        }
      }
      // ISO date: "2025-06-15"
      if (!dateRef) {
        const isoMatch = msg.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (isoMatch) dateRef = isoMatch[1];
      }
    }
  }

  // ── Build startDateTime / endDateTime from dateRef + times ──
  // Priority: structured fields > natural language matches
  const bestTimeRange = structTimeRangeMatch || timeRangeMatch;
  const bestSingleTime = structSingleTimeMatch || singleTimeMatch;
  const bestDateRef = structDateRef || dateRef;

  if (!hasValue(state.startDateTime) && bestDateRef) {
    if (bestTimeRange) {
      const t1 = parseTime(bestTimeRange[1]);
      const t2 = parseTime(bestTimeRange[2]);
      if (t1) {
        state.startDateTime = toISO(bestDateRef, t1, state.timezone);
        if (t2) {
          state.endDateTime = toISO(bestDateRef, t2, state.timezone);
        }
      }
    } else if (bestSingleTime) {
      const t = parseTime(bestSingleTime[1]);
      if (t) {
        state.startDateTime = toISO(bestDateRef, t, state.timezone);
        const endH = t.hours + 1;
        state.endDateTime = toISO(bestDateRef, { hours: endH, minutes: t.minutes }, state.timezone);
      }
    } else {
      state.startDateTime = toISO(bestDateRef, { hours: 9, minutes: 0 }, state.timezone);
      state.endDateTime = toISO(bestDateRef, { hours: 10, minutes: 0 }, state.timezone);
    }
  } else if (!hasValue(state.startDateTime) && !bestDateRef && (bestTimeRange || bestSingleTime)) {
    const todayStr = today.toISOString().slice(0, 10);
    if (bestTimeRange) {
      const t1 = parseTime(bestTimeRange[1]);
      const t2 = parseTime(bestTimeRange[2]);
      if (t1) state.startDateTime = toISO(todayStr, t1, state.timezone);
      if (t2) state.endDateTime = toISO(todayStr, t2, state.timezone);
    } else if (bestSingleTime) {
      const t = parseTime(bestSingleTime[1]);
      if (t) {
        state.startDateTime = toISO(todayStr, t, state.timezone);
        state.endDateTime = toISO(todayStr, { hours: t.hours + 1, minutes: t.minutes }, state.timezone);
      }
    }
  }

  // ── Detect title ──
  // Strategy: strip out everything we've already parsed (dates, times, recurrence,
  // timezone, filler words) and treat the remaining noun phrase as the title.
  if (!hasValue(state.title)) {
    let titleCandidate = msg;

    // Remove date/time/recurrence/timezone/filler tokens
    const stripPatterns = [
      /\b(?:tomorrow|today|next\s+(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?)\b/gi,
      /\b(?:every|each|daily|weekly|monthly|yearly|biweekly)\b/gi,
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi,
      /\b(?:morning|afternoon|evening|night)\b/gi,
      /\b(?:for|the|next|previous|last|this|coming)\b/gi,
      /\b\d{4}-\d{2}-\d{2}\b/g,
      /\b(?:on|at|from|to|until|in|of)\b/gi,
      /\b(?:am|pm|a\.m\.|p\.m\.)\b/gi,
      /\b(?:est|cst|mst|pst|utc|gmt|ist|jst|aest|nzst)\b/gi,
      /\b(?:eastern|central|mountain|pacific|india|japan|australia|new\s+zealand)\b/gi,
      /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
      /\b(?:add|create|make|set|schedule|book|plan|put|delete|remove|cancel|an?|event|meeting|shift|appointment)\b/gi,
      /[,\-–—]+/g,
    ];
    for (const pat of stripPatterns) {
      titleCandidate = titleCandidate.replace(pat, ' ');
    }
    // Collapse whitespace
    titleCandidate = titleCandidate.replace(/\s+/g, ' ').trim();

    // Remove leading stop words
    const words = titleCandidate.split(' ');
    while (words.length > 0 && STOP_WORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    titleCandidate = words.join(' ').trim();

    // If what remains is meaningful (>= 2 chars and not just a number), use it
    if (titleCandidate.length >= 2 && !/^\d+$/.test(titleCandidate)) {
      state.title = titleCandidate.charAt(0).toUpperCase() + titleCandidate.slice(1);
    }
  }

  // ── Detect location ──
  if (!hasValue(state.location)) {
    const locMatch = msg.match(/\b(?:at|in|location|place|room|venue)[:\s]+([A-Za-z0-9\s,.'-]+?)(?:\.|,|\band\b|$)/i);
    if (locMatch) {
      const loc = locMatch[1].trim();
      if (loc && !/^(none|n\/a|nothing|no)$/i.test(loc)) {
        state.location = loc;
      }
    }
  }

  // ── Detect description ──
  if (!hasValue(state.description)) {
    const descMatch = msg.match(/\b(?:description|notes?|details?|about|regarding)[:\s]+(.+?)(?:\.|$)/i);
    if (descMatch) {
      const desc = descMatch[1].trim();
      if (desc && !/^(none|n\/a|nothing|no)$/i.test(desc)) {
        state.description = desc;
      }
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// 4. RRULE helpers
// ---------------------------------------------------------------------------

function buildRRule(opts) {
  if (!opts || !opts.freq) return null;
  const parts = [`FREQ=${opts.freq.toUpperCase()}`];
  if (opts.interval && opts.interval > 1) parts.push(`INTERVAL=${opts.interval}`);
  if (opts.byDay && opts.freq.toUpperCase() === 'WEEKLY') parts.push(`BYDAY=${opts.byDay.toUpperCase()}`);
  if (opts.count) parts.push(`COUNT=${opts.count}`);
  else if (opts.until) parts.push(`UNTIL=${opts.until.replace(/-/g, '')}`);
  return parts.join(';');
}

function parseRecurrenceText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(daily|every\s*day|each\s*day)\b/.test(t)) return { freq: 'DAILY', interval: 1 };
  if (/\b(weekly|every\s*week|each\s*week)\b/.test(t)) return { freq: 'WEEKLY', interval: 1 };
  if (/\b(monthly|every\s*month|each\s*month)\b/.test(t)) return { freq: 'MONTHLY', interval: 1 };
  if (/\b(yearly|annually|every\s*year|each\s*year)\b/.test(t)) return { freq: 'YEARLY', interval: 1 };
  const everyN = t.match(/every\s+(\d+)\s+(day|week|month|year)s?/);
  if (everyN) {
    const map = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
    return { freq: map[everyN[2]], interval: parseInt(everyN[1], 10) };
  }
  const dayMap = {
    sun: 'SU', sunday: 'SU', mon: 'MO', monday: 'MO', tue: 'TU', tuesday: 'TU',
    wed: 'WE', wednesday: 'WE', thu: 'TH', thursday: 'TH', fri: 'FR', friday: 'FR',
    sat: 'SA', saturday: 'SA',
  };
  const dayMatches = [...t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day)?s?\b/g)];
  if (dayMatches.length > 0) {
    const days = [...new Set(dayMatches.map(m => dayMap[m[1]]))];
    return { freq: 'WEEKLY', interval: 1, byDay: days.join(',') };
  }
  if (/\bbiweekly\b/.test(t)) return { freq: 'WEEKLY', interval: 2 };
  if (/\bbimonthly\b/.test(t)) return { freq: 'MONTHLY', interval: 2 };
  return null;
}

// ---------------------------------------------------------------------------
// 5. Tool definitions
// ---------------------------------------------------------------------------
const tools = [
  {
    type: 'function',
    function: {
      name: 'listEvents',
      description: 'List calendar events for a given date range.',
      parameters: {
        type: 'object',
        properties: {
          timeMin: { type: 'string', description: 'Start of time range in ISO 8601 format' },
          timeMax: { type: 'string', description: 'End of time range in ISO 8601 format' },
          maxResults: { type: 'integer', description: 'Maximum number of events to return (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createEvent',
      description: 'Create a new calendar event. Supports single and recurring events.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title / summary' },
          description: { type: 'string', description: 'Event description or notes' },
          location: { type: 'string', description: 'Event location' },
          startDateTime: { type: 'string', description: 'Event start in ISO 8601 format' },
          endDateTime: { type: 'string', description: 'Event end in ISO 8601 format' },
          timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York)' },
          recurrence: {
            type: 'object',
            description: 'RFC 5545 RRULE for recurring events.',
            properties: { rrule: { type: 'string', description: 'Full RRULE string' } },
          },
          recurrenceText: { type: 'string', description: 'Natural-language recurrence description' },
          recurrenceCount: { type: 'integer', description: 'Total occurrences for recurrence' },
        },
        required: ['summary', 'startDateTime', 'endDateTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deleteEvent',
      description: 'Delete a calendar event by its ID.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'The Google Calendar event ID to delete' },
        },
        required: ['eventId'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 6. Google Calendar helpers
// ---------------------------------------------------------------------------

async function listEvents(args, auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: args.timeMin || new Date().toISOString(),
    timeMax: args.timeMax || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: args.maxResults || 10,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return response.data.items || [];
}

async function createEvent(args, auth) {
  const calendar = google.calendar({ version: 'v3', auth });

  let rrule = null;
  if (args.recurrence && args.recurrence.rrule) {
    rrule = args.recurrence.rrule;
  } else if (args.recurrenceText) {
    const parsed = parseRecurrenceText(args.recurrenceText);
    if (parsed) rrule = buildRRule({ ...parsed, count: args.recurrenceCount });
  }

  const tz = args.timezone || 'UTC';
  const event = {
    summary: args.summary,
    description: args.description || '',
    location: args.location || '',
    start: { dateTime: args.startDateTime, timeZone: tz },
    end: { dateTime: args.endDateTime, timeZone: tz },
  };
  // Google Calendar API requires the "RRULE:" prefix on each recurrence string.
  // See: https://developers.google.com/calendar/api/v3/reference/events/insert
  if (rrule) event.recurrence = ['RRULE:' + rrule];

  const response = await calendar.events.insert({ calendarId: 'primary', resource: event });
  return response.data;
}

async function deleteEvent(args, auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId: 'primary', eventId: args.eventId });
  return { success: true, message: 'Event deleted successfully' };
}

// ---------------------------------------------------------------------------
// 7. System Prompt — enforces cumulative slot-filling
// ---------------------------------------------------------------------------

function buildSystemPrompt(eventState, now, customPrompt = null) {
  // Build a human-readable summary of what's already been collected
  const collected = [];
  if (hasValue(eventState.title)) collected.push(`- Title: "${eventState.title}"`);
  if (hasValue(eventState.startDateTime)) collected.push(`- Start: ${eventState.startDateTime}`);
  if (hasValue(eventState.endDateTime)) collected.push(`- End: ${eventState.endDateTime}`);
  if (hasValue(eventState.timezone)) collected.push(`- Timezone: ${eventState.timezone}`);
  if (hasValue(eventState.recurrenceRule)) collected.push(`- Recurrence: ${eventState.recurrenceRule} (${eventState.recurrenceText || ''})`);
  if (hasValue(eventState.location)) collected.push(`- Location: ${eventState.location}`);
  if (hasValue(eventState.description)) collected.push(`- Description: ${eventState.description}`);

  const missing = [];
  if (!hasValue(eventState.title)) missing.push('title');
  if (!hasValue(eventState.startDateTime)) missing.push('start date/time');
  if (!hasValue(eventState.endDateTime)) missing.push('end date/time');
  if (!hasValue(eventState.timezone)) missing.push('timezone');

  const collectedBlock = collected.length > 0
    ? `Collected so far:\n${collected.join('\n')}`
    : 'No fields collected yet.';

  const missingBlock = missing.length > 0
    ? `Still missing (MUST ask for these): ${missing.join(', ')}`
    : 'All mandatory fields collected.';

  // If the user provided a custom system prompt, use it as the base
  // and append the slot-filling state so the agent still has context.
  const basePrompt = customPrompt
    ? `${customPrompt}\n\nYou also have access to calendar tools (listEvents, createEvent, deleteEvent). Use them when the user asks to manage their calendar.`
    : `You are a calendar assistant. You manage the user's Google Calendar via tool calls.`;

  return `${basePrompt}

## SLOT-FILLING STATE MACHINE — YOU MUST FOLLOW THIS EXACTLY

${collectedBlock}

${missingBlock}

### RULES — VIOLATION = FAILURE

1. NEVER ask for a field that is already listed in "Collected so far".
2. NEVER re-ask for the title if it appears above.
3. NEVER re-ask for the timezone if it appears above.
4. When the user provides a new piece of information, MERGE it into the existing state. Do NOT discard previously collected fields.
5. If the user says "6:30" and a prior turn established "PM", treat it as 6:30 PM — do NOT reinterpret as AM.
6. Do NOT treat sentence-starting words like "IT", "The", "My" as event titles. These are pronouns/determiners.
7. ONLY ask for fields in the "Still missing" list. Ask for AT MOST 1-2 missing fields per turn.
8. When ALL mandatory fields (title, start, end, timezone) are present, IMMEDIATELY call createEvent. Do NOT ask about optional fields (description, location) if they are not provided.
9. If the user says "that's all" or "no more details" or "just create it" and the mandatory fields are filled, call createEvent immediately.

### RECURRENCE — FULLY SUPPORTED
The createEvent tool FULLY supports recurring events. The recurrence field accepts RFC 5545 RRULE strings.
Examples the tool accepts:
  - recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }
  - recurrence: { rrule: "FREQ=DAILY" }
  - recurrence: { rrule: "FREQ=MONTHLY;BYMONTHDAY=15" }
  - recurrence: { rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU" }
  - recurrence: { rrule: "FREQ=WEEKLY;BYDAY=FR;UNTIL=20270620T120000Z" }
NEVER tell the user that recurrence is unsupported. Always create recurring events when asked.

### TIMEZONE RULE
- If no timezone was provided by the user, you MUST ask "Which timezone?" before calling createEvent.
- Common timezone names: America/New_York, America/Chicago, America/Denver, America/Los_Angeles, Europe/London, Asia/Kolkata, UTC.
- The user may say "EST" → use America/New_York, "PST" → America/Los_Angeles, etc.

### CONFIRMATION FORMAT
When confirming a created event, output:
- Event title
- Date & time (formatted nicely)
- Recurrence (if any, e.g. "Every Monday at 9:00 AM")
- Timezone
- Location (if any)

When listing events, use a numbered list with date, time, and title.

Current date/time: ${now.toISOString()}`;
}

// ---------------------------------------------------------------------------
// 8. LLM-based extraction — fallback when regex misses fields
// ---------------------------------------------------------------------------

const extractionTool = [
  {
    type: 'function',
    function: {
      name: 'extractEventDetails',
      description: 'Extract structured event details from the user\'s message. Call this for EVERY user message that mentions creating or scheduling an event.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title / summary' },
          startDateTime: { type: 'string', description: 'Event start in ISO 8601 format (YYYY-MM-DDTHH:MM:SS)' },
          endDateTime: { type: 'string', description: 'Event end in ISO 8601 format (YYYY-MM-DDTHH:MM:SS)' },
          timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York)' },
          recurrence: { type: 'string', description: 'RFC 5545 RRULE string (e.g. FREQ=WEEKLY;BYDAY=MO)' },
          recurrenceDescription: { type: 'string', description: 'Human-readable recurrence (e.g. every Monday)' },
          location: { type: 'string', description: 'Event location' },
          description: { type: 'string', description: 'Event description or notes' },
        },
        required: ['title', 'startDateTime', 'endDateTime'],
      },
    },
  },
];

/**
 * Ask the LLM to extract event details from a message.
 * Returns a partial state object with whatever the LLM could extract.
 */
async function llmExtractEvent(userMessage, now) {
  const prompt = `You are an event detail extractor. Given the user's message, extract event details.
Current date/time: ${now.toISOString()}
Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Rules:
- For dates like "tomorrow", "next Friday", "September 4" — compute the actual ISO date.
- For times like "3pm", "6:30 PM" — use 24-hour format in the ISO string.
- For recurrence like "every Monday", "weekly on Fridays" — generate the RFC 5545 RRULE.
- For "until June 2027" — add UNTIL=YYYYMMDDT000000Z to the RRULE.
- If the user gives a duration (e.g. "for 1 hour", "for 30 minutes"), compute endDateTime from start + duration.
- If no end time is given, default to start + 1 hour.
- If no timezone is mentioned, leave timezone as null.
- Title: extract the event name. Ignore words like "create", "add", "schedule", "set up", "meeting", "event".`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userMessage },
      ],
      tools: extractionTool,
      tool_choice: { type: 'function', function: { name: 'extractEventDetails' } },
      stream: false,
    });

    const msg = response.choices[0].message;
    if (msg.tool_calls && msg.tool_calls[0]) {
      return JSON.parse(msg.tool_calls[0].function.arguments);
    }
  } catch (err) {
    console.error('LLM extraction failed:', err.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 9. Main chat function
// ---------------------------------------------------------------------------

/**
 * @param {string} userMessage
 * @param {object} auth           - Google OAuth2 client
 * @param {Array}  conversationHistory - rolling message history
 * @param {object} eventState     - mutable slot-filling state from session
 * @param {string|null} customPrompt - optional user-defined system prompt override
 * @returns {{ reply: string, eventState: object }}
 */
async function chat(userMessage, auth, conversationHistory = [], eventState = null, customPrompt = null) {
  // Initialise state if first call
  if (!eventState) eventState = blankEventState();

  const now = new Date();

  // ── Step 1: Regex extraction (fast path, no API call) ──
  eventState = extractEntities(userMessage, eventState);

  // ── Step 2: If regex got all mandatory fields, create directly ──
  if (allMandatoryFilled(eventState)) {
    return await createEventDirectly(eventState, auth);
  }

  // ── Step 3: Regex missed fields — ask LLM to extract ──
  const extracted = await llmExtractEvent(userMessage, now);
  if (extracted) {
    // Merge LLM extraction into state (only fill missing fields)
    if (!hasValue(eventState.title) && extracted.title) eventState.title = extracted.title;
    if (!hasValue(eventState.startDateTime) && extracted.startDateTime) eventState.startDateTime = extracted.startDateTime;
    if (!hasValue(eventState.endDateTime) && extracted.endDateTime) eventState.endDateTime = extracted.endDateTime;
    if (!hasValue(eventState.timezone) && extracted.timezone) eventState.timezone = extracted.timezone;
    if (!hasValue(eventState.location) && extracted.location) eventState.location = extracted.location;
    if (!hasValue(eventState.description) && extracted.description) eventState.description = extracted.description;
    if (!hasValue(eventState.recurrenceRule) && extracted.recurrence) {
      eventState.recurrenceRule = extracted.recurrence;
      eventState.recurrenceText = extracted.recurrenceDescription || extracted.recurrence;
    }

    // Check again after LLM extraction
    if (allMandatoryFilled(eventState)) {
      return await createEventDirectly(eventState, auth);
    }
  }

  // ── Step 4: Still missing fields — continue slot-filling conversation ──
  const systemContent = buildSystemPrompt(eventState, now, customPrompt);

  const messages = [
    { role: 'system', content: systemContent },
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    stream: false,
  });

  let assistantMessage = response.choices[0].message;

  // Agentic tool-calling loop (for listEvents, deleteEvent, or if LLM calls createEvent)
  while (assistantMessage.tool_calls) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const { name, arguments: argsStr } = toolCall.function;
      const args = JSON.parse(argsStr);
      let result;

      try {
        if (name === 'listEvents') {
          result = await listEvents(args, auth);
        } else if (name === 'createEvent') {
          result = await createEvent(args, auth);
          eventState = blankEventState();
        } else if (name === 'deleteEvent') {
          result = await deleteEvent(args, auth);
        }
      } catch (err) {
        result = { error: err.message };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      stream: false,
    });

    assistantMessage = response.choices[0].message;
  }

  let reply = assistantMessage.content || '';
  if (assistantMessage.reasoning_details && !reply) {
    reply = '[Reasoning] ' + JSON.stringify(assistantMessage.reasoning_details);
  }

  // Store in conversation history (limit to last 20 messages)
  conversationHistory.push({ role: 'user', content: userMessage });
  conversationHistory.push({ role: 'assistant', content: reply });
  if (conversationHistory.length > 20) {
    conversationHistory.splice(0, conversationHistory.length - 20);
  }

  return { reply, eventState };
}

/**
 * Create an event directly from state — bypasses the LLM entirely.
 */
async function createEventDirectly(state, auth) {
  const createArgs = {
    summary: state.title,
    startDateTime: state.startDateTime,
    endDateTime: state.endDateTime,
    timezone: state.timezone || 'UTC',
  };
  if (state.recurrenceRule) createArgs.recurrence = { rrule: state.recurrenceRule };
  if (state.recurrenceText) createArgs.recurrenceText = state.recurrenceText;
  if (state.location) createArgs.location = state.location;
  if (state.description) createArgs.description = state.description;

  let result;
  try {
    result = await createEvent(createArgs, auth);
  } catch (err) {
    result = { error: err.message };
  }

  let reply = `Created **${state.title}**\n`;
  reply += `Date: ${state.startDateTime} — ${state.endDateTime}\n`;
  if (state.timezone) reply += `Timezone: ${state.timezone}\n`;
  if (state.recurrenceText) reply += `Recurrence: ${state.recurrenceText}\n`;
  if (state.location) reply += `Location: ${state.location}\n`;
  if (result.error) reply = `Failed to create event: ${result.error}\n`;
  else if (result.htmlLink) reply += `[View in Google Calendar](${result.htmlLink})`;

  return { reply, eventState: blankEventState() };
}

module.exports = { chat, buildRRule, parseRecurrenceText, extractEntities, blankEventState, hasValue };
