import fs from 'fs';
import path from 'path';
import { MEMORY_DIR } from '../config/loader.js';

/**
 * Persistent per-agent markdown files for long-term learning:
 *   ~/.aura/memory/<ns>/user_profile.md   — facts about the user
 *   ~/.aura/memory/<ns>/self_knowledge.md — facts the agent learned about itself
 *
 * Plain markdown so it is human-readable and editable.
 */
export class ProfileMemory {
  private dir(ns: string): string {
    return path.join(MEMORY_DIR, ns);
  }

  private profilePath(ns: string): string {
    return path.join(this.dir(ns), 'user_profile.md');
  }

  private selfPath(ns: string): string {
    return path.join(this.dir(ns), 'self_knowledge.md');
  }

  private ensureDir(ns: string): void {
    const d = this.dir(ns);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  readProfile(ns: string): string {
    const fp = this.profilePath(ns);
    return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  }

  readSelf(ns: string): string {
    const fp = this.selfPath(ns);
    return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  }

  appendToProfile(ns: string, facts: string): void {
    this.ensureDir(ns);
    const fp   = this.profilePath(ns);
    const date = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, '# User Profile\n', 'utf8');
    }
    fs.appendFileSync(fp, `\n<!-- ${date} -->\n${facts.trim()}\n`, 'utf8');
  }

  appendToSelf(ns: string, facts: string): void {
    this.ensureDir(ns);
    const fp   = this.selfPath(ns);
    const date = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, '# Agent Self-Knowledge\n', 'utf8');
    }
    fs.appendFileSync(fp, `\n<!-- ${date} -->\n${facts.trim()}\n`, 'utf8');
  }

  writeProfile(ns: string, content: string): void {
    this.ensureDir(ns);
    fs.writeFileSync(this.profilePath(ns), content, 'utf8');
  }

  writeSelf(ns: string, content: string): void {
    this.ensureDir(ns);
    fs.writeFileSync(this.selfPath(ns), content, 'utf8');
  }
}
