/**
 * Build-time script: generates public/reference/examples.json from the
 * reference/config directory and copies all .cfg files to
 * public/reference/config/ so they can be served as static assets on
 * Cloudflare Workers / Pages without a Python backend.
 */
import { readdirSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONFIG_SRC = join(REPO_ROOT, 'reference', 'config');
const CONFIG_DEST = join(__dirname, '..', 'public', 'reference', 'config');
const MANIFEST_DEST = join(__dirname, '..', 'public', 'reference', 'examples.json');
const SCHEMA_SRC = join(REPO_ROOT, 'reference', 'schema.json');
const SCHEMA_DEST = join(__dirname, '..', 'public', 'reference', 'schema.json');
const CONFIG_REFERENCE_SRC = join(REPO_ROOT, 'reference', 'reference_docs', 'klipper_docs', 'Config_Reference.md');
const CONFIG_REFERENCE_DEST_DIR = join(__dirname, '..', 'public', 'reference', 'docs');
const CONFIG_REFERENCE_DEST = join(CONFIG_REFERENCE_DEST_DIR, 'Config_Reference.md');

mkdirSync(CONFIG_DEST, { recursive: true });
mkdirSync(CONFIG_REFERENCE_DEST_DIR, { recursive: true });

const CATEGORY_PREFIXES = [
  ['example-', 'example'],
  ['generic-', 'generic'],
  ['printer-', 'printer'],
  ['sample-', 'sample'],
  ['kit-', 'kit'],
];

// Board-type subdirectories → board_type value
const BOARD_TYPE_DIRS = {
  Mainboard: 'mainboard',
  Toolhead: 'toolhead',
  Probe: 'probe',
  Expander: 'expander',
  Accelerometer: 'accelerometer',
  Other: 'other',
};

function extractTags(name) {
  let clean = name;
  for (const [prefix] of CATEGORY_PREFIXES) {
    if (name.startsWith(prefix)) {
      clean = name.slice(prefix.length);
      break;
    }
  }
  return clean.split(/[-_.]/).filter((p) => p.length > 1);
}

function categoryFromPrefix(name) {
  for (const [prefix, cat] of CATEGORY_PREFIXES) {
    if (name.startsWith(prefix)) return cat;
  }
  return 'other';
}

const examples = [];

// Scan typed subdirectories
for (const [subdirName, boardType] of Object.entries(BOARD_TYPE_DIRS)) {
  const subdirPath = join(CONFIG_SRC, subdirName);
  if (!existsSync(subdirPath)) continue;

  const files = readdirSync(subdirPath).filter((f) => f.endsWith('.cfg')).sort();
  for (const filename of files) {
    copyFileSync(join(subdirPath, filename), join(CONFIG_DEST, filename));
    const name = filename.replace(/\.cfg$/, '');
    examples.push({
      filename,
      name,
      category: categoryFromPrefix(name),
      board_type: boardType,
      tags: extractTags(name),
    });
  }
}

// Also pick up any .cfg files remaining in the config root (compat)
const rootFiles = readdirSync(CONFIG_SRC).filter((f) => f.endsWith('.cfg')).sort();
for (const filename of rootFiles) {
  copyFileSync(join(CONFIG_SRC, filename), join(CONFIG_DEST, filename));
  const name = filename.replace(/\.cfg$/, '');
  examples.push({
    filename,
    name,
    category: categoryFromPrefix(name),
    board_type: 'other',
    tags: extractTags(name),
  });
}

writeFileSync(MANIFEST_DEST, JSON.stringify({ examples }, null, 2));
console.log(`Generated examples.json with ${examples.length} configs.`);

// Copy schema.json
if (existsSync(SCHEMA_SRC)) {
  copyFileSync(SCHEMA_SRC, SCHEMA_DEST);
  console.log('Copied schema.json.');
} else {
  console.warn('WARNING: reference/schema.json not found. Run: python scripts/generate-schema.py');
}

if (existsSync(CONFIG_REFERENCE_SRC)) {
  copyFileSync(CONFIG_REFERENCE_SRC, CONFIG_REFERENCE_DEST);
  console.log('Copied Config_Reference.md.');
} else {
  console.warn('WARNING: Config_Reference.md not found.');
}
