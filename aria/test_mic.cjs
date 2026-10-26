const { spawn } = require('child_process');
const p = spawn('powershell.exe', [
  '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
  '-File', 'C:\\Users\\avani\\OneDrive\\Documents\\personalassistant\\aria\\electron\\speech-recognizer.ps1'
], { windowsHide: true });

p.stdout.on('data', d => console.log('OUT:', d.toString().trim()));
p.stderr.on('data', d => console.error('ERR:', d.toString().trim()));
p.on('exit', c => console.log('EXIT:', c));
setTimeout(() => { p.kill(); console.log('Killed'); }, 5000);