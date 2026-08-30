local TradeBroker = require("Modules.AIPoB.TradeBroker")
local ItemImport = require("Modules.AIPoB.ItemImport")

describe("AIPathOfBuilding Trade broker", function()
	local function query(overrides)
		local typedQuery = assert(TradeBroker.BuildTypedQuery({
			category = "armour.helmet", rarity = "rare", statFilters = { },
		}))
		local value = {
			requestId = "trade-test",
			realm = "pc",
			league = "Settlers",
			slot = "Helmet",
			query = typedQuery,
			budgetDivine = 5,
			maxResults = 10,
		}
		for key, item in pairs(overrides or { }) do value[key] = item end
		return value
	end

	local function item(overrides)
		local value = {
			amount = 2,
			currency = "divine",
			priceType = "~b/o",
			item_string = "Rarity: Rare\nTitanium Spirit Shield",
			trader = "redacted",
			whisper = "@redacted Hi",
			id = "listing-id",
		}
		for key, entry in pairs(overrides or { }) do value[key] = entry end
		return value
	end

	it("normalizes fixed prices and removes seller metadata", function()
		local broker = TradeBroker.new()
		local result = assert(broker:NormalizeResults({ item() }, query()))
		assert.are.equal(1, #result)
		assert.are.equal("trade", result[1].source)
		assert.are.equal(2, result[1].price.divineEquivalent)
		assert.is_nil(result[1].trader)
		assert.is_nil(result[1].whisper)
		assert.is_nil(result[1].listingId)
	end)

	it("builds only bounded typed queries inside the PoB process", function()
		local encoded = assert(TradeBroker.BuildTypedQuery({
			category = "armour.helmet", rarity = "rare", minItemLevel = 84,
			statFilters = { { id = "explicit.stat_3299347043", min = 80 } },
		}))
		assert.matches("armour.helmet", encoded, nil, true)
		assert.matches("explicit.stat_3299347043", encoded, nil, true)
		local invalid, err = TradeBroker.BuildTypedQuery({
			category = "arbitrary.raw.query", statFilters = { },
		})
		assert.is_nil(invalid)
		assert.are.equal("invalid_query", err.code)
		local injected, injectedErr = TradeBroker.BuildTypedQuery({
			category = "armour.helmet",
			statFilters = { { id = "explicit.stat_1\"}]}}" } },
		})
		assert.is_nil(injected)
		assert.are.equal("invalid_query", injectedErr.code)
	end)

	it("rejects negotiable and over-budget prices", function()
		local broker = TradeBroker.new()
		local negotiable = assert(broker:NormalizeResults({ item({ priceType = "~price" }) }, query()))
		assert.are.equal(0, #negotiable)
		local overBudget = assert(broker:NormalizeResults({ item({ amount = 6 }) }, query({ budgetDivine = 5 })))
		assert.are.equal(0, #overBudget)
	end)

	it("deduplicates requests by idempotency and ignores cancelled late responses", function()
		local requestCallback
		local calls = 0
		local requests = {
			SearchWithQuery = function(_, _, _, _, callback)
				calls = calls + 1
				requestCallback = callback
			end,
		}
		local broker = TradeBroker.new({ requests = requests })
		local callbackCalls = 0
		local requestId = broker:Search(query(), function() callbackCalls = callbackCalls + 1 end)
		broker:Search(query(), function() callbackCalls = callbackCalls + 1 end)
		assert.are.equal(1, calls)
		assert.is_true(broker:Cancel(requestId))
		requestCallback({ item() })
		assert.are.equal(0, callbackCalls)
	end)

	it("validates import payload hashes before touching ItemsTab", function()
		local raw = "Rarity: Rare\nTitanium Spirit Shield"
		local valid = {
			slot = "Helmet",
			itemRaw = raw,
			itemHash = ItemImport.Hash(raw),
			source = "trade",
		}
		assert.is_true(ItemImport.Validate(valid))
		local invalid, err = ItemImport.Validate({ slot = "Helmet", itemRaw = raw, itemHash = string.rep("0", 64), source = "trade" })
		assert.is_nil(invalid)
		assert.matches("itemHash", err)
	end)
end)
