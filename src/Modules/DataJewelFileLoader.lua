-- Path of Building
--
-- Module: Jewel Data File Loader
-- Loads compressed jewel data from one file or a numbered set of parts.
--
local t_concat = table.concat

local function defaultValidator(value)
	return type(value) == "string" and #value > 0
end

local function readValidated(path, validator)
	local file = io.open(path, "rb")
	if not file then return nil end
	local value = file:read("*a")
	file:close()
	if validator(value) then return value end
	return nil
end

local function writeCacheAtomically(path, value, validator)
	if not validator(value) then return nil, "jewel data validation failed" end
	local suffix = tostring(os.time()) .. "." .. tostring(math.random(1, 999999999))
	local temporaryPath = path .. ".tmp." .. suffix
	local file = io.open(temporaryPath, "wb")
	if not file then return nil, "cannot open temporary jewel cache" end
	local ok, err = file:write(value)
	if ok then file:flush() end
	file:close()
	if not ok then
		os.remove(temporaryPath)
		return nil, tostring(err)
	end
	if not readValidated(temporaryPath, validator) then
		os.remove(temporaryPath)
		return nil, "temporary jewel cache verification failed"
	end
	if readValidated(path, validator) then
		os.remove(temporaryPath)
		return true
	end
	-- The target is a generated cache. Remove only this exact invalid target so
	-- Windows can atomically promote the verified same-directory temporary file.
	os.remove(path)
	local renamed, renameErr = os.rename(temporaryPath, path)
	if not renamed then
		-- Another worker may have won the race. Accept only its verified result.
		if readValidated(path, validator) then
			os.remove(temporaryPath)
			return true
		end
		os.remove(temporaryPath)
		return nil, tostring(renameErr)
	end
	return true
end

local function loadJewelFile(jewelTypeName, cacheUncompressed, validator)
	local jewelPath = "/Data/TimelessJewelData/" .. jewelTypeName
	local scriptPath = GetScriptPath()
	validator = type(validator) == "function" and validator or defaultValidator
	if scriptPath == "" then
		-- The desktop app supplies its script folder. Headless tests may start in
		-- either the repository root or the src folder, so check both locations.
		local relativePath = "." .. jewelPath
		local file = io.open(relativePath .. ".zip", "rb") or io.open(relativePath .. ".zip.part0", "rb") or io.open(relativePath .. ".bin", "rb")
		if file then
			file:close()
			scriptPath = "."
		else
			scriptPath = "./src"
		end
	end
	cacheUncompressed = cacheUncompressed ~= false

	local uncompressedFileAttr = { }
	if cacheUncompressed then
		local fileHandle = NewFileSearch(scriptPath .. jewelPath .. ".bin")
		if fileHandle then
			uncompressedFileAttr.fileName = fileHandle:GetFileName()
			uncompressedFileAttr.modified = fileHandle:GetFileModifiedTime()
		end
	end

	local compressedFileAttr = { }
	local fileHandle = NewFileSearch(scriptPath .. jewelPath .. ".zip")
	if fileHandle then
		compressedFileAttr.modified = fileHandle:GetFileModifiedTime()
	end
	fileHandle = NewFileSearch(scriptPath .. jewelPath .. ".zip.part*")
	if fileHandle then
		compressedFileAttr.modified = fileHandle:GetFileModifiedTime()
	end

	if uncompressedFileAttr.modified and uncompressedFileAttr.modified > (compressedFileAttr.modified or 0) then
		ConPrintf("Uncompressed jewel data is up-to-date, loading " .. uncompressedFileAttr.fileName)
		local jewelData = readValidated(scriptPath .. jewelPath .. ".bin", validator)
		if jewelData then return jewelData end
		ConPrintf("Rejected invalid uncompressed jewel cache " .. scriptPath .. jewelPath .. ".bin")
	end

	if cacheUncompressed then
		ConPrintf("Failed to load " .. scriptPath .. jewelPath .. ".bin, or data is out of date, falling back to compressed file")
	end
	local compressedFile = io.open(scriptPath .. jewelPath .. ".zip", "rb")
	local compressedData
	if compressedFile then
		compressedData = compressedFile:read("*a")
		compressedFile:close()
	else
		local splitFile = { }
		local part = 0
		while true do
			local file = io.open(scriptPath .. jewelPath .. ".zip.part" .. part, "rb")
			if not file then
				break
			end
			splitFile[part + 1] = file:read("*a")
			file:close()
			part = part + 1
		end
		compressedData = t_concat(splitFile, "")
	end

	if not compressedData or compressedData == "" then
		ConPrintf("Failed to load jewel data: " .. jewelTypeName)
		return
	end

	local inflateOk, jewelData = pcall(Inflate, compressedData)
	if not inflateOk or not validator(jewelData) then
		ConPrintf("Failed to validate inflated jewel data: " .. jewelTypeName)
		return
	end
	if cacheUncompressed then
		local wrote, writeErr = writeCacheAtomically(scriptPath .. jewelPath .. ".bin", jewelData, validator)
		if not wrote then ConPrintf("Failed to publish jewel cache: " .. tostring(writeErr)) end
	end
	return jewelData
end

return loadJewelFile
