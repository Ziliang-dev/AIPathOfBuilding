describe("AIPlannerTab", function()
	it("builds the confirmed structured objective with safe defaults", function()
		newBuild()
		local planner = build.plannerTab
		local objective = planner:BuildObjective()

		assert.are.equals(2, objective.schemaVersion)
		assert.are.equals("mapping", objective.primaryScenario)
		assert.are.equals(0.55, objective.scenarioWeights.mapping)
		assert.are.equals(0.15, objective.scenarioWeights.standardBoss)
		assert.is_true(objective.locks.class)
		assert.is_true(objective.locks.ascendancy)
		assert.is_true(objective.locks.mainSkill)
		assert.is_nil(objective.budgetDivine)
		assert.are.equals("deep", objective.searchPreset)
		assert.are.equals("combinedDps", objective.goals[1].metric)
		assert.are.equals("maximize", objective.goals[1].direction)
		assert.are.equals(0, #objective.hardConstraints)
		assert.is_true(objective.candidateSources.currentBuild)
		assert.is_false(objective.candidateSources.uniques)
		assert.is_false(objective.candidateSources.targetRares)
		assert.is_false(objective.candidateSources.trade)
	end)

	it("saves only durable objective fields and requires confirmation again after load", function()
		newBuild()
		local planner = build.plannerTab
		planner.controls.goalText:SetText("Improve damage without losing recovery")
		planner.controls.hardConstraints:SetText("Keep current unique body armour")
		planner.controls.budget:SetText("12.5")
		planner.controls.sourceUniques.state = true
		planner.controls.sourceTargetRares.state = true
		planner.controls.sourceTrade.state = true
		planner.controls.tradeRealm:SelByValue("xbox", "id")
		planner.controls.tradeLeague:SetText("Keepers")
		planner.controls.minEHP:SetText("50000")
		planner.controls.minWorstCaseMaxHit:SetText("18000")
		planner.controls.confirmed.state = true
		local paidObjective = planner:BuildObjective()
		assert.is_true(paidObjective.candidateSources.uniques)
		assert.is_true(paidObjective.candidateSources.targetRares)
		assert.is_true(paidObjective.candidateSources.trade)
		assert.are.equals("xbox", paidObjective.tradeContext.realm)
		assert.are.equals("Keepers", paidObjective.tradeContext.league)
		assert.are.equals("effectiveHitPool", paidObjective.hardConstraints[1].metric)
		assert.are.equals(">=", paidObjective.hardConstraints[1].operator)
		assert.are.equals(50000, paidObjective.hardConstraints[1].value)
		assert.are.equals("worstCaseMaxHit", paidObjective.hardConstraints[2].metric)
		assert.are.equals(18000, paidObjective.hardConstraints[2].value)

		local xml = { elem = "AIPlanner" }
		planner:Save(xml)

		assert.are.equals("2", xml.attrib.schemaVersion)
		assert.are.equals("12.5", xml.attrib.budgetDivine)
		assert.are.equals("true", xml.attrib.sourceUniques)
		assert.are.equals("true", xml.attrib.sourceTargetRares)
		assert.are.equals("true", xml.attrib.sourceTrade)
		assert.are.equals("xbox", xml.attrib.tradeRealm)
		assert.are.equals("Keepers", xml.attrib.tradeLeague)
		assert.are.equals("50000", xml.attrib.minEHP)
		assert.are.equals("18000", xml.attrib.minWorstCaseMaxHit)
		assert.is_nil(xml.attrib.confirmed)
		assert.is_nil(xml.attrib.runId)
		assert.are.equals("Goals", xml[1].elem)
		assert.are.equals("HardConstraints", xml[2].elem)

		planner.controls.goalText:SetText("")
		planner.controls.hardConstraints:SetText("")
		planner.controls.minEHP:SetText("")
		planner.controls.minWorstCaseMaxHit:SetText("")
		planner.controls.confirmed.state = true
		planner:Load(xml)

		assert.are.equals("Improve damage without losing recovery", planner.controls.goalText.buf)
		assert.are.equals("Keep current unique body armour", planner.controls.hardConstraints.buf)
		assert.are.equals("50000", planner.controls.minEHP.buf)
		assert.are.equals("18000", planner.controls.minWorstCaseMaxHit.buf)
		assert.is_true(planner.controls.sourceUniques.state)
		assert.is_true(planner.controls.sourceTargetRares.state)
		assert.is_true(planner.controls.sourceTrade.state)
		assert.are.equals("xbox", planner.controls.tradeRealm:GetSelValueByKey("id"))
		assert.are.equals("Keepers", planner.controls.tradeLeague.buf)
		assert.is_false(planner.controls.confirmed.state)
		assert.is_false(planner.modFlag)
	end)

	it("requires review of Planner Chat drafts and blocks unresolved metrics", function()
		newBuild()
		local planner = build.plannerTab
		planner.state.objectiveDraft = {
			primaryScenario = "uber", budgetDivine = 6,
			goals = { { metric = "worstCaseMaxHit", direction = "maximize", weight = 1 } },
			hardConstraints = { { metric = "effectiveHitPool", operator = ">=", value = 50000 } },
			candidateSources = { currentBuild = true, uniques = true, targetRares = false, trade = true },
			tradeContext = { realm = "pc", league = "Keepers" },
		}
		planner.state.objectiveDraftUnresolved = { "unknownMetric" }
		planner:ApplyPlannerDraft()
		assert.matches("unknown metrics", planner.runtimeError)
		assert.is_table(planner.state.objectiveDraft)

		planner.state.objectiveDraftUnresolved = { }
		planner.controls.confirmed.state = true
		planner:ApplyPlannerDraft()
		assert.is_nil(planner.runtimeError)
		assert.is_nil(planner.state.objectiveDraft)
		assert.is_false(planner.controls.confirmed.state)
		local objective = planner:BuildObjective()
		assert.are.equals("uber", objective.primaryScenario)
		assert.are.equals(6, objective.budgetDivine)
		assert.are.equals("worstCaseMaxHit", objective.goals[1].metric)
		assert.are.equals("effectiveHitPool", objective.hardConstraints[1].metric)
		assert.is_true(objective.candidateSources.trade)
		assert.are.equals("Keepers", objective.tradeContext.league)
	end)

	it("never starts a run without per-run human confirmation", function()
		newBuild()
		local planner = build.plannerTab
		build.mainSocketGroup = 1
		build.skillsTab.socketGroupList = { {
			enabled = true, slotEnabled = true, mainActiveSkill = 1,
			displaySkillList = { { activeEffect = { } } },
		} }
		local received
		planner.controller = {
			Start = function(_, objective)
				received = objective
				return true
			end,
		}

		planner:Start()
		assert.is_nil(received)
		assert.are.equals("Confirm the structured objective before starting.", planner.runtimeError)

		planner.controls.confirmed.state = true
		planner:Start()
		assert.is_table(received)
		assert.is_false(planner.controls.confirmed.state)
	end)

	it("blocks an empty Build until it has an active main skill", function()
		newBuild()
		local planner = build.plannerTab
		planner.controls.confirmed.state = true
		planner.controller = { Start = function() error("must not start") end }

		planner:Start()
		assert.matches("active main skill", planner.runtimeError)
		assert.is_false(planner.controls.start.enabled())

		build.mainSocketGroup = 1
		build.skillsTab.socketGroupList = { {
			enabled = true, slotEnabled = true, mainActiveSkill = 1,
			displaySkillList = { { activeEffect = { } } },
		} }
		assert.is_true(planner:HasActiveMainSkill())
	end)

	it("starts the sidecar from LLM Setup and gates Configure on an exact successful test", function()
		newBuild()
		local planner = build.plannerTab
		local connects = 0
		planner.controller = {
			EnsureConnected = function() connects = connects + 1 return true end,
		}
		planner.state = {
			status = "idle", candidates = { }, sidecarStatus = "connected",
			sidecarCapabilities = { providerConnectionTest = true, providerCompatibility = true },
			providerStatus = { configured = false, credentialConfigured = false, consent = "required" },
		}

		planner:OpenProviderPopup()
		local controls = planner.providerPopupControls
		local popupState = planner.providerPopupState
		assert.are.equal(1, connects)
		controls.key:SetText("test-secret")
		assert.is_false(controls.save.enabled())
		popupState.testedRevision = popupState.inputRevision
		popupState.testId = "8d9e3853-93b9-4b03-a9ab-f84d4c4d33ae"
		assert.is_true(controls.save.enabled())
		controls.model:SetText("changed-model", true)
		assert.is_false(controls.save.enabled())
		popupState.loading = true
		controls.key:SetText("")
		popupState.loading = false
		planner.providerPopupControls = nil
		planner.providerPopupState = nil
		main:ClosePopup()
	end)

	it("applies provider presets and keeps manual model entry after optional discovery", function()
		newBuild()
		local planner = build.plannerTab
		local listed
		planner.controller = {
			EnsureConnected = function() return true end,
			ListProviderModels = function(_, profile, callback)
				listed = profile
				callback({ models = { "model-a", "model-b" } })
				return true
			end,
		}
		planner.state = {
			status = "idle", candidates = { }, sidecarStatus = "connected",
			sidecarCapabilities = { providerConnectionTest = true, providerCompatibility = true },
			providerStatus = { configured = false, credentialConfigured = false, consent = "required" },
		}

		planner:OpenProviderPopup()
		local controls = planner.providerPopupControls
		controls.preset:SetSel(2)
		assert.are.equal("https://openrouter.ai/api/v1", controls.endpoint.buf)
		assert.are.equal("openai/gpt-4.1-mini", controls.model.buf)
		controls.key:SetText("test-secret")
		assert.is_true(controls.modelLoad.enabled())
		controls.modelLoad.onClick()
		assert.are.equal("test-secret", listed.apiKey)
		assert.are.equal(2, #controls.modelChoice.list)
		controls.modelChoice:SetSel(2)
		assert.are.equal("model-b", controls.model.buf)

		controls.preset:SetSel(4)
		assert.are.equal("http://127.0.0.1:11434/v1", controls.endpoint.buf)
		assert.are.equal("none", controls.auth:GetSelValueByKey("value"))
		controls.model:SetText("local-model")
		controls.key:SetText("")
		assert.is_true(controls.test.enabled())
		controls.cancel.onClick()
	end)

	it("requires a new key when the provider endpoint changes", function()
		newBuild()
		local planner = build.plannerTab
		planner.controller = { EnsureConnected = function() return true end }
		planner.state = {
			status = "idle", candidates = { }, sidecarStatus = "connected",
			sidecarCapabilities = { providerConnectionTest = true, providerCompatibility = true },
			providerStatus = {
				configured = true, credentialConfigured = true, consent = "required",
				profile = {
					baseURL = "https://provider.invalid/v1/", model = "saved-model",
					authMode = "bearer", apiMode = "auto", reasoningMode = "auto",
				},
			},
		}

		planner:OpenProviderPopup()
		local controls = planner.providerPopupControls
		local popupState = planner.providerPopupState
		assert.is_true(controls.test.enabled())
		controls.endpoint:SetText("https://other.invalid/v1")
		assert.is_false(controls.test.enabled())
		controls.key:SetText("replacement-secret")
		assert.is_true(controls.test.enabled())
		popupState.loading = true
		controls.key:SetText("")
		popupState.loading = false
		planner.providerPopupControls = nil
		planner.providerPopupState = nil
		main:ClosePopup()
	end)

	it("keeps the protected key after test and Configure failures", function()
		newBuild()
		local planner = build.plannerTab
		local shouldPass = false
		planner.controller = {
			EnsureConnected = function() return true end,
			PreviewProviderTest = function(_, _, callback)
				callback({
					endpoint = "https://provider.invalid/v1", model = "test-model", consentKey = "bound",
					payloadPreview = { estimatedBytes = 10, redactedHash = "sha256:"..string.rep("a", 64) },
				})
				return true
			end,
			TestProviderConnection = function(_, _, _, callback)
				if shouldPass then
					callback({
						ok = true, latencyMs = 12, responseModel = "test-model", toolCallValidated = true,
						testId = "8d9e3853-93b9-4b03-a9ab-f84d4c4d33ae",
						resolvedApiMode = "chat_completions", resolvedReasoning = "provider_default",
					})
				else
					callback(nil, "Connection test failed: HTTP 401")
				end
				return true
			end,
			ConfigureProvider = function(_, _, callback)
				callback(nil, "LLM configuration failed")
				return true
			end,
		}
		planner.state = {
			status = "idle", candidates = { }, sidecarStatus = "connected",
			sidecarCapabilities = { providerConnectionTest = true, providerCompatibility = true },
			providerStatus = { configured = false, credentialConfigured = false, consent = "required" },
		}

		planner:OpenProviderPopup()
		local controls = planner.providerPopupControls
		local popupState = planner.providerPopupState
		controls.endpoint:SetText("https://provider.invalid/v1")
		controls.model:SetText("test-model")
		controls.key:SetText("test-secret")
		controls.test.onClick()
		main.popups[1].controls.confirm.onClick()
		assert.are.equal("test-secret", controls.key.buf)
		assert.is_nil(popupState.testedRevision)
		assert.matches("HTTP 401", popupState.statusText)

		shouldPass = true
		controls.test.onClick()
		main.popups[1].controls.confirm.onClick()
		assert.is_true(controls.save.enabled())
		controls.save.onClick()
		assert.are.equal("test-secret", controls.key.buf)
		assert.matches("configuration failed", popupState.statusText)
		controls.cancel.onClick()
	end)

	it("blocks Start but permits Cancel while a run awaits approval", function()
		newBuild()
		local planner = build.plannerTab
		planner.controls.confirmed.state = true
		planner.state = { status = "awaitingApproval", runId = "run-1", candidates = { } }
		assert.is_false(planner.controls.start.enabled())
		assert.is_true(planner.controls.cancel.enabled())
	end)
end)
