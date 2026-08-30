require('dotenv').config();
const http = require('http');
const url = require('url');
const { google } = require('googleapis');
const readline = require('readline');
const { chat } = require('./gemini');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const PORT = 3000;

let authTokens = null;

async function authenticate() {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    console.log('\n🔐 Open this URL in your browser to authenticate:\n');
    console.log(authUrl);
    console.log('\nWaiting for authentication...\n');

    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      if (query.code) {
        try {
          const { tokens } = await oauth2Client.getToken(query.code);
          oauth2Client.setCredentials(tokens);
          authTokens = tokens;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>✅ Authentication successful! You can close this tab.</h1>');
          server.close();
          resolve();
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>❌ Authentication failed</h1>');
          server.close();
          reject(error);
        }
      }
    });

    server.listen(PORT, () => {
      console.log(`Local server listening on http://localhost:${PORT}`);
    });
  });
}

async function main() {
  console.log('📅 Calendar Chatbot - Terminal Edition\n');

  try {
    await authenticate();
    console.log('✅ Authenticated successfully!\n');
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('You: ', async (message) => {
      if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
        console.log('\n👋 Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (!message.trim()) {
        prompt();
        return;
      }

      try {
        const reply = await chat(message, oauth2Client);
        console.log(`\nBot: ${reply}\n`);
      } catch (error) {
        console.error(`\n❌ Error: ${error.message}\n`);
      }

      prompt();
    });
  };

  console.log('Type your message or "exit" to quit.\n');
  prompt();
}

main();
