local sha = require("sha2")
local Util = require("Modules.AIPoB.Util")
local BuildState = require("Modules.AIPoB.BuildState")
local Metrics = require("Modules.AIPoB.Metrics")
local ModifierProjection = require("Modules.AIPoB.ModifierProjection")
local NativeEvidence = require("Modules.AIPoB.NativeEvidence")
local NativeLinkProbe = require("Modules.AIPoB.NativeLinkProbe")

-- Worker-only diagnostic mutations. This module never emits a BuildAction and
-- is loaded only by AIPoBWorker.lua against an isolated BuildSandbox.
local MechanicExperiment = { }
local jsonObjectMeta = { __jsontype = "object" }

local function jsonObject(value)
	return setmetatable(value or { }, jsonObjectMeta)
end

local partyTypes = {
	Aura = { control = "editAuras", actor = "Aura" },
	Curse = { control = "editCurses", actor = "Curse" },
	Warcry = { control = "editWarcries", actor = "Warcry" },
	["Warcry Skills"] = { control = "editWarcries", actor = "Warcry" },
	Link = { control = "editLinks", actor = "Link" },
	["Link Skills"] = { control = "editLinks", actor = "Link" },
	PartyMemberStats = { control = "editPartyMemberStats", actor = "modDB" },
	EnemyConditions = { control = "enemyCond", enemy = true },
	EnemyMods = { control = "enemyMods", enemy = true },
}

local function finite(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function sortedPrimitiveRecord(value)
	local result = { }
	for _, key in ipairs(Util.sortedKeys(value or { })) do
		local current = value[key]
		if type(current) == "string" or type(current) == "boolean" or finite(current) then
			result[tostring(key)] = current
		end
	end
	return jsonObject(result)
end

local function activeConfigValues(configTab)
	local active = { }
	local defaults = configTab and configTab.defaultState or { }
	for key, value in pairs(configTab and configTab.input or { }) do
		if value ~= defaults[key] then active[key] = value end
	end
	return sortedPrimitiveRecord(active)
end

local function numericOutputFields(output, predicate, limit)
	local result, count = { }, 0
	for _, key in ipairs(Util.sortedKeys(output or { })) do
		if count >= limit then break end
		local value = output[key]
		if finite(value) and predicate(tostring(key)) then
			result[tostring(key)] = value
			count = count + 1
		end
	end
	return jsonObject(result)
end

local function outputResources(output)
	return numericOutputFields(output, function(key)
		return key:find("Cost", 1, true) or key:find("Reserved", 1, true)
			or key:find("Reservation", 1, true) or key:find("Regen", 1, true)
			or key:find("Leech", 1, true) or key:find("Recovery", 1, true)
			or key == "Life" or key == "Mana" or key == "EnergyShield"
	end, 1024)
end

local function outputCooldowns(output)
	return numericOutputFields(output, function(key) return key:find("Cooldown", 1, true) ~= nil end, 1024)
end

local function outputDurations(output)
	return numericOutputFields(output, function(key) return key:find("Duration", 1, true) ~= nil end, 1024)
end

local function outputContributions(output)
	return numericOutputFields(output, function() return true end, 4096)
end

local function setContext(build, context)
	if context ~= "weaponSet1" and context ~= "weaponSet2" then return nil, "invalid mechanic context" end
	local tab = build.itemsTab
	if type(tab) ~= "table" or type(tab.activeItemSet) ~= "table" then return nil, "item set is unavailable" end
	if type(tab.SetActiveItemSet) == "function" then tab:SetActiveItemSet(tab.activeItemSetId) end
	tab.activeItemSet.useSecondWeaponSet = context == "weaponSet2"
	build.buildFlag = true
	return true
end

local function supportObservations(group)
	local result, seen = { }, { }
	for _, support in ipairs(group.currentSupports or { }) do
		local id = tostring(support.grantedEffectId or support.name or "unknown")
		if not seen[id] then
			seen[id] = true
			table.insert(result, {
				id = id, name = tostring(support.name or id),
				fromItem = support.context and support.context.fromItem == true or false,
			})
		end
	end
	table.sort(result, function(left, right) return left.id < right.id end)
	return result
end

local function skillObservations(build, probe)
	local result = { }
	for _, group in ipairs(probe.groups or { }) do
		local socketGroup = build.skillsTab and build.skillsTab.socketGroupList[group.index]
		if group.enabled and group.slotEnabled then
			for index, skill in ipairs(group.activeSkills or { }) do
				local id = tostring(skill.id or skill.name or index)
				table.insert(result, {
					id = tostring(group.index) .. ":" .. id .. ":" .. tostring(index),
					name = tostring(skill.name or id), group = group.index, enabled = true,
					includeInFullDps = socketGroup and socketGroup.includeInFullDPS == true or false,
					fromItem = skill.fromItem == true, supports = supportObservations(group),
				})
			end
		end
	end
	table.sort(result, function(left, right) return left.id < right.id end)
	return result
end

local function conditionObservations(evidence)
	local result = { }
	for _, claim in ipairs(evidence.claims or { }) do
		local sources = { }
		for _, source in ipairs(claim.sources or { }) do table.insert(sources, tostring(source.id)) end
		table.sort(sources)
		table.insert(result, {
			id = tostring(claim.actor or "player") .. ":" .. tostring(claim.condition),
			actor = tostring(claim.actor or "player"), sources = sources,
		})
	end
	table.sort(result, function(left, right) return left.id < right.id end)
	return result
end

local function activeModifierIds(projection)
	local result = { }
	for _, item in ipairs(projection.items or { }) do
		for _, line in ipairs(item.modifierLines or { }) do
			if line.active then table.insert(result, tostring(line.id)) end
		end
	end
	table.sort(result)
	return result
end

local function activeItemIds(projection)
	local result = { }
	for _, item in ipairs(projection.items or { }) do if item.active then table.insert(result, tostring(item.id)) end end
	table.sort(result)
	return result
end

local function activePassiveIds(build)
	local result = { }
	for _, id in ipairs(Util.sortedKeys(build.spec and build.spec.allocNodes or { })) do table.insert(result, tostring(id)) end
	return result
end

local function appendRecord(parts, name, record)
	for _, key in ipairs(Util.sortedKeys(record or { })) do
		table.insert(parts, name .. ":" .. tostring(key) .. "=" .. tostring(record[key]))
	end
end

local function observationFingerprint(observation)
	local parts = { observation.context, observation.projectionFingerprint, observation.nativeProbeFingerprint, observation.evidenceFingerprint }
	for _, skill in ipairs(observation.skills) do
		table.insert(parts, "skill:" .. skill.id)
		for _, support in ipairs(skill.supports or { }) do table.insert(parts, "support:" .. skill.id .. ":" .. support.id) end
	end
	for _, condition in ipairs(observation.conditions) do table.insert(parts, "condition:" .. condition.id) end
	for _, id in ipairs(observation.activeItemIds) do table.insert(parts, "item:" .. id) end
	for _, id in ipairs(observation.activeModifierIds) do table.insert(parts, "modifier:" .. id) end
	for _, id in ipairs(observation.activePassiveIds) do table.insert(parts, "passive:" .. id) end
	appendRecord(parts, "metric", observation.metrics)
	appendRecord(parts, "config", observation.configValues)
	appendRecord(parts, "resource", observation.resources)
	appendRecord(parts, "cooldown", observation.cooldowns)
	appendRecord(parts, "duration", observation.durations)
	appendRecord(parts, "contribution", observation.contributions)
	return "sha256:" .. sha.sha256(table.concat(parts, "\n"))
end

function MechanicExperiment.Observe(build, context, probeOptions)
	local projection, projectionErr = ModifierProjection.Capture(build)
	if not projection then return nil, projectionErr end
	local linkProbe, linkErr = NativeLinkProbe.Extract(build, probeOptions)
	if not linkProbe then return nil, linkErr end
	local nativeEvidence, evidenceErr = NativeEvidence.Extract(build, probeOptions)
	if not nativeEvidence then return nil, evidenceErr end
	if not linkProbe.complete or linkProbe.truncated or not nativeEvidence.complete or nativeEvidence.truncated then
		return nil, "native mechanic observation is incomplete"
	end
	local metrics, metricsErr = Metrics.Capture(build)
	if not metrics then return nil, metricsErr end
	local output = build.calcsTab and build.calcsTab.mainOutput or { }
	local observation = {
		context = context,
		projectionFingerprint = projection.fingerprint,
		nativeProbeFingerprint = linkProbe.nativeProbeFingerprint or linkProbe.probeFingerprint,
		evidenceFingerprint = nativeEvidence.evidenceFingerprint or nativeEvidence.probeFingerprint,
		metrics = jsonObject(metrics),
		skills = skillObservations(build, linkProbe),
		conditions = conditionObservations(nativeEvidence),
		activeItemIds = activeItemIds(projection), activeModifierIds = activeModifierIds(projection),
		activePassiveIds = activePassiveIds(build),
		configValues = activeConfigValues(build.configTab),
		resources = outputResources(output), cooldowns = outputCooldowns(output), durations = outputDurations(output),
		contributions = outputContributions(output),
	}
	observation.fingerprint = observationFingerprint(observation)
	return observation
end

local function suppressModifier(build, intervention)
	local item = build.itemsTab and build.itemsTab.items[tonumber(intervention.itemId) or intervention.itemId]
	if not item then return nil, "diagnostic item does not exist" end
	local section
	for _, candidate in ipairs(itemLib.modLineSections or { }) do
		if candidate.name == intervention.section then section = candidate break end
	end
	if not section then return nil, "diagnostic modifier section does not exist" end
	local line = item[section.field] and item[section.field][intervention.ordinal]
	if not line then return nil, "diagnostic modifier line does not exist" end
	line.disabled = true
	item:BuildModList()
	return true
end

local function suppressGem(build, intervention)
	local group = build.skillsTab and build.skillsTab.socketGroupList[intervention.group]
	if not group then return nil, "diagnostic skill group does not exist" end
	if intervention.gem then
		local gem = group.gemList and group.gemList[intervention.gem]
		if not gem then return nil, "diagnostic gem does not exist" end
		gem.enabled = false
	else
		group.enabled = false
	end
	return true
end

local function suppressPassive(build, intervention)
	local spec = build.spec
	local node = spec and spec.nodes and spec.nodes[intervention.nodeId]
	if not node or not node.alloc then return nil, "diagnostic passive source is not allocated" end
	node.alloc = false
	spec.allocNodes[node.id] = nil
	if spec.masterySelections then spec.masterySelections[node.id] = nil end
	return true
end

local function suppressConfig(build, intervention)
	if not build.configTab or build.configTab.input[intervention.configKey] == nil then
		return nil, "diagnostic config source does not exist"
	end
	local current = build.configTab.input[intervention.configKey]
	local default = build.configTab.defaultState and build.configTab.defaultState[intervention.configKey]
	if default == nil then
		if type(current) == "boolean" then default = false
		elseif type(current) == "number" then default = 0
		elseif type(current) == "string" then default = ""
		end
	end
	build.configTab.input[intervention.configKey] = default
	return true
end

local function suppressActorBuff(build, intervention)
	local definition = partyTypes[intervention.buffer]
	local tab = build.partyTab
	local control = definition and tab and tab.controls and tab.controls[definition.control]
	if not control or type(control.SetText) ~= "function" or type(tab.ParseBuffs) ~= "function" then
		return nil, "diagnostic actor buff source does not exist"
	end
	control:SetText("", false)
	if definition.enemy then
		tab.enemyModList = new("ModList"):ModList()
		tab:ParseBuffs(tab.enemyModList, tab.controls.enemyCond.buf, "EnemyConditions")
		tab:ParseBuffs(tab.enemyModList, tab.controls.enemyMods.buf, "EnemyMods", tab.controls.simpleEnemyMods)
	elseif definition.actor == "modDB" then
		tab.actor.modDB = new("ModDB"):ModDB()
		tab.actor.modDB.actor = tab.actor
	else
		tab.actor[definition.actor] = { }
	end
	return true
end

function MechanicExperiment.Apply(build, intervention)
	if type(intervention) ~= "table" or type(intervention.kind) ~= "string" then return nil, "diagnostic intervention is invalid" end
	local ok, err
	if intervention.kind == "suppress_item_modifier" then ok, err = suppressModifier(build, intervention)
	elseif intervention.kind == "suppress_skill_effect" or intervention.kind == "suppress_support" then ok, err = suppressGem(build, intervention)
	elseif intervention.kind == "suppress_passive_source" then ok, err = suppressPassive(build, intervention)
	elseif intervention.kind == "suppress_config_source" then ok, err = suppressConfig(build, intervention)
	elseif intervention.kind == "suppress_actor_buff" then ok, err = suppressActorBuff(build, intervention)
	elseif intervention.kind == "switch_weapon_set" then ok, err = setContext(build, intervention.context)
	else return nil, "unsupported diagnostic intervention: " .. tostring(intervention.kind) end
	if not ok then return nil, err end
	build.buildFlag = true
	return true
end

function MechanicExperiment.Run(build, experiment, probeOptions)
	if type(experiment) ~= "table" or type(experiment.id) ~= "string" then return nil, "mechanic experiment is invalid" end
	local context = experiment.context
	local contextOk, contextErr = setContext(build, context)
	if not contextOk then return nil, contextErr end
	local rebuilt, rebuildErr = BuildState.Rebuild(build)
	if not rebuilt then return nil, rebuildErr end
	local baseline, baselineErr = MechanicExperiment.Observe(build, context, probeOptions)
	if not baseline then return nil, baselineErr end
	if experiment.intervention then
		local applied, applyErr = MechanicExperiment.Apply(build, experiment.intervention)
		if not applied then return nil, applyErr end
		local diagnosticRebuilt, diagnosticErr = BuildState.Rebuild(build)
		if not diagnosticRebuilt then return nil, diagnosticErr end
	end
	local diagnostic, diagnosticErr = MechanicExperiment.Observe(build, context, probeOptions)
	if not diagnostic then return nil, diagnosticErr end
	return {
		experimentId = experiment.id, claimId = experiment.claimId, context = context,
		baseline = baseline, diagnostic = diagnostic,
	}
end

return MechanicExperiment
