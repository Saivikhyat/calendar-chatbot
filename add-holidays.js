require('dotenv').config();
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Load tokens from session file or environment
const fs = require('fs');
let tokens = null;
try {
  // Try to load from session storage
  const sessionDir = path.join(__dirname, '.sessions');
  if (fs.existsSync(sessionDir)) {
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
      if (data.tokens) {
        tokens = data.tokens;
        break;
      }
    }
  }
} catch (e) {}

// Fallback: check for tokens in environment
if (!tokens && process.env.GOOGLE_ACCESS_TOKEN) {
  tokens = {
    access_token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  };
}

if (!tokens) {
  console.error('No Google tokens found. Please authenticate first by running the server and logging in.');
  process.exit(1);
}

oauth2Client.setCredentials(tokens);

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// All holidays and celebrations for 2026-2027
const holidays = [
  // 2026 Holidays
  { summary: "New Year's Day", date: '2026-01-01', description: 'Federal Holiday' },
  { summary: 'Martin Luther King Jr. Day', date: '2026-01-19', description: 'Federal Holiday - Third Monday in January' },
  { summary: "Presidents' Day", date: '2026-02-16', description: 'Federal Holiday - Third Monday in February' },
  { summary: "Valentine's Day", date: '2026-02-14', description: 'Celebration' },
  { summary: "St. Patrick's Day", date: '2026-03-17', description: 'Celebration' },
  { summary: 'Easter Sunday', date: '2026-04-05', description: 'Celebration' },
  { summary: 'Mother\'s Day', date: '2026-05-10', description: 'Second Sunday in May' },
  { summary: 'Memorial Day', date: '2026-05-25', description: 'Federal Holiday - Last Monday in May' },
  { summary: "Father's Day", date: '2026-06-21', description: 'Third Sunday in June' },
  { summary: 'Independence Day', date: '2026-07-04', description: 'Federal Holiday' },
  { summary: 'Labour Day', date: '2026-09-07', description: 'Federal Holiday - First Monday in September' },
  { summary: 'Columbus Day', date: '2026-10-12', description: 'Federal Holiday - Second Monday in October' },
  { summary: 'Halloween', date: '2026-10-31', description: 'Celebration' },
  { summary: 'Veterans Day', date: '2026-11-11', description: 'Federal Holiday' },
  { summary: 'Thanksgiving Day', date: '2026-11-26', description: 'Federal Holiday - Fourth Thursday in November' },
  { summary: 'Black Friday', date: '2026-11-27', description: 'Day after Thanksgiving' },
  { summary: 'Christmas Eve', date: '2026-12-24', description: 'Celebration' },
  { summary: 'Christmas Day', date: '2026-12-25', description: 'Federal Holiday' },
  { summary: "Boxing Day", date: '2026-12-26', description: 'Celebration' },
  { summary: "New Year's Eve", date: '2026-12-31', description: 'Celebration' },

  // 2027 Holidays
  { summary: "New Year's Day", date: '2027-01-01', description: 'Federal Holiday' },
  { summary: 'Martin Luther King Jr. Day', date: '2027-01-18', description: 'Federal Holiday - Third Monday in January' },
  { summary: "Presidents' Day", date: '2027-02-15', description: 'Federal Holiday - Third Monday in February' },
  { summary: "Valentine's Day", date: '2027-02-14', description: 'Celebration' },
  { summary: "St. Patrick's Day", date: '2027-03-17', description: 'Celebration' },
  { summary: 'Easter Sunday', date: '2027-03-28', description: 'Celebration' },
  { summary: "Mother's Day", date: '2027-05-09', description: 'Second Sunday in May' },
  { summary: 'Memorial Day', date: '2027-05-31', description: 'Federal Holiday - Last Monday in May' },
  { summary: "Father's Day", date: '2027-06-20', description: 'Third Sunday in June' },
  { summary: 'Independence Day', date: '2027-07-04', description: 'Federal Holiday (Observed July 5)' },
  { summary: 'Labour Day', date: '2027-09-06', description: 'Federal Holiday - First Monday in September' },
  { summary: 'Columbus Day', date: '2027-10-11', description: 'Federal Holiday - Second Monday in October' },
  { summary: 'Halloween', date: '2027-10-31', description: 'Celebration' },
  { summary: 'Veterans Day', date: '2027-11-11', description: 'Federal Holiday' },
  { summary: 'Thanksgiving Day', date: '2027-11-25', description: 'Federal Holiday - Fourth Thursday in November' },
  { summary: 'Black Friday', date: '2027-11-26', description: 'Day after Thanksgiving' },
  { summary: 'Christmas Eve', date: '2027-12-24', description: 'Celebration' },
  { summary: 'Christmas Day', date: '2027-12-25', description: 'Federal Holiday' },
  { summary: "Boxing Day", date: '2027-12-26', description: 'Celebration' },
  { summary: "New Year's Eve", date: '2027-12-31', description: 'Celebration' },
];

async function addHolidays() {
  console.log(`Adding ${holidays.length} holidays and celebrations for 2026-2027...\n`);
  
  let success = 0;
  let failed = 0;

  for (const holiday of holidays) {
    try {
      const event = {
        summary: holiday.summary,
        description: holiday.description || '',
        start: { date: holiday.date },
        end: { date: holiday.date },
      };

      await calendar.events.insert({
        calendarId: 'primary',
        resource: event,
      });

      console.log(`✓ ${holiday.summary} - ${holiday.date}`);
      success++;
    } catch (err) {
      console.error(`✗ ${holiday.summary} - ${holiday.date}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone! ${success} added, ${failed} failed.`);
}

// Need path module
const path = require('path');

addHolidays().catch(console.error);
