const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_DIR = path.join(os.homedir(), '.claude-commander');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

const DEFAULTS = {
  launchMode: 'inapp',  // 'inapp' | 'external'
};

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch (e) {
    console.error('settings read error:', e.message);
  }
  return { ...DEFAULTS };
}

function setSetting(key, value) {
  const current = getSettings();
  current[key] = value;
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2), 'utf8');
  } catch (e) {
    console.error('settings write error:', e.message);
  }
  return current;
}

module.exports = { getSettings, setSetting };
