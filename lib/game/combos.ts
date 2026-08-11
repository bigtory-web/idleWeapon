import type { EquipmentComboId, EquippedWeaponSnapshot, Tier, WeaponId } from "./types";

export interface EquipmentComboDefinition {
  id: EquipmentComboId;
  name: string;
  weapons: readonly [WeaponId, WeaponId];
  description: string;
  drawback: string;
}

export const EQUIPMENT_COMBOS: readonly EquipmentComboDefinition[] = [
  { id: "dual-blades", name: "쌍검", weapons: ["sword", "sword"], description: "검 공격속도 +35%", drawback: "검 피해 -15%" },
  { id: "rapid-bow", name: "연발궁", weapons: ["bow", "bow"], description: "화살을 한 발 더 발사", drawback: "재장전 +20%" },
  { id: "earthshaker", name: "지진술사", weapons: ["hammer", "hammer"], description: "세 번째 망치 공격이 대형 충격파", drawback: "이동 -12%" },
  { id: "overcharge", name: "과충전", weapons: ["wand", "wand"], description: "연쇄 대상 +1", drawback: "공격 시 최대 HP 1% 반동" },
  { id: "fortress", name: "철벽", weapons: ["shield", "shield"], description: "받는 피해 45% 감소", drawback: "이동 -25%" },
  { id: "grand-grimoire", name: "대마도서", weapons: ["spellbook", "spellbook"], description: "마법 피해 +30%, 사거리 +15%", drawback: "마법 재사용 +15%" },
  { id: "vanguard", name: "선봉대", weapons: ["sword", "shield"], description: "막은 뒤 다음 검 공격이 강한 반격", drawback: "없음" },
  { id: "arcane-aegis", name: "비전 방벽", weapons: ["shield", "spellbook"], description: "같은 행 아군에게 주기적으로 보호막", drawback: "직접 공격 피해 -15%" },
  { id: "spellblade", name: "마검사", weapons: ["sword", "spellbook"], description: "세 번째 검 공격이 방어 무시 마법 참격", drawback: "없음" },
  { id: "arcane-arrow", name: "마력 화살", weapons: ["bow", "spellbook"], description: "화살이 가까운 적에게 50% 피해로 튕김", drawback: "없음" },
  { id: "ironbreaker", name: "철갑 파쇄자", weapons: ["hammer", "shield"], description: "첫 망치 공격이 방어 무시·밀치기", drawback: "없음" },
  { id: "archmage", name: "대마법사", weapons: ["wand", "spellbook"], description: "연쇄 마지막 지점에 작은 폭발", drawback: "최대 HP -8%" },
] as const;

export function getActiveEquipmentCombos(
  characterTier: Tier,
  weapons: readonly Pick<EquippedWeaponSnapshot, "weaponId" | "tier">[],
): EquipmentComboDefinition[] {
  if (characterTier !== 5) return [];
  const counts = new Map<WeaponId, number>();
  for (const { weaponId, tier } of weapons) {
    if (tier === 5) counts.set(weaponId, (counts.get(weaponId) ?? 0) + 1);
  }
  return EQUIPMENT_COMBOS.filter(({ weapons: [left, right] }) => left === right
    ? (counts.get(left) ?? 0) >= 2
    : (counts.get(left) ?? 0) >= 1 && (counts.get(right) ?? 0) >= 1);
}

export function getComboRecipesForWeapon(weaponId: WeaponId): EquipmentComboDefinition[] {
  return EQUIPMENT_COMBOS.filter(({ weapons }) => weapons.includes(weaponId));
}

export function comboName(id: EquipmentComboId): string {
  return EQUIPMENT_COMBOS.find((combo) => combo.id === id)?.name ?? id;
}
