const fs = require('fs');
const path = require('path');
const { RepairService } = require('./index');

function parseArgv(argv) {
  const args = { _: [] };
  const tokens = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      args[body] = next;
      i += 1;
      continue;
    }
    args[body] = true;
  }
  return args;
}

function resolveManifestPath(args) {
  const candidate = args.manifest || args.request || args._[0] || '';
  if (!candidate) {
    throw new Error('Missing --manifest <path>.');
  }
  return path.resolve(String(candidate));
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const manifestPath = resolveManifestPath(args);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const request = JSON.parse(raw);

  const service = new RepairService();
  try {
    const result = await service.run(request);
    process.stdout.write(JSON.stringify(result));
  } finally {
    await service.close();
  }
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
