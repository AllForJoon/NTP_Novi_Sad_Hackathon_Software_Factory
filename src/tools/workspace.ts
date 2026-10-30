import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { EngineeringTicket } from '../schemas.js';
import type { ArtifactRecord } from '../state.js';

export function safePath(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes('\\') || name.includes(':') || name.includes('\0')) throw new Error('Unsafe path');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw new Error('Unsafe path component');
  if (parts.some(p => ['.git', '.env', 'node_modules'].includes(p.toLowerCase()))) throw new Error('Protected path');
  const base = resolve(root), target = resolve(base, ...parts);
  if (!target.startsWith(base + sep)) throw new Error('Path escapes workspace');
  let cursor = base;
  for (const component of ['', ...parts]) {
    if (component) cursor = resolve(cursor, component);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symlinks are not allowed in artifact paths');
  }
  return target;
}
export function writeOwned(root: string, file: string, content: string, ticket: EngineeringTicket): void {
  if (!ticket.ownedFiles.includes(file)) throw new Error(`Ticket ${ticket.id} does not own ${file}`);
  if (Buffer.byteLength(content) > 100_000) throw new Error('File exceeds 100 KB limit');
  const target = safePath(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}
export function hashFile(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
export function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', '.git'].includes(name)) continue;
      const file = resolve(dir, name), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Unexpected symlink');
      if (info.isDirectory()) walk(file);
      else files.push(relative(root, file).split(sep).join('/'));
      if (files.length > 150) throw new Error('Workspace file limit exceeded');
    }
  };
  walk(root); return files.sort();
}
export function readBounded(root: string, file: string): string {
  const target = safePath(root, file);
  if (lstatSync(target).size > 100_000) throw new Error('File exceeds read limit');
  return readFileSync(target, 'utf8');
}
export function scaffold(root: string, toolchainRoot: string): void {
  mkdirSync(root, { recursive: true });
  const write = (file: string, data: unknown): void => writeFileSync(safePath(root, file), JSON.stringify(data, null, 2) + '\n');
  write('package.json', {
    name: 'factory-generated-project', version: '0.1.0', private: true, type: 'module',
    scripts: { build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit', test: 'node --test tests/*.test.mjs', start: 'node dist/index.js' },
    devDependencies: { typescript: '~5.9.3', '@types/node': '^22.19.0' },
  });
  write('tsconfig.json', { compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    outDir: 'dist', rootDir: 'src', skipLibCheck: true, types: ['node'],
  }, include: ['src/**/*.ts'] });
  // Reuse the installed compiler/types during a run; no model-controlled package scripts.
  // For a standalone copy, replace this ignored link with `npm install --ignore-scripts`.
  const modules = resolve(root, 'node_modules');
  if (!existsSync(modules)) symlinkSync(resolve(toolchainRoot, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
}
export function captureArtifacts(root: string, ticket: EngineeringTicket): ArtifactRecord[] {
  return ticket.ownedFiles.map(file => {
    const path = safePath(root, file);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing owned artifact ${file}`);
    return { ticketId: ticket.id, owner: ticket.owner, file, path, sha256: hashFile(path), version: ticket.retryCount, accepted: false };
  });
}
export function latestAccepted(artifacts: ArtifactRecord[]): ArtifactRecord[] {
  const files = new Map<string, ArtifactRecord>();
  for (const artifact of artifacts) if (artifact.accepted) files.set(artifact.file, artifact);
  return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
}
export function integrateArtifacts(root: string, artifacts: ArtifactRecord[]): void {
  for (const artifact of artifacts) {
    const origin = safePath(resolve(artifact.path.slice(0, -artifact.file.length)), artifact.file);
    if (origin !== artifact.path || hashFile(origin) !== artifact.sha256) throw new Error(`Artifact changed after submission: ${artifact.file}`);
    const target = safePath(root, artifact.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(origin));
  }
}
