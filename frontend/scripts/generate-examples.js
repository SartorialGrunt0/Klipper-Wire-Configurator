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

mkdirSync(CONFIG_DEST, { recursive: true });

const CATEGORY_PREFIXES = [
  ['example-', 'example'],
  ['generic-', 'generic'],
  ['printer-', 'printer'],
  ['sample-', 'sample'],
  ['kit-', 'kit'],
];

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

const files = readdirSync(CONFIG_SRC).filter((f) => f.endsWith('.cfg')).sort();
const examples = [];

for (const filename of files) {
  copyFileSync(join(CONFIG_SRC, filename), join(CONFIG_DEST, filename));

  const name = filename.replace(/\.cfg$/, '');
  let category = 'other';
  for (const [prefix, cat] of CATEGORY_PREFIXES) {
    if (name.startsWith(prefix)) {
      category = cat;
      break;
    }
  }

  examples.push({
    filename,
    name,
    category,
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
