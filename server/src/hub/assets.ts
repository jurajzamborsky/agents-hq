/**
 * Agents HQ: the office assets the browser needs (floors, walls, carpets,
 * furniture and the template layout), loaded once at start from dist/assets.
 */

import type { LoadedAssets } from './assetLoader.js';
import { loadCarpetTiles, loadDefaultLayout, loadFloorTiles, loadFurnitureAssets, loadWallTiles } from './assetLoader.js';

export interface AssetCache {
  floorTiles: string[][][] | null;
  wallTiles: unknown[] | null;
  carpetTiles: unknown[] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export async function buildAssetCache(distRoot: string): Promise<AssetCache> {
  return {
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    carpetTiles: await loadCarpetTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadFurnitureAssets(distRoot),
    defaultLayout: loadDefaultLayout(distRoot),
  };
}
