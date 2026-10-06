// The tools Claude can call for one person: calendar tools for their calendars (if they have any),
// read_budget (if Budget is set up for Dot; it reads with their own access), and whatever family
// tools discovery found for them (discovery.mjs: { definitions, connected, handlers }). Each tool's input
// is checked here before anything runs, and a failure comes back to Claude as an error result.

const dateTime = 'Date "YYYY-MM-DD" or local time "YYYY-MM-DDTHH:MM" (the calendar’s time zone unless an offset is given)';

export function makeTools({ calendar, calendarNames = [], budget, discovered = { definitions: [], connected: [], handlers: {} } }) {
  const cal = { type: 'string', enum: calendarNames, description: 'Which calendar' };
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
          calendar: cal,
          title: { type: 'string' },
          start: { type: 'string', description: dateTime },
          end: { type: 'string', description: `${dateTime}. Defaults to start.` },
          all_day: { type: 'boolean' },
          location: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['calendar', 'title', 'start'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_event',
      description: 'Change an existing event: only the fields given are changed. When changing the time, give start and end (and all_day for all-day events).',
      input_schema: {
        type: 'object',
        properties: {
          calendar: cal,
          event_id: { type: 'string' },
          title: { type: 'string' },
          start: { type: 'string', description: dateTime },
          end: { type: 'string', description: dateTime },
          all_day: { type: 'boolean' },
          location: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['calendar', 'event_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_event',
      description: 'Delete an event.',
      input_schema: {
        type: 'object',
        properties: { calendar: cal, event_id: { type: 'string' } },
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
      + 'the household’s `plan` (the Planning tab), if there is one: from each step’s month (YYYY-MM) on, that step’s Shared version applies; a month’s '
      + 'saved amount is the total of that version’s categories with kind "save", everything else (mortgage included) is spending; the running total '
      + 'starts at starting_balance and adds each month’s saved amount and one_offs. You can’t change the budget; '
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
  const definitions = [...(calendarNames.length ? calendarTools : []), ...budgetTools, ...discovered.definitions];

  const handlers = {
    read_budget: (i) => budget.read(i),
    list_calendars: () => calendar.listCalendars(),
    list_events: (i) => calendar.listEvents(i),
    create_event: (i) => calendar.createEvent(i),
    update_event: (i) => calendar.updateEvent(i),
    delete_event: (i) => calendar.deleteEvent(i),
    ...discovered.handlers,
  };

  /** Minimal schema check: required fields, known fields, and basic types */
  function validate(def, input) {
    const s = def.input_schema;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
    for (const r of s.required || []) if (input[r] === undefined || input[r] === '') return `missing "${r}"`;
    for (const [k, v] of Object.entries(input)) {
      const p = s.properties[k];
      if (!p) return `unknown field "${k}"`;
      if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
      if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
      if (p.type === 'boolean' && typeof v !== 'boolean') return `"${k}" must be true or false`;
      if (p.type === 'integer' && !Number.isInteger(v)) return `"${k}" must be a whole number`;
    }
    return null;
  }

  return {
    definitions,
    /** Family tools found by discovery, for the system prompt: [{ title, description, tools }] */
    connected: discovered.connected,
    /** Runs one tool_use block; always resolves to a tool_result block */
    async run(block) {
      const def = definitions.find((d) => d.name === block.name);
      const fail = (msg) => ({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: msg });
      if (!def) return fail(`Unknown tool "${block.name}"`);
      const problem = validate(def, block.input);
      if (problem) return fail(`Invalid input: ${problem}`);
      try {
        const out = await handlers[block.name](block.input);
        return { type: 'tool_result', tool_use_id: block.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
      } catch (e) {
        return fail(e.message);
      }
    },
  };
}
