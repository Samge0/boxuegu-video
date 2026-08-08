// Copy CUDA DLLs from nvidia pip packages into ctranslate2 directory
// so faster-whisper can find them at runtime
const fs = require('fs');
const path = require('path');

const venvBase = path.join(__dirname, '..', '.whisper-venv', 'Lib', 'site-packages');
const ctranslate2Dir = path.join(venvBase, 'ctranslate2');
const nvidiaBase = path.join(venvBase, 'nvidia');

if (!fs.existsSync(ctranslate2Dir)) {
  console.error('ctranslate2 not found. Run: npm run setup-whisper');
  process.exit(1);
}

let copied = 0;
function copyDlls(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      copyDlls(fullPath);
    } else if (entry.name.endsWith('.dll')) {
      const dest = path.join(ctranslate2Dir, entry.name);
      if (!fs.existsSync(dest)) {
        try {
          fs.copyFileSync(fullPath, dest);
          copied++;
          console.log(`  Copied: ${entry.name}`);
        } catch (e) {
          console.warn(`  Failed to copy ${entry.name}: ${e.message}`);
        }
      }
    }
  }
}

console.log('Copying CUDA DLLs to ctranslate2 directory...');
copyDlls(nvidiaBase);
console.log(`Done! Copied ${copied} DLLs.`);
