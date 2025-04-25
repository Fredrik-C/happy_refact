#!/usr/bin/env node
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
