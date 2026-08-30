-- Path of Building
--
-- Module: AIPoB Item Mechanic Probe
-- Produces conservative structural legality evidence from live PoB Item state.
-- Ownership and Trade authenticity are intentionally outside this probe.

local ModifierCatalog = require("Modules.AIPoB.ModifierCatalog")

local ItemMechanicProbe = { VERSION = 1 }

local eldritchBaseTypes = {
	Helmet = true,
	["Body Armour"] = true,
	Gloves = true,
	Boots = true,
}

local function addFinding(findings, status, code, reason, lineId)
	table.insert(findings, {
		status = status,
		code = code,
		reason = reason,
		lineId = lineId,
	})
end

local function donorType(donor)
	local uniqueDB = main and main.uniqueDB and main.uniqueDB.byTitle
	local unique = uniqueDB and uniqueDB[tostring(donor):lower()]
	return unique and unique.base and unique.base.type or nil
end

local function checkVestigial(item, line, provenance, findings, lineId)
	if item.rarity ~= "UNIQUE" then
		addFinding(findings, "invalid", "vestigial_requires_unique", "Vestigial implicit requires a Unique target item", lineId)
	end
	if not item.base or not data or not data.vestigialUniqueBaseTypes or not data.vestigialUniqueBaseTypes[item.base.type] then
		addFinding(findings, "invalid", "vestigial_target_type", "Item base type cannot receive Vestigial implicits", lineId)
	end
	if not provenance.donorItem then
		addFinding(findings, "unverifiable", "vestigial_donor_unknown", "Vestigial donor could not be resolved from PoB data", lineId)
		return
	end
	if item.title and item.title:lower() == provenance.donorItem:lower() then
		addFinding(findings, "invalid", "vestigial_same_unique", "Vestigial donor cannot be the target Unique", lineId)
	end
	local sourceType = donorType(provenance.donorItem)
	if sourceType and item.type and sourceType ~= item.type then
		addFinding(findings, "invalid", "vestigial_type_mismatch", "Vestigial donor and target must use the same item type", lineId)
	elseif not sourceType then
		addFinding(findings, "unverifiable", "vestigial_donor_type_unknown", "Vestigial donor item type is unavailable in the loaded Unique catalog", lineId)
	end
	if line.implicit == false then
		addFinding(findings, "invalid", "vestigial_not_implicit", "Vestigial modifier is not stored as an implicit", lineId)
	end
end

local function checkEldritch(item, line, findings, lineId)
	if item.rarity == "UNIQUE" or item.rarity == "RELIC" then
		addFinding(findings, "invalid", "eldritch_unique", "Eldritch implicits cannot apply to Unique or Relic items", lineId)
	end
	if not item.base or not eldritchBaseTypes[item.base.type] then
		addFinding(findings, "invalid", "eldritch_target_type", "Item base type cannot receive Eldritch implicits", lineId)
	end
	if line.exarch and not item.cleansing then
		addFinding(findings, "unverifiable", "exarch_influence_missing", "Exarch modifier exists without Exarch item influence state", lineId)
	end
	if line.eater and not item.tangle then
		addFinding(findings, "unverifiable", "eater_influence_missing", "Eater modifier exists without Eater item influence state", lineId)
	end
end

local function effectiveLimit(item, kind)
	local list = kind == "prefix" and item.prefixes or item.suffixes
	if list and tonumber(list.limit) then return tonumber(list.limit) end
	if tonumber(item.affixLimit) and item.affixLimit > 0 then return item.affixLimit / 2 end
	return nil
end

function ItemMechanicProbe.Check(item, context)
	local findings = { }
	if type(item) ~= "table" then
		return { status = "invalid", findings = { { status = "invalid", code = "item_missing", reason = "Item is missing" } } }
	end
	if not item.base then addFinding(findings, "invalid", "base_unknown", "Item base is not known to PoB") end

	local prefixCount, suffixCount = 0, 0
	for _, section in ipairs(itemLib.modLineSections or { }) do
		for ordinal, line in ipairs(item[section.field] or { }) do
			local lineId = tostring(section.name) .. ":" .. tostring(ordinal)
			if line.prefix then prefixCount = prefixCount + 1 end
			if line.suffix then suffixCount = suffixCount + 1 end
			local provenance = ModifierCatalog.Resolve(item, section.name, line)
			if line.vestigial then checkVestigial(item, line, provenance, findings, lineId) end
			if line.exarch or line.eater then checkEldritch(item, line, findings, lineId) end
			if line.fractured and not item.fractured then
				addFinding(findings, "unverifiable", "fractured_item_state_missing", "Fractured modifier exists without item-level Fractured state", lineId)
			end
			if line.scourge and not item.corrupted then
				addFinding(findings, "unverifiable", "scourge_corruption_state_missing", "Scourge modifier exists without Corrupted item state", lineId)
			end
			if line.custom or line.extra or type(line.modList) ~= "table" or (#line.modList == 0 and not line.disabled) then
				addFinding(findings, "unverifiable", "modifier_semantics_incomplete", "Modifier line is not completely represented by parsed PoB Mods", lineId)
			end
		end
	end

	local prefixLimit = effectiveLimit(item, "prefix")
	local suffixLimit = effectiveLimit(item, "suffix")
	if prefixLimit and prefixCount > prefixLimit then
		addFinding(findings, "invalid", "prefix_limit", "Item has more prefix modifiers than its PoB limit")
	end
	if suffixLimit and suffixCount > suffixLimit then
		addFinding(findings, "invalid", "suffix_limit", "Item has more suffix modifiers than its PoB limit")
	end

	if context and context.slotName and context.itemsTab and type(context.itemsTab.IsItemValidForSlot) == "function" then
		local ok, valid = pcall(context.itemsTab.IsItemValidForSlot, context.itemsTab, item, context.slotName, context.itemSet)
		if ok and not valid then
			addFinding(findings, "invalid", "slot_incompatible", "Item is incompatible with its equipped slot")
		elseif not ok then
			addFinding(findings, "unverifiable", "slot_check_failed", "PoB slot compatibility check failed")
		end
	end

	local status = "valid"
	for _, finding in ipairs(findings) do
		if finding.status == "invalid" then status = "invalid" break end
		if finding.status == "unverifiable" then status = "unverifiable" end
	end
	return { version = ItemMechanicProbe.VERSION, status = status, findings = findings }
end

return ItemMechanicProbe
