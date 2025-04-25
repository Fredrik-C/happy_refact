// File: scripts/create-launcher.js
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The launcher script must also use ES modules syntax since the package has "type": "module"
const launcherContent = `#!/usr/bin/env node
// This is a launcher script that runs the MCP server with proper Node.js flags
// to handle N-API callback exceptions
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the actual MCP server index.js
const serverPath = path.join(__dirname, 'index.js');

// Spawn Node with the necessary flags to handle N-API callback exceptions
const child = spawn(process.execPath, [
  '--force-node-api-uncaught-exceptions-policy=true', 
  serverPath,
  ...process.argv.slice(2)
], {
  stdio: 'inherit'
});

// Forward exit codes
child.on('exit', (code) => {
  process.exit(code);
});

// Forward signals
process.on('SIGINT', () => {
  child.kill('SIGINT');
});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
`;

// Path to write the launcher script
const launcherPath = path.join(process.cwd(), 'build', 'src', 'launcher.js');

// Create the build/src directory if it doesn't exist
const launcherDir = path.dirname(launcherPath);
if (!fs.existsSync(launcherDir)) {
  fs.mkdirSync(launcherDir, { recursive: true });
}

// Write the launcher script
fs.writeFileSync(launcherPath, launcherContent, 'utf8');

// Make it executable
try {
  fs.chmodSync(launcherPath, '755');
  console.log('Created executable launcher script at:', launcherPath);
} catch (err) {
  console.log('Created launcher script at:', launcherPath);
  console.log('Note: Could not set executable permission. This is normal on Windows.');
}