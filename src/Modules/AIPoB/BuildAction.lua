local Snapshot = require("Modules.AIPoB.Snapshot")
local Util = require("Modules.AIPoB.Util")
local ActorSeason = require("Modules.AIPoB.ActorSeason")
local ItemImport = require("Modules.AIPoB.ItemImport")

local BuildAction = {
	SCHEMA_VERSION = 4,
}

local supportedKinds = {
	["build.setProperty"] = "build",
	["config.setInput"] = "config",
	["skills.setMainGroup"] = "skills",
	["skills.setGroupEnabled"] = "skills",
	["skills.setGem"] = "skills",
	["skills.replaceLinks"] = "skills",
	["items.equip"] = "items",
	["items.importAndEquip"] = "items",
	["items.setSlotActive"] = "items",
	["tree.selectSpec"] = "tree",
	["tree.setNode"] = "tree",
	["tree.setMastery"] = "tree",
	["tree.selectSecondaryAscendancy"] = "tree",
	["tree.setOverride"] = "tree",
	["party.setBuffer"] = "party",
	["loadout.select"] = "loadout",
}

local buildProperties = {
	characterLevel = "number",
	characterLevelAutoMode = "boolean",
	bandit = "string",
	pantheonMajorGod = "string",
	pantheonMinorGod = "string",
	mainSocketGroup = "number",
}

local gemScalarFields = {
	"nameSpec", "level", "quality", "qualityId", "enabled", "count",
	"skillPart", "skillPartCalcs", "skillStage", "skillStageCount", "skillStageCountCalcs",
	"includeInFullDPS", "enableGlobal1", "enableGlobal2",
}

local partyTypes = {
	Aura = { control = "editAuras", actor = "Aura" },
	Curse = { control = "editCurses", actor = "Curse" },
	["Warcry Skills"] = { control = "editWarcries", actor = "Warcry" },
	["Link Skills"] = { control = "editLinks", actor = "Link" },
	PartyMemberStats = { control = "editPartyMemberStats", actor = "modDB" },
	EnemyConditions = { control = "enemyCond", enemy = true },
	EnemyMods = { control = "enemyMods", enemy = true },
}

local configVars
local function getConfigVars()
	if configVars then
		return configVars
	end
	configVars = { }
	local ok, list = pcall(require, "Modules.ConfigOptions")
	if ok and type(list) == "table" then
		for _, option in ipairs(list) do
			if type(option) == "table" and type(option.var) == "string" then
				configVars[option.var] = true
			end
		end
	end
	return configVars
end

local function invalid(message)
	return nil, message
end

local function integer(value, minimum)
	return type(value) == "number" and value % 1 == 0 and value >= (minimum or 1)
end

local canonicalKinds = {
	setRules = true, setIdentity = true, setSkill = true, replaceSkillLinks = true,
	replaceItem = true, setTree = true, setActor = true, setConfig = true,
	selectExternal = true, addProgressionStep = true,
	importAndEquip = true, selectSecondaryAscendancy = true,
	setTreeOverride = true, setPartyBuffer = true,
}

function BuildAction.Normalize(action)
	if type(action) ~= "table" or not canonicalKinds[action.kind] then return action end
	local payload = action.payload or { }
	local normalized = {
		version = BuildAction.SCHEMA_VERSION, id = action.id, dependsOn = action.dependsOn or { },
		preconditions = action.preconditions, payload = { },
	}
	if action.kind == "setConfig" then
		normalized.kind = "config.setInput"
		normalized.payload = { name = payload.name or payload.key, value = payload.value, configSetId = payload.configSetId, expected = payload.expected }
	elseif action.kind == "replaceItem" or action.kind == "selectExternal" then
		if not payload.slot or payload.itemId == nil then return nil, action.kind .. " requires an imported itemId and slot" end
		normalized.kind = "items.equip"
		normalized.payload = { slot = payload.slot, itemId = payload.itemId, itemSetId = payload.itemSetId }
	elseif action.kind == "importAndEquip" then
		normalized.kind = "items.importAndEquip"
		normalized.payload = Util.shallowCopy(payload)
		if type(normalized.payload.itemHash) == "string" then
			normalized.payload.itemHash = normalized.payload.itemHash:gsub("^sha256:", "")
		end
	elseif action.kind == "selectSecondaryAscendancy" then
		normalized.kind = "tree.selectSecondaryAscendancy"
		normalized.payload = { secondaryAscendClassId = payload.secondaryAscendClassId }
	elseif action.kind == "setTreeOverride" then
		normalized.kind = "tree.setOverride"
		normalized.payload = { nodeId = payload.nodeId, dn = payload.name, overrideType = payload.overrideType }
	elseif action.kind == "setPartyBuffer" then
		normalized.kind = "party.setBuffer"
		normalized.payload = {
			buffer = payload.buffer, text = payload.text,
			catalogId = payload.catalogId, sourceHash = payload.sourceHash,
		}
	elseif action.kind == "replaceSkillLinks" then
		normalized.kind = "skills.replaceLinks"
		normalized.payload = { group = payload.group, gems = payload.gems }
	elseif action.kind == "setSkill" then
		if payload.mainGroup then
			normalized.kind, normalized.payload = "skills.setMainGroup", { group = payload.mainGroup }
		elseif payload.group and payload.gem and payload.changes then
			normalized.kind, normalized.payload = "skills.setGem", { group = payload.group, gem = payload.gem, changes = payload.changes }
		else
			return nil, "setSkill payload is unsupported"
		end
	elseif action.kind == "setTree" then
		if payload.specId then
			normalized.kind, normalized.payload = "tree.selectSpec", { specId = payload.specId }
		elseif payload.nodeId and payload.effectId then
			normalized.kind, normalized.payload = "tree.setMastery", { nodeId = payload.nodeId, effectId = payload.effectId }
		elseif payload.nodeId and payload.allocated ~= nil then
			normalized.kind, normalized.payload = "tree.setNode", { nodeId = payload.nodeId, allocated = payload.allocated }
		else
			return nil, "setTree payload is unsupported"
		end
	elseif action.kind == "setActor" then
		normalized.kind, normalized.payload = "party.setBuffer", { buffer = payload.buffer, text = payload.text }
	elseif action.kind == "setIdentity" then
		local aliases = { level = "characterLevel", mainSkill = "mainSocketGroup" }
		normalized.kind = "build.setProperty"
		normalized.payload = { property = aliases[payload.property] or payload.property, value = payload.value, expected = payload.expected }
	elseif action.kind == "setRules" then
		return nil, "ruleset mutation requires a dedicated PoB conversion and is not directly applicable"
	else
		return nil, "progression annotations are not build mutations"
	end
	return normalized
end

function BuildAction.Validate(action)
	if type(action) ~= "table" then
		return invalid("action must be an object")
	end
	if canonicalKinds[action.kind] then
		local normalized, err = BuildAction.Normalize(action)
		if not normalized then return nil, err end
		return BuildAction.Validate(normalized)
	end
	if action.version ~= BuildAction.SCHEMA_VERSION then
		return invalid("unsupported BuildAction version: " .. tostring(action.version))
	end
	if type(action.id) ~= "string" or action.id == "" then
		return invalid("action id is required")
	end
	if not supportedKinds[action.kind] then
		return invalid("unsupported BuildAction kind: " .. tostring(action.kind))
	end
	if type(action.payload) ~= "table" then
		return invalid("action payload must be an object")
	end
	if action.dependsOn ~= nil and type(action.dependsOn) ~= "table" then
		return invalid("dependsOn must be an array")
	end
	if action.preconditions ~= nil then
		if type(action.preconditions) ~= "table" then return invalid("preconditions must be an array or object") end
		for index, condition in ipairs(action.preconditions) do
			if type(condition) ~= "string" or condition == "" then return invalid("precondition expressions must be non-empty strings") end
		end
		for key, value in pairs(action.preconditions) do
			if type(key) ~= "number" and key ~= "baseFingerprint" then return invalid("unsupported precondition: " .. tostring(key)) end
			if key == "baseFingerprint" and (type(value) ~= "string" or value == "") then return invalid("baseFingerprint precondition must be a non-empty string") end
		end
	end

	local payload = action.payload
	if action.kind == "build.setProperty" then
		local expectedType = buildProperties[payload.property]
		if not expectedType then
			return invalid("unsupported build property: " .. tostring(payload.property))
		end
		if type(payload.value) ~= expectedType then
			return invalid("invalid value for build property " .. payload.property)
		end
		if payload.property == "characterLevel" and (payload.value < 1 or payload.value > 100 or payload.value % 1 ~= 0) then
			return invalid("characterLevel must be an integer from 1 to 100")
		end
	elseif action.kind == "config.setInput" then
		if type(payload.name) ~= "string" or payload.name == "" then
			return invalid("config input name is required")
		end
		if not getConfigVars()[payload.name] then
			return invalid("unsupported config input: " .. payload.name)
		end
		if payload.configSetId ~= nil and not integer(payload.configSetId) then
			return invalid("configSetId must be a positive integer")
		end
	elseif action.kind == "skills.setMainGroup" then
		if not integer(payload.group) then return invalid("group must be a positive integer") end
	elseif action.kind == "skills.setGroupEnabled" then
		if not integer(payload.group) or type(payload.enabled) ~= "boolean" then return invalid("group/enabled is invalid") end
	elseif action.kind == "skills.setGem" then
		if not integer(payload.group) or not integer(payload.gem) then return invalid("group/gem must be positive integers") end
		local allowed = {
			nameSpec = "string", level = "number", quality = "number", qualityId = "string",
			enabled = "boolean", count = "number", skillPart = "number", skillPartCalcs = "number",
			skillStage = "number", skillStageCount = "number", skillStageCountCalcs = "number",
			includeInFullDPS = "boolean", enableGlobal1 = "boolean", enableGlobal2 = "boolean",
		}
		if type(payload.changes) ~= "table" then return invalid("gem changes are required") end
		for key, value in pairs(payload.changes) do
			if not allowed[key] or type(value) ~= allowed[key] then return invalid("unsupported gem change: " .. tostring(key)) end
		end
	elseif action.kind == "skills.replaceLinks" then
		if not integer(payload.group) or type(payload.gems) ~= "table" or #payload.gems == 0 then return invalid("group/gems is invalid") end
		for _, gem in ipairs(payload.gems) do
			if type(gem) ~= "string" and type(gem) ~= "table" then return invalid("replacement gem is invalid") end
		end
	elseif action.kind == "items.equip" then
		if type(payload.slot) ~= "string" or not integer(payload.itemId, 0) then return invalid("slot/itemId is invalid") end
		if payload.itemSetId ~= nil and not integer(payload.itemSetId) then return invalid("itemSetId must be a positive integer") end
	elseif action.kind == "items.importAndEquip" then
		local ok, itemErr = ItemImport.Validate(payload)
		if not ok then return nil, itemErr end
	elseif action.kind == "items.setSlotActive" then
		if type(payload.slot) ~= "string" or type(payload.active) ~= "boolean" then return invalid("slot/active is invalid") end
	elseif action.kind == "tree.selectSpec" then
		if not integer(payload.specId) then return invalid("specId must be a positive integer") end
	elseif action.kind == "tree.setNode" then
		if not integer(payload.nodeId) or type(payload.allocated) ~= "boolean" then return invalid("nodeId/allocated is invalid") end
	elseif action.kind == "tree.setMastery" then
		if not integer(payload.nodeId) or not integer(payload.effectId) then return invalid("nodeId/effectId is invalid") end
	elseif action.kind == "tree.selectSecondaryAscendancy" then
		if not integer(payload.secondaryAscendClassId, 0) then return invalid("secondaryAscendClassId must be a non-negative integer") end
	elseif action.kind == "tree.setOverride" then
		if not integer(payload.nodeId) or type(payload.dn) ~= "string" or payload.dn == "" then return invalid("tree override is invalid") end
	elseif action.kind == "party.setBuffer" then
		if not partyTypes[payload.buffer] or type(payload.text) ~= "string" then return invalid("party buffer/text is invalid") end
		if payload.catalogId ~= nil and (type(payload.catalogId) ~= "string" or payload.catalogId == "") then return invalid("party catalogId is invalid") end
		if payload.sourceHash ~= nil then
			if type(payload.sourceHash) ~= "string" or not payload.sourceHash:match("^sha256:[0-9a-fA-F]+$")
				or #payload.sourceHash ~= 71 then return invalid("party sourceHash is invalid") end
			if payload.sourceHash:sub(8):lower() ~= ItemImport.Hash(payload.text):lower() then return invalid("party sourceHash does not match text") end
		end
	elseif action.kind == "loadout.select" then
		if type(payload) ~= "table" then return invalid("loadout selection is invalid") end
		for _, key in ipairs({ "treeSpecId", "itemSetId", "skillSetId", "configSetId" }) do
			if payload[key] ~= nil and not integer(payload[key]) then return invalid(key .. " must be a positive integer") end
		end
	end
	return true
end

local function checkExpected(actual, payload)
	if payload.expected ~= nil and actual ~= payload.expected then
		return nil, "action precondition failed"
	end
	return true
end

local function applyBuild(build, payload)
	local ok, err = checkExpected(build[payload.property], payload)
	if not ok then return nil, err end
	build[payload.property] = payload.value
	build.buildFlag = true
	return true
end

local function applyConfig(build, payload)
	local tab = build.configTab
	if not tab then return invalid("build has no configuration tab") end
	local setId = payload.configSetId or tab.activeConfigSetId
	local configSet = tab.configSets and tab.configSets[setId]
	if not configSet then return invalid("configuration set does not exist: " .. tostring(setId)) end
	local ok, err = checkExpected(configSet.input[payload.name], payload)
	if not ok then return nil, err end
	configSet.input[payload.name] = payload.value
	if setId == tab.activeConfigSetId then
		tab.input = configSet.input
		if type(tab.BuildModList) == "function" then tab:BuildModList() end
	end
	build.buildFlag = true
	return true
end

local function applySkills(build, action)
	local tab = build.skillsTab
	if not tab then return invalid("build has no skills tab") end
	local payload = action.payload
	if action.kind == "skills.setMainGroup" then
		if not tab.socketGroupList[payload.group] then return invalid("socket group does not exist") end
		build.mainSocketGroup = payload.group
	elseif action.kind == "skills.setGroupEnabled" then
		local group = tab.socketGroupList[payload.group]
		if not group then return invalid("socket group does not exist") end
		group.enabled = payload.enabled
	elseif action.kind == "skills.setGem" then
		local group = tab.socketGroupList[payload.group]
		local gem = group and group.gemList[payload.gem]
		if not gem then return invalid("gem does not exist") end
		for key, value in pairs(payload.changes) do gem[key] = value end
	else
		local group = tab.socketGroupList[payload.group]
		if not group then return invalid("socket group does not exist") end
		local replacement = { }
		for _, value in ipairs(payload.gems) do
			local gem = type(value) == "string" and { nameSpec = value } or value
			if type(gem.nameSpec) ~= "string" or gem.nameSpec == "" then return invalid("replacement gem nameSpec is required") end
			local copied = { }
			for _, key in ipairs(gemScalarFields) do
				local scalar = gem[key]
				if type(scalar) == "string" or type(scalar) == "number" or type(scalar) == "boolean" then copied[key] = scalar end
			end
			copied.level = tonumber(copied.level) or 20
			copied.quality = tonumber(copied.quality) or 0
			copied.enabled = copied.enabled ~= false
			copied.count = tonumber(copied.count) or 1
			copied.enableGlobal1 = copied.enableGlobal1 ~= false
			copied.enableGlobal2 = copied.enableGlobal2 ~= false
			table.insert(replacement, copied)
		end
		group.gemList = replacement
	end
	if type(tab.UpdateSocketGroups) == "function" then tab:UpdateSocketGroups() end
	build.buildFlag = true
	return true
end

local function applyItems(build, action)
	local tab = build.itemsTab
	if not tab then return invalid("build has no items tab") end
	local payload = action.payload
	if action.kind == "items.importAndEquip" then
		local result, importErr = ItemImport.ImportAndEquip(tab, payload, {
			requireSource = payload.source == "trade" and "trade" or nil,
		})
		if not result then return nil, importErr end
		return true
	end
	local slot = tab.slots and tab.slots[payload.slot]
	if not slot then return invalid("item slot does not exist: " .. tostring(payload.slot)) end
	if action.kind == "items.setSlotActive" then
		slot.active = payload.active
		if slot.controls and slot.controls.activate then slot.controls.activate.state = payload.active end
		build.buildFlag = true
		return true
	end
	if payload.itemId ~= 0 and not tab.items[payload.itemId] then return invalid("item does not exist: " .. tostring(payload.itemId)) end
	local itemSetId = payload.itemSetId or tab.activeItemSetId
	local itemSet = tab.itemSets and tab.itemSets[itemSetId]
	if not itemSet then return invalid("item set does not exist: " .. tostring(itemSetId)) end
	if payload.itemId ~= 0 and type(tab.IsItemValidForSlot) == "function" and not tab:IsItemValidForSlot(tab.items[payload.itemId], payload.slot, itemSet) then
		return invalid("item is invalid for slot: " .. payload.slot)
	end
	if itemSetId == tab.activeItemSetId and type(slot.SetSelItemId) == "function" then
		slot:SetSelItemId(payload.itemId)
	elseif itemSet[payload.slot] then
		itemSet[payload.slot].selItemId = payload.itemId
	else
		return invalid("slot is not available in item set")
	end
	if type(tab.PopulateSlots) == "function" then tab:PopulateSlots() end
	build.buildFlag = true
	return true
end

local function restoreSpecWith(spec, mutate)
	if type(spec.CreateUndoState) ~= "function" or type(spec.RestoreUndoState) ~= "function" then
		return invalid("passive spec does not support transactional updates")
	end
	local state = spec:CreateUndoState()
	local ok, err = mutate(state)
	if not ok then return nil, err end
	spec:RestoreUndoState(state)
	return true
end

local function validateTreePointBudget(build, spec)
	if type(spec.CountAllocNodes) ~= "function" then return invalid("passive point counter is unavailable") end
	local passiveUsed, ascendancyUsed, secondaryAscendancyUsed = spec:CountAllocNodes()
	local extraPoints = build.calcsTab and build.calcsTab.mainOutput and tonumber(build.calcsTab.mainOutput.ExtraPoints) or 0
	local levelCap = build.characterLevelAutoMode and 100 or tonumber(build.characterLevel) or 1
	levelCap = math.max(1, math.min(100, levelCap))
	local passiveMax = math.max(0, levelCap - 1) + 23 + extraPoints
	if passiveUsed > passiveMax then return invalid("passive point budget exceeded: " .. passiveUsed .. " / " .. passiveMax) end
	if ascendancyUsed > 8 then return invalid("ascendancy point budget exceeded: " .. ascendancyUsed .. " / 8") end
	if secondaryAscendancyUsed > 8 then return invalid("secondary ascendancy point budget exceeded: " .. secondaryAscendancyUsed .. " / 8") end
	return true
end

local function applyTree(build, action)
	local tab = build.treeTab
	if not tab or not build.spec then return invalid("build has no passive tree") end
	local payload = action.payload
	if action.kind == "tree.selectSecondaryAscendancy" then
		return ActorSeason.ApplySecondaryAscendancy(build, payload.secondaryAscendClassId)
	end
	if action.kind == "tree.setOverride" then
		return ActorSeason.ApplyOverride(build, payload.nodeId, payload.dn)
	end
	if action.kind == "tree.selectSpec" then
		if not tab.specList[payload.specId] then return invalid("passive spec does not exist") end
		tab:SetActiveSpec(payload.specId)
		return true
	end
	local spec = build.spec
	local undoState = type(spec.CreateUndoState) == "function" and spec:CreateUndoState() or nil
	local node = spec.nodes and spec.nodes[payload.nodeId]
	if not node then return invalid("passive node does not exist: " .. tostring(payload.nodeId)) end
	if action.kind == "tree.setNode" then
		if node.alloc == payload.allocated then return true end
		if payload.allocated then
			if node.type == "Mastery" and not spec.masterySelections[node.id] then return invalid("mastery effect must be selected before allocation") end
			if type(spec.AllocNode) ~= "function" or not node.path then return invalid("passive node is not connectable") end
			spec:AllocNode(node)
		else
			if type(spec.DeallocNode) ~= "function" then return invalid("passive node cannot be deallocated") end
			spec:DeallocNode(node)
		end
	else
		if node.type ~= "Mastery" then return invalid("node is not a mastery") end
		if not spec.tree.masteryEffects[payload.effectId] then return invalid("mastery effect does not exist") end
		local ok, err = restoreSpecWith(spec, function(state)
			state.masteryEffects[payload.nodeId] = payload.effectId
			local found = false
			for _, id in ipairs(state.hashList) do found = found or id == payload.nodeId end
			if not found then table.insert(state.hashList, payload.nodeId) end
			return true
		end)
		if not ok then return nil, err end
	end
	local budgetOk, budgetErr = validateTreePointBudget(build, spec)
	if not budgetOk then
		if undoState and type(spec.RestoreUndoState) == "function" then spec:RestoreUndoState(undoState) end
		return nil, budgetErr
	end
	build.buildFlag = true
	return true
end

local function applyParty(build, payload)
	local tab = build.partyTab
	local definition = partyTypes[payload.buffer]
	if not tab or not definition then return invalid("build has no supported party interface") end
	local control = tab.controls and tab.controls[definition.control]
	if not control or type(control.SetText) ~= "function" or type(tab.ParseBuffs) ~= "function" then return invalid("party buffer is unavailable") end
	control:SetText(payload.text, false)
	if definition.enemy then
		tab.enemyModList = new("ModList"):ModList()
		tab:ParseBuffs(tab.enemyModList, tab.controls.enemyCond.buf, "EnemyConditions")
		tab:ParseBuffs(tab.enemyModList, tab.controls.enemyMods.buf, "EnemyMods", tab.controls.simpleEnemyMods)
	elseif definition.actor == "modDB" then
		tab.actor.modDB = new("ModDB"):ModDB()
		tab.actor.modDB.actor = tab.actor
		tab:ParseBuffs(tab.actor.modDB, payload.text, "PartyMemberStats", tab.actor.output)
	else
		tab.actor[definition.actor] = { }
		tab:ParseBuffs(tab.actor[definition.actor], payload.text, payload.buffer)
	end
	build.buildFlag = true
	return true
end

local function applyLoadout(build, payload)
	if payload.treeSpecId then
		if not build.treeTab or not build.treeTab.specList[payload.treeSpecId] then return invalid("loadout passive spec does not exist") end
		build.treeTab:SetActiveSpec(payload.treeSpecId)
	end
	if payload.itemSetId then
		if not build.itemsTab or not build.itemsTab.itemSets[payload.itemSetId] then return invalid("loadout item set does not exist") end
		build.itemsTab:SetActiveItemSet(payload.itemSetId)
	end
	if payload.skillSetId then
		if not build.skillsTab or not build.skillsTab.skillSets[payload.skillSetId] then return invalid("loadout skill set does not exist") end
		build.skillsTab:SetActiveSkillSet(payload.skillSetId)
	end
	if payload.configSetId then
		if not build.configTab or not build.configTab.configSets[payload.configSetId] then return invalid("loadout config set does not exist") end
		build.configTab:SetActiveConfigSet(payload.configSetId)
	end
	build.buildFlag = true
	return true
end

function BuildAction.Apply(build, action)
	local normalized, normalizeErr = BuildAction.Normalize(action)
	if not normalized then return nil, normalizeErr end
	action = normalized
	local valid, err = BuildAction.Validate(action)
	if not valid then return nil, err end
	if action.preconditions and #action.preconditions > 0 then
		return nil, "unsupported precondition expression: " .. tostring(action.preconditions[1])
	end
	if action.preconditions and action.preconditions.baseFingerprint then
		local ok, verifyErr = Snapshot.Verify(build, action.preconditions.baseFingerprint)
		if not ok then return nil, verifyErr end
	end
	local category = supportedKinds[action.kind]
	if category == "build" then return applyBuild(build, action.payload) end
	if category == "config" then return applyConfig(build, action.payload) end
	if category == "skills" then return applySkills(build, action) end
	if category == "items" then return applyItems(build, action) end
	if category == "tree" then return applyTree(build, action) end
	if category == "party" then return applyParty(build, action.payload) end
	if category == "loadout" then return applyLoadout(build, action.payload) end
	return invalid("unsupported BuildAction category")
end

function BuildAction.Order(actions)
	local byId, indegree, outgoing = { }, { }, { }
	for _, action in ipairs(actions or { }) do
		local ok, err = BuildAction.Validate(action)
		if not ok then return nil, err end
		if byId[action.id] then return nil, "duplicate action id: " .. action.id end
		byId[action.id], indegree[action.id], outgoing[action.id] = action, 0, { }
	end
	for _, action in ipairs(actions or { }) do
		for _, dependency in ipairs(action.dependsOn or { }) do
			if not byId[dependency] then return nil, "missing action dependency: " .. tostring(dependency) end
			indegree[action.id] = indegree[action.id] + 1
			table.insert(outgoing[dependency], action.id)
		end
	end
	local ready = { }
	for id, degree in pairs(indegree) do if degree == 0 then table.insert(ready, id) end end
	table.sort(ready)
	local ordered = { }
	while #ready > 0 do
		local id = table.remove(ready, 1)
		table.insert(ordered, byId[id])
		for _, nextId in ipairs(outgoing[id]) do
			indegree[nextId] = indegree[nextId] - 1
			if indegree[nextId] == 0 then table.insert(ready, nextId) end
		end
		table.sort(ready)
	end
	if #ordered ~= #(actions or { }) then return nil, "action dependency cycle" end
	return ordered
end

return BuildAction
