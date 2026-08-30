require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { google } = require('googleapis');
const { chat } = require('./gemini');

const app = express();
const PORT = process.env.PORT || 3000;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'calendar-chatbot-secret',
  resave: false,
  saveUninitialized: false,
}));

app.get('/auth/login', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    req.session.tokens = tokens;
    req.session.authenticated = true;
    res.redirect('/');
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

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
      return res.status(401).json({ error: 'Session expired', authUrl: '/auth/login' });
    }
    oauth2Client.setCredentials(req.session.tokens);
    const reply = await chat(message, oauth2Client);
    res.json({ reply });
  } catch (error) {
    console.error('Chat error:', error);
    if (error.message?.includes('invalid_grant') || error.message?.includes('Token has been expired or revoked')) {
      req.session.authenticated = false;
      req.session.tokens = null;
      return res.status(401).json({ error: 'Token expired', authUrl: '/auth/login' });
    }
    res.status(500).json({ error: error.message || 'Failed to process your request' });
  }
});

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`📅 Calendar Chatbot running at http://localhost:${PORT}`);
});
