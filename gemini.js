const Groq = require('groq-sdk');
const { google } = require('googleapis');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const tools = [
  {
    type: 'function',
    function: {
      name: 'listEvents',
      description: 'List calendar events for a given date range',
      parameters: {
        type: 'object',
        properties: {
          timeMin: { type: 'string', description: 'Start of time range in ISO 8601 format' },
          timeMax: { type: 'string', description: 'End of time range in ISO 8601 format' },
          maxResults: { type: 'integer', description: 'Maximum number of events to return' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createEvent',
      description: 'Create a new calendar event',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          description: { type: 'string', description: 'Event description' },
          startDateTime: { type: 'string', description: 'Event start time in ISO 8601 format' },
          endDateTime: { type: 'string', description: 'Event end time in ISO 8601 format' },
          location: { type: 'string', description: 'Event location' },
        },
        required: ['summary', 'startDateTime', 'endDateTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deleteEvent',
      description: 'Delete a calendar event by its ID',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'The ID of the event to delete' },
        },
        required: ['eventId'],
      },
    },
  },
];

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
  const event = {
    summary: args.summary,
    description: args.description || '',
    location: args.location || '',
    start: { dateTime: args.startDateTime, timeZone: 'UTC' },
    end: { dateTime: args.endDateTime, timeZone: 'UTC' },
  };
  const response = await calendar.events.insert({ calendarId: 'primary', resource: event });
  return response.data;
}

async function deleteEvent(args, auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId: 'primary', eventId: args.eventId });
  return { success: true, message: 'Event deleted successfully' };
}

async function chat(userMessage, auth) {
  const messages = [
    {
      role: 'system',
      content: 'You are a helpful calendar assistant. Help users manage their Google Calendar events by listing, creating, and deleting events. Be concise and friendly.',
    },
    { role: 'user', content: userMessage },
  ];

  let response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages,
    tools,
    tool_choice: 'auto',
  });

  let assistantMessage = response.choices[0].message;

  while (assistantMessage.tool_calls) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const { name, arguments: argsStr } = toolCall.function;
      const args = JSON.parse(argsStr);
      let result;

      if (name === 'listEvents') {
        result = await listEvents(args, auth);
      } else if (name === 'createEvent') {
        result = await createEvent(args, auth);
      } else if (name === 'deleteEvent') {
        result = await deleteEvent(args, auth);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    response = await groq.chat.completions.create({
model: 'openai/gpt-oss-20b',
      messages,
      tools,
      tool_choice: 'auto',
    });

    assistantMessage = response.choices[0].message;
  }

  return assistantMessage.content;
}

module.exports = { chat };
