// start-dev.js
const { execSync } = require('child_process');
const os = require('os');

if (os.platform() === 'win32') {
  execSync('powershell -ExecutionPolicy Bypass -File start-dev.bat', { stdio: 'inherit' });
} else {
  execSync('bash start-dev.sh', { stdio: 'inherit' });
}