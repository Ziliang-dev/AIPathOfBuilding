-- Path of Building
--
-- Module: AI Planner Tab
-- Presents the local AIPathOfBuilding planner without owning transport or search logic.
--
local ipairs = ipairs
local pairs = pairs
local m_floor = math.floor
local m_max = math.max
local m_min = math.min
local s_format = string.format
local t_concat = table.concat
local t_insert = table.insert

local SCHEMA_VERSION = 1

local scenarioList = {
	{ id = "mapping", label = "Mapping" },
	{ id = "standardBoss", label = "Standard Boss" },
	{ id = "pinnacle", label = "Guardian / Pinnacle" },
	{ id = "uber", label = "Uber Pinnacle" },
}

local presetList = {
	{ id = "balanced", label = "Balanced", goals = {
		{ metric = "combinedDps", direction = "maximize", weight = 1 },
		{ metric = "effectiveHitPool", direction = "maximize", weight = 0.8 },
		{ metric = "worstCaseMaxHit", direction = "maximize", weight = 0.8 },
		{ metric = "netLifeRegen", direction = "maximize", weight = 0.25 },
	} },
	{ id = "offence", label = "Maximum Offence", goals = {
		{ metric = "combinedDps", direction = "maximize", weight = 1 },
		{ metric = "speed", direction = "maximize", weight = 0.2 },
	} },
	{ id = "defence", label = "Maximum Defence", goals = {
		{ metric = "worstCaseMaxHit", direction = "maximize", weight = 1 },
		{ metric = "effectiveHitPool", direction = "maximize", weight = 0.8 },
		{ metric = "netLifeRegen", direction = "maximize", weight = 0.35 },
	} },
	{ id = "mapping", label = "Smooth Mapping", goals = {
		{ metric = "speed", direction = "maximize", weight = 1 },
		{ metric = "combinedDps", direction = "maximize", weight = 0.75 },
		{ metric = "effectiveHitPool", direction = "maximize", weight = 0.5 },
	} },
}

local candidateLabels = { "Offence", "Balanced", "Defence" }

local terminalStatus = {
	idle = true,
	completed = true,
	complete = true,
	failed = true,
	error = true,
	cancelled = true,
	canceled = true,
	awaitingApproval = true,
	awaiting_approval = true,
	preview = true,
}

local unresolvedRunStatus = {
	awaitingApproval = true,
	awaiting_approval = true,
	preview = true,
}

local function cloneFlatTable(source)
	local result = { }
	for key, value in pairs(source or { }) do
		result[key] = value
	end
	return result
end

local function safeText(value)
	if value == nil then
		return ""
	end
	local text = tostring(value):gsub("[%c]", " ")
	return text
end

local function formatScalar(value)
	if type(value) == "number" then
		local absolute = math.abs(value)
		if absolute >= 1000000 then
			return s_format("%.2fM", value / 1000000)
		elseif absolute >= 1000 then
			return s_format("%.1fK", value / 1000)
		elseif absolute > 0 and absolute < 0.01 then
			return s_format("%.4f", value)
		end
		local formatted = s_format("%.2f", value):gsub("%.?0+$", "")
		return formatted
	elseif type(value) == "boolean" then
		return value and "yes" or "no"
	end
	return safeText(value)
end

local function formatMetrics(metrics)
	if type(metrics) ~= "table" then
		return safeText(metrics)
	end
	local entries = { }
	for key, value in pairs(metrics) do
		if #entries >= 5 then
			break
		end
		if type(value) ~= "table" then
			t_insert(entries, safeText(key)..": "..formatScalar(value))
		end
	end
	table.sort(entries)
	return t_concat(entries, "  |  ")
end

local function formatPreview(preview)
	if type(preview) == "string" then
		return preview
	elseif type(preview) ~= "table" then
		return nil
	end
	if type(preview.diff) == "string" then
		return preview.diff
	end
	local entries = { }
	if type(preview.summary) == "string" then
		t_insert(entries, preview.summary)
	end
	local actions = type(preview.actions) == "table" and preview.actions or (type(preview.diff) == "table" and preview.diff or nil)
	for _, action in ipairs(actions or { }) do
		if #entries >= 6 then
			break
		end
		if type(action) == "table" then
			t_insert(entries, "- "..safeText(action.description or action.summary or action.kind or action.id))
		else
			t_insert(entries, "- "..safeText(action))
		end
	end
	return #entries > 0 and t_concat(entries, "\n") or safeText(preview.message)
end

local function wrapText(text, width, maxLines)
	local wrapped = main:WrapString(safeText(text), 14, m_max(width, 30))
	if maxLines and #wrapped > maxLines then
		while #wrapped > maxLines do
			table.remove(wrapped)
		end
		wrapped[maxLines] = wrapped[maxLines].."..."
	end
	return t_concat(wrapped, "\n")
end

---@class AIPlannerTab: ControlHost, Control
local AIPlannerTabClass = newClass("AIPlannerTab", "ControlHost", "Control")

---@param build Build
function AIPlannerTabClass:AIPlannerTab(build)
	self:ControlHost()
	self:Control()

	self.build = build
	self.state = { status = "idle", message = "", progress = 0, candidates = { } }
	self.modFlag = false
	self.controller = nil
	self.controllerError = nil
	self.runtimeError = nil

	local ok, controllerModule = pcall(require, "Modules.AIPoB.PlannerController")
	if not ok then
		self.controllerError = safeText(controllerModule)
	elseif type(controllerModule) ~= "table" or type(controllerModule.new) ~= "function" then
		self.controllerError = "PlannerController.new(build) is unavailable."
	else
		local created, controller = pcall(controllerModule.new, build)
		if created and type(controller) == "table" then
			self.controller = controller
		elseif created then
			self.controllerError = "PlannerController.new(build) returned no controller."
		else
			self.controllerError = safeText(controller)
		end
	end

	local function objectiveChanged()
		self.modFlag = true
		self.controls.confirmed.state = false
	end

	self.controls.goalPreset = new("DropDownControl"):DropDownControl({"TOPLEFT",self,"TOPLEFT"}, {12, 66, 210, 20}, presetList, objectiveChanged)
	self.controls.goalText = new("EditControl"):EditControl({"TOPLEFT",self,"TOPLEFT"}, {12, 112, 460, 46}, "", "Describe the desired build outcome", nil, 500, objectiveChanged, 14, false, true)
	self.controls.hardConstraints = new("EditControl"):EditControl({"TOPLEFT",self,"TOPLEFT"}, {12, 184, 460, 46}, "", "LLM drafting notes; not enforced", nil, 500, objectiveChanged, 14, false, true)
	self.controls.hardConstraints.tooltipText = "Free-text notes guide LLM drafting only. They are not hard constraints until converted into structured fields."
	self.controls.minEHP = new("EditControl"):EditControl({"TOPLEFT",self,"TOPLEFT"}, {12, 246, 150, 20}, "", "Optional", "^%d%.", 14, objectiveChanged, nil, false, true)
	self.controls.minEHP.tooltipText = "Minimum effective hit pool required in all four sustainable scenarios."
	self.controls.minWorstCaseMaxHit = new("EditControl"):EditControl({"TOPLEFT",self,"TOPLEFT"}, {190, 246, 180, 20}, "", "Optional", "^%d%.", 14, objectiveChanged, nil, false, true)
	self.controls.minWorstCaseMaxHit.tooltipText = "Minimum worst-case elemental/physical/chaos max hit required in all four sustainable scenarios."

	self.controls.primaryScenario = new("DropDownControl"):DropDownControl({"TOPLEFT",self,"TOPLEFT"}, {510, 66, 210, 20}, scenarioList, objectiveChanged)
	self.controls.budget = new("EditControl"):EditControl({"TOPLEFT",self,"TOPLEFT"}, {510, 112, 160, 20}, "", "Candidate cost limit", "^%d%.", 12, objectiveChanged, nil, false, true)
	self.controls.budget.tooltipText = "A budget may enable catalog-backed Unique and target-Rare proposals. Trade stays disabled until the main-process broker is connected."
	self.controls.sourceUniques = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {510, 138, 18}, "Unique catalog", objectiveChanged, nil, false)
	self.controls.sourceUniques.labelRight = true
	self.controls.sourceTargetRares = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {650, 138, 18}, "Target rares", objectiveChanged, nil, false)
	self.controls.sourceTargetRares.labelRight = true

	self.controls.lockClass = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {510, 174, 18}, "Class", objectiveChanged, nil, true)
	self.controls.lockClass.labelRight = true
	self.controls.lockAscendancy = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {590, 174, 18}, "Ascendancy", objectiveChanged, nil, true)
	self.controls.lockAscendancy.labelRight = true
	self.controls.lockMainSkill = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {710, 174, 18}, "Main Skill", objectiveChanged, nil, true)
	self.controls.lockMainSkill.labelRight = true

	self.controls.confirmed = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {510, 210, 18}, "Confirm this objective before search", function() end, "The planner cannot start until you explicitly confirm the structured objective.", false)
	self.controls.confirmed.labelRight = true

	self.controls.start = new("ButtonControl"):ButtonControl({"TOPLEFT",self,"TOPLEFT"}, {510, 242, 100, 22}, "Start", function()
		self:Start()
	end)
	self.controls.start.enabled = function()
		local status = self.state and self.state.status or "idle"
		return self.controller ~= nil and self.controls.confirmed.state and not self:IsBusy() and not unresolvedRunStatus[status]
	end
	self.controls.cancel = new("ButtonControl"):ButtonControl({"LEFT",self.controls.start,"RIGHT"}, {10, 0, 100, 22}, "Cancel", function()
		self:Cancel()
	end)
	self.controls.cancel.enabled = function()
		local status = self.state and self.state.status
		return self.controller ~= nil and self.state ~= nil and self.state.runId ~= nil
			and (status == "running" or unresolvedRunStatus[status] == true)
	end
	for _, name in ipairs({ "goalPreset", "goalText", "hardConstraints", "minEHP", "minWorstCaseMaxHit", "primaryScenario", "budget", "sourceUniques", "sourceTargetRares", "lockClass", "lockAscendancy", "lockMainSkill", "confirmed" }) do
		local controlName = name
		self.controls[name].enabled = function()
			if controlName == "sourceUniques" or controlName == "sourceTargetRares" then
				return not self:IsBusy() and tonumber(self.controls.budget.buf) ~= nil
			end
			return not self:IsBusy()
		end
	end

	self.candidateButtons = { }
	for index, label in ipairs(candidateLabels) do
		local preview = new("ButtonControl"):ButtonControl({"TOPLEFT",self,"TOPLEFT"}, {0, 0, 72, 20}, "Preview", function()
			self:PreviewCandidate(index)
		end)
		preview.x = function()
			return self:GetCardLeft(index) + 10
		end
		preview.y = function()
			return self:GetCardsTop() + self:GetCardHeight() - 30
		end
		preview.enabled = function()
			return self.controller ~= nil and self:GetCandidate(index) ~= nil and not self:IsBusy()
		end
		local apply = new("ButtonControl"):ButtonControl({"TOPLEFT",self,"TOPLEFT"}, {0, 0, 72, 20}, "Apply", function()
			self:ConfirmApply(index)
		end)
		apply.x = function()
			return self:GetCardLeft(index) + self:GetCardWidth() - 82
		end
		apply.y = preview.y
		apply.enabled = function()
			local candidate = self:GetCandidate(index)
			return self.controller ~= nil and candidate ~= nil and candidate.hardConstraintsSatisfied ~= false and not self:IsBusy()
		end
		self.controls["candidatePreview"..label] = preview
		self.controls["candidateApply"..label] = apply
		self.candidateButtons[index] = { preview = preview, apply = apply }
	end

	return self
end

function AIPlannerTabClass:IsBusy()
	local status = self.state and self.state.status or "idle"
	return status ~= nil and status ~= "" and not terminalStatus[status]
end

function AIPlannerTabClass:GetCardWidth()
	return m_max(180, m_floor((self.width - 40) / 3))
end

function AIPlannerTabClass:GetCardLeft(index)
	return 10 + (index - 1) * (self:GetCardWidth() + 10)
end

function AIPlannerTabClass:GetCardsTop()
	return 336
end

function AIPlannerTabClass:GetCardHeight()
	return m_min(190, m_max(150, self.height - self:GetCardsTop() - 170))
end

function AIPlannerTabClass:GetCandidate(index)
	local candidates = self.state and self.state.candidates or { }
	local wanted = candidateLabels[index]:lower()
	for _, candidate in ipairs(candidates) do
		if safeText(candidate.label):lower() == wanted then
			return candidate
		end
	end
	return candidates[index]
end

function AIPlannerTabClass:ControllerCall(method, ...)
	if not self.controller or type(self.controller[method]) ~= "function" then
		self.runtimeError = "Planner controller does not implement "..method.."()."
		return false, self.runtimeError
	end
	local ok, accepted, err = pcall(self.controller[method], self.controller, ...)
	if not ok then
		self.runtimeError = safeText(accepted)
		return false, self.runtimeError
	end
	if not accepted then
		self.runtimeError = safeText(err ~= nil and err or method.." was rejected.")
		return false, self.runtimeError
	end
	self.runtimeError = nil
	return true
end

function AIPlannerTabClass:BuildObjective()
	local preset = self.controls.goalPreset:GetSelValue() or presetList[1]
	local primaryScenario = self.controls.primaryScenario:GetSelValueByKey("id")
	local weights = { mapping = 0.15, standardBoss = 0.15, pinnacle = 0.15, uber = 0.15 }
	weights[primaryScenario] = 0.55
	local budget = tonumber(self.controls.budget.buf)
	if budget and budget < 0 then
		budget = nil
	end
	local goals = cloneFlatTable(preset.goals)
	local hardConstraints = { }
	local minEHP = tonumber(self.controls.minEHP.buf)
	local minWorstCaseMaxHit = tonumber(self.controls.minWorstCaseMaxHit.buf)
	if minEHP then
		t_insert(hardConstraints, { metric = "effectiveHitPool", operator = ">=", value = minEHP })
	end
	if minWorstCaseMaxHit then
		t_insert(hardConstraints, { metric = "worstCaseMaxHit", operator = ">=", value = minWorstCaseMaxHit })
	end
	return {
		schemaVersion = SCHEMA_VERSION,
		primaryScenario = primaryScenario,
		scenarioWeights = weights,
		locks = {
			class = self.controls.lockClass.state == true,
			ascendancy = self.controls.lockAscendancy.state == true,
			mainSkill = self.controls.lockMainSkill.state == true,
		},
		budgetDivine = budget,
		searchPreset = "deep",
		goals = goals,
		hardConstraints = hardConstraints,
		candidateSources = {
			currentBuild = true,
			uniques = budget ~= nil and self.controls.sourceUniques.state == true,
			targetRares = budget ~= nil and self.controls.sourceTargetRares.state == true,
			trade = false,
		},
		description = self.controls.goalText.buf,
		constraintNotes = self.controls.hardConstraints.buf,
	}
end

function AIPlannerTabClass:Start()
	if not self.controls.confirmed.state then
		self.runtimeError = "Confirm the structured objective before starting."
		return
	end
	if self.controls.budget.buf ~= "" and not tonumber(self.controls.budget.buf) then
		self.runtimeError = "Budget must be a non-negative number or empty."
		return
	end
	if self.controls.minEHP.buf ~= "" and not tonumber(self.controls.minEHP.buf) then
		self.runtimeError = "Minimum EHP must be a non-negative number or empty."
		return
	end
	if self.controls.minWorstCaseMaxHit.buf ~= "" and not tonumber(self.controls.minWorstCaseMaxHit.buf) then
		self.runtimeError = "Minimum worst-case max hit must be a non-negative number or empty."
		return
	end
	local accepted = self:ControllerCall("Start", self:BuildObjective())
	if accepted then
		-- Confirmation is a per-run human action, not durable authority.
		self.controls.confirmed.state = false
	end
end

function AIPlannerTabClass:Cancel()
	self:ControllerCall("Cancel")
end

function AIPlannerTabClass:PreviewCandidate(index)
	local candidate = self:GetCandidate(index)
	if candidate and candidate.id then
		self:ControllerCall("Preview", candidate.id)
	end
end

function AIPlannerTabClass:ConfirmApply(index)
	local candidate = self:GetCandidate(index)
	if not candidate or not candidate.id then
		return
	end
	local label = safeText(candidate.label ~= "" and candidate.label or candidateLabels[index])
	main:OpenConfirmPopup(
		"Apply Planner Candidate",
		"Apply the "..label.." candidate to the current build?\n\nThe planner will verify the build fingerprint and roll back if any action fails.",
		"Apply",
		function()
			self:ControllerCall("Apply", candidate.id)
		end
	)
end

function AIPlannerTabClass:OnFrame()
	if not self.controller then
		return
	end
	local ok, err = pcall(self.controller.OnFrame, self.controller)
	if not ok then
		self.runtimeError = safeText(err)
		return
	end
	local stateOk, state = pcall(self.controller.GetState, self.controller)
	if stateOk and type(state) == "table" then
		self.state = state
	else
		self.runtimeError = stateOk and "PlannerController.GetState() returned invalid state." or safeText(state)
	end
end

function AIPlannerTabClass:Shutdown()
	if self.controller and type(self.controller.Shutdown) == "function" then
		local ok, err = pcall(self.controller.Shutdown, self.controller)
		if not ok then
			ConPrintf("AI Planner shutdown error: %s", safeText(err))
		end
	end
	self.controller = nil
end

function AIPlannerTabClass:Load(xml)
	local attrib = xml.attrib or { }
	self.controls.goalPreset:SelByValue(attrib.preset or "balanced", "id")
	self.controls.primaryScenario:SelByValue(attrib.primaryScenario or "mapping", "id")
	self.controls.budget:SetText(attrib.budgetDivine or "")
	self.controls.sourceUniques.state = attrib.sourceUniques == "true"
	self.controls.sourceTargetRares.state = attrib.sourceTargetRares == "true"
	self.controls.minEHP:SetText(attrib.minEHP or "")
	self.controls.minWorstCaseMaxHit:SetText(attrib.minWorstCaseMaxHit or "")
	self.controls.lockClass.state = attrib.lockClass ~= "false"
	self.controls.lockAscendancy.state = attrib.lockAscendancy ~= "false"
	self.controls.lockMainSkill.state = attrib.lockMainSkill ~= "false"
	for _, node in ipairs(xml) do
		if type(node) == "table" and node.elem == "Goals" then
			self.controls.goalText:SetText(type(node[1]) == "string" and node[1] or "")
		elseif type(node) == "table" and node.elem == "HardConstraints" then
			self.controls.hardConstraints:SetText(type(node[1]) == "string" and node[1] or "")
		end
	end
	self.controls.confirmed.state = false
	self.modFlag = false
end

function AIPlannerTabClass:Save(xml)
	local objective = self:BuildObjective()
	xml.attrib = {
		schemaVersion = tostring(SCHEMA_VERSION),
		preset = self.controls.goalPreset:GetSelValueByKey("id"),
		primaryScenario = objective.primaryScenario,
		budgetDivine = objective.budgetDivine and tostring(objective.budgetDivine) or nil,
		sourceUniques = tostring(objective.candidateSources.uniques),
		sourceTargetRares = tostring(objective.candidateSources.targetRares),
		minEHP = self.controls.minEHP.buf ~= "" and self.controls.minEHP.buf or nil,
		minWorstCaseMaxHit = self.controls.minWorstCaseMaxHit.buf ~= "" and self.controls.minWorstCaseMaxHit.buf or nil,
		lockClass = tostring(objective.locks.class),
		lockAscendancy = tostring(objective.locks.ascendancy),
		lockMainSkill = tostring(objective.locks.mainSkill),
	}
	t_insert(xml, { elem = "Goals", self.controls.goalText.buf })
	t_insert(xml, { elem = "HardConstraints", self.controls.hardConstraints.buf })
	self.modFlag = false
end

function AIPlannerTabClass:DrawCandidate(index, candidate)
	local x = self.x + self:GetCardLeft(index)
	local y = self.y + self:GetCardsTop()
	local width = self:GetCardWidth()
	local height = self:GetCardHeight()
	SetDrawColor(candidate and 0.32 or 0.18, candidate and 0.32 or 0.18, candidate and 0.32 or 0.18)
	DrawImage(nil, x, y, width, height)
	SetDrawColor(0.06, 0.06, 0.06)
	DrawImage(nil, x + 2, y + 2, width - 4, height - 4)
	SetDrawColor(1, 1, 1)
	DrawString(x + 10, y + 8, "LEFT", 18, "VAR", "^7"..candidateLabels[index])
	if not candidate then
		DrawString(x + 10, y + 40, "LEFT", 14, "VAR", "^8No verified candidate yet.")
		return
	end
	local summary = candidate.summary or "Candidate ready for preview."
	DrawString(x + 10, y + 38, "LEFT", 14, "VAR", wrapText(summary, width - 20, 4))
	local metrics = formatMetrics(candidate.metrics)
	if metrics ~= "" then
		DrawString(x + 10, y + 104, "LEFT", 13, "VAR", wrapText(metrics, width - 20, 2))
	end
	local cost = "No paid-source cost"
	if type(candidate.cost) == "table" then
		cost = candidate.cost.display or (candidate.cost.divine and formatScalar(candidate.cost.divine).." Divine") or cost
	elseif candidate.cost ~= nil then
		cost = formatScalar(candidate.cost)
	end
	local actionCount = type(candidate.actions) == "table" and #candidate.actions or 0
	DrawString(x + 10, y + height - 52, "LEFT", 13, "VAR", wrapText("Cost: "..cost.."  |  "..actionCount.." actions", width - 20, 1))
end

function AIPlannerTabClass:Draw(viewPort, inputEvents)
	self.x = viewPort.x
	self.y = viewPort.y
	self.width = viewPort.width
	self.height = viewPort.height

	self.controls.goalText.width = m_max(260, m_floor(self.width * 0.52) - 24)
	self.controls.hardConstraints.width = self.controls.goalText.width
	local rightX = m_floor(self.width * 0.55)
	for _, name in ipairs({ "primaryScenario", "budget", "sourceUniques", "sourceTargetRares", "lockClass", "lockAscendancy", "lockMainSkill", "confirmed", "start" }) do
		self.controls[name].x = rightX
	end
	self.controls.sourceTargetRares.x = rightX + 140
	self.controls.lockAscendancy.x = rightX + 80
	self.controls.lockMainSkill.x = rightX + 200

	self:ProcessControlsInput(inputEvents, viewPort)
	main:DrawBackground(viewPort)

	SetDrawColor(1, 1, 1)
	DrawString(self.x + 12, self.y + 10, "LEFT", 22, "VAR", "^7AI Build Planner")
	local availability
	if self.controller then
		availability = "^2Planner loaded. Sidecar starts on search; build changes require explicit Apply."
	else
		availability = "^1Planner unavailable:^7 "..safeText(self.controllerError)
	end
	DrawString(self.x + 12, self.y + 34, "LEFT", 14, "VAR", wrapText(availability, self.width - 24, 2))

	DrawString(self.x + 12, self.y + 50, "LEFT", 14, "VAR", "^7Goal preset")
	DrawString(self.x + 12, self.y + 96, "LEFT", 14, "VAR", "^7Goal details")
	DrawString(self.x + 12, self.y + 168, "LEFT", 14, "VAR", wrapText("^7LLM constraint drafting notes ^1(not enforced until converted)", self.controls.hardConstraints.width, 1))
	DrawString(self.x + 12, self.y + 232, "LEFT", 13, "VAR", "^7Min EHP (all scenarios)")
	DrawString(self.x + 190, self.y + 232, "LEFT", 13, "VAR", "^7Min worst-case max hit")
	DrawString(self.x + rightX, self.y + 50, "LEFT", 14, "VAR", "^7Primary scenario")
	DrawString(self.x + rightX, self.y + 96, "LEFT", 14, "VAR", "^7Budget (Divine)")
	DrawString(self.x + rightX, self.y + 158, "LEFT", 14, "VAR", "^7Locked domains")
	DrawString(self.x + 12, self.y + 274, "LEFT", 14, "VAR", wrapText("^7Deep: 40 steps / 30 min / 100k evaluations / 16 model calls; all four scenarios evaluated", self.width - 24, 1))

	local status = safeText(self.state.status ~= nil and self.state.status or "idle")
	local message = safeText(self.state.message)
	if self.state.error then
		message = safeText(self.state.error)
	end
	if self.runtimeError then
		message = self.runtimeError
	end
	DrawString(self.x + 12, self.y + 296, "LEFT", 15, "VAR", "^7Status: ^3"..status.."^7  "..wrapText(message, self.width - 170, 1))
	local progress = tonumber(self.state.progress) or 0
	if progress > 1 then
		progress = progress / 100
	end
	progress = m_min(1, m_max(0, progress))
	SetDrawColor(0.25, 0.25, 0.25)
	DrawImage(nil, self.x + 12, self.y + 318, self.width - 24, 8)
	SetDrawColor(0.25, 0.75, 0.35)
	DrawImage(nil, self.x + 12, self.y + 318, (self.width - 24) * progress, 8)

	for index = 1, 3 do
		self:DrawCandidate(index, self:GetCandidate(index))
	end

	local previewTop = self:GetCardsTop() + self:GetCardHeight() + 12
	DrawString(self.x + 12, self.y + previewTop, "LEFT", 17, "VAR", "^7Preview Diff")
	local previewText = "Select Preview on a candidate to calculate a verified, non-mutating diff."
	previewText = formatPreview(self.state.preview) or previewText
	DrawString(self.x + 12, self.y + previewTop + 24, "LEFT", 14, "VAR", wrapText(previewText, self.width - 24, 6))

	self:DrawControls(viewPort)
end
