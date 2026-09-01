# calendar-chatbot

A web-based calendar chatbot powered by Google Calendar API and Nvidia NIM (Llama 3.2 90B).

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
   NVIDIA_API_KEY=your_nvidia_nim_api_key
   ```

3. Enable Google Calendar API in [Google Cloud Console](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)

4. Get an Nvidia NIM API key at [Build.nvidia.com](https://build.nvidia.com)

## Usage

```bash
npm start
```

Open `http://localhost:3000` in your browser, connect your Google Calendar, and start chatting!

## Features

- List calendar events
- Create single and recurring events (with conflict detection)
- Update/reschedule events
- Delete events with confirmation
- Complex recurrence patterns (e.g., "2nd Tuesday of every month")
- Natural language interaction via Nvidia NIM
- Beautiful, responsive web interface
