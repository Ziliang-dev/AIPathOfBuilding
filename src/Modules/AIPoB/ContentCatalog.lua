local Util = require("Modules.AIPoB.Util")
local ActorSeason = require("Modules.AIPoB.ActorSeason")
local NativeEvidence = require("Modules.AIPoB.NativeEvidence")
local NativeLinkProbe = require("Modules.AIPoB.NativeLinkProbe")

local ContentCatalog = { SCHEMA_VERSION = 1 }

local allowedDomains = {
	ruleset = true, skills = true, items = true, tree = true, actors = true, config = true, loadouts = true,
}

local function selectedDomains(requested)
	local selected = { }
	if type(requested) ~= "table" or #requested == 0 then
		for domain in pairs(allowedDomains) do selected[domain] = true end
		return selected
	end
	for _, domain in ipairs(requested) do
		if allowedDomains[domain] then selected[domain] = true end
	end
	return selected
end

local function boundedInsert(list, value, limit)
	if #list < limit then table.insert(list, value) end
end

local function stringKeys(value)
	local result = { }
	for _, key in ipairs(Util.sortedKeys(value or { })) do table.insert(result, tostring(key)) end
	return result
end

local function exportSkills(build, limit)
	local result = { groups = { }, availableGems = { }, availableGemCount = data and data.gems and 0 or nil,
		currentGroupsTruncated = false, truncated = false }
	local groupCount = 0
	for index, group in ipairs(build.skillsTab and build.skillsTab.socketGroupList or { }) do
		groupCount = groupCount + 1
		local exported = {
			index = index, label = group.label, slot = group.slot, enabled = group.enabled,
			includeInFullDPS = group.includeInFullDPS, gems = { },
		}
		for gemIndex, gem in ipairs(group.gemList or { }) do
			boundedInsert(exported.gems, {
				index = gemIndex, name = gem.nameSpec, level = gem.level, quality = gem.quality,
				qualityId = gem.qualityId, enabled = gem.enabled, count = gem.count,
				skillPart = gem.skillPart, skillPartCalcs = gem.skillPartCalcs,
				skillStage = gem.skillStage, skillStageCount = gem.skillStageCount,
				skillStageCountCalcs = gem.skillStageCountCalcs,
				includeInFullDPS = gem.includeInFullDPS,
				enableGlobal1 = gem.enableGlobal1, enableGlobal2 = gem.enableGlobal2,
			}, limit)
		end
		boundedInsert(result.groups, exported, limit)
	end
	result.currentGroupsTruncated = groupCount > #result.groups
	if data and data.gems then
		local count = 0
		for _, id in ipairs(Util.sortedKeys(data.gems)) do
			count = count + 1
			local gem = data.gems[id]
			boundedInsert(result.availableGems, {
				id = id, name = gem.name or gem.baseTypeName, variantId = gem.variantId,
				grantedEffectId = gem.grantedEffectId, support = gem.tags and gem.tags.support == true,
				tags = stringKeys(gem.tags), naturalMaxLevel = gem.naturalMaxLevel,
				requirements = { str = gem.reqStr, dex = gem.reqDex, int = gem.reqInt },
			}, limit)
		end
		result.availableGemCount = count
		result.truncated = count > #result.availableGems
	end
	local nativeProbe = NativeLinkProbe.Extract(build, { limit = limit })
	if nativeProbe then result.nativeLinkProbe = nativeProbe end
	return result
end

local function exportItems(build, limit)
	local tab = build.itemsTab
	local result = { items = { }, slots = { }, itemSets = { }, actionCandidates = { }, truncated = false }
	for _, itemId in ipairs(tab and tab.itemOrderList or { }) do
		local item = tab.items[itemId]
		if item then
			boundedInsert(result.items, {
				id = itemId, name = item.name, baseName = item.baseName, type = item.type,
				rarity = item.rarity, quality = item.quality, level = item.level,
			}, limit)
		end
	end
	for _, slotName in ipairs(Util.sortedKeys(tab and tab.slots or { })) do
		local slot = tab.slots[slotName]
		boundedInsert(result.slots, { name = slotName, itemId = slot.selItemId or 0, active = slot.active ~= false, nodeId = slot.nodeId }, limit)
	end
	for _, id in ipairs(tab and tab.itemSetOrderList or { }) do
		local set = tab.itemSets[id]
		boundedInsert(result.itemSets, { id = id, title = set and set.title, active = id == tab.activeItemSetId, useSecondWeaponSet = set and set.useSecondWeaponSet == true }, limit)
	end
	local candidateCount = 0
	for _, itemId in ipairs(tab and tab.itemOrderList or { }) do
		local item = tab.items[itemId]
		for _, slotName in ipairs(Util.sortedKeys(tab.slots or { })) do
			local slot = tab.slots[slotName]
			if item and not slot.nodeId and (not tab.IsItemValidForSlot or tab:IsItemValidForSlot(item, slotName, tab.activeItemSet)) then
				candidateCount = candidateCount + 1
				boundedInsert(result.actionCandidates, {
					kind = "replaceItem", payload = { slot = slotName, itemId = itemId, itemSetId = tab.activeItemSetId },
				}, limit)
			end
		end
	end
	result.truncated = candidateCount > #result.actionCandidates or #result.items >= limit or #result.slots >= limit
	return result
end

local function exportTree(build, limit)
	local spec = build.spec
	local passiveUsed, ascendancyUsed, secondaryAscendancyUsed = 0, 0, 0
	if spec and type(spec.CountAllocNodes) == "function" then
		passiveUsed, ascendancyUsed, secondaryAscendancyUsed = spec:CountAllocNodes()
	end
	local extraPoints = build.calcsTab and build.calcsTab.mainOutput and tonumber(build.calcsTab.mainOutput.ExtraPoints) or 0
	local levelCap = build.characterLevelAutoMode and 100 or tonumber(build.characterLevel) or 1
	levelCap = math.max(1, math.min(100, levelCap))
	local passiveMax = math.max(0, levelCap - 1) + 23 + extraPoints
	local result = {
		treeVersion = spec and spec.treeVersion, allocated = { }, masteries = { }, jewels = { },
		connectable = { }, masteryCandidates = { }, truncated = false,
		pointBudget = {
			passiveUsed = passiveUsed, passiveMax = passiveMax, remainingPassive = math.max(0, passiveMax - passiveUsed),
			ascendancyUsed = ascendancyUsed, ascendancyMax = 8, remainingAscendancy = math.max(0, 8 - ascendancyUsed),
			secondaryAscendancyUsed = secondaryAscendancyUsed, secondaryAscendancyMax = 8,
		},
	}
	for _, id in ipairs(Util.sortedKeys(spec and spec.allocNodes or { })) do
		local node = spec.allocNodes[id]
		local masteryEffectId = spec.masterySelections and spec.masterySelections[id]
		local masteryEffect = masteryEffectId and spec.tree and spec.tree.masteryEffects and spec.tree.masteryEffects[masteryEffectId]
		boundedInsert(result.allocated, {
			id = id, name = node.dn or node.name, type = node.type,
			stats = node.sd or node.stats or { },
			isTattoo = node.isTattoo == true, runegraft = node.runegraft,
			masteryEffectId = masteryEffectId, masteryStats = masteryEffect and masteryEffect.sd or { },
			ascendancyName = node.ascendancyName, classStartIndex = node.classStartIndex,
			isProxy = node.isProxy == true, proxyNodeId = node.proxyNode and node.proxyNode.id,
			expansionJewel = node.expansionJewel == true, clusterJewelNodeId = node.clusterJewelNodeId,
			jewelRadius = node.jewelRadius or node.radius,
		}, limit)
	end
	for _, id in ipairs(Util.sortedKeys(spec and spec.masterySelections or { })) do
		boundedInsert(result.masteries, { nodeId = id, effectId = spec.masterySelections[id] }, limit)
	end
	for _, nodeId in ipairs(Util.sortedKeys(spec and spec.jewels or { })) do
		boundedInsert(result.jewels, { nodeId = nodeId, itemId = spec.jewels[nodeId] }, limit)
	end
	local connectable = { }
	for id, node in pairs(spec and spec.nodes or { }) do
		if not node.alloc and type(node.path) == "table" and #node.path > 0 then
			table.insert(connectable, { id = id, node = node, cost = #node.path })
		end
	end
	table.sort(connectable, function(left, right) return left.cost == right.cost and left.id < right.id or left.cost < right.cost end)
	for _, entry in ipairs(connectable) do
		local path = { }
		for _, pathNode in ipairs(entry.node.path) do table.insert(path, pathNode.id) end
		boundedInsert(result.connectable, {
			id = entry.id, name = entry.node.dn or entry.node.name, type = entry.node.type,
			pointCost = entry.cost, pointPool = entry.node.ascendancyName and "ascendancy" or "passive", path = path,
		}, limit)
		if entry.node.type == "Mastery" then
			for _, effect in ipairs(entry.node.masteryEffects or { }) do
				local effectId = effect.effect or effect.id
				local effectData = effectId and spec.tree.masteryEffects[effectId]
				boundedInsert(result.masteryCandidates, {
					nodeId = entry.id, effectId = effectId, stats = effectData and effectData.sd or { },
					pointCost = entry.cost, pointPool = "passive", path = path,
				}, limit)
			end
		end
	end
	result.allocatedTruncated = #(spec and Util.sortedKeys(spec.allocNodes or { }) or { }) > #result.allocated
	result.truncated = #connectable > #result.connectable or result.allocatedTruncated
	return result
end

local function exportActors(build, limit)
	local spectres = { }
	for _, id in ipairs(build.spectreList or { }) do boundedInsert(spectres, id, limit) end
	local projection = ActorSeason.Project(build, { limit = limit })
	return {
		player = true,
		minions = build.calcsTab and build.calcsTab.mainEnv and build.calcsTab.mainEnv.minion ~= nil,
		spectres = spectres,
		actors = projection.actors,
		season = projection.season,
		actorSeason = projection,
	}
end

local function exportConfig(build, limit)
	local values = { }
	local conditionClaims = { }
	local input = build.configTab and build.configTab.input or { }
	local valueCount = 0
	for _, key in ipairs(Util.sortedKeys(input)) do
		local value = input[key]
		if type(value) == "string" or type(value) == "number" or type(value) == "boolean" then
			valueCount = valueCount + 1
			boundedInsert(values, { name = key, value = value }, limit)
		end
	end
	local options = require("Modules.ConfigOptions")
	local claimCount = 0
	for _, option in ipairs(options) do
		if type(option.var) == "string" then
			claimCount = claimCount + 1
			local current = input[option.var]
			local default
			if build.configTab and type(build.configTab.GetDefaultState) == "function" then
				local ok, value = pcall(build.configTab.GetDefaultState, build.configTab, option.var, type(current))
				if ok then default = value end
			end
			local configured = current ~= nil and current ~= default
			boundedInsert(conditionClaims, {
				condition = option.var, configKey = option.var, label = option.label,
				current = current, value = option.type == "check" and true or current,
				optionType = option.type, category = option.category or option.section or "configuration",
				requiresFlag = option.ifCond, implies = option.implyCond or option.implyCondList,
				source = configured and "current-config" or nil,
				sourceStatus = configured and "manual" or "unknown",
				trigger = nil, uptime = nil,
			}, limit)
		end
	end
	local nativeEvidence = NativeEvidence.Extract(build, { })
	return {
		activeConfigSetId = build.configTab and build.configTab.activeConfigSetId,
		values = values, conditionClaims = conditionClaims,
		nativeEvidence = nativeEvidence,
		valuesTruncated = valueCount > #values,
		conditionClaimsTruncated = claimCount > #conditionClaims,
		truncated = valueCount > #values or claimCount > #conditionClaims,
	}
end

function ContentCatalog.Export(build, options)
	if type(build) ~= "table" then return nil, "build is required" end
	options = options or { }
	local limit = math.max(1, math.min(tonumber(options.limit) or 5000, 10000))
	local domains = selectedDomains(options.domains)
	local result = { schemaVersion = ContentCatalog.SCHEMA_VERSION, truncatedAt = limit, domains = { } }
	if domains.ruleset then
		result.domains.ruleset = {
			targetVersion = build.targetVersion, treeVersion = build.spec and build.spec.treeVersion,
			level = build.characterLevel, class = build.spec and build.spec.curClassName,
			ascendancy = build.spec and build.spec.curAscendClassName,
			bandit = build.configTab and build.configTab.input.bandit,
			pantheonMajor = build.configTab and build.configTab.input.pantheonMajorGod,
			pantheonMinor = build.configTab and build.configTab.input.pantheonMinorGod,
		}
	end
	if domains.skills and build.skillsTab then result.domains.skills = exportSkills(build, limit) end
	if domains.items and build.itemsTab then result.domains.items = exportItems(build, limit) end
	if domains.tree and build.spec then result.domains.tree = exportTree(build, limit) end
	if domains.actors then result.domains.actors = exportActors(build, limit) end
	if domains.config and build.configTab then result.domains.config = exportConfig(build, limit) end
	if domains.loadouts then
		result.domains.loadouts = {
			activeTreeSpecId = build.treeTab and build.treeTab.activeSpec,
			activeItemSetId = build.itemsTab and build.itemsTab.activeItemSetId,
			activeSkillSetId = build.skillsTab and build.skillsTab.activeSkillSetId,
			activeConfigSetId = build.configTab and build.configTab.activeConfigSetId,
			treeSpecIds = build.treeTab and Util.shallowCopy(build.treeTab.specList and (function()
				local ids = { } for id in ipairs(build.treeTab.specList) do table.insert(ids, id) end return ids
			end)() or { }) or { },
			itemSetIds = build.itemsTab and Util.shallowCopy(build.itemsTab.itemSetOrderList) or { },
			skillSetIds = build.skillsTab and Util.shallowCopy(build.skillsTab.skillSetOrderList) or { },
			configSetIds = build.configTab and Util.shallowCopy(build.configTab.configSetOrderList) or { },
			truncated = false,
		}
	end
	return result
end

function ContentCatalog.ToEntries(catalog)
	local entries = { }
	local domainMap = {
		ruleset = "rules", skills = "skills", items = "gear", tree = "tree",
		actors = "actor", config = "config", loadouts = "progression",
	}
	for _, key in ipairs({ "ruleset", "skills", "items", "tree", "actors", "config", "loadouts" }) do
		local value = catalog and catalog.domains and catalog.domains[key]
		if value then
			table.insert(entries, {
				id = "pob:" .. key, domain = domainMap[key], kind = "currentBuild",
				name = key, available = true, data = value,
			})
		end
	end
	return entries
end

return ContentCatalog
