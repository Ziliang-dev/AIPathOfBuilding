local Util = { }

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

return Util
