-- Path of Building
--
-- Module: AIPoB Modifier Catalog
-- Resolves live Item ModLines against PoB-owned modifier data. This module is
-- deliberately read-only: the sidecar receives bounded descriptions, never a
-- copied game-rules database.

local Util = require("Modules.AIPoB.Util")

local ModifierCatalog = { VERSION = 1 }

local sourceFamilies = {
	Explicit = "explicit",
	ItemExclusive = "itemExclusive",
	Corrupted = "corrupted",
	Delve = "delve",
	Synthesis = "synthesis",
	Scourge = "scourge",
	Eldritch = "eldritch",
	Flask = "flask",
	Tincture = "tincture",
	Graft = "graft",
	Jewel = "jewel",
	JewelAbyss = "jewelAbyss",
	JewelCluster = "jewelCluster",
	JewelCharm = "jewelCharm",
	Foulborn = "foulborn",
	Mercenary = "mercenary",
	Vestigial = "vestigial",
	WatchersEye = "watchersEye",
}

local dedicatedFlagFamilies = {
	vestigial = "vestigial",
	mutated = "foulborn",
	crucible = "crucible",
	scourge = "scourge",
	exarch = "eldritch",
	eater = "eldritch",
	synthesis = "synthesis",
	fractured = "fractured",
	crafted = "crafted",
	enchant = "enchant",
	custom = "custom",
}

local sectionFamilies = {
	buff = "baseBuff",
	enchant = "enchant",
	scourge = "scourge",
	classRequirement = "classRequirement",
	implicit = "implicit",
	explicit = "explicit",
	crucible = "crucible",
}

local function normalizeLine(line)
	return tostring(line or "")
		:gsub("%b{}", "")
		:gsub("%s+", " ")
		:gsub("^%s+", "")
		:gsub("%s+$", "")
		:gsub("%+?%-?%d+%.?%d*", "#")
		:lower()
end

ModifierCatalog.NormalizeLine = normalizeLine

local function modifierLines(mod)
	local lines = { }
	if type(mod) ~= "table" then return lines end
	for index = 1, #mod do
		if type(mod[index]) == "string" then
			for line in mod[index]:gmatch("[^\n]+") do table.insert(lines, line) end
		end
	end
	return lines
end

local function addCandidate(index, line, candidate)
	local key = normalizeLine(line)
	if key == "" then return end
	index[key] = index[key] or { }
	table.insert(index[key], candidate)
end

local function indexTable(index, tableName, family, sourceTable)
	local count = 0
	for _, modId in ipairs(Util.sortedKeys(sourceTable or { })) do
		local mod = sourceTable[modId]
		local lines = modifierLines(mod)
		if #lines > 0 then
			count = count + 1
			local candidate = {
				sourceTable = tableName,
				sourceFamily = family,
				modId = tostring(modId),
				mod = mod,
			}
			for _, line in ipairs(lines) do addCandidate(index, line, candidate) end
			if #lines > 1 then addCandidate(index, table.concat(lines, " "), candidate) end
		end
	end
	return count
end

local cachedData
local cachedIndex
local cachedCounts

local function ensureIndex()
	if cachedData == data and cachedIndex then return cachedIndex, cachedCounts end
	local index = { }
	local counts = { }
	for tableName, family in pairs(sourceFamilies) do
		local sourceTable = data and data.itemMods and data.itemMods[tableName]
		if sourceTable then counts[family] = (counts[family] or 0) + indexTable(index, "itemMods." .. tableName, family, sourceTable) end
	end
	for _, source in ipairs({
		{ name = "masterMods", family = "crafted", value = data and data.masterMods },
		{ name = "veiledMods", family = "veiled", value = data and data.veiledMods },
		{ name = "necropolisMods", family = "necropolis", value = data and data.necropolisMods },
		{ name = "beastCraft", family = "beastcraft", value = data and data.beastCraft },
		{ name = "crucible", family = "crucible", value = data and data.crucible },
	}) do
		if source.value then counts[source.family] = indexTable(index, source.name, source.family, source.value) end
	end
	for _, candidates in pairs(index) do
		table.sort(candidates, function(left, right)
			local leftKey = left.sourceTable .. ":" .. left.modId
			local rightKey = right.sourceTable .. ":" .. right.modId
			return leftKey < rightKey
		end)
	end
	cachedData = data
	cachedIndex = index
	cachedCounts = counts
	return index, counts
end

local function donorFor(modId)
	return data and data.vestigialModMappings and data.vestigialModMappings[modId] or nil
end

local function directFamily(modLine, section)
	for _, flag in ipairs(Util.sortedKeys(dedicatedFlagFamilies)) do
		if modLine and modLine[flag] then return dedicatedFlagFamilies[flag], flag end
	end
	return sectionFamilies[section] or "unknown", nil
end

local function candidateMatchesFamily(candidate, family)
	if family == "implicit" then
		return candidate.sourceFamily == "itemExclusive"
			or candidate.sourceFamily == "corrupted"
			or candidate.sourceFamily == "delve"
			or candidate.sourceFamily == "synthesis"
			or candidate.sourceFamily == "eldritch"
	end
	if family == "explicit" then
		return candidate.sourceFamily ~= "vestigial" and candidate.sourceFamily ~= "corrupted"
	end
	return family == "unknown" or candidate.sourceFamily == family
end

local function selectCandidate(candidates, family, modLine)
	if modLine and modLine.modId then
		for _, candidate in ipairs(candidates or { }) do
			if candidate.modId == tostring(modLine.modId) then return candidate, "exact" end
		end
	end
	local filtered = { }
	for _, candidate in ipairs(candidates or { }) do
		if candidateMatchesFamily(candidate, family) then table.insert(filtered, candidate) end
	end
	if #filtered == 1 then return filtered[1], "exact" end
	if #filtered > 1 then return filtered[1], "inferred", filtered end
	if #candidates == 1 then return candidates[1], "inferred" end
	return nil, "unknown", #candidates > 0 and candidates or nil
end

function ModifierCatalog.Resolve(item, section, modLine)
	modLine = modLine or { }
	local family, flagEvidence = directFamily(modLine, section)
	local index = ensureIndex()
	local candidates = index[normalizeLine(modLine.line)] or { }
	local candidate, resolution, alternatives = selectCandidate(candidates, family, modLine)
	local result = {
		sourceFamily = candidate and candidate.sourceFamily or family,
		resolution = resolution,
		evidence = { "section:" .. tostring(section) },
	}
	if flagEvidence then table.insert(result.evidence, "flag:" .. flagEvidence) end
	if candidate then
		result.sourceTable = candidate.sourceTable
		result.sourceModId = candidate.modId
		table.insert(result.evidence, "pob-data:" .. candidate.sourceTable .. ":" .. candidate.modId)
		local donor = candidate.sourceFamily == "vestigial" and donorFor(candidate.modId)
		if donor then
			result.donorItem = donor
			table.insert(result.evidence, "vestigial-donor:" .. donor)
		end
	elseif modLine.modId then
		result.sourceModId = tostring(modLine.modId)
		table.insert(result.evidence, "mod-id:" .. tostring(modLine.modId))
	end
	if alternatives then
		result.alternatives = { }
		for index = 1, math.min(8, #alternatives) do
			local alternative = alternatives[index]
			table.insert(result.alternatives, alternative.sourceTable .. ":" .. alternative.modId)
		end
	end
	if result.sourceFamily == "custom" then result.resolution = "unknown" end
	return result
end

local function findSourceTable(name)
	local itemName = tostring(name or ""):match("^itemMods%.(.+)$")
	if itemName then return data and data.itemMods and data.itemMods[itemName] end
	return data and data[name]
end

local function describeOne(ref)
	if type(ref) ~= "table" then return nil end
	local sourceTable = findSourceTable(ref.sourceTable)
	local mod = sourceTable and (sourceTable[ref.modId] or sourceTable[tonumber(ref.modId)])
	if type(mod) ~= "table" then return nil end
	return {
		sourceTable = ref.sourceTable,
		modId = tostring(ref.modId),
		type = mod.type,
		group = mod.group,
		affix = mod.affix,
		level = tonumber(mod.level),
		lines = modifierLines(mod),
		modTags = type(mod.modTags) == "table" and mod.modTags or { },
		donorItem = ref.sourceTable == "itemMods.Vestigial" and donorFor(tostring(ref.modId)) or nil,
	}
end

function ModifierCatalog.Describe(modRefs, options)
	local limit = math.max(1, math.min(128, tonumber(options and options.limit) or 128))
	local result = { entries = { }, truncated = false }
	for _, ref in ipairs(modRefs or { }) do
		if #result.entries >= limit then result.truncated = true break end
		local description = describeOne(ref)
		if description then table.insert(result.entries, description) end
	end
	return result
end

function ModifierCatalog.Inventory()
	local _, counts = ensureIndex()
	local flags = { }
	for _, flag in ipairs(Util.sortedKeys(itemLib and itemLib.modLineFlags or { })) do table.insert(flags, flag) end
	local sections = { }
	for _, section in ipairs(itemLib and itemLib.modLineSections or { }) do table.insert(sections, section.name) end
	local families = { }
	for _, family in ipairs(Util.sortedKeys(counts)) do
		table.insert(families, { name = family, modifierCount = counts[family] })
	end
	return { version = ModifierCatalog.VERSION, sections = sections, lineFlags = flags, sourceFamilies = families }
end

return ModifierCatalog
