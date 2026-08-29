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

local SCHEMA_VERSION = 2

local scenarioList = {
	{ id = "mapping", label = "Mapping" },
	{ id = "standardBoss", label = "Standard Boss" },
	{ id = "pinnacle", label = "Guardian / Pinnacle" },
	{ id = "uber", label = "Uber Pinnacle" },
}

local tradeRealmList = {
	{ id = "pc", label = "PC" },
	{ id = "xbox", label = "Xbox" },
	{ id = "sony", label = "Sony" },
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

local function comparableProviderEndpoint(value)
	local text = tostring(value or ""):match("^%s*(.-)%s*$"):gsub("/+$", "")
	local scheme, authority, path = text:match("^(https?)://([^/]+)(.*)$")
	if not scheme then return text end
	return scheme:lower().."://"..authority:lower()..path
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
		self.draftedObjective = nil
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
	self.controls.budget.tooltipText = "A budget may enable Unique, target-Rare, and authenticated main-process Trade catalog proposals."
	self.controls.sourceUniques = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {510, 138, 18}, "Unique catalog", objectiveChanged, nil, false)
	self.controls.sourceUniques.labelRight = true
	self.controls.sourceTargetRares = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {650, 138, 18}, "Target rares", objectiveChanged, nil, false)
	self.controls.sourceTargetRares.labelRight = true
	self.controls.sourceTrade = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {780, 138, 18}, "PoE Trade", objectiveChanged, nil, false)
	self.controls.sourceTrade.labelRight = true
	self.controls.tradeRealm = new("DropDownControl"):DropDownControl({"TOPLEFT",self,"TOPLEFT"}, {510, 210, 90, 20}, tradeRealmList, objectiveChanged)
	self.controls.tradeLeague = new("EditControl"):EditControl({"TOPLEFT",self,"TOPLEFT"}, {610, 210, 190, 20}, "", "Exact league name", nil, 128, objectiveChanged, nil, false, true)

	self.controls.lockClass = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {510, 174, 18}, "Class", objectiveChanged, nil, true)
	self.controls.lockClass.labelRight = true
	self.controls.lockAscendancy = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {590, 174, 18}, "Ascendancy", objectiveChanged, nil, true)
	self.controls.lockAscendancy.labelRight = true
	self.controls.lockMainSkill = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {710, 174, 18}, "Main Skill", objectiveChanged, nil, true)
	self.controls.lockMainSkill.labelRight = true

	self.controls.confirmed = new("CheckBoxControl"):CheckBoxControl({"TOPLEFT",self,"TOPLEFT"}, {510, 242, 18}, "Confirm this objective before search", function() end, "The planner cannot start until you explicitly confirm the structured objective.", false)
	self.controls.confirmed.labelRight = true

	self.controls.start = new("ButtonControl"):ButtonControl({"TOPLEFT",self,"TOPLEFT"}, {510, 274, 100, 22}, "Start", function()
		self:Start()
	end)
	self.controls.start.enabled = function()
		local status = self.state and self.state.status or "idle"
		return self.controller ~= nil and self:HasActiveMainSkill() and self.controls.confirmed.state
			and not self:IsBusy() and not unresolvedRunStatus[status]
	end
	self.controls.start.tooltipText = function()
		if not self:HasActiveMainSkill() then return "Import a build or add an active main skill before search." end
		if not self.controls.confirmed.state then return "Confirm the structured objective before search." end
		if self:IsBusy() then return "Wait for the current Planner operation to finish." end
		return "Start the confirmed optimization."
	end
	self.controls.cancel = new("ButtonControl"):ButtonControl({"LEFT",self.controls.start,"RIGHT"}, {10, 0, 100, 22}, "Cancel", function()
		self:Cancel()
	end)
	self.controls.cancel.enabled = function()
		local status = self.state and self.state.status
		return self.controller ~= nil and self.state ~= nil and self.state.runId ~= nil
			and (status == "running" or unresolvedRunStatus[status] == true)
	end
	self.controls.llmSetup = new("ButtonControl"):ButtonControl({"TOPLEFT",self,"TOPLEFT"}, {0, 10, 92, 20}, "LLM Setup", function() self:OpenProviderPopup() end)
	self.controls.llmSetup.tooltipText = "Configure and test an OpenAI-compatible provider. Opening this starts the sidecar."
	self.controls.llmConsent = new("ButtonControl"):ButtonControl({"LEFT",self.controls.llmSetup,"RIGHT"}, {8, 0, 92, 20}, "Consent", function() self:ConfirmProviderConsent() end)
	self.controls.llmConsent.enabled = function()
		return self.controller ~= nil and self.state.sidecarStatus == "connected" and type(self.state.consentPreview) == "table"
	end
	self.controls.llmConsent.tooltipText = function()
		if self.state.sidecarStatus ~= "connected" then return "Open LLM Setup and wait for the sidecar to connect." end
		return type(self.state.consentPreview) == "table"
			and "Grant normal provider access for the exact endpoint, model, policies, and data categories."
			or "Configure the provider first; Test Connection does not grant normal data consent."
	end
	self.controls.llmDraft = new("ButtonControl"):ButtonControl({"LEFT",self.controls.llmConsent,"RIGHT"}, {8, 0, 92, 20}, "Draft Goal", function() self:OpenDraftPopup() end)
	self.controls.llmDraft.enabled = function()
		local status = self.state.providerStatus
		return self.controller ~= nil and self.state.sidecarStatus == "connected"
			and type(status) == "table" and status.consent == "granted" and not self:IsBusy()
	end
	self.controls.llmDraft.tooltipText = function()
		local status = self.state.providerStatus
		if self.state.sidecarStatus ~= "connected" then return "Open LLM Setup and wait for the sidecar to connect." end
		if type(status) ~= "table" or not status.configured then return "Configure and test an LLM provider first." end
		if status.consent ~= "granted" then return "Grant first-call consent before using Planner Chat." end
		return "Draft a structured objective with ephemeral Planner Chat."
	end
	self.controls.applyDraft = new("ButtonControl"):ButtonControl({"LEFT",self.controls.llmDraft,"RIGHT"}, {8, 0, 92, 20}, "Use Draft", function() self:ApplyPlannerDraft() end)
	self.controls.applyDraft.enabled = function() return type(self.state.objectiveDraft) == "table" and not self:IsBusy() end
	self.controls.applyDraft.tooltipText = function()
		return type(self.state.objectiveDraft) == "table" and "Apply the reviewed draft to Planner controls."
			or "Create and review a Planner Chat draft first."
	end
	for _, name in ipairs({ "goalPreset", "goalText", "hardConstraints", "minEHP", "minWorstCaseMaxHit", "primaryScenario", "budget", "sourceUniques", "sourceTargetRares", "sourceTrade", "tradeRealm", "tradeLeague", "lockClass", "lockAscendancy", "lockMainSkill", "confirmed" }) do
		local controlName = name
		self.controls[name].enabled = function()
			if controlName == "sourceUniques" or controlName == "sourceTargetRares" or controlName == "sourceTrade"
				or controlName == "tradeRealm" or controlName == "tradeLeague" then
				return not self:IsBusy() and tonumber(self.controls.budget.buf) ~= nil
			end
			return not self:IsBusy()
		end
	end
	for _, name in ipairs({ "sourceUniques", "sourceTargetRares", "sourceTrade", "tradeRealm", "tradeLeague" }) do
		self.controls[name].tooltipText = function()
			return tonumber(self.controls.budget.buf) ~= nil
				and "Budget-bound candidate source."
				or "Set a valid Divine Budget to enable paid catalog and Trade sources."
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

function AIPlannerTabClass:HasActiveMainSkill()
	local skillsTab = self.build and self.build.skillsTab
	local groups = skillsTab and skillsTab.socketGroupList
	local group = type(groups) == "table" and groups[tonumber(self.build.mainSocketGroup) or 1] or nil
	if type(group) ~= "table" or group.enabled == false or group.slotEnabled == false then return false end
	local skills = group.displaySkillList
	local active = type(skills) == "table" and skills[tonumber(group.mainActiveSkill) or 1] or nil
	return type(active) == "table" and type(active.activeEffect) == "table"
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
	local draft = self.draftedObjective
	local goals = draft and type(draft.goals) == "table" and draft.goals or cloneFlatTable(preset.goals)
	local hardConstraints = draft and type(draft.hardConstraints) == "table" and cloneFlatTable(draft.hardConstraints) or { }
	local minEHP = tonumber(self.controls.minEHP.buf)
	local minWorstCaseMaxHit = tonumber(self.controls.minWorstCaseMaxHit.buf)
	if minEHP then
		t_insert(hardConstraints, { metric = "effectiveHitPool", operator = ">=", value = minEHP })
	end
	if minWorstCaseMaxHit then
		t_insert(hardConstraints, { metric = "worstCaseMaxHit", operator = ">=", value = minWorstCaseMaxHit })
	end
	local trade = budget ~= nil and self.controls.sourceTrade.state == true and self.controls.tradeLeague.buf ~= ""
	local objective = {
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
			trade = trade,
		},
		description = self.controls.goalText.buf,
		constraintNotes = self.controls.hardConstraints.buf,
	}
	if trade then
		objective.tradeContext = {
			realm = self.controls.tradeRealm:GetSelValueByKey("id"),
			league = self.controls.tradeLeague.buf,
		}
	end
	return objective
end

function AIPlannerTabClass:Start()
	if not self.controls.confirmed.state then
		self.runtimeError = "Confirm the structured objective before starting."
		return
	end
	if not self:HasActiveMainSkill() then
		self.runtimeError = "Import a build or add an active main skill before search."
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
	if self.controls.sourceTrade.state and self.controls.tradeLeague.buf == "" then
		self.runtimeError = "Trade requires an exact league name."
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

function AIPlannerTabClass:OpenProviderPopup()
	self:ControllerCall("EnsureConnected")
	local controls = { }
	local popupState = { inputRevision = 0, statusText = "Waiting for sidecar", loading = false, modelChoices = { } }
	local profile = type(self.state.providerStatus) == "table" and self.state.providerStatus.profile or { }
	local providerPresets = {
		{ label = "OpenAI", value = "openai", baseUrl = "https://api.openai.com/v1", model = "gpt-4.1-mini", authMode = "bearer" },
		{ label = "OpenRouter", value = "openrouter", baseUrl = "https://openrouter.ai/api/v1", model = "openai/gpt-4.1-mini", authMode = "bearer" },
		{ label = "DeepSeek", value = "deepseek", baseUrl = "https://api.deepseek.com", model = "deepseek-chat", authMode = "bearer" },
		{ label = "Local", value = "local", baseUrl = "http://127.0.0.1:11434/v1", model = "", authMode = "none" },
		{ label = "Custom", value = "custom" },
	}
	local apiModes = {
		{ label = "Auto", value = "auto" },
		{ label = "Chat Completions", value = "chat_completions" },
		{ label = "Responses", value = "responses" },
	}
	local reasoningModes = {
		{ label = "Auto", value = "auto" },
		{ label = "Off", value = "off" },
		{ label = "Fast", value = "fast" },
		{ label = "Balanced", value = "balanced" },
		{ label = "Deep", value = "deep" },
	}
	local authModes = {
		{ label = "Bearer key", value = "bearer" },
		{ label = "No key (local)", value = "none" },
	}
	local function invalidateTest()
		if popupState.loading then return end
		popupState.inputRevision = popupState.inputRevision + 1
		popupState.testedRevision = nil
		popupState.testId = nil
		popupState.statusText = "Fields changed; run Test Connection again"
	end
	controls.presetLabel = new("LabelControl"):LabelControl(nil, {0, 14, 0, 16}, "^7Provider")
	controls.preset = new("DropDownControl"):DropDownControl(nil, {0, 34, 180, 20}, providerPresets, function(_, preset)
		if type(preset) ~= "table" or preset.value == "custom" then return end
		popupState.loading = true
		controls.endpoint:SetText(preset.baseUrl)
		controls.model:SetText(preset.model)
		controls.auth:SetSel(preset.authMode == "none" and 2 or 1, true)
		popupState.loading = false
		invalidateTest()
	end)
	controls.preset:SelByValue("custom", "value")
	for _, preset in ipairs(providerPresets) do
		if preset.baseUrl and comparableProviderEndpoint(preset.baseUrl) == comparableProviderEndpoint(profile.baseURL or "") then
			controls.preset:SelByValue(preset.value, "value")
			break
		end
	end
	controls.endpointLabel = new("LabelControl"):LabelControl(nil, {0, 64, 0, 16}, "^7OpenAI-compatible endpoint")
	controls.endpoint = new("EditControl"):EditControl(nil, {0, 84, 680, 20}, profile.baseURL or "https://api.openai.com/v1", nil, nil, 2048, invalidateTest)
	controls.modelLabel = new("LabelControl"):LabelControl(nil, {0, 114, 0, 16}, "^7Model")
	controls.model = new("EditControl"):EditControl(nil, {0, 134, 410, 20}, profile.model or "gpt-4.1-mini", nil, nil, 256, invalidateTest)
	controls.modelLoad = new("ButtonControl"):ButtonControl(nil, {420, 134, 100, 20}, "Load Models", function()
		popupState.statusText = "Loading provider model list"
		local input = {
			baseUrl = controls.endpoint.buf,
			authMode = controls.auth:GetSelValueByKey("value"),
			apiKey = controls.key.buf,
		}
		self:ControllerCall("ListProviderModels", input, function(result, listErr)
			if listErr then popupState.statusText = listErr return end
			local models = type(result) == "table" and result.models or nil
			if type(models) ~= "table" or #models == 0 then
				popupState.statusText = "Provider returned no model IDs; enter one manually"
				return
			end
			popupState.modelChoices = models
			controls.modelChoice:SetList(models)
			controls.modelChoice.selIndex = 1
			popupState.statusText = "Loaded "..tostring(#models).." models; select one or keep typing"
		end)
	end)
	controls.modelChoice = new("DropDownControl"):DropDownControl(nil, {530, 134, 150, 20}, { }, function(_, value)
		if type(value) == "string" and value ~= "" then controls.model:SetText(value) end
	end)
	controls.modelChoice.shown = function() return #popupState.modelChoices > 0 end
	controls.keyLabel = new("LabelControl"):LabelControl(nil, {0, 164, 0, 16}, "^7API key (stored only in Windows Credential Manager)")
	local hasStoredKey = type(self.state.providerStatus) == "table" and self.state.providerStatus.credentialConfigured == true
	controls.key = new("EditControl"):EditControl(nil, {0, 184, 680, 20}, "", hasStoredKey and "Leave blank to use the saved key" or "Required for remote providers", nil, 16384, invalidateTest)
	controls.key:SetProtected(true)
	controls.advanced = new("CheckBoxControl"):CheckBoxControl(nil, {0, 216, 16}, "Advanced", nil, "Override API route, reasoning, or authentication.", false)
	controls.advanced.labelRight = true
	controls.apiLabel = new("LabelControl"):LabelControl(nil, {115, 216, 0, 16}, "^7API")
	controls.api = new("DropDownControl"):DropDownControl(nil, {145, 214, 150, 20}, apiModes, function() invalidateTest() end)
	controls.api:SelByValue(profile.apiMode or "auto", "value")
	controls.reasoningLabel = new("LabelControl"):LabelControl(nil, {305, 216, 0, 16}, "^7Reasoning")
	controls.reasoning = new("DropDownControl"):DropDownControl(nil, {375, 214, 130, 20}, reasoningModes, function() invalidateTest() end)
	controls.reasoning:SelByValue(profile.reasoningMode or "auto", "value")
	controls.authLabel = new("LabelControl"):LabelControl(nil, {515, 216, 0, 16}, "^7Auth")
	controls.auth = new("DropDownControl"):DropDownControl(nil, {555, 214, 125, 20}, authModes, function() invalidateTest() end)
	controls.auth:SelByValue(profile.authMode or "bearer", "value")
	for _, control in ipairs({ controls.apiLabel, controls.api, controls.reasoningLabel, controls.reasoning, controls.authLabel, controls.auth }) do
		control.shown = function() return controls.advanced.state end
	end
	controls.disclosure = new("LabelControl"):LabelControl(nil, {0, 248, 0, 16}, "^8Test sends one fixed synthetic tool call; no Build/chat data; exactly one inference request.")
	controls.status = new("LabelControl"):LabelControl(nil, {0, 272, 0, 16}, "")
	controls.status.label = function()
		local sidecar = self.state and self.state.sidecarStatus or "stopped"
		local sidecarLabel = ({ starting = "Starting", connecting = "Starting", reconnecting = "Starting", connected = "Connected", failed = "Failed", stopped = "Stopped" })[sidecar] or safeText(sidecar)
		local detail = popupState.statusText
		if sidecar ~= "connected" and self.state and self.state.sidecarMessage then detail = self.state.sidecarMessage end
		return "^7Sidecar: ^3"..sidecarLabel.."^7  "..safeText(detail)
	end
	local function connected()
		return self.state and self.state.sidecarStatus == "connected"
	end
	local function connectionTestSupported()
		local capabilities = self.state and self.state.sidecarCapabilities
		return type(capabilities) == "table" and capabilities.providerConnectionTest == true and capabilities.providerCompatibility == true
	end
	local function currentInput()
		return {
			baseUrl = controls.endpoint.buf,
			model = controls.model.buf,
			apiKey = controls.key.buf,
			authMode = controls.auth:GetSelValueByKey("value"),
			apiMode = controls.api:GetSelValueByKey("value"),
			reasoningMode = controls.reasoning:GetSelValueByKey("value"),
			testId = popupState.testId,
		}
	end
	local function savedKeyUsable()
		local status = self.state and self.state.providerStatus
		local savedProfile = type(status) == "table" and status.profile or nil
		return type(savedProfile) == "table" and status.credentialConfigured == true
			and savedProfile.authMode ~= "none"
			and comparableProviderEndpoint(savedProfile.baseURL) == comparableProviderEndpoint(controls.endpoint.buf)
	end
	local function fieldsPresent()
		local authMode = controls.auth:GetSelValueByKey("value")
		return controls.endpoint.buf ~= "" and controls.model.buf ~= ""
			and (authMode == "none" or controls.key.buf ~= "" or savedKeyUsable())
	end
	controls.modelLoad.enabled = function()
		if not connected() or controls.endpoint.buf == "" then return false end
		return controls.auth:GetSelValueByKey("value") == "none" or controls.key.buf ~= "" or savedKeyUsable()
	end
	controls.retry = new("ButtonControl"):ButtonControl(nil, {-270, 316, 105, 20}, "Retry Sidecar", function()
		popupState.statusText = "Retrying sidecar"
		self:ControllerCall("EnsureConnected")
	end)
	controls.retry.shown = function() return self.state and self.state.sidecarStatus == "failed" end
	controls.test = new("ButtonControl"):ButtonControl(nil, {-145, 316, 125, 20}, "Test Connection", function()
		if not fieldsPresent() or popupState.testing then return end
		local attempt = currentInput()
		attempt.revision = popupState.inputRevision
		popupState.testing = true
		popupState.testedRevision = nil
		popupState.statusText = "Preparing test authorization"
		local accepted = self:ControllerCall("PreviewProviderTest", attempt, function(preview, previewErr)
			if previewErr then
				popupState.testing = false
				popupState.statusText = previewErr
				return
			end
			if popupState.inputRevision ~= attempt.revision then
				popupState.testing = false
				popupState.statusText = "Fields changed; run Test Connection again"
				return
			end
			popupState.testing = false
			popupState.statusText = "Review the one-time authorization"
			local payload = type(preview.payloadPreview) == "table" and preview.payloadPreview or { }
			main:OpenConfirmPopup(
				"One-time LLM Connection Test",
				"Endpoint: "..safeText(preview.endpoint).."\nModel: "..safeText(preview.model)
					.."\nAPI: "..safeText(preview.resolvedApiMode).."\nReasoning: "..safeText(preview.resolvedReasoning)
					.."\nData: fixed synthetic connection_probe only\nRedacted bytes: "..safeText(payload.estimatedBytes)
					.."\nPayload hash: "..safeText(payload.redactedHash)
					.."\n\nRun this one-time provider request? It does not grant normal Build/chat consent.",
				"Run Test",
				function()
					if popupState.inputRevision ~= attempt.revision then
						popupState.statusText = "Fields changed; run Test Connection again"
						return
					end
					popupState.testing = true
					popupState.statusText = "Testing endpoint, key, model, and tool calling"
					local queued = self:ControllerCall("TestProviderConnection", attempt, preview, function(result, testErr)
						popupState.testing = false
						if testErr then
							popupState.statusText = testErr
							return
						end
						if popupState.inputRevision ~= attempt.revision then
							popupState.statusText = "Fields changed after test; run it again"
							return
						end
						popupState.testedRevision = attempt.revision
						popupState.testId = result.testId
						local usage = type(result.usage) == "table"
							and "; tokens "..safeText(result.usage.inputTokens).."/"..safeText(result.usage.outputTokens) or ""
						popupState.statusText = "Passed in "..safeText(result.latencyMs).." ms; model "
							..safeText(result.responseModel or result.requestedModel).."; "..safeText(result.resolvedApiMode)
							.."; reasoning "..safeText(result.resolvedReasoning).."; tool calling verified"..usage..". Configure to save."
					end)
					if not queued then
						popupState.testing = false
						popupState.statusText = safeText(self.runtimeError)
					end
				end
			)
		end)
		if not accepted then
			popupState.testing = false
			popupState.statusText = safeText(self.runtimeError)
		end
	end)
	controls.test.enabled = function() return connected() and connectionTestSupported() and fieldsPresent() and not popupState.testing and not popupState.configuring end
	controls.test.tooltipText = function()
		if not connected() then return "Wait for the sidecar to connect or retry after failure." end
		if not connectionTestSupported() then return "The connected sidecar does not support Provider compatibility v3." end
		if controls.endpoint.buf == "" then return "Enter an OpenAI-compatible endpoint." end
		if controls.model.buf == "" then return "Enter the provider model name." end
		if not fieldsPresent() then return "Enter an API key; a saved key is reusable only for the unchanged endpoint." end
		if popupState.testing then return "Wait for the current connection test." end
		return "Runs a real forced tool-call probe against the current unsaved fields."
	end
	controls.save = new("ButtonControl"):ButtonControl(nil, {-10, 316, 100, 20}, "Configure", function()
		if popupState.testedRevision ~= popupState.inputRevision or not popupState.testId or popupState.configuring then return end
		popupState.configuring = true
		popupState.statusText = "Saving tested configuration"
		local accepted = self:ControllerCall("ConfigureProvider", currentInput(), function(_, configureErr)
			popupState.configuring = false
			if configureErr then
				popupState.statusText = configureErr
				return
			end
			popupState.loading = true
			controls.key:SetText("")
			popupState.loading = false
			self.providerPopupControls = nil
			self.providerPopupState = nil
			main:ClosePopup()
		end)
		if not accepted then
			popupState.configuring = false
			popupState.statusText = safeText(self.runtimeError)
		end
	end)
	controls.save.enabled = function()
		return connected() and connectionTestSupported() and popupState.testId ~= nil
			and popupState.testedRevision == popupState.inputRevision and not popupState.testing and not popupState.configuring
	end
	controls.save.tooltipText = function()
		return popupState.testedRevision == popupState.inputRevision
			and "Save the exact tested fields, then review normal provider data consent."
			or "Run Test Connection successfully for these exact fields first."
	end
	controls.clear = new("ButtonControl"):ButtonControl(nil, {100, 316, 90, 20}, "Clear", function()
		popupState.statusText = "Clearing saved provider configuration"
		self:ControllerCall("ClearProvider", function(_, clearErr)
			if clearErr then
				popupState.statusText = clearErr
				return
			end
			popupState.loading = true
			controls.key:SetText("")
			popupState.loading = false
			self.providerPopupControls = nil
			self.providerPopupState = nil
			main:ClosePopup()
		end)
	end)
	controls.clear.enabled = function() return connected() and not popupState.testing and not popupState.configuring end
	controls.cancel = new("ButtonControl"):ButtonControl(nil, {200, 316, 90, 20}, "Cancel", function()
		popupState.loading = true
		controls.key:SetText("")
		popupState.loading = false
		self.providerPopupControls = nil
		self.providerPopupState = nil
		main:ClosePopup()
	end)
	self.providerPopupControls = controls
	self.providerPopupState = popupState
	main:OpenPopup(740, 365, "Planner LLM", controls, "test", "key", "cancel")
end

function AIPlannerTabClass:ConfirmProviderConsent()
	local preview = self.state.consentPreview
	if type(preview) ~= "table" then
		self:ControllerCall("PreviewProviderConsent")
		return
	end
	local categories = type(preview.dataCategories) == "table" and t_concat(preview.dataCategories, ", ") or "unknown"
	local payload = type(preview.payloadPreview) == "table" and preview.payloadPreview or { }
	main:OpenConfirmPopup(
		"First LLM Authorization",
		"Endpoint: "..safeText(preview.endpoint).."\nModel: "..safeText(preview.model)
			.."\nData: "..safeText(categories).."\nRedacted bytes: "..safeText(payload.estimatedBytes)
			.."\n\nGrant access for this exact endpoint/model/policy? Revocation aborts active provider calls.",
		"Grant",
		function() self:ControllerCall("GrantProviderConsent") end
	)
end

function AIPlannerTabClass:OpenDraftPopup()
	local controls = { }
	controls.label = new("LabelControl"):LabelControl(nil, {0, 14, 0, 16}, "^7Describe desired changes. Chat text is ephemeral.")
	controls.message = new("EditControl"):EditControl(nil, {0, 40, 520, 74}, "", "Example: more Uber max hit without losing mapping speed", nil, 8000, nil, 14, false, true)
	controls.draft = new("ButtonControl"):ButtonControl(nil, {-98, 130, 90, 20}, "Draft", function()
		if controls.message.buf == "" then return end
		local accepted = self:ControllerCall("DraftObjective", controls.message.buf, self:BuildObjective())
		controls.message:SetText("")
		if accepted then main:ClosePopup() end
	end)
	controls.cancel = new("ButtonControl"):ButtonControl(nil, {8, 130, 90, 20}, "Cancel", function()
		controls.message:SetText("")
		main:ClosePopup()
	end)
	main:OpenPopup(570, 165, "Planner Chat", controls, "draft", "message", "cancel")
end

function AIPlannerTabClass:ApplyPlannerDraft()
	local draft = self.state.objectiveDraft
	if type(draft) ~= "table" then return end
	if type(self.state.objectiveDraftUnresolved) == "table" and #self.state.objectiveDraftUnresolved > 0 then
		self.runtimeError = "Planner draft contains unknown metrics; resolve them before use."
		return
	end
	self.draftedObjective = draft
	if type(draft.primaryScenario) == "string" then self.controls.primaryScenario:SelByValue(draft.primaryScenario, "id") end
	if type(draft.budgetDivine) == "number" then self.controls.budget:SetText(tostring(draft.budgetDivine)) end
	if type(draft.candidateSources) == "table" then
		self.controls.sourceUniques.state = draft.candidateSources.uniques == true
		self.controls.sourceTargetRares.state = draft.candidateSources.targetRares == true
		self.controls.sourceTrade.state = draft.candidateSources.trade == true
	end
	if type(draft.tradeContext) == "table" then
		self.controls.tradeRealm:SelByValue(draft.tradeContext.realm or "pc", "id")
		self.controls.tradeLeague:SetText(draft.tradeContext.league or "")
	end
	self.controls.confirmed.state = false
	self.modFlag = true
	self.runtimeError = nil
	self.state.objectiveDraft = nil
	self.state.message = "Draft applied to controls; review and confirm before search"
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
	local popup = self.providerPopupControls
	local popupState = self.providerPopupState
	local provider = type(self.state.providerStatus) == "table" and self.state.providerStatus or nil
	if popup and popupState and not popupState.profileLoaded and popupState.inputRevision == 0 and provider and type(provider.profile) == "table" then
		popupState.loading = true
		popup.endpoint:SetText(provider.profile.baseURL or popup.endpoint.buf)
		popup.model:SetText(provider.profile.model or popup.model.buf)
		popup.key.prompt = provider.credentialConfigured and "Leave blank to use the saved key" or "Required for first configuration"
		popupState.loading = false
		popupState.profileLoaded = true
		popupState.statusText = "Saved profile loaded; run Test Connection"
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
	self.controls.sourceTrade.state = attrib.sourceTrade == "true"
	self.controls.tradeRealm:SelByValue(attrib.tradeRealm or "pc", "id")
	self.controls.tradeLeague:SetText(attrib.tradeLeague or "")
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
		sourceTrade = tostring(objective.candidateSources.trade),
		tradeRealm = objective.tradeContext and objective.tradeContext.realm or nil,
		tradeLeague = objective.tradeContext and objective.tradeContext.league or nil,
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
	for _, name in ipairs({ "primaryScenario", "budget", "sourceUniques", "sourceTargetRares", "sourceTrade", "tradeRealm", "tradeLeague", "lockClass", "lockAscendancy", "lockMainSkill", "confirmed", "start" }) do
		self.controls[name].x = rightX
	end
	self.controls.sourceTargetRares.x = rightX + 140
	self.controls.sourceTrade.x = rightX + 270
	self.controls.tradeLeague.x = rightX + 100
	self.controls.lockAscendancy.x = rightX + 80
	self.controls.lockMainSkill.x = rightX + 200
	self.controls.llmSetup.x = m_max(rightX, self.width - 410)

	self:ProcessControlsInput(inputEvents, viewPort)
	main:DrawBackground(viewPort)

	SetDrawColor(1, 1, 1)
	DrawString(self.x + 12, self.y + 10, "LEFT", 22, "VAR", "^7AI Build Planner")
	local availability
	if self.controller then
		availability = self:HasActiveMainSkill()
			and "^2Planner ready. Sidecar starts when LLM setup or search needs it; build changes require explicit Apply."
			or "^1Import a build or add an active main skill before search. LLM setup remains available."
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
	DrawString(self.x + rightX, self.y + 194, "LEFT", 13, "VAR", "^7Trade realm / exact league")
	DrawString(self.x + 12, self.y + 274, "LEFT", 14, "VAR", wrapText("^7Deep: 40 steps / 30 min / 100k evaluations / 16 model calls; all four scenarios evaluated", self.width - 24, 1))

	local status = safeText(self.state.status ~= nil and self.state.status or "idle")
	local message = safeText(self.state.message)
	if self.state.error then
		message = safeText(self.state.error)
	end
	if self.runtimeError then
		message = self.runtimeError
	end
	local sidecar = safeText(self.state.sidecarStatus ~= nil and self.state.sidecarStatus or "stopped")
	DrawString(self.x + 12, self.y + 296, "LEFT", 15, "VAR", "^7Run: ^3"..status.."^7  |  Sidecar: ^3"..sidecar.."^7  "..wrapText(message, self.width - 260, 1))
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
