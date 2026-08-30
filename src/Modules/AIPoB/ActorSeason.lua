-- Native, sidecar-safe projections and mutation helpers for actor/season state.
--
-- This module deliberately returns identifiers and bounded metadata only.  PoB's
-- calculator remains authoritative for actor outputs, uptime and legality.

local sha = require("sha2")

local ActorSeason = {
	SCHEMA_VERSION = 1,
}

local SUPPORTED_RULESETS = {
	["3_29"] = true,
	["3_29_ruthless"] = true,
}

local function copy(value)
	if type(value) ~= "table" then return value end
	return copyTable(value, true)
end

local function digest(value)
	if type(value) ~= "string" then return nil end
	if type(sha) == "table" and type(sha.sha256) == "function" then
		return sha.sha256(value)
	end
	return nil
end

local function integer(value, minimum)
	return type(value) == "number" and value % 1 == 0 and value >= (minimum or 0)
end

local function sortedKeys(value)
	local keys = { }
	for key in pairs(value or { }) do table.insert(keys, key) end
	table.sort(keys, function(left, right) return tostring(left) < tostring(right) end)
	return keys
end

local function rollbackSpec(spec, undo, secondaryAscendancyId)
	if undo then spec:RestoreUndoState(undo) end
	-- PassiveSpec's undo payload predates the secondary ascendancy field.  Reapply
	-- the captured selection so a failed action cannot silently clear it.
	local expected = secondaryAscendancyId or 0
	if type(spec.SelectSecondaryAscendClass) == "function" and spec.curSecondaryAscendClassId ~= expected then
		pcall(spec.SelectSecondaryAscendClass, spec, expected)
	end
end

local function rulesetKey(value)
	if type(value) ~= "string" then return nil end
	local key = value:lower():gsub("%.", "_")
	if key == "3_29ruthless" then key = "3_29_ruthless" end
	return key
end

local function treeFor(build)
	return build and build.spec and build.spec.tree
end

local function alternateAscendancy(build, identifier)
	local tree = treeFor(build)
	local list = tree and tree.alternate_ascendancies
	if type(list) ~= "table" then return nil end
	local numericIdentifier = type(identifier) == "number" and identifier or tonumber(identifier)
	if integer(numericIdentifier, 1) then
		local value = list[numericIdentifier]
		return value and numericIdentifier or nil, value
	end
	if type(identifier) ~= "string" then return nil end
	for index, value in ipairs(list) do
		if value.id == identifier or value.name == identifier then return index, value end
	end
	return nil
end

local function minionsFor(build)
	local buildData = build and build.data
	if buildData and type(buildData.minions) == "table" then return buildData.minions end
	if type(data) == "table" and type(data.minions) == "table" then return data.minions end
	return { }
end

local function gemName(gem)
	return gem and (gem.nameSpec or (gem.gemData and gem.gemData.name))
end

local function gemId(gem)
	return gem and (gem.skillId or (gem.gemData and (gem.gemData.gameId or gem.gemData.grantedEffectId)))
end

local function isMinionGem(gem)
	return gem and gem.gemData and gem.gemData.tags and gem.gemData.tags.minion == true
		or gemName(gem) and gemName(gem):lower():find("minion", 1, true) ~= nil
	end

local function bounded(list, value, limit)
	if #list >= limit then return false end
	table.insert(list, value)
	return true
end

local function actorProvenance(build, limit)
	limit = math.max(1, math.min(500, tonumber(limit) or 128))
	local actors = {
		{ id = "actor:player", kind = "player", source = "Build" },
	}
	local seen = { ["actor:player"] = true }
	local truncated = false
	local function add(value)
		if type(value) ~= "table" or type(value.id) ~= "string" or seen[value.id] then return end
		seen[value.id] = true
		if not bounded(actors, value, limit) then truncated = true end
	end

	local skills = build and build.skillsTab
	for groupIndex, group in ipairs(skills and skills.socketGroupList or { }) do
		for gemIndex, gem in ipairs(group.gemList or { }) do
			if isMinionGem(gem) then
				local name = gemName(gem)
				local id = gemId(gem) or name
				if id then
					local actorId = "actor:minion:" .. tostring(id)
					add({
						id = actorId, kind = "minion", source = "Skills",
						skillId = gemId(gem), name = name, group = groupIndex, gem = gemIndex,
						minionId = gem.skillMinion, itemSetId = gem.skillMinionItemSet,
					})
					if name and name:lower():find("animate guardian", 1, true) then
						add({
							id = "actor:animate-guardian", kind = "animateGuardian", source = "Skills",
							skillId = gemId(gem), name = name, group = groupIndex, gem = gemIndex,
							minionId = gem.skillMinion, itemSetId = gem.skillMinionItemSet,
						})
					end
				end
			end
		end
	end
	for index, id in ipairs(build and build.spectreList or { }) do
		local key = "actor:spectre:" .. tostring(id)
		add({ id = key, kind = "spectre", source = "Build.Spectre", spectreId = id, index = index,
			known = minionsFor(build)[id] ~= nil })
	end
	local party = build and build.partyTab
	local controls = party and party.controls or { }
	for _, pair in ipairs({
		{ "Aura", "editAuras" }, { "Curse", "editCurses" }, { "Warcry", "editWarcries" },
		{ "Link", "editLinks" }, { "PartyMemberStats", "editPartyMemberStats" },
		{ "EnemyConditions", "enemyCond" }, { "EnemyMods", "enemyMods" },
	}) do
		local buffer, controlName = pair[1], pair[2]
		local control = controls[controlName]
		local text = control and control.buf or ""
		add({ id = "actor:party:" .. buffer, kind = "party", source = "Party." .. buffer,
			buffer = buffer, active = text ~= "", textHash = digest(text), sourceStatus = "manual" })
	end
	return actors, truncated
end

local function seasonProjection(build, limit)
	limit = math.max(1, math.min(500, tonumber(limit) or 128))
	local spec = build and build.spec
	local result = {
		truncated = false,
		secondaryAscendancy = nil,
		pacts = { },
		timeless = nil,
		overrides = { },
		items = { grafts = { }, tinctures = { }, foulborn = { } },
	}
	if spec and spec.curSecondaryAscendClassId and spec.curSecondaryAscendClassId ~= 0 then
		local index, value = alternateAscendancy(build, spec.curSecondaryAscendClassId)
		if index and value then
			result.secondaryAscendancy = { id = value.id, name = value.name, index = index,
				treeVersion = spec.treeVersion, source = "Tree.Spec.secondaryAscendClassId" }
		end
	end
	local skills = build and build.skillsTab
	for groupIndex, group in ipairs(skills and skills.socketGroupList or { }) do
		for gemIndex, gem in ipairs(group.gemList or { }) do
			local name = gemName(gem)
			if name and name:lower():find("pact of ", 1, true) then
				if not bounded(result.pacts, { id = "season:pact:" .. name, name = name, group = groupIndex, gem = gemIndex,
					source = "Skills.Gem", skillId = gemId(gem) }, limit) then result.truncated = true end
			end
		end
	end
	local timeless = build and build.timelessData
	if type(timeless) == "table" then
		result.timeless = {
			jewelTypeId = timeless.jewelType and timeless.jewelType.id,
			conquerorTypeId = timeless.conquerorType and timeless.conquerorType.id,
			jewelSocketId = timeless.jewelSocket and timeless.jewelSocket.id,
			devotionVariant1 = timeless.devotionVariant1, devotionVariant2 = timeless.devotionVariant2,
			source = "Build.TimelessData",
		}
	end
	for _, nodeId in ipairs(sortedKeys(spec and spec.hashOverrides or { })) do
		local override = spec.hashOverrides[nodeId]
		if #result.overrides < limit then
			table.insert(result.overrides, { nodeId = nodeId, dn = override.dn, id = override.id,
				isTattoo = override.isTattoo == true, overrideType = override.overrideType,
				source = "Tree.Spec.Overrides" })
		else result.truncated = true end
	end
	local itemsTab = build and build.itemsTab
	for _, itemId in ipairs(sortedKeys(itemsTab and itemsTab.items or { })) do
		local item = itemsTab.items[itemId]
		if item.type == "Graft" and #result.items.grafts < limit then
			table.insert(result.items.grafts, { itemId = itemId, baseName = item.baseName, type = item.type, source = "Items" })
		elseif item.type == "Graft" then result.truncated = true
		elseif item.type == "Tincture" and #result.items.tinctures < limit then
			table.insert(result.items.tinctures, { itemId = itemId, baseName = item.baseName, type = item.type, source = "Items" })
		elseif item.type == "Tincture" then result.truncated = true
		elseif item.foulborn and #result.items.foulborn < limit then
			table.insert(result.items.foulborn, { itemId = itemId, title = item.title, baseName = item.baseName, source = "Items" })
		elseif item.foulborn then result.truncated = true end
	end
	return result
end

function ActorSeason.NormalizeRuleset(value)
	return rulesetKey(value)
end

function ActorSeason.IsSupportedRuleset(value)
	return SUPPORTED_RULESETS[rulesetKey(value)] == true
end

function ActorSeason.SupportedRulesets()
	return { "3_29", "3_29_ruthless" }
end

function ActorSeason.FindSecondaryAscendancy(build, identifier)
	return alternateAscendancy(build, identifier)
end

function ActorSeason.ValidateSecondaryAscendancy(build, identifier)
	if identifier == nil or identifier == 0 or identifier == "0" then return true, 0 end
	local index, value = alternateAscendancy(build, identifier)
	if not index then return nil, "unknown secondary ascendancy: " .. tostring(identifier) end
	return true, index, value
end

function ActorSeason.ApplySecondaryAscendancy(build, identifier)
	local valid, index, value = ActorSeason.ValidateSecondaryAscendancy(build, identifier)
	if not valid then return nil, index end
	local spec = build and build.spec
	if not spec or type(spec.SelectSecondaryAscendClass) ~= "function" then return nil, "passive spec cannot select secondary ascendancy" end
	if type(spec.CountAllocNodes) ~= "function" then return nil, "passive point counter is unavailable" end
	if type(spec.CreateUndoState) ~= "function" or type(spec.RestoreUndoState) ~= "function" then
		return nil, "passive spec does not support transactional updates"
	end
	local undo = spec:CreateUndoState()
	local previousSecondaryAscendancyId = spec.curSecondaryAscendClassId
	local ok, err = pcall(spec.SelectSecondaryAscendClass, spec, index)
	if not ok then
		rollbackSpec(spec, undo, previousSecondaryAscendancyId)
		return nil, tostring(err)
	end
	local _, _, secondaryUsed = spec:CountAllocNodes()
	if secondaryUsed > 8 then
		rollbackSpec(spec, undo, previousSecondaryAscendancyId)
		return nil, "secondary ascendancy point budget exceeded: " .. tostring(secondaryUsed) .. " / 8"
	end
	build.buildFlag = true
	return true, index, value
end

function ActorSeason.ValidateOverride(build, nodeId, dn)
	if not integer(nodeId, 1) then return nil, "override nodeId must be a positive integer" end
	if type(dn) ~= "string" or dn == "" then return nil, "override dn is required" end
	local spec = build and build.spec
	local node = spec and spec.nodes and spec.nodes[nodeId]
	local tattoo = spec and spec.tree and spec.tree.tattoo and spec.tree.tattoo.nodes and spec.tree.tattoo.nodes[dn]
	if not node then return nil, "passive override node does not exist: " .. tostring(nodeId) end
	if not tattoo then return nil, "unknown passive override: " .. tostring(dn) end
	return true, node, tattoo
end

function ActorSeason.ApplyOverride(build, nodeId, dn)
	local valid, node, tattoo = ActorSeason.ValidateOverride(build, nodeId, dn)
	if not valid then return nil, node end
	local spec = build.spec
	if type(spec.BuildAllDependsAndPaths) ~= "function" then return nil, "passive dependency builder is unavailable" end
	if type(spec.CreateUndoState) ~= "function" or type(spec.RestoreUndoState) ~= "function" then
		return nil, "passive spec does not support transactional updates"
	end
	local undo = spec:CreateUndoState()
	spec.hashOverrides = spec.hashOverrides or { }
	local override = copy(tattoo)
	override.id = nodeId
	spec.hashOverrides[nodeId] = override
	local ok, err = pcall(spec.BuildAllDependsAndPaths, spec)
	if not ok then
		rollbackSpec(spec, undo)
		return nil, tostring(err)
	end
	build.buildFlag = true
	return true, node, override
end

function ActorSeason.Project(build, options)
	options = options or { }
	local actors, actorTruncated = actorProvenance(build, options.limit)
	local season = seasonProjection(build, options.limit)
	return {
		schemaVersion = ActorSeason.SCHEMA_VERSION,
		ruleset = build and build.targetVersion,
		treeVersion = build and build.spec and build.spec.treeVersion,
		actors = actors,
		season = season,
		truncated = actorTruncated or season.truncated == true,
	}
end

return ActorSeason
