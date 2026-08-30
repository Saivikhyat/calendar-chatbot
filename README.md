# calendar-chatbot

A web-based calendar chatbot powered by Google Calendar API and Groq AI.

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
   GROQ_API_KEY=your_groq_api_key
   ```

3. Enable Google Calendar API in [Google Cloud Console](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)

4. Get a Groq API key at [Groq Console](https://console.groq.com/keys)

## Usage

```bash
npm start
```

Open `http://localhost:3000` in your browser, connect your Google Calendar, and start chatting!

## Features

- List calendar events
- Create new events
- Delete events
- Natural language interaction via Groq AI
- Beautiful, responsive web interface
