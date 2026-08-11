import { CHARACTERS, ITEM_DEFINITIONS, REWARD_ITEM_IDS, WEAPONS } from "./data";
import { placeRewardInFirstEmptyCell } from "./inventory";
import { createSeededRng } from "./rng";
import type { GridItem, ItemId, PendingReward, ShopOffer } from "./types";

export interface ShopPurchaseResult {
  success: boolean;
  gridItems: GridItem[];
  gold: number;
  reason?: "already-purchased" | "not-enough-gold" | "grid-full";
  merges: number;
}

export function generateShopOffers(seed: string, waveIndex: number, rerollIndex = 0): ShopOffer[] {
  const normalizedReroll = Math.max(0, Math.trunc(rerollIndex));
  const rng = createSeededRng(`${seed}:shop:${waveIndex}:reroll:${normalizedReroll}`);
  const characters = rng.shuffle(Object.keys(CHARACTERS) as ItemId[]);
  const weapons = rng.shuffle(Object.keys(WEAPONS) as ItemId[]);
  const chosen = [characters[0], weapons[0]].filter(Boolean) as ItemId[];
  const remaining = rng.shuffle(REWARD_ITEM_IDS.filter((id) => !chosen.includes(id)));
  if (remaining[0]) chosen.push(remaining[0]);

  return chosen.map((definitionId, index) => ({
    id: `shop-${waveIndex}-${normalizedReroll}-${index}-${definitionId}`,
    waveIndex,
    definitionId,
    tier: 1,
    price: ITEM_DEFINITIONS[definitionId].shopPrice,
    purchased: false,
  }));
}

export function purchaseShopOffer(
  gridItems: readonly GridItem[],
  gold: number,
  offer: ShopOffer,
  unlockedColumns?: number,
): ShopPurchaseResult {
  if (offer.purchased) {
    return { success: false, gridItems: cloneGrid(gridItems), gold, reason: "already-purchased", merges: 0 };
  }
  if (gold < offer.price) {
    return { success: false, gridItems: cloneGrid(gridItems), gold, reason: "not-enough-gold", merges: 0 };
  }

  const pending: PendingReward = {
    id: `purchase-${offer.waveIndex}-${offer.id}`,
    definitionId: offer.definitionId,
    tier: offer.tier,
  };

  const placed = placeRewardInFirstEmptyCell(gridItems, pending, unlockedColumns);
  if (!placed.success) {
    return { success: false, gridItems: cloneGrid(gridItems), gold, reason: "grid-full", merges: 0 };
  }
  return { success: true, gridItems: placed.gridItems, gold: gold - offer.price, merges: 0 };
}

export function canPurchaseShopOffer(
  gridItems: readonly GridItem[],
  gold: number,
  offer: ShopOffer,
  unlockedColumns?: number,
): boolean {
  return purchaseShopOffer(gridItems, gold, offer, unlockedColumns).success;
}

function cloneGrid(items: readonly GridItem[]): GridItem[] {
  return items.map((item) => ({
    ...item,
    position: item.position ? { ...item.position } : null,
  }));
}
