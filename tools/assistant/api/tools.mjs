// The tools Claude can call for one person: calendar tools for their calendars (if they have any),
// read_budget (if Budget is set up for Dot; it reads with their own access), house_control and
// lists_change (if they can use Lists; lists.mjs), memory (remember, forget, recall; memory.mjs), schedule (scheduled asks;
// schedules.mjs), automations (everything that runs on its own for them, from every tool; automations.mjs), and whatever family tools discovery found for them. readOnly (a scheduled ask's run) leaves out every
// tool that changes anything
// (discovery.mjs: { definitions, connected, handlers }). Each tool's input
// is checked here before anything runs, and a failure comes back to Claude as an error result.

import { COLORS } from './calendars.mjs';
import { definition as houseControl } from './house.mjs';
import { definition as listsChange } from './lists.mjs';
import { definitions as memoryTools } from './memory.mjs';
import { definition as scheduleTool } from './schedules.mjs';
import { definition as automationsTool } from './automations.mjs';

const dateTime = 'Date "YYYY-MM-DD" or local time "YYYY-MM-DDTHH:MM" (the calendar’s time zone unless an offset is given)';

const color = {
  type: 'string', enum: [...COLORS, 'default'],
  description: 'Event color, by the names Google Calendar shows; "default" uses the calendar’s own color',
};

const people = {
  type: 'array',
  maxItems: 10,
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, email: { type: 'string' } },
    additionalProperties: false,
  },
  description: 'People for this appointment, by name and/or email (the doctor, the office, who’s coming). They’re noted on the event '
    + 'for reference, not invited: Google won’t send them anything.',
};

// What a scheduled ask's run may not use: with no one there to ask, it only reads
// (discovered writes, like House's automations, are left out by discovery's `writes`)
export const WRITE_TOOLS = ['house_control', 'lists_change', 'create_event', 'update_event', 'delete_event', 'remember', 'forget', 'schedule'];

export function makeTools({ calendar, calendarNames = [], readOnlyCalendars = [], budget, house, lists, memory, schedule, automations, readOnly = false, discovered = { definitions: [], connected: [], handlers: {} } }) {
  const cal = { type: 'string', enum: calendarNames, description: 'Which calendar' };
  // Changes are offered only on calendars this person may change (Calendars refuses the rest too)
  const writable = calendarNames.filter((c) => !readOnlyCalendars.includes(c));
  const writableCal = { type: 'string', enum: writable, description: 'Which calendar (only ones you can change)' };
  const calendarTools = [
    {
      name: 'list_calendars',
      description: 'List the calendars you can use, with their display names and time zones.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_events',
      description: 'List events on a calendar between two times (recurring events are expanded). Use it to answer schedule questions and to find an event’s id before changing it.',
      input_schema: {
        type: 'object',
        properties: {
          calendar: cal,
          start: { type: 'string', description: dateTime },
          end: { type: 'string', description: dateTime },
          query: { type: 'string', description: 'Optional text to match in titles, descriptions and locations' },
          max_results: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['calendar', 'start', 'end'],
        additionalProperties: false,
      },
    },
    {
      name: 'create_event',
      description: 'Create an event. For all-day events set all_day and give dates; end is the last day (inclusive) and defaults to start.',
      input_schema: {
        type: 'object',
        properties: {
          calendar: writableCal,
          title: { type: 'string' },
          start: { type: 'string', description: dateTime },
          end: { type: 'string', description: `${dateTime}. Defaults to start.` },
          all_day: { type: 'boolean' },
          location: { type: 'string' },
          description: { type: 'string' },
          people,
          color,
        },
        required: ['calendar', 'title', 'start'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_event',
      description: 'Change an existing event (including its color): only the fields given are changed. When changing the time, give start and end (and all_day for all-day events).',
      input_schema: {
        type: 'object',
        properties: {
          calendar: writableCal,
          event_id: { type: 'string' },
          title: { type: 'string' },
          start: { type: 'string', description: dateTime },
          end: { type: 'string', description: dateTime },
          all_day: { type: 'boolean' },
          location: { type: 'string' },
          description: { type: 'string', description: 'The event’s own notes (the people list is kept separately)' },
          people: { ...people, description: `${people.description} Replaces the whole list; [] clears it.` },
          color,
        },
        required: ['calendar', 'event_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_event',
      description: 'Delete an event. It asks the person first: when it says so, ask them and stop; only when they agree, call again with confirm: true.',
      input_schema: {
        type: 'object',
        properties: { calendar: writableCal, event_id: { type: 'string' }, confirm: { type: 'boolean', description: 'Only after the person agreed' } },
        required: ['calendar', 'event_id'],
        additionalProperties: false,
      },
    },
  ];
  const budgetTools = budget ? [{
    name: 'read_budget',
    description: 'Read the household budget (read-only), with this person’s own access. Without `version`: that budget’s working copy, '
      + 'which is what the budget app shows now and may include unsaved edits, plus its saved versions and tags. With `version`: that saved version, '
      + 'by name or by tag (e.g. "default"). Amounts are dollars; freq "mo" is monthly and "yr" yearly. The shared budget also returns '
      + 'the household’s `plans` (the Planning tab, by name), if any: in a plan, from each step’s month (YYYY-MM) on, that step’s Shared version applies; a month’s '
      + 'saved amount is the total of that version’s categories with kind "save", everything else (mortgage included) is spending. Money sits in the '
      + 'plan’s accounts (balance, negative for a loan; yearly rate %). Each month, per account: interest on the opening balance (rate/12), then a '
      + 'loan with paid_by gets that Shared line’s monthly amount until it reaches zero, then the saved amount lands in the savings account, then '
      + 'one_offs land in their account (or move from it to moved_to). The running total is all accounts added up. A cheaper Shared budget '
      + 'shows up as less paid in by each person, not in the running total. You can’t change the budget; '
      + 'for changes, point them to budget.dot-y.co.',
    input_schema: {
      type: 'object',
      properties: {
        doc: { type: 'string', enum: budget.docs, description: 'Which budget: the shared household one, or a person’s own (default shared)' },
        version: { type: 'string', description: 'Optional saved version name or tag' },
      },
      additionalProperties: false,
    },
  }] : [];
  const writeTools = ['create_event', 'update_event', 'delete_event'];
  const offered = calendarTools.filter((t) => writable.length || !writeTools.includes(t.name));
  const all = [...(calendarNames.length ? offered : []), ...budgetTools, ...(house ? [houseControl] : []), ...(lists ? [listsChange] : []), ...(memory ? memoryTools : []), ...(schedule ? [scheduleTool] : []), ...(automations ? [automationsTool] : []), ...discovered.definitions];
  // Discovered writes (a tool's declared POST/PUT/PATCH/DELETE) change things too
  const writing = new Set([...WRITE_TOOLS, ...(discovered.writes ?? [])]);
  const definitions = readOnly ? all.filter((d) => !writing.has(d.name)) : all;

  const handlers = {
    read_budget: (i) => budget.read(i),
    house_control: (i, ctx) => house.control(i, ctx),
    lists_change: (i, ctx) => lists.change(i, ctx),
    remember: (i, ctx) => memory.remember(i, ctx),
    forget: (i) => memory.forget(i),
    recall: (i) => memory.recall(i),
    schedule: (i, ctx) => schedule(i, ctx),
    automations: () => automations.list(),
    list_calendars: () => calendar.listCalendars(),
    list_events: (i) => calendar.listEvents(i),
    create_event: (i) => calendar.createEvent(i),
    update_event: (i) => calendar.updateEvent(i),
    delete_event: (i, ctx) => calendar.deleteEvent(i, ctx),
    ...discovered.handlers,
  };

  /** Minimal schema check: required fields, known fields, and basic types (lists of objects one level down) */
  function validate(s, input, at = '') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return `${at || 'input'} must be an object`;
    for (const r of s.required || []) if (input[r] === undefined || input[r] === '') return `missing "${at}${r}"`;
    for (const [k, v] of Object.entries(input)) {
      const p = Object.hasOwn(s.properties, k) ? s.properties[k] : null, name = `${at}${k}`;
      if (!p) return `unknown field "${name}"`;
      if (p.enum && !p.enum.includes(v)) return `"${name}" must be one of ${p.enum.join(', ')}`;
      if (p.type === 'string' && typeof v !== 'string') return `"${name}" must be a string`;
      if (p.type === 'boolean' && typeof v !== 'boolean') return `"${name}" must be true or false`;
      if (p.type === 'integer' && !Number.isInteger(v)) return `"${name}" must be a whole number`;
      if (p.type === 'array') {
        if (!Array.isArray(v)) return `"${name}" must be a list`;
        if (p.maxItems && v.length > p.maxItems) return `"${name}" can have at most ${p.maxItems}`;
        for (const [i, item] of v.entries()) {
          const problem = p.items?.type === 'object' ? validate(p.items, item, `${name}[${i}].`) : null;
          if (problem) return problem;
        }
      }
    }
    return null;
  }

  return {
    definitions,
    /** Family tools found by discovery, for the system prompt: [{ title, description, tools }] */
    connected: discovered.connected,
    /** Runs one tool_use block; always resolves to a tool_result block. ctx: { history } of the conversation */
    async run(block, ctx = {}) {
      const def = definitions.find((d) => d.name === block.name);
      const fail = (msg) => ({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: msg });
      if (!def) return fail(`Unknown tool "${block.name}"`);
      const problem = validate(def.input_schema, block.input);
      if (problem) return fail(`Invalid input: ${problem}`);
      try {
        const out = await handlers[block.name](block.input, ctx);
        return { type: 'tool_result', tool_use_id: block.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
      } catch (e) {
        return fail(e.message);
      }
    },
  };
}
