local Util = { }

local json = require("dkjson")

function Util.shallowCopy(value)
	local copy = { }
	for key, item in pairs(value or { }) do
		copy[key] = item
	end
	return copy
end

function Util.deepCopy(value, seen)
	if type(value) ~= "table" then
		return value
	end
	seen = seen or { }
	if seen[value] then
		return seen[value]
	end
	local copy = { }
	seen[value] = copy
	for key, item in pairs(value) do
		copy[Util.deepCopy(key, seen)] = Util.deepCopy(item, seen)
	end
	return setmetatable(copy, getmetatable(value))
end

function Util.isArray(value)
	if type(value) ~= "table" then
		return false
	end
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
			return false
		end
		count = count + 1
	end
	return count == #value
end

function Util.sortedKeys(value)
	local keys = { }
	for key in pairs(value or { }) do
		table.insert(keys, key)
	end
	table.sort(keys, function(left, right)
		return tostring(left) < tostring(right)
	end)
	return keys
end

function Util.now()
	if type(GetTime) == "function" then
		return GetTime()
	end
	return math.floor(os.clock() * 1000)
end

function Util.safeCall(method, object, ...)
	if type(method) ~= "function" then
		return nil, "unsupported interface"
	end
	local result = { pcall(method, object, ...) }
	if not result[1] then
		return nil, tostring(result[2])
	end
	return unpack(result, 2)
end

local function finiteNumber(value)
	return value == value and value ~= math.huge and value ~= -math.huge
end

-- Stable JSON encoding for fingerprints that cross the Lua/TypeScript seam.
-- Non-JSON values are represented as strings; cycles are rejected.
function Util.canonicalJSON(value, seen)
	local valueType = type(value)
	if value == nil then return "null" end
	if valueType == "boolean" then return value and "true" or "false" end
	if valueType == "number" then return finiteNumber(value) and string.format("%.17g", value) or "null" end
	if valueType == "string" then return json.encode(value) or "null" end
	if valueType ~= "table" then return json.encode(tostring(value)) or "null" end
	seen = seen or { }
	if seen[value] then error("canonical JSON contains a cycle") end
	seen[value] = true
	local isArray = Util.isArray(value)
	local parts = { }
	if isArray then
		for index = 1, #value do table.insert(parts, Util.canonicalJSON(value[index], seen)) end
	else
		for _, key in ipairs(Util.sortedKeys(value)) do
			table.insert(parts, (json.encode(tostring(key)) or "null") .. ":" .. Util.canonicalJSON(value[key], seen))
		end
	end
	seen[value] = nil
	return (isArray and "[" or "{") .. table.concat(parts, ",") .. (isArray and "]" or "}")
end

return Util
