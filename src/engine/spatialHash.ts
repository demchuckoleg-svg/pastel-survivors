/**
 * Fast 64px cell-based 2D Spatial Hash for 60 FPS collision, targeting,
 * and enemy separation with 300+ active entities.
 */

export interface SpatialEntity {
  x: number;
  y: number;
  radius?: number;
}

export const DEFAULT_CELL_SIZE = 64;

/**
 * Packs signed 16-bit integer grid coordinates into a single 32-bit integer key.
 * Avoids per-frame string allocations while supporting ±32,767 cells (~±2M px).
 */
function packCellKey(cx: number, cy: number): number {
  return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

export class SpatialHash<T extends SpatialEntity> {
  public readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly cells = new Map<number, T[]>();
  private readonly activeBuckets: T[][] = [];
  private readonly bucketPool: T[][] = [];
  private hasMultiCellItem = false;

  constructor(cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  /**
   * Clears all entries while recycling bucket arrays to minimize GC pressure.
   */
  public clear(): void {
    for (let i = 0; i < this.activeBuckets.length; i++) {
      const bucket = this.activeBuckets[i];
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.activeBuckets.length = 0;
    this.cells.clear();
    this.hasMultiCellItem = false;
  }

  /**
   * Inserts an entity into every grid cell overlapped by its bounding circle.
   */
  public insert(item: T): void {
    const r = item.radius ?? 0;
    if (r <= 0) {
      const cx = Math.floor(item.x * this.invCellSize);
      const cy = Math.floor(item.y * this.invCellSize);
      this.insertIntoCell(packCellKey(cx, cy), item);
      return;
    }

    const minCx = Math.floor((item.x - r) * this.invCellSize);
    const maxCx = Math.floor((item.x + r) * this.invCellSize);
    const minCy = Math.floor((item.y - r) * this.invCellSize);
    const maxCy = Math.floor((item.y + r) * this.invCellSize);

    if (minCx === maxCx && minCy === maxCy) {
      this.insertIntoCell(packCellKey(minCx, minCy), item);
      return;
    }

    this.hasMultiCellItem = true;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        this.insertIntoCell(packCellKey(cx, cy), item);
      }
    }
  }

  /**
   * Batch-inserts a collection of entities.
   */
  public insertAll(items: readonly T[]): void {
    for (let i = 0; i < items.length; i++) {
      this.insert(items[i]);
    }
  }

  /**
   * Returns all entities whose bounding circles overlap the given query circle.
   * Pass an optional reusable `out` array to avoid allocations in hot loops.
   */
  public queryRadius(x: number, y: number, radius: number, out: T[] = []): T[] {
    out.length = 0;
    const minCx = Math.floor((x - radius) * this.invCellSize);
    const maxCx = Math.floor((x + radius) * this.invCellSize);
    const minCy = Math.floor((y - radius) * this.invCellSize);
    const maxCy = Math.floor((y + radius) * this.invCellSize);

    const dedup = this.hasMultiCellItem ? new Set<T>() : null;

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(packCellKey(cx, cy));
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (dedup) {
            if (dedup.has(item)) continue;
            dedup.add(item);
          }

          const dx = item.x - x;
          const dy = item.y - y;
          const combinedR = radius + (item.radius ?? 0);
          if (dx * dx + dy * dy <= combinedR * combinedR) {
            out.push(item);
          }
        }
      }
    }

    return out;
  }

  /**
   * Returns all entities overlapping the given axis-aligned bounding box.
   */
  public queryRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    out: T[] = []
  ): T[] {
    out.length = 0;
    const minCx = Math.floor(minX * this.invCellSize);
    const maxCx = Math.floor(maxX * this.invCellSize);
    const minCy = Math.floor(minY * this.invCellSize);
    const maxCy = Math.floor(maxY * this.invCellSize);

    const dedup = this.hasMultiCellItem ? new Set<T>() : null;

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(packCellKey(cx, cy));
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (dedup) {
            if (dedup.has(item)) continue;
            dedup.add(item);
          }

          const r = item.radius ?? 0;
          if (
            item.x + r >= minX &&
            item.x - r <= maxX &&
            item.y + r >= minY &&
            item.y - r <= maxY
          ) {
            out.push(item);
          }
        }
      }
    }

    return out;
  }

  /**
   * Finds the closest entity within `maxRadius` matching an optional predicate.
   */
  public findNearest(
    x: number,
    y: number,
    maxRadius: number,
    filter?: (item: T) => boolean
  ): T | null {
    const minCx = Math.floor((x - maxRadius) * this.invCellSize);
    const maxCx = Math.floor((x + maxRadius) * this.invCellSize);
    const minCy = Math.floor((y - maxRadius) * this.invCellSize);
    const maxCy = Math.floor((y + maxRadius) * this.invCellSize);

    const dedup = this.hasMultiCellItem ? new Set<T>() : null;
    let best: T | null = null;
    let bestDistSq = maxRadius * maxRadius;

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(packCellKey(cx, cy));
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (dedup) {
            if (dedup.has(item)) continue;
            dedup.add(item);
          }
          if (filter && !filter(item)) continue;

          const dx = item.x - x;
          const dy = item.y - y;
          const distSq = dx * dx + dy * dy;
          if (distSq <= bestDistSq) {
            bestDistSq = distSq;
            best = item;
          }
        }
      }
    }

    return best;
  }

  /**
   * Applies soft circle-circle separation between overlapping entities currently
   * indexed in this hash grid. Useful for keeping 300+ enemies from stacking.
   */
  public resolveSeparation(
    items: readonly T[],
    defaultRadius = 14,
    strength = 0.45
  ): void {
    const neighbors: T[] = [];

    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      const ra = a.radius ?? defaultRadius;
      this.queryRadius(a.x, a.y, ra * 2, neighbors);

      for (let j = 0; j < neighbors.length; j++) {
        const b = neighbors[j];
        if (a === b) continue;

        const rb = b.radius ?? defaultRadius;
        const minDist = ra + rb;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDist * minDist) {
          if (distSq > 0.0001) {
            const dist = Math.sqrt(distSq);
            const overlap = (minDist - dist) * strength * 0.5;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x += nx * overlap;
            a.y += ny * overlap;
            b.x -= nx * overlap;
            b.y -= ny * overlap;
          } else {
            // Deterministic tiny nudge when two entities share exact coordinates
            const angle = (i * 1.61803398875) % (Math.PI * 2);
            const nudge = minDist * 0.25 * strength;
            a.x += Math.cos(angle) * nudge;
            a.y += Math.sin(angle) * nudge;
            b.x -= Math.cos(angle) * nudge;
            b.y -= Math.sin(angle) * nudge;
          }
        }
      }
    }
  }

  private insertIntoCell(key: number, item: T): void {
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = this.bucketPool.pop() ?? [];
      this.cells.set(key, bucket);
      this.activeBuckets.push(bucket);
    }
    bucket.push(item);
  }
}
