/** Stable furniture/object definitions — display name is NOT the id. */

const TYPE_FROM_NAME = [
  ["камин", "fireplace"], ["fire", "fireplace"],
  ["стол", "table"], ["table", "table"],
  ["сундук", "chest"], ["chest", "chest"], ["хран", "chest"],
  ["кроват", "bed"], ["bed", "bed"],
  ["кузн", "forge"], ["forge", "forge"],
  ["конюш", "stable"], ["stable", "stable"],
  ["окно", "window"], ["window", "window"],
];

export function inferType(displayName) {
  const t = String(displayName || "").toLowerCase();
  for (const [needle, type] of TYPE_FROM_NAME) {
    if (t.includes(needle)) return type;
  }
  return "misc";
}

const ROOM_INDEX = { 0: "common", 1: "family", 2: "workshop", 3: "yard", 4: "storage", 5: "history" };

function roomMatches(f, tab) {
  const r = f.room ?? f.Room;
  if (r === tab || String(r).toLowerCase() === tab) return true;
  if (typeof r === "number" && ROOM_INDEX[r] === tab) return true;
  if (tab === "common" && (r === "common" || r === "Common" || r === 0)) return true;
  return false;
}

/**
 * Build stable furniture catalog from house DTO + room fallbacks.
 * @returns {Record<string, object>}
 */
export function buildFurnitureCatalog(house, tab) {
  const out = {};
  const furn = (house?.furniture || []).filter((f) => roomMatches(f, tab));
  const list = furn.length
    ? furn
    : tab === "common"
      ? [
          { id: "fireplace_01", name: "Камин", state: "активен", x: 15, y: 28 },
          { id: "table_01", name: "Стол", state: "свободен", x: 39, y: 49 },
          { id: "chest_01", name: "Сундук", state: `${house?.storageUsed || 0}/${house?.storageCapacity || 0}`, x: 11, y: 61 },
        ]
      : tab === "family"
        ? [
            { id: "table_family_01", name: "Семейный стол", state: String(house?.familyCapacity || house?.residentsCapacity || ""), x: 35, y: 48 },
            { id: "bed_01", name: "Кровати", state: `${house?.residentsCount || 0}/${house?.residentsCapacity || 0}`, x: 70, y: 48 },
          ]
        : [];

  list.forEach((f, i) => {
    const displayName = f.name || f.Name || "Объект";
    const id =
      f.id ||
      f.Id ||
      f.furnitureId ||
      f.ObjectId ||
      `${inferType(displayName)}_${String(i + 1).padStart(2, "0")}`;
    const type = f.type || f.Type || inferType(displayName);
    out[id] = {
      id,
      type,
      room: tab,
      displayName,
      state: f.state || f.State || "",
      x: Number(f.x ?? f.X ?? 20),
      y: Number(f.y ?? f.Y ?? 40),
      atmosphereActions: atmosphereActionsForType(type),
      bannerlordActions: bannerlordActionsForType(type, tab),
    };
  });
  return out;
}

function atmosphereActionsForType(type) {
  const map = {
    table: [{ pose: "sit", label: "Сесть за стол" }, { pose: "stand", label: "Встать" }],
    fireplace: [{ pose: "inspect", label: "Осмотреть камин" }, { pose: "warm", label: "Погреться" }],
    bed: [{ pose: "rest", label: "Прилечь" }, { pose: "stand", label: "Встать" }],
    chest: [{ pose: "peek", label: "Заглянуть" }],
    forge: [{ pose: "watch", label: "Смотреть на огонь" }],
    stable: [{ pose: "pat", label: "Погладить" }],
    window: [{ pose: "look", label: "Смотреть в окно" }],
    person: [{ pose: "look", label: "Осмотреть" }, { pose: "wave", label: "Помахать" }],
    misc: [{ pose: "look", label: "Осмотреть" }],
  };
  return map[type] || map.misc;
}

function bannerlordActionsForType(type, tab) {
  if (type === "chest" || (type === "misc" && tab === "storage")) {
    return [{ id: "inventory", label: "Склад / инвентарь BLT" }];
  }
  if (type === "forge") return [{ id: "forge_craft", label: "Открыть кузницу (вкладка)" }];
  return [];
}

export function atmosphereActions(obj) {
  return obj?.atmosphereActions || atmosphereActionsForType(obj?.type || "misc");
}

export function bannerlordActions(obj) {
  return obj?.bannerlordActions || [];
}
