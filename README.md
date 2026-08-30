# calendar-chatbot

A terminal-based calendar chatbot powered by Google Calendar API and Gemini AI.

## Installation

```bash
git clone https://github.com/Saivikhyat/calendar-chatbot.git
cd calendar-chatbot
npm install
```

## Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in your credentials in `.env`:
   ```
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   REDIRECT_URI=http://localhost:3000/auth/callback
   GEMINI_API_KEY=your_gemini_api_key
   ```

3. Enable Google Calendar API in [Google Cloud Console](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)

## Usage

```bash
npm start
```

The chatbot will open a browser for Google authentication, then you can chat in the terminal to manage your calendar events.

**Commands:**
- Type natural language to interact (e.g., "What's on my schedule today?")
- Type `exit` or `quit` to quit

## Features

- List calendar events
- Create new events
- Delete events
- Natural language interaction via Gemini AI
