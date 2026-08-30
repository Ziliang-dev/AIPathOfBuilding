local Util = require("Modules.AIPoB.Util")
local sha = require("sha2")

-- Native skill/link facts.  The calculator remains the authority: this module
-- only serialises the objects and decisions produced by the live PoB engine.
local NativeLinkProbe = { SCHEMA_VERSION = 1 }

local function sortedFlagKeys(value)
	local keys = { }
	for key, enabled in pairs(value or { }) do
		if enabled then table.insert(keys, tostring(key)) end
	end
	table.sort(keys)
	return keys
end

local function grantedIdentity(grantedEffect)
	if type(grantedEffect) ~= "table" then return nil end
	return {
		id = grantedEffect.id,
		name = grantedEffect.name,
		support = grantedEffect.support == true,
		unsupported = grantedEffect.unsupported == true,
		cannotBeSupported = grantedEffect.cannotBeSupported == true,
		fromItem = grantedEffect.fromItem == true,
		skillTypes = sortedFlagKeys(grantedEffect.skillTypes),
		minionSkillTypes = sortedFlagKeys(grantedEffect.minionSkillTypes),
	}
end

local function actorKind(actor)
	if type(actor) ~= "table" then return "unknown" end
	if actor.enemy and actor.enemy.player == actor then return "player" end
	if actor.type then return tostring(actor.type) end
	return "unknown"
end

local function activeIdentity(activeSkill)
	local activeEffect = activeSkill and activeSkill.activeEffect
	local grantedEffect = activeEffect and activeEffect.grantedEffect
	if type(grantedEffect) ~= "table" then return nil end
	local identity = grantedIdentity(grantedEffect)
	identity.actor = actorKind(activeSkill.actor)
	identity.fromItem = grantedEffect.fromItem == true
		or (activeEffect.srcInstance and activeEffect.srcInstance.fromItem == true) or false
	identity.skillTypes = sortedFlagKeys(activeSkill.skillTypes)
	identity.minionSkillTypes = sortedFlagKeys(activeSkill.minionSkillTypes)
	identity.acceptedSupportIds = { }
	identity.acceptedSupportNames = { }
	for _, effect in ipairs(activeSkill.effectList or { }) do
		local support = effect and effect.grantedEffect
		if support and support.support then
			table.insert(identity.acceptedSupportIds, tostring(support.id))
			table.insert(identity.acceptedSupportNames, tostring(support.name or support.id))
		end
	end
	table.sort(identity.acceptedSupportIds)
	table.sort(identity.acceptedSupportNames)
	return identity
end

local function currentGem(gem, index)
	if type(gem) ~= "table" then return nil end
	local gemData = gem.gemData
	local grantedEffect = gem.grantedEffect or (gemData and gemData.grantedEffect)
	return {
		index = index,
		name = gem.nameSpec,
		gemId = gemData and gemData.id,
		gameId = gemData and gemData.gameId,
		variantId = gemData and gemData.variantId,
		grantedEffectId = grantedEffect and grantedEffect.id or gem.skillId,
		enabled = gem.enabled ~= false,
		support = grantedEffect and grantedEffect.support == true or false,
	}
end

local function activeSkills(group)
	local result = { }
	local complete = true
	for index, activeSkill in ipairs(group.displaySkillList or { }) do
		local identity = activeIdentity(activeSkill)
		if identity then
			identity.index = index
			table.insert(result, identity)
		elseif activeSkill ~= nil then
			complete = false
		end
	end
	return result, complete
end

local function supportContext(supportEffect)
	return {
		fromItem = supportEffect and supportEffect.grantedEffect and supportEffect.grantedEffect.fromItem == true or false,
		appliesToGrantedSkills = supportEffect and supportEffect.appliesToGrantedSkills == true or false,
		-- Imbued/ExtraSupport effects are synthesized without srcInstance. Item
		-- ExtraSupport marks grantedEffect.fromItem; an unmarked synthetic support
		-- is therefore an imbued support. Keep this fact explicit for consumers.
		imbued = supportEffect and supportEffect.imbuedSupport == true
			or (supportEffect ~= nil and supportEffect.srcInstance == nil and supportEffect.grantedEffect and supportEffect.grantedEffect.fromItem ~= true)
			or false,
	}
end

local function currentSupportEffects(group, gemOrigins)
	local result = { }
	local complete = true
	for activeSkillIndex, activeSkill in ipairs(group.displaySkillList or { }) do
		local identity = activeIdentity(activeSkill)
		if not identity then complete = false end
		for _, effect in ipairs(activeSkill.effectList or { }) do
			local grantedEffect = effect and effect.grantedEffect
			if grantedEffect and grantedEffect.support then
				local origin = effect.srcInstance and gemOrigins[effect.srcInstance] or nil
				if effect.srcInstance ~= nil and origin == nil then complete = false end
				table.insert(result, {
					grantedEffectId = grantedEffect.id,
					name = grantedEffect.name,
					context = supportContext(effect),
					appliesToSkillIndex = activeSkillIndex,
					appliesToSkillId = identity and identity.id or nil,
					sourceResolved = effect.srcInstance == nil or origin ~= nil,
					sourceGroup = origin and origin.group or nil,
					sourceGem = origin and origin.gem or nil,
				})
			end
		end
	end
	return result, complete
end

local function crossLinkedSupportSlots(build, socketGroup)
	local links = build.calcsTab and build.calcsTab.mainEnv and build.calcsTab.mainEnv.crossLinkedSupportGroups
	if type(links) ~= "table" then return { } end
	local target = socketGroup.slot and socketGroup.slot:gsub(" Swap", "") or nil
	if not target then return { } end
	local result = { }
	for supportSlot, targets in pairs(links) do
		for _, supportedSlot in ipairs(type(targets) == "table" and targets or { }) do
			if supportedSlot == target then
				table.insert(result, tostring(supportSlot))
				break
			end
		end
	end
	table.sort(result)
	return result
end

local function candidateSupports(build, skills, options)
	local result = { }
	local checker = type(calcLib) == "table" and calcLib.canGrantedEffectSupportActiveSkill or nil
	local data = build.data
	local complete = type(checker) == "function" and type(data) == "table" and type(data.gems) == "table"
	if type(data) ~= "table" or type(data.gems) ~= "table" then return result, complete end
	for _, gemId in ipairs(Util.sortedKeys(data.gems or { })) do
		local gemData = data.gems[gemId]
		local effects = gemData and gemData.grantedEffectList or { gemData and gemData.grantedEffect }
		for effectIndex, grantedEffect in ipairs(effects or { }) do
			if grantedEffect and grantedEffect.support then
				local acceptedBy = { }
				local acceptedByIds = { }
				for skillIndex, activeSkill in ipairs(skills or { }) do
					local ok, accepted
					if checker then
						ok, accepted = pcall(checker, grantedEffect, activeSkill, options.imbuedSupport == true, nil)
					else
						ok = false
					end
					if not ok then
						complete = false
					elseif accepted then
						table.insert(acceptedBy, skillIndex)
						local activeEffect = activeSkill and activeSkill.activeEffect
						local activeGrantedEffect = activeEffect and activeEffect.grantedEffect
						if activeGrantedEffect and activeGrantedEffect.id then
							table.insert(acceptedByIds, tostring(activeGrantedEffect.id))
						end
					end
				end
				table.sort(acceptedBy)
				table.sort(acceptedByIds)
				local supportId = tostring(gemId) .. "#" .. tostring(grantedEffect.id or effectIndex)
				table.insert(result, {
					id = supportId,
					gemId = gemId,
					gameId = gemData.gameId,
					variantId = gemData.variantId,
					grantedEffectId = grantedEffect.id,
					name = grantedEffect.name or gemData.name,
					acceptedBy = acceptedBy,
					acceptedByIds = acceptedByIds,
					available = true,
				})
			end
		end
	end
	return result, complete
end

local function probeFingerprint(build, groups, options)
	local parts = {
		tostring(_G.version or _G.buildVersion or "unknown"),
		tostring(_G.dataVersion or build.targetVersion or "unknown"),
		"imbuedSupport=" .. tostring(options and options.imbuedSupport == true),
	}
	for _, group in ipairs(groups) do
		table.insert(parts, tostring(group.index))
		for _, supportSlot in ipairs(group.crossLinkedSupportSlots or { }) do table.insert(parts, "cross:" .. tostring(supportSlot)) end
		for _, skill in ipairs(group.activeSkills or { }) do
			table.insert(parts, tostring(skill.id or ""))
			for _, supportId in ipairs(skill.acceptedSupportIds or { }) do table.insert(parts, tostring(supportId)) end
		end
		for _, support in ipairs(group.supports or { }) do
			table.insert(parts, tostring(support.id))
			for _, skillIndex in ipairs(support.acceptedBy or { }) do table.insert(parts, tostring(skillIndex)) end
			for _, skillId in ipairs(support.acceptedByIds or { }) do table.insert(parts, tostring(skillId)) end
		end
		for _, support in ipairs(group.currentSupports or { }) do
			table.insert(parts, table.concat({
				"current", tostring(support.grantedEffectId or ""),
				tostring(support.appliesToSkillIndex or ""), tostring(support.appliesToSkillId or ""),
				tostring(support.sourceGroup or ""), tostring(support.sourceGem or ""),
				tostring(support.sourceResolved),
			}, ":"))
		end
	end
	return sha.sha256(table.concat(parts, "\n"))
end

function NativeLinkProbe.Extract(build, options)
	if type(build) ~= "table" then return nil, "build is required" end
	if not build.skillsTab then return nil, "build has no skills tab" end
	if type(build.calcsTab) ~= "table" or type(build.calcsTab.mainEnv) ~= "table" then
		return nil, "native calculator output is unavailable"
	end
	if type(build.skillsTab.socketGroupList) ~= "table" then
		return nil, "native socket groups are unavailable"
	end
	options = type(options) == "table" and options or { }
	local groups = { }
	local complete = true
	local gemOrigins = { }
	for groupIndex, socketGroup in ipairs(build.skillsTab.socketGroupList or { }) do
		for gemIndex, gem in ipairs(socketGroup.gemList or { }) do
			gemOrigins[gem] = { group = groupIndex, gem = gemIndex }
		end
	end
	for index, socketGroup in ipairs(build.skillsTab.socketGroupList or { }) do
		local skills = socketGroup.displaySkillList or { }
		local active, activeComplete = activeSkills(socketGroup)
		local supports, supportsComplete = candidateSupports(build, skills, options)
		local currentSupports, currentSupportsComplete = currentSupportEffects(socketGroup, gemOrigins)
		complete = complete and activeComplete and supportsComplete and currentSupportsComplete
		local gems = { }
		for gemIndex, gem in ipairs(socketGroup.gemList or { }) do
			local exported = currentGem(gem, gemIndex)
			if exported then table.insert(gems, exported) end
		end
		table.insert(groups, {
			index = index,
			slot = socketGroup.slot,
			source = socketGroup.source,
			crossLinkedSupportSlots = crossLinkedSupportSlots(build, socketGroup),
			enabled = socketGroup.enabled ~= false,
			slotEnabled = socketGroup.slotEnabled ~= false,
			includeInFullDps = socketGroup.includeInFullDPS == true or socketGroup.includeInFullDps == true,
			mainActiveSkill = socketGroup.mainActiveSkill,
			noSupports = socketGroup.noSupports == true,
			capacity = #gems,
			gems = gems,
			activeSkills = active,
			currentSupports = currentSupports,
			supports = supports,
		})
	end
	local result = {
		schemaVersion = NativeLinkProbe.SCHEMA_VERSION,
		complete = complete,
		truncated = false,
		engineVersion = tostring(_G.version or _G.buildVersion or "unknown"),
		dataVersion = tostring(_G.dataVersion or build.targetVersion or "unknown"),
		groups = groups,
	}
	result.probeFingerprint = probeFingerprint(build, groups, options)
	-- Keep semantic alias for cross-process candidate records while retaining the
	-- compact internal field used by schema v1 fixtures.
	result.nativeProbeFingerprint = result.probeFingerprint
	return result
end

return NativeLinkProbe
