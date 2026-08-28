require("Classes.CompareEntry")

local t_insert = table.insert
---@class BuildSandbox: CompareEntry
local BuildSandboxClass = newClass("BuildSandbox", "CompareEntry")

local saverOrder = { "Config", "Party", "Items", "Skills", "Calcs", "Tree", "TreeView" }
local regeneratedBuildChildren = {
	Spectre = true, TimelessData = true,
	PlayerStat = true, MinionStat = true, FullDPSSkill = true,
}

local function cloneXML(value)
	if type(value) ~= "table" then return value end
	local copy = { }
	for key, child in pairs(value) do copy[key] = cloneXML(child) end
	return copy
end

function BuildSandboxClass:BuildSandbox(xmlText, label)
	self:CompareEntry(nil, label or "AIPathOfBuilding Sandbox")
	if xmlText then
		local ok, err = self:LoadFromXML(xmlText)
		if not ok then
			self.loadError = err
		end
	end
	return self
end

function BuildSandboxClass:LoadFromXML(xmlText)
	local dbXML, errMsg = common.xml.ParseXML(xmlText)
	if errMsg then return nil, "XML parse failed: " .. tostring(errMsg) end
	if not dbXML or not dbXML[1] or dbXML[1].elem ~= "PathOfBuilding" then
		return nil, "PathOfBuilding root element missing"
	end

	local root = dbXML[1]
	for _, node in ipairs(root) do
		if type(node) == "table" and node.elem == "Build" then
			self.aipobOriginalBuildAttrib = cloneXML(node.attrib or { })
			self.aipobUnknownBuildChildren = { }
			for _, child in ipairs(node) do
				if type(child) ~= "table" or not regeneratedBuildChildren[child.elem] then
					t_insert(self.aipobUnknownBuildChildren, cloneXML(child))
				end
			end
			self:LoadBuildSection(node)
			break
		end
	end
	if self.targetVersion ~= liveTargetVersion then self.targetVersion = liveTargetVersion end

	-- Keep the real PartyTab. CompareEntry's empty Party stub is intentionally not used.
	self.partyTab = new("PartyTab"):PartyTab(self)
	self.configTab = new("ConfigTab"):ConfigTab(self)
	self.itemsTab = new("ItemsTab"):ItemsTab(self)
	self.treeTab = new("TreeTab"):TreeTab(self)
	self.skillsTab = new("SkillsTab"):SkillsTab(self)
	self.calcsTab = new("CalcsTab"):CalcsTab(self)
	self.savers = {
		Config = self.configTab,
		Party = self.partyTab,
		Items = self.itemsTab,
		Skills = self.skillsTab,
		Calcs = self.calcsTab,
		Tree = self.treeTab,
		TreeView = self.treeTab.viewer,
	}
	self.legacyLoaders = { Spec = self.treeTab }
	self.configTab:BuildModList()
	for _, key in ipairs({ "bandit", "pantheonMajorGod", "pantheonMinorGod" }) do
		self.configTab.input[key] = self[key]
	end

	local deferredTrees = { }
	for _, node in ipairs(root) do
		if type(node) == "table" then
			if node.elem == "Import" and node.attrib and node.attrib.importLink then
				self.importLink = node.attrib.importLink
			elseif node.elem == "Notes" then
				for _, text in ipairs(node) do if type(text) == "string" then self.notesText = text break end end
			end
			local saver = self.savers[node.elem] or self.legacyLoaders[node.elem]
			if saver then
				if saver == self.treeTab then
					t_insert(deferredTrees, node)
				else
					local ok, loadErr = pcall(saver.Load, saver, node, "BuildSandbox")
					if not ok then return nil, "failed loading " .. tostring(node.elem) .. ": " .. tostring(loadErr) end
				end
			end
		end
	end
	for _, node in ipairs(deferredTrees) do
		local ok, loadErr = pcall(self.treeTab.Load, self.treeTab, node, "BuildSandbox")
		if not ok then return nil, "failed loading passive tree: " .. tostring(loadErr) end
	end
	for _, name in ipairs(saverOrder) do
		local saver = self.savers[name]
		if saver and saver.PostLoad then saver:PostLoad() end
	end
	if next(self.configTab.input) == nil and self.configTab.ImportCalcSettings then self.configTab:ImportCalcSettings() end
	self:SyncCalcsSkillSelection()
	self.skillsTab:UpdateSocketGroups()
	wipeGlobalCache()
	self.calcsTab:BuildOutput()
	self.buildFlag = false
	return true
end

function BuildSandboxClass:SaveBuildSection(xml)
	xml.attrib = cloneXML(self.aipobOriginalBuildAttrib or { })
	xml.attrib.targetVersion = self.targetVersion
	xml.attrib.viewMode = self.viewMode
	xml.attrib.level = tostring(self.characterLevel)
	xml.attrib.className = self.spec and self.spec.curClassName
	xml.attrib.ascendClassName = self.spec and self.spec.curAscendClassName
	xml.attrib.bandit = self.configTab.input.bandit or self.bandit
	xml.attrib.pantheonMajorGod = self.configTab.input.pantheonMajorGod or self.pantheonMajorGod
	xml.attrib.pantheonMinorGod = self.configTab.input.pantheonMinorGod or self.pantheonMinorGod
	xml.attrib.mainSocketGroup = tostring(self.mainSocketGroup)
	xml.attrib.mainSkillIndex = nil
	xml.attrib.characterLevelAutoMode = tostring(self.characterLevelAutoMode)
	for _, id in ipairs(self.spectreList) do
		t_insert(xml, { elem = "Spectre", attrib = { id = id } })
	end
	t_insert(xml, {
		elem = "TimelessData",
		attrib = {
			jewelTypeId = next(self.timelessData.jewelType) and tostring(self.timelessData.jewelType.id),
			conquerorTypeId = next(self.timelessData.conquerorType) and tostring(self.timelessData.conquerorType.id),
			devotionVariant1 = tostring(self.timelessData.devotionVariant1),
			devotionVariant2 = tostring(self.timelessData.devotionVariant2),
			jewelSocketId = next(self.timelessData.jewelSocket) and tostring(self.timelessData.jewelSocket.id),
			fallbackWeightModeIdx = next(self.timelessData.fallbackWeightMode) and tostring(self.timelessData.fallbackWeightMode.idx),
			socketFilter = self.timelessData.socketFilter and "true",
			socketAllocate = self.timelessData.socketAllocate and "true",
			socketFilterDistance = tostring(self.timelessData.socketFilterDistance or 0),
			searchList = tostring(self.timelessData.searchList or ""),
			searchListFallback = tostring(self.timelessData.searchListFallback or ""),
		},
	})
	for _, child in ipairs(self.aipobUnknownBuildChildren or { }) do
		t_insert(xml, cloneXML(child))
	end
end

function BuildSandboxClass:SaveDB()
	local root = { elem = "PathOfBuilding" }
	local buildNode = { elem = "Build" }
	self:SaveBuildSection(buildNode)
	t_insert(root, buildNode)
	for _, name in ipairs(saverOrder) do
		local saver = self.savers[name]
		if saver and saver.Save then
			local node = { elem = name }
			saver:Save(node)
			t_insert(root, node)
		end
	end
	local xml, err = common.xml.ComposeXML(root)
	if not xml then return nil, err end
	return xml
end

return BuildSandboxClass
