-- Path of Building
--
-- Module: AIPoB Modifier Projection
-- Captures every live Item ModLine and its parsed PoB Mods without copying the
-- underlying game database into the sidecar.

local sha = require("sha2")
local Util = require("Modules.AIPoB.Util")
local ModifierCatalog = require("Modules.AIPoB.ModifierCatalog")
local ItemMechanicProbe = require("Modules.AIPoB.ItemMechanicProbe")

local ModifierProjection = { VERSION = 1 }

local itemStateFields = {
	"split", "mirrored", "corrupted", "fractured", "synthesised", "vestigial",
	"foulborn", "veiled", "scourge", "crucible", "crafted", "implicit",
	"shaper", "elder", "adjudicator", "basilisk", "crusader", "eyrie",
	"cleansing", "tangle",
}

local numericModTypes = {
	BASE = true, INC = true, MORE = true, OVERRIDE = true, MAX = true,
	CHANCE = true, DUMMY = true, MIN = true,
}

local function jsonValue(value, depth, seen)
	depth = depth or 0
	if depth > 8 then return "<max-depth>" end
	local valueType = type(value)
	if valueType == "nil" then return nil end
	if valueType == "string" or valueType == "boolean" then return value end
	if valueType == "number" then
		return value == value and value ~= math.huge and value ~= -math.huge and value or nil
	end
	if valueType ~= "table" then return tostring(value) end
	seen = seen or { }
	if seen[value] then return "<cycle>" end
	seen[value] = true
	local result = { }
	local count = 0
	for _, key in ipairs(Util.sortedKeys(value)) do
		count = count + 1
		if count > 128 then
			result.truncated = true
			break
		end
		local copied = jsonValue(value[key], depth + 1, seen)
		if copied ~= nil then result[type(key) == "number" and key or tostring(key)] = copied end
	end
	seen[value] = nil
	return result
end

local function modClassification(modType)
	if numericModTypes[modType] then return "numeric" end
	if modType == "FLAG" or modType == "Flag" then return "boolean" end
	if modType == "LIST" then return "structured" end
	return "unknown"
end

local function exportParsedMod(mod)
	local tags = { }
	for index = 1, #(mod or { }) do table.insert(tags, jsonValue(mod[index])) end
	local value = jsonValue(mod.value)
	if type(value) == "table" and value.skillId and data and data.skills and data.skills[value.skillId] then
		value.skillName = data.skills[value.skillId].name or data.skills[value.skillId].id
	end
	return {
		name = tostring(mod.name or "unknown"),
		type = tostring(mod.type or "unknown"),
		classification = modClassification(mod.type),
		value = value,
		flags = tonumber(mod.flags) or 0,
		keywordFlags = tonumber(mod.keywordFlags) or 0,
		source = mod.source and tostring(mod.source) or nil,
		tags = tags,
	}
end

local function lineIsSelected(item, modLine)
	if modLine.disabled then return false end
	if type(item.GetModLineVariantCount) ~= "function" then return true end
	local ok, count = pcall(item.GetModLineVariantCount, item, modLine)
	return not ok or tonumber(count) == nil or count > 0
end

local function exportLine(item, itemId, itemActive, section, ordinal, modLine)
	local flags = { }
	for _, flag in ipairs(Util.sortedKeys(itemLib.modLineFlags or { })) do
		if modLine[flag] then table.insert(flags, flag) end
	end
	local parsedMods = { }
	for _, mod in ipairs(modLine.modList or { }) do table.insert(parsedMods, exportParsedMod(mod)) end
	local parseStatus
	if modLine.disabled then
		parseStatus = "disabled"
	elseif #parsedMods > 0 and modLine.extra then
		parseStatus = "partial"
	elseif #parsedMods > 0 then
		parseStatus = "parsed"
	else
		parseStatus = "unknown"
	end
	return {
		id = "item:" .. tostring(itemId) .. ":" .. section.name .. ":" .. tostring(ordinal),
		section = section.name,
		ordinal = ordinal,
		rawText = tostring(modLine.line or ""),
		active = itemActive and lineIsSelected(item, modLine),
		disabled = modLine.disabled == true,
		flags = flags,
		modTags = jsonValue(modLine.modTags or { }),
		modId = modLine.modId and tostring(modLine.modId) or nil,
		newModId = modLine.newModId and tostring(modLine.newModId) or nil,
		range = jsonValue(modLine.range),
		corruptedRange = tonumber(modLine.corruptedRange),
		valueScalar = tonumber(modLine.valueScalar),
		extra = modLine.extra and tostring(modLine.extra) or nil,
		parseStatus = parseStatus,
		provenance = ModifierCatalog.Resolve(item, section.name, modLine),
		parsedMods = parsedMods,
	}
end

local function activeSlot(tab, slotName, itemId)
	local slot = tab.slots and tab.slots[slotName]
	if not slot or tonumber(slot.selItemId) ~= tonumber(itemId) then return false end
	if slot.inactive or slot.active == false then return false end
	if slot.weaponSet then
		local current = tab.activeItemSet and tab.activeItemSet.useSecondWeaponSet and 2 or 1
		if slot.weaponSet ~= current then return false end
	end
	if type(slot.shown) == "function" then
		local ok, shown = pcall(slot.shown)
		if ok and shown == false then return false end
	end
	return true
end

local function itemReferences(tab)
	local refs = { }
	for _, itemSetId in ipairs(tab.itemSetOrderList or { }) do
		local itemSet = tab.itemSets and tab.itemSets[itemSetId]
		for _, slotName in ipairs(Util.sortedKeys(tab.slots or { })) do
			local slot = tab.slots[slotName]
			local setSlot = not slot.nodeId and itemSet and itemSet[slotName]
			local itemId = setSlot and tonumber(setSlot.selItemId) or 0
			if itemId > 0 then
				refs[itemId] = refs[itemId] or { }
				table.insert(refs[itemId], {
					itemSetId = tostring(itemSetId),
					slot = slotName,
					active = itemSetId == tab.activeItemSetId and activeSlot(tab, slotName, itemId),
				})
			end
		end
	end
	-- Passive-tree jewel slots do not live inside ItemSet records.
	for _, slotName in ipairs(Util.sortedKeys(tab.slots or { })) do
		local slot = tab.slots[slotName]
		local itemId = slot.nodeId and tonumber(slot.selItemId) or 0
		if itemId > 0 then
			refs[itemId] = refs[itemId] or { }
			table.insert(refs[itemId], {
				itemSetId = tostring(tab.activeItemSetId or 0),
				slot = slotName,
				active = activeSlot(tab, slotName, itemId),
				nodeId = slot.nodeId,
			})
		end
	end
	return refs
end

local function exportItem(tab, itemId, item, refs)
	local active = false
	for _, ref in ipairs(refs or { }) do if ref.active then active = true break end end
	local state = { }
	for _, field in ipairs(itemStateFields) do state[field] = item[field] == true end
	local lines = { }
	for _, section in ipairs(itemLib.modLineSections or { }) do
		for ordinal, modLine in ipairs(item[section.field] or { }) do
			table.insert(lines, exportLine(item, itemId, active, section, ordinal, modLine))
		end
	end
	local activeRef
	for _, ref in ipairs(refs or { }) do if ref.active then activeRef = ref break end end
	local legality = ItemMechanicProbe.Check(item, activeRef and {
		slotName = activeRef.slot,
		itemsTab = tab,
		itemSet = tab.activeItemSet,
	} or nil)
	return {
		id = tostring(itemId),
		name = item.name,
		title = item.title,
		baseName = item.baseName,
		type = item.type,
		rarity = item.rarity,
		itemLevel = tonumber(item.itemLevel),
		quality = tonumber(item.quality),
		equipped = refs ~= nil and #refs > 0,
		active = active,
		references = refs or { },
		state = state,
		legality = legality,
		modifierLines = lines,
	}
end

function ModifierProjection.Capture(build)
	if type(build) ~= "table" or type(build.itemsTab) ~= "table" then
		return nil, "build items are unavailable"
	end
	local tab = build.itemsTab
	local refs = itemReferences(tab)
	local order = { }
	local seen = { }
	for _, itemId in ipairs(tab.itemOrderList or { }) do
		if tab.items[itemId] then table.insert(order, itemId) seen[itemId] = true end
	end
	for _, itemId in ipairs(Util.sortedKeys(tab.items or { })) do
		if not seen[itemId] then table.insert(order, itemId) end
	end
	local result = {
		version = ModifierProjection.VERSION,
		inventory = ModifierCatalog.Inventory(),
		items = { },
		modifierCount = 0,
		activeModifierCount = 0,
		unresolvedModifierCount = 0,
	}
	local modRefs, modRefSeen = { }, { }
	for _, itemId in ipairs(order) do
		local exported = exportItem(tab, itemId, tab.items[itemId], refs[tonumber(itemId)] or refs[itemId])
		table.insert(result.items, exported)
		for _, line in ipairs(exported.modifierLines) do
			result.modifierCount = result.modifierCount + 1
			if line.active then result.activeModifierCount = result.activeModifierCount + 1 end
			if line.parseStatus == "unknown" or line.provenance.resolution == "unknown" then
				result.unresolvedModifierCount = result.unresolvedModifierCount + 1
			end
			local provenance = line.provenance
			if provenance.sourceTable and provenance.sourceModId then
				local key = provenance.sourceTable .. ":" .. provenance.sourceModId
				if not modRefSeen[key] then
					modRefSeen[key] = true
					table.insert(modRefs, { sourceTable = provenance.sourceTable, modId = provenance.sourceModId })
				end
			end
		end
	end
	result.descriptions = ModifierCatalog.Describe(modRefs, { limit = 128 })
	result.fingerprint = "sha256:" .. sha.sha256(Util.canonicalJSON(result))
	return result
end

return ModifierProjection
