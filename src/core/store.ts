// What a model wrote, kept on disk by the content it was written for: a unit's ladder by its text, a section's line
// by its units, a translation by the sentences. Renaming a note keeps its levels; editing a paragraph asks again
// for that paragraph's section only. Sixteen JSON files a kind, by the key's first hex digit, written a moment
// after the last change.

import { SectionLadder, UnitLadder } from './levels';

export interface FileIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Changes when the prompts change in a way that should ask the model again. */
export const PROMPT_VERSION = 'v1';

class Shelf<T> {
  private shards = new Map<string, Record<string, T>>();
  private dirty = new Set<string>();
  private loading: Promise<void> | null = null;

  constructor(private io: FileIO, private dir: string, private kind: string) {}

  private file(shard: string) { return `${this.dir}/${this.kind}-${shard}.json`; }

  ready(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        for (const shard of '0123456789abcdef') {
          const f = this.file(shard);
          try {
            this.shards.set(shard, (await this.io.exists(f)) ? JSON.parse(await this.io.read(f)) : {});
          } catch {
            this.shards.set(shard, {});   // a damaged file starts over
          }
        }
      })();
    }
    return this.loading;
  }

  get(key: string): T | undefined {
    return this.shards.get(key[0])?.[key];
  }

  set(key: string, value: T) {
    const shard = key[0];
    if (!this.shards.has(shard)) this.shards.set(shard, {});
    this.shards.get(shard)![key] = value;
    this.dirty.add(shard);
  }

  delete(key: string) {
    const shard = this.shards.get(key[0]);
    if (shard && key in shard) {
      delete shard[key];
      this.dirty.add(key[0]);
    }
  }

  async flush() {
    if (!this.dirty.size) return;
    if (!(await this.io.exists(this.dir))) await this.io.mkdir(this.dir);
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const shard of dirty) await this.io.write(this.file(shard), JSON.stringify(this.shards.get(shard) ?? {}));
  }

  async clear() {
    await this.ready();
    for (const shard of '0123456789abcdef') {
      this.shards.set(shard, {});
      const f = this.file(shard);
      if (await this.io.exists(f)) await this.io.remove(f);
    }
    this.dirty.clear();
  }
}

export class Store {
  readonly units: Shelf<UnitLadder>;
  readonly sections: Shelf<SectionLadder>;
  readonly tr: Shelf<string[]>;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(io: FileIO, dir: string) {
    this.units = new Shelf(io, dir, 'unit');
    this.sections = new Shelf(io, dir, 'section');
    this.tr = new Shelf(io, dir, 'tr');
  }

  ready() {
    return Promise.all([this.units.ready(), this.sections.ready(), this.tr.ready()]);
  }

  /** Writes what changed, a moment after the last change. */
  touch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1500);
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([this.units.flush(), this.sections.flush(), this.tr.flush()]);
  }

  async clear() {
    await Promise.all([this.units.clear(), this.sections.clear(), this.tr.clear()]);
  }
}
