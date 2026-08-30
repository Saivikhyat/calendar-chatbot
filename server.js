require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { router: authRouter, getAuthenticatedClient } = require('./auth');
const { chat } = require('./gemini');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'calendar-chatbot-secret',
  resave: false,
  saveUninitialized: false,
}));

app.use(authRouter);

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Please authenticate with Google first', authUrl: '/auth/login' });
  }

  try {
    if (!req.session.tokens || !req.session.tokens.access_token) {
      req.session.authenticated = false;
      return res.status(401).json({ error: 'Session expired. Please re-authenticate.', authUrl: '/auth/login' });
    }
    const auth = getAuthenticatedClient();
    auth.setCredentials(req.session.tokens);
    const reply = await chat(message, auth);
    res.json({ reply });
  } catch (error) {
    console.error('Chat error:', error);
    if (error.message?.includes('invalid_grant') || error.message?.includes('Token has been expired or revoked')) {
      req.session.authenticated = false;
      req.session.tokens = null;
      return res.status(401).json({ error: 'Token expired. Please re-authenticate.', authUrl: '/auth/login' });
    }
    if (error.code === 403 && error.message?.includes('Calendar API has not been used')) {
      return res.status(500).json({ error: 'Google Calendar API is not enabled. Please enable it in Google Cloud Console for project 467708387068.' });
    }
    res.status(500).json({ error: 'Failed to process your request' });
  }
});

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Calendar chatbot running on http://localhost:${PORT}`);
});
