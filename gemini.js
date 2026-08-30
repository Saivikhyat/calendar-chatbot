const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const tools = [
  {
    functionDeclarations: [
      {
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
      {
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
      {
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
    ],
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
  let response = await genai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      tools,
      systemInstruction: 'You are a helpful calendar assistant. Help users manage their Google Calendar events by listing, creating, and deleting events. Be concise and friendly.',
    },
  });

  let functionCalls = response.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];

  while (functionCalls.length > 0) {
    const functionResults = [];
    for (const fc of functionCalls) {
      const { name, args: fArgs } = fc.functionCall;
      let result;
      if (name === 'listEvents') {
        result = await listEvents(fArgs, auth);
      } else if (name === 'createEvent') {
        result = await createEvent(fArgs, auth);
      } else if (name === 'deleteEvent') {
        result = await deleteEvent(fArgs, auth);
      }
      functionResults.push({ functionResponse: { name, response: result } });
    }

    response = await genai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [
        { role: 'user', parts: [{ text: userMessage }] },
        { role: 'model', parts: functionCalls.map(fc => ({ functionCall: fc.functionCall })) },
        { role: 'user', parts: functionResults },
      ],
      config: { tools },
    });

    functionCalls = response.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];
  }

  const textParts = response.candidates?.[0]?.content?.parts?.filter(p => p.text) || [];
  return textParts.map(p => p.text).join('');
}

module.exports = { chat };
