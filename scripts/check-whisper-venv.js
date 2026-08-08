// Check if .whisper-venv exists for GPU-accelerated subtitle extraction
const fs = require('fs');
const path = require('path');

const venvPython = path.join(__dirname, '..', '.whisper-venv', 'Scripts', 'python.exe');
if (fs.existsSync(venvPython)) {
  console.log('✓ faster-whisper GPU venv found');
  process.exit(0);
} else {
  console.log('ℹ faster-whisper venv not found — CPU whisper.cpp will be used instead');
  console.log('  To enable GPU acceleration, run: npm run setup-whisper');
  process.exit(0); // Don't fail npm install
}
