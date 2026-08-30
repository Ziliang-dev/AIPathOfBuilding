local ActorSeason = require("Modules.AIPoB.ActorSeason")

describe("AIPathOfBuilding actor and season helpers", function()
	it("normalizes and gates the reviewed 3.29 rulesets", function()
		assert.are.equal("3_29", ActorSeason.NormalizeRuleset("3.29"))
		assert.are.equal("3_29_ruthless", ActorSeason.NormalizeRuleset("3.29_ruthless"))
		assert.is_true(ActorSeason.IsSupportedRuleset("3_29"))
		assert.is_true(ActorSeason.IsSupportedRuleset("3.29_ruthless"))
		assert.is_false(ActorSeason.IsSupportedRuleset("3.30"))
	end)

	it("validates secondary ascendancy and rolls back a point-budget violation", function()
		local restored
		local build = {
			spec = {
				tree = {
					alternate_ascendancies = {
						{ id = "Farrul", name = "Farrul Bloodline" },
						{ id = "Warlock", name = "Warlock Bloodline" },
					},
				},
				curSecondaryAscendClassId = 2,
				CreateUndoState = function() return { marker = true } end,
				RestoreUndoState = function(_, state) restored = state end,
				SelectSecondaryAscendClass = function(self, index)
					self.curSecondaryAscendClassId = index
				end,
				CountAllocNodes = function() return 0, 0, 9 end,
			},
		}
		local ok, err = ActorSeason.ApplySecondaryAscendancy(build, "Farrul")
		assert.is_nil(ok)
		assert.matches("budget", err)
		assert.is_table(restored)
		assert.are.equal(2, build.spec.curSecondaryAscendClassId)
		assert.is_nil(build.buildFlag)
	end)

	it("rejects an unknown secondary ascendancy before mutating the spec", function()
		local selected = false
		local build = {
			spec = {
				tree = { alternate_ascendancies = { { id = "Farrul", name = "Farrul Bloodline" } } },
				SelectSecondaryAscendClass = function() selected = true end,
			},
		}
		local ok, err = ActorSeason.ApplySecondaryAscendancy(build, "NotARealBloodline")
		assert.is_nil(ok)
		assert.matches("unknown secondary ascendancy", err)
		assert.is_false(selected)
	end)

	it("applies a validated tattoo or runegraft override", function()
		local build = {
			spec = {
				nodes = { [101] = { id = 101, type = "Mastery" } },
				tree = {
					tattoo = {
						nodes = {
							["Tattoo of the Tawhoa Shaman"] = {
								dn = "Tattoo of the Tawhoa Shaman", isTattoo = true,
								overrideType = "AlternateMastery",
							},
						},
					},
				},
				hashOverrides = {},
				CreateUndoState = function() return {} end,
				RestoreUndoState = function() error("restore should not run") end,
				BuildAllDependsAndPaths = function(self) self.rebuilt = true end,
			},
		}
		local ok, node, override = ActorSeason.ApplyOverride(build, 101, "Tattoo of the Tawhoa Shaman")
		assert.is_true(ok)
		assert.are.equal(101, node.id)
		assert.are.equal(101, override.id)
		assert.is_true(build.spec.rebuilt)
		assert.are.same(override, build.spec.hashOverrides[101])
		assert.is_true(build.buildFlag)
	end)

	it("projects bounded actor provenance and season records without party text", function()
		local build = {
			targetVersion = "3_29",
			spec = {
				treeVersion = "3_29",
				curSecondaryAscendClassId = 1,
				tree = {
					alternate_ascendancies = {
						{ id = "Farrul", name = "Farrul Bloodline" },
					},
				},
				hashOverrides = {
					[101] = { dn = "Tattoo of the Tawhoa Shaman", isTattoo = true },
				},
			},
			timelessData = {
				jewelType = { id = 9 }, conquerorType = { id = 1 },
				jewelSocket = { id = 61419 }, devotionVariant1 = 2,
			},
			skillsTab = {
				socketGroupList = {
					{ gemList = {
						{ nameSpec = "Animate Guardian", skillId = "AnimateGuardian",
							gemData = { tags = { minion = true } }, skillMinionItemSet = 2 },
						{ nameSpec = "Pact of Beidat", skillId = "PactOfBeidat" },
					} },
				},
			},
			spectreList = { "Metadata/Monsters/KitavaCultist" },
			partyTab = { controls = {
				editAuras = { buf = "private party text" },
			} },
			itemsTab = { items = {
				graft = { type = "Graft", baseName = "Uul-Netol Graft" },
				tincture = { type = "Tincture", baseName = "Prismatic Tincture" },
				foulborn = { type = "Amulet", foulborn = true, title = "Foulborn" },
			} },
		}
		local projection = ActorSeason.Project(build, { limit = 32 })
		assert.are.equal("3_29", projection.ruleset)
		assert.are.equal("Farrul", projection.season.secondaryAscendancy.id)
		assert.are.equal(1, #projection.season.pacts)
		assert.are.equal(9, projection.season.timeless.jewelTypeId)
		assert.are.equal(1, #projection.season.overrides)
		assert.are.equal(1, #projection.season.items.grafts)
		assert.are.equal(1, #projection.season.items.tinctures)
		assert.are.equal(1, #projection.season.items.foulborn)
		local foundSpectre, foundGuardian, foundParty
		for _, actor in ipairs(projection.actors) do
			foundSpectre = foundSpectre or actor.kind == "spectre"
			foundGuardian = foundGuardian or actor.kind == "animateGuardian"
			if actor.kind == "party" then
				foundParty = true
				assert.is_string(actor.textHash)
				assert.is_nil(actor.text)
				assert.is_nil(actor.buf)
			end
		end
		assert.is_true(foundSpectre)
		assert.is_true(foundGuardian)
		assert.is_true(foundParty)
	end)
end)
