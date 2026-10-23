// Compatibility entry point. Browser fixtures now exercise the built React app.
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const result = spawnSync('npm', ['run', 'test:e2e', '--prefix', resolve(__dirname, '../frontend')], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
