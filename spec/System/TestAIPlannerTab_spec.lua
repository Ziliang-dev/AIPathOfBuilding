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

	it("blocks Start but permits Cancel while a run awaits approval", function()
		newBuild()
		local planner = build.plannerTab
		planner.controls.confirmed.state = true
		planner.state = { status = "awaitingApproval", runId = "run-1", candidates = { } }
		assert.is_false(planner.controls.start.enabled())
		assert.is_true(planner.controls.cancel.enabled())
	end)
end)
