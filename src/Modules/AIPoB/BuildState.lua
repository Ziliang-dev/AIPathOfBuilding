local BuildState = { }

local function parse(xmlText)
	local document, err = common.xml.ParseXML(xmlText)
	if err then return nil, tostring(err) end
	if not document or not document[1] or document[1].elem ~= "PathOfBuilding" then
		return nil, "PathOfBuilding root element missing"
	end
	return document[1]
end

local function restoreAbsentBuildDefaults(build, buildNode)
	for _, child in ipairs(buildNode or { }) do
		if type(child) == "table" and child.elem == "TimelessData" then
			if (child.attrib or { }).socketFilterDistance == nil then build.timelessData.socketFilterDistance = nil end
			return
		end
	end
end

local function restoreSerializedTabDefaults(build, node)
	if node.elem == "Skills" and (node.attrib or { }).defaultGemQuality == "nil" then
		build.skillsTab.defaultGemQuality = nil
		if build.skillsTab.controls and build.skillsTab.controls.defaultQuality then
			build.skillsTab.controls.defaultQuality:SetText("")
		end
	end
end

function BuildState.Rebuild(build)
	if build.configTab and type(build.configTab.BuildModList) == "function" then build.configTab:BuildModList() end
	if build.skillsTab and type(build.skillsTab.UpdateSocketGroups) == "function" then build.skillsTab:UpdateSocketGroups() end
	if type(wipeGlobalCache) == "function" then wipeGlobalCache() end
	if not build.calcsTab or type(build.calcsTab.BuildOutput) ~= "function" then return nil, "build cannot calculate output" end
	local ok, err = pcall(build.calcsTab.BuildOutput, build.calcsTab)
	if not ok then return nil, "calculation failed: " .. tostring(err) end
	build.outputRevision = (tonumber(build.outputRevision) or 0) + 1
	build.buildFlag = false
	if type(build.RefreshStatList) == "function" then pcall(build.RefreshStatList, build) end
	return true
end

-- Reconstruct gameplay tabs instead of reusing loaders whose tables may retain prior items.
function BuildState.Restore(build, xmlText)
	local root, err = parse(xmlText)
	if not root then return nil, err end
	local buildNode
	for _, node in ipairs(root) do
		if type(node) == "table" and node.elem == "Build" then buildNode = node break end
	end
	if buildNode then
		local loader = build.Load or build.LoadBuildSection
		if type(loader) ~= "function" then return nil, "build section loader unavailable" end
		local ok, loadErr = pcall(loader, build, buildNode, "AIPathOfBuilding rollback")
		if not ok then return nil, "build section restore failed: " .. tostring(loadErr) end
		restoreAbsentBuildDefaults(build, buildNode)
	end

	local ok, createErr = pcall(function()
		build.partyTab = new("PartyTab"):PartyTab(build)
		build.configTab = new("ConfigTab"):ConfigTab(build)
		build.itemsTab = new("ItemsTab"):ItemsTab(build)
		build.treeTab = new("TreeTab"):TreeTab(build)
		build.skillsTab = new("SkillsTab"):SkillsTab(build)
		build.calcsTab = new("CalcsTab"):CalcsTab(build)
	end)
	if not ok then return nil, "tab reconstruction failed: " .. tostring(createErr) end
	-- Preserve the existing saver table so Build.SaveDB's pairs() traversal keeps
	-- the same section order before and after rollback. Replacing the table can
	-- change an otherwise equivalent snapshot fingerprint.
	local savers = build.savers or { }
	savers.Config = build.configTab
	savers.Party = build.partyTab
	savers.Items = build.itemsTab
	savers.Tree = build.treeTab
	savers.TreeView = build.treeTab.viewer
	savers.Skills = build.skillsTab
	savers.Calcs = build.calcsTab
	if build.notesTab then savers.Notes = build.notesTab end
	if build.importTab then savers.Import = build.importTab end
	if build.plannerTab then savers.AIPlanner = build.plannerTab end
	build.savers = savers
	local legacy = { Spec = build.treeTab }
	local deferred = { }
	for _, node in ipairs(root) do
		if type(node) == "table" then
			local saver = build.savers[node.elem] or legacy[node.elem]
			if saver then
				if saver == build.treeTab then
					table.insert(deferred, node)
				else
					local loaded, loadErr = pcall(saver.Load, saver, node, "AIPathOfBuilding rollback")
					if not loaded then return nil, "restore failed for " .. node.elem .. ": " .. tostring(loadErr) end
					restoreSerializedTabDefaults(build, node)
				end
			end
		end
	end
	for _, node in ipairs(deferred) do
		local loaded, loadErr = pcall(build.treeTab.Load, build.treeTab, node, "AIPathOfBuilding rollback")
		if not loaded then return nil, "passive tree restore failed: " .. tostring(loadErr) end
	end
	for _, saver in pairs(build.savers) do if saver.PostLoad then saver:PostLoad() end end
	if build.controls and build.controls.breakdown then build.controls.breakdown.calcsTab = build.calcsTab end
	build.breakdownIndex = nil
	if type(build.SyncLoadouts) == "function" then pcall(build.SyncLoadouts, build) end
	return BuildState.Rebuild(build)
end

return BuildState
