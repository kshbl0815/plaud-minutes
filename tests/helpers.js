import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
export async function fileBlob(name, type = '') { return fs.openAsBlob(path.join(FIX, name), { type }); }
export function ffprobeDur(file) { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim()); }
export async function writeTmp(blob, name) { const p = path.join('/tmp', name); fs.writeFileSync(p, Buffer.from(await blob.arrayBuffer())); return p; }
