-- Main-process Trade/catalog broker.
--
-- The broker owns the Trade request barrier and the short-lived result cache.
-- It deliberately returns a small, typed catalog record: seller identity,
-- whispers, listing IDs, auth tokens, URLs, and rate-limit headers never leave
-- this module.

local dkjson = require("dkjson")
local sha = require("sha2")

local TradeBroker = {
	SCHEMA_VERSION = 1,
	DEFAULT_MAX_RESULTS = 10,
	DEFAULT_MAX_QUERIES = 18,
	DEFAULT_MAX_QUERY_LENGTH = 128 * 1024,
	DEFAULT_MAX_RAW_LENGTH = 32 * 1024,
	DEFAULT_CACHE_TTL_MS = 30 * 1000,
	DEFAULT_DEADLINE_MS = 30 * 1000,
}
TradeBroker.__index = TradeBroker

local realms = { pc = true, xbox = true, sony = true }
local fixedPriceTypes = { ["~b/o"] = true, ["fixed"] = true, ["buyout"] = true }
local typedCategories = {
	["armour.helmet"] = true, ["armour.chest"] = true, ["armour.gloves"] = true,
	["armour.boots"] = true, ["accessory.amulet"] = true,
	["accessory.ring"] = true, ["accessory.belt"] = true,
}
local typedRarities = { unique = true, rare = true, nonunique = true }

local function nowMs()
	if type(GetTime) == "function" then return tonumber(GetTime()) or 0 end
	return os.time() * 1000
end

local function finiteNumber(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function clone(value, seen)
	if type(value) ~= "table" then return value end
	seen = seen or { }
	if seen[value] then return seen[value] end
	local copy = { }
	seen[value] = copy
	for key, item in pairs(value) do copy[clone(key, seen)] = clone(item, seen) end
	return copy
end

local function jsonString(value)
	local encoded = dkjson.encode(value)
	return encoded or "null"
end

-- dkjson preserves insertion order.  Query objects can be assembled by UI and
-- RPC callers in different orders, so cache keys use a small canonical encoder.
local function canonical(value, seen)
	local valueType = type(value)
	if value == nil then return "null" end
	if valueType == "boolean" then return value and "true" or "false" end
	if valueType == "number" then
		if not finiteNumber(value) then return "null" end
		return string.format("%.17g", value)
	end
	if valueType == "string" then return jsonString(value) end
	if valueType ~= "table" then return jsonString(tostring(value)) end
	seen = seen or { }
	if seen[value] then error("trade query contains a cycle") end
	seen[value] = true
	local isArray = true
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then isArray = false break end
		count = math.max(count, key)
	end
	if isArray then
		for index = 1, count do if value[index] == nil then isArray = false break end end
	end
	local parts = { }
	if isArray then
		for index = 1, count do table.insert(parts, canonical(value[index], seen)) end
	else
		local keys = { }
		for key in pairs(value) do table.insert(keys, key) end
		table.sort(keys, function(left, right) return tostring(left) < tostring(right) end)
		for _, key in ipairs(keys) do
			table.insert(parts, jsonString(tostring(key)) .. ":" .. canonical(value[key], seen))
		end
	end
	seen[value] = nil
	return (isArray and "[" or "{") .. table.concat(parts, ",") .. (isArray and "]" or "}")
end

local function errorObject(code, message, extra)
	local result = { code = code, message = message }
	for key, value in pairs(extra or { }) do result[key] = value end
	return result
end

local function errorText(value)
	if type(value) == "table" and type(value.message) == "string" then return value.message end
	return tostring(value or "Trade broker failed")
end

local function validText(value, maxLength)
	return type(value) == "string" and #value > 0 and #value <= maxLength
		and not value:find("[%z\r\n]", 1)
end

local function normalizePriceType(value)
	if value == nil then return nil end
	if type(value) ~= "string" then return nil end
	return string.lower(value)
end

local function normalizeUpstreamError(value)
	if type(value) == "table" and type(value.code) == "string" and type(value.message) == "string" then
		return value
	end
	local text = errorText(value)
	local lower = string.lower(text)
	if lower:find("429", 1, true) or lower:find("rate", 1, true) then
		return errorObject("trade_rate_limited", "Trade rate limit reached")
	end
	if lower:find("401", 1, true) or lower:find("invalid_token", 1, true) or lower:find("authorization", 1, true) then
		return errorObject("trade_auth_required", "Trade authorization is required")
	end
	if lower:find("cancel", 1, true) then return errorObject("cancelled", "Trade query cancelled") end
	return errorObject("trade_unavailable", "Trade request failed")
end

local function callbackOnce(callback, ...)
	if type(callback) == "function" then pcall(callback, ...) end
end

local function defaultConverter(currency, amount)
	if string.lower(currency) == "divine" then return amount end
	return nil
end

local function validateId(value, name)
	if value == nil then return true end
	if type(value) ~= "string" or #value == 0 or #value > 128 or value:find("[%z\r\n]", 1) then
		return nil, name .. " is invalid"
	end
	return true
end

--- Build the upstream query only inside the authenticated PoB process.  The
--- sidecar supplies bounded semantic constraints, never arbitrary query JSON.
function TradeBroker.BuildTypedQuery(constraints)
	if type(constraints) ~= "table" or not typedCategories[constraints.category] then
		return nil, errorObject("invalid_query", "Trade category is unsupported")
	end
	if constraints.rarity ~= nil and not typedRarities[constraints.rarity] then
		return nil, errorObject("invalid_query", "Trade rarity is unsupported")
	end
	if constraints.baseType ~= nil and not validText(constraints.baseType, 256) then
		return nil, errorObject("invalid_query", "Trade base type is invalid")
	end
	if constraints.minItemLevel ~= nil and (not finiteNumber(constraints.minItemLevel)
		or constraints.minItemLevel % 1 ~= 0 or constraints.minItemLevel < 1 or constraints.minItemLevel > 100) then
		return nil, errorObject("invalid_query", "Trade item level is invalid")
	end
	local stats = { }
	for _, filter in ipairs(constraints.statFilters or { }) do
		if type(filter) ~= "table" or not validText(filter.id, 256)
			or not filter.id:match("^[%w%._:%-]+$") then
			return nil, errorObject("invalid_query", "Trade stat filter is invalid")
		end
		if filter.min ~= nil and not finiteNumber(filter.min) then return nil, errorObject("invalid_query", "Trade stat minimum is invalid") end
		if filter.max ~= nil and not finiteNumber(filter.max) then return nil, errorObject("invalid_query", "Trade stat maximum is invalid") end
		if filter.min ~= nil and filter.max ~= nil and filter.min > filter.max then
			return nil, errorObject("invalid_query", "Trade stat range is invalid")
		end
		table.insert(stats, { id = filter.id, value = { min = filter.min, max = filter.max } })
	end
	local query = {
		query = {
			status = { option = "online" },
			filters = {
				type_filters = { filters = {
					category = { option = constraints.category },
					rarity = constraints.rarity and { option = constraints.rarity } or nil,
				} },
				misc_filters = { filters = {
					corrupted = constraints.corrupted ~= nil and { option = constraints.corrupted and "true" or "false" } or nil,
					ilvl = constraints.minItemLevel and { min = constraints.minItemLevel } or nil,
				} },
			},
			stats = #stats > 0 and { { type = "and", filters = stats } } or { },
		},
		sort = { price = "asc" },
	}
	if constraints.baseType then query.query.type = constraints.baseType end
	local encoded = dkjson.encode(query)
	if type(encoded) ~= "string" then return nil, errorObject("invalid_query", "Trade query could not be encoded") end
	return encoded
end

function TradeBroker.new(options)
	options = options or { }
	local self = setmetatable({
		requests = options.requests,
		rateLimiter = options.rateLimiter,
		currencyToDivine = options.currencyToDivine or defaultConverter,
		maxResults = math.max(1, math.min(tonumber(options.maxResults) or TradeBroker.DEFAULT_MAX_RESULTS, 100)),
		maxQueries = math.max(1, math.min(tonumber(options.maxQueries) or TradeBroker.DEFAULT_MAX_QUERIES, 64)),
		maxQueryLength = math.max(1024, tonumber(options.maxQueryLength) or TradeBroker.DEFAULT_MAX_QUERY_LENGTH),
		maxRawLength = math.max(1024, tonumber(options.maxRawLength) or TradeBroker.DEFAULT_MAX_RAW_LENGTH),
		cacheTtlMs = math.max(0, tonumber(options.cacheTtlMs) or TradeBroker.DEFAULT_CACHE_TTL_MS),
		deadlineMs = math.max(1000, tonumber(options.deadlineMs) or TradeBroker.DEFAULT_DEADLINE_MS),
		fixedPriceTypes = options.fixedPriceTypes or fixedPriceTypes,
		cache = { },
		inflightByKey = { },
		active = { },
		completed = { },
		barriers = { },
		nextRequestId = 1,
		nextBarrierId = 1,
	}, TradeBroker)
	if not self.requests then
		if not self.rateLimiter and type(main) == "table" and main.api then self.rateLimiter = main.api.rateLimiter end
		if not self.rateLimiter and type(new) == "function" then self.rateLimiter = new("TradeQueryRateLimiter"):TradeQueryRateLimiter() end
		if type(new) == "function" then self.requests = new("TradeQueryRequests"):TradeQueryRequests(self.rateLimiter) end
	end
	return self
end

function TradeBroker:ValidateQuery(spec)
	if type(spec) ~= "table" then return nil, errorObject("invalid_query", "Trade query must be an object") end
	if not realms[spec.realm] then return nil, errorObject("invalid_query", "Trade realm is invalid") end
	if not validText(spec.league, 96) then return nil, errorObject("invalid_query", "Trade league is invalid") end
	if not validText(spec.slot, 96) then return nil, errorObject("invalid_query", "Trade slot is invalid") end
	if type(spec.query) ~= "string" or #spec.query == 0 or #spec.query > self.maxQueryLength then
		return nil, errorObject("invalid_query", "Trade query JSON is invalid")
	end
	if spec.query:find("%z", 1) then return nil, errorObject("invalid_query", "Trade query JSON contains a NUL byte") end
	local query, _, decodeErr = dkjson.decode(spec.query, 1, nil)
	if decodeErr or type(query) ~= "table" then return nil, errorObject("invalid_query", "Trade query JSON is malformed") end
	if spec.budgetDivine == nil or not finiteNumber(spec.budgetDivine) or spec.budgetDivine < 0 then
		return nil, errorObject("budget_required", "Trade queries require a finite Divine budget")
	end
	if spec.itemSetId ~= nil and (type(spec.itemSetId) ~= "number" or spec.itemSetId % 1 ~= 0 or spec.itemSetId < 1) then
		return nil, errorObject("invalid_query", "itemSetId must be a positive integer")
	end
	if spec.maxResults ~= nil and (type(spec.maxResults) ~= "number" or spec.maxResults % 1 ~= 0 or spec.maxResults < 1 or spec.maxResults > self.maxResults) then
		return nil, errorObject("invalid_query", "maxResults exceeds the broker limit")
	end
	local idOk, idErr = validateId(spec.requestId, "requestId")
	if not idOk then return nil, errorObject("invalid_query", idErr) end
	idOk, idErr = validateId(spec.idempotencyKey, "idempotencyKey")
	if not idOk then return nil, errorObject("invalid_query", idErr) end
	return { query = query, queryText = spec.query }
end

function TradeBroker:QueryHash(spec, decodedQuery)
	local query = decodedQuery
	if query == nil then
		local validated, validationErr = self:ValidateQuery(spec)
		if not validated then return nil, validationErr end
		query = validated.query
	end
	return sha.sha256(canonical({
		realm = spec.realm,
		league = spec.league,
		slot = spec.slot,
		query = query,
		ruleset = spec.ruleset,
	}))
end

function TradeBroker:CacheKey(spec, queryHash)
	return sha.sha256(canonical({
		queryHash = queryHash,
		budgetDivine = spec.budgetDivine,
		maxResults = spec.maxResults or self.maxResults,
		pricePolicy = "fixed-divine-v1",
	}))
end

local function ceilPrice(value)
	-- Four decimal places are sufficient for budget comparison while always
	-- rounding against the user (never under-reporting cost).
	return math.ceil((value * 10000) - 1e-9) / 10000
end

function TradeBroker:NormalizeResults(items, spec, queryHash)
	if type(items) ~= "table" then return nil, errorObject("trade_invalid_response", "Trade result set is malformed") end
	if type(spec) ~= "table" or not finiteNumber(spec.budgetDivine) or spec.budgetDivine < 0 then
		return nil, errorObject("budget_required", "Trade queries require a finite Divine budget")
	end
	if not queryHash then
		local computedHash, hashErr = self:QueryHash(spec)
		if not computedHash then return nil, hashErr end
		queryHash = computedHash
	end
	local output, seen = { }, { }
	local maximum = math.min(spec.maxResults or self.maxResults, self.maxResults)
	for _, raw in ipairs(items) do
		if #output >= maximum then break end
		if type(raw) == "table" then
			local itemRaw = raw.itemRaw or raw.item_string
			local amount, currency = raw.amount, raw.currency
			local priceType = normalizePriceType(raw.priceType or raw.price_type)
			if type(itemRaw) == "string" and #itemRaw > 0 and #itemRaw <= self.maxRawLength
				and not itemRaw:find("%z", 1)
				and finiteNumber(amount) and amount > 0
				and type(currency) == "string" and #currency > 0 and #currency <= 32
				and priceType and self.fixedPriceTypes[priceType]
			then
				currency = string.lower(currency)
				local ok, divine = pcall(self.currencyToDivine, currency, amount, spec)
				if ok and finiteNumber(divine) and divine >= 0 then
					divine = ceilPrice(divine)
					if divine <= spec.budgetDivine then
						local itemHash = sha.sha256(itemRaw)
						local dedupeKey = itemHash .. ":" .. tostring(divine) .. ":" .. currency
						if not seen[dedupeKey] then
							seen[dedupeKey] = true
							local priceHash = sha.sha256(dedupeKey)
							local weight = finiteNumber(tonumber(raw.weight)) and tonumber(raw.weight) or nil
							table.insert(output, {
								id = "trade:" .. queryHash:sub(1, 20) .. ":" .. priceHash:sub(1, 20),
								domain = "gear",
								kind = "tradeItem",
								available = true,
								source = "trade",
								slot = spec.slot,
								itemSetId = spec.itemSetId,
								itemRaw = itemRaw,
								itemHash = itemHash,
								queryHash = queryHash,
								league = spec.league,
								realm = spec.realm,
								price = { amount = amount, currency = currency, divineEquivalent = divine },
								weight = weight,
							})
						end
					end
				end
			end
		end
	end
	return output
end

function TradeBroker:SanitizeResult(raw, spec, queryHash)
	local result, err = self:NormalizeResults({ raw }, spec, queryHash)
	if not result then return nil, err end
	if not result[1] then return nil, errorObject("trade_item_rejected", "Trade item did not satisfy fixed-price/budget policy") end
	return result[1]
end

function TradeBroker:_newRequestId(spec)
	if type(spec) ~= "table" then spec = { } end
	local id = spec.requestId or spec.idempotencyKey
	if id then return id end
	id = "trade-request-" .. tostring(self.nextRequestId)
	self.nextRequestId = self.nextRequestId + 1
	return id
end

function TradeBroker:_finishSubscriber(state, subscriber, result, err)
	if subscriber.done then return end
	subscriber.done = true
	self.active[subscriber.id] = nil
	if not subscriber.cancelled then
		self.completed[subscriber.id] = { key = state.key, result = clone(result), error = clone(err), expiresAt = nowMs() + self.cacheTtlMs }
		for _, callback in ipairs(subscriber.callbacks or { subscriber.callback }) do
			callbackOnce(callback, clone(result), clone(err), subscriber.id)
		end
	end
	state.remaining = state.remaining - 1
end

function TradeBroker:_finishState(state, items, upstreamErr)
	if state.done then return end
	state.done = true
	if self.inflightByKey[state.key] == state then self.inflightByKey[state.key] = nil end
	local result, err
	if state.cancelled then
		err = errorObject("cancelled", "Trade query cancelled")
	elseif upstreamErr then
		err = normalizeUpstreamError(upstreamErr)
	else
		result, err = self:NormalizeResults(items, state.spec, state.queryHash)
	end
	local anyLive = false
	for _, subscriber in ipairs(state.subscribers) do if not subscriber.cancelled then anyLive = true break end end
	if result and anyLive and self.cacheTtlMs > 0 then
		self.cache[state.key] = { result = clone(result), expiresAt = nowMs() + self.cacheTtlMs }
	end
	for _, subscriber in ipairs(state.subscribers) do self:_finishSubscriber(state, subscriber, result, err) end
end

function TradeBroker:Search(spec, callback)
	local validated, validationErr = self:ValidateQuery(spec)
	if not validated then
		local id = self:_newRequestId(spec or { })
		callbackOnce(callback, nil, validationErr, id)
		return id, validationErr
	end
	spec = clone(spec)
	local requestId = self:_newRequestId(spec)
	local queryHash = self:QueryHash(spec, validated.query)
	local key = self:CacheKey(spec, queryHash)
	local existingActive = self.active[requestId]
	if existingActive and not existingActive.done then
		if existingActive.key ~= key then
			local conflict = errorObject("idempotency_conflict", "requestId was reused for a different Trade query")
			callbackOnce(callback, nil, conflict, requestId)
			return requestId, conflict
		end
		if type(callback) == "function" then
			existingActive.callbacks = existingActive.callbacks or { existingActive.callback }
			table.insert(existingActive.callbacks, callback)
		end
		return requestId
	end
	local completed = self.completed[requestId]
	if completed and completed.expiresAt >= nowMs() then
		if completed.key ~= key then
			local conflict = errorObject("idempotency_conflict", "requestId was reused for a different Trade query")
			callbackOnce(callback, nil, conflict, requestId)
			return requestId, conflict
		end
		callbackOnce(callback, clone(completed.result), clone(completed.error), requestId)
		return requestId
	end
	self.completed[requestId] = nil
	local cached = self.cache[key]
	if cached and cached.expiresAt >= nowMs() then
		self.completed[requestId] = { key = key, result = clone(cached.result), expiresAt = cached.expiresAt }
		callbackOnce(callback, clone(cached.result), nil, requestId)
		return requestId
	end
	if cached then self.cache[key] = nil end
	local subscriber = { id = requestId, key = key, callback = callback, callbacks = { }, cancelled = false, done = false }
	if type(callback) == "function" then table.insert(subscriber.callbacks, callback) end
	self.active[requestId] = subscriber
	local state = self.inflightByKey[key]
	if state then
		table.insert(state.subscribers, subscriber)
		state.remaining = state.remaining + 1
		return requestId
	end
	state = {
		key = key,
		spec = spec,
		queryHash = queryHash,
		subscribers = { subscriber },
		remaining = 1,
		cancelled = false,
		done = false,
		startedAt = nowMs(),
		deadlineAt = nowMs() + self.deadlineMs,
	}
	self.inflightByKey[key] = state
	if not self.requests then
		self:_finishState(state, nil, errorObject("trade_unavailable", "Trade request queue is unavailable"))
		return requestId
	end
	local function response(items, err)
		-- Ignore late callbacks after cancellation/settlement.  In particular,
		-- never populate cache from a request whose only subscriber was cancelled.
		if state.done then return end
		if nowMs() >= state.deadlineAt then
			self:_finishState(state, nil, errorObject("trade_timeout", "Trade query deadline exceeded"))
			return
		end
		self:_finishState(state, items, err)
	end
	local ok, callErr = pcall(function()
		if type(self.requests.SearchWithQueryWeightAdjusted) == "function" then
			self.requests:SearchWithQueryWeightAdjusted(spec.realm, spec.league, spec.query, response)
		elseif type(self.requests.SearchWithQuery) == "function" then
			self.requests:SearchWithQuery(spec.realm, spec.league, spec.query, response)
		else
			error("Trade request queue has no search method")
		end
	end)
	if not ok then response(nil, callErr) end
	return requestId
end

--- Advance broker deadlines.  Call from the PoB on-frame loop alongside the
--- existing TradeQueryRequests queue.  In-flight HTTP callbacks are ignored
--- after this method settles a state.
function TradeBroker:OnFrame()
	local now = nowMs()
	local states = { }
	for _, state in pairs(self.inflightByKey) do table.insert(states, state) end
	for _, state in ipairs(states) do
		if not state.done and now >= state.deadlineAt then
			self:_finishState(state, nil, errorObject("trade_timeout", "Trade query deadline exceeded"))
		end
	end
	for requestId, completed in pairs(self.completed) do
		if completed.expiresAt < now then self.completed[requestId] = nil end
	end
	for key, cached in pairs(self.cache) do
		if cached.expiresAt < now then self.cache[key] = nil end
	end
end

function TradeBroker:Cancel(requestId)
	local barrier = self.barriers[requestId]
	if barrier then
		if barrier.done then return false end
		barrier.cancelled = true
		for _, childId in ipairs(barrier.children) do self:Cancel(childId) end
		barrier.done = true
		self.barriers[requestId] = nil
		callbackOnce(barrier.callback, nil, errorObject("cancelled", "Trade query barrier cancelled"), requestId)
		return true
	end
	local subscriber = self.active[requestId]
	if not subscriber or subscriber.done then return false end
	subscriber.cancelled = true
	self.active[requestId] = nil
	for _, state in pairs(self.inflightByKey) do
		for _, candidate in ipairs(state.subscribers) do
			if candidate == subscriber then
				if not state.done then
					local allCancelled = true
					for _, entry in ipairs(state.subscribers) do if not entry.cancelled then allCancelled = false break end end
					if allCancelled then state.cancelled = true end
				end
				break
			end
		end
	end
	return true
end

function TradeBroker:QueryBarrier(specs, callback)
	if type(specs) ~= "table" or #specs == 0 or #specs > self.maxQueries then
		local id = "trade-barrier-" .. tostring(self.nextBarrierId)
		self.nextBarrierId = self.nextBarrierId + 1
		callbackOnce(callback, nil, errorObject("invalid_query", "Trade query barrier size is invalid"), id)
		return id
	end
	local barrierId = "trade-barrier-" .. tostring(self.nextBarrierId)
	self.nextBarrierId = self.nextBarrierId + 1
	local barrier = {
		id = barrierId,
		callback = callback,
		children = { },
		results = { },
		pending = #specs,
		done = false,
		cancelled = false,
	}
	self.barriers[barrierId] = barrier
	local function finishIfReady()
		if barrier.done or barrier.pending > 0 then return end
		barrier.done = true
		self.barriers[barrierId] = nil
		if barrier.error then callbackOnce(callback, nil, barrier.error, barrierId)
		else callbackOnce(callback, barrier.results, nil, barrierId) end
	end
	for index, rawSpec in ipairs(specs) do
		local spec = clone(rawSpec)
		if type(spec) ~= "table" then
			barrier.error = errorObject("invalid_query", "Trade barrier member is invalid")
			barrier.pending = barrier.pending - 1
		else
			spec.requestId = spec.requestId or (barrierId .. ":" .. tostring(index))
			local childId = self:Search(spec, function(result, err, requestId)
				if barrier.done then return end
				if err and not barrier.error then barrier.error = err end
				if result then barrier.results[requestId or spec.requestId] = clone(result) end
				barrier.pending = barrier.pending - 1
				finishIfReady()
			end)
			table.insert(barrier.children, childId)
		end
	end
	finishIfReady()
	return barrierId
end

TradeBroker.Barrier = TradeBroker.QueryBarrier

function TradeBroker:GetCached(spec)
	local valid, validationErr = self:ValidateQuery(spec)
	if not valid then return nil, validationErr end
	local queryHash = self:QueryHash(spec, valid.query)
	local key = self:CacheKey(spec, queryHash)
	local cached = self.cache[key]
	if not cached or cached.expiresAt < nowMs() then
		self.cache[key] = nil
		return nil
	end
	return clone(cached.result), nil
end

function TradeBroker:ClearCache()
	self.cache = { }
	self.completed = { }
end

return TradeBroker
