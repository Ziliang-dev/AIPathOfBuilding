-- Transaction-safe import/equip helper for externally sourced item text.
--
-- This module deliberately does not touch display-item controls or the undo
-- stack.  BuildAction/Transaction owns the surrounding snapshot and rollback;
-- this helper only mutates ItemsTab after all structural checks pass.

local sha = require("sha2")

local ItemImport = {
	MAX_RAW_LENGTH = 32 * 1024,
}

local allowedSources = {
	trade = true,
	unique = true,
	targetRare = true,
	currentBuild = true,
	seasonal = true,
}

local function invalid(message)
	return nil, message
end

local function isPositiveInteger(value)
	return type(value) == "number" and value % 1 == 0 and value > 0
end

local function isValidSlot(slot)
	return type(slot) == "string"
		and #slot > 0
		and #slot <= 96
		and not slot:find("[%z\r\n]", 1)
end

local function isValidHash(value)
	return type(value) == "string" and value:match("^[0-9a-fA-F]+$") ~= nil and #value == 64
end

local function rawText(payload)
	return payload.itemRaw or payload.raw or payload.item_string
end

function ItemImport.Hash(raw)
	if type(raw) ~= "string" then return nil end
	return sha.sha256(raw)
end

function ItemImport.Validate(payload, options)
	options = options or { }
	if type(payload) ~= "table" then return invalid("item import payload must be an object") end
	if not isValidSlot(payload.slot) then return invalid("item import slot is invalid") end
	if payload.itemSetId ~= nil and not isPositiveInteger(payload.itemSetId) then
		return invalid("itemSetId must be a positive integer")
	end
	local itemRaw = rawText(payload)
	if type(itemRaw) ~= "string" or itemRaw == "" then
		return invalid("itemRaw is required")
	end
	if #itemRaw > (options.maxRawLength or ItemImport.MAX_RAW_LENGTH) then
		return invalid("itemRaw exceeds the maximum length")
	end
	if itemRaw:find("%z", 1) then return invalid("itemRaw contains a NUL byte") end
	if not isValidHash(payload.itemHash) then return invalid("itemHash must be a SHA-256 hex digest") end
	if ItemImport.Hash(itemRaw):lower() ~= payload.itemHash:lower() then
		return invalid("itemHash does not match itemRaw")
	end
	if payload.source ~= nil and (type(payload.source) ~= "string" or not allowedSources[payload.source]) then
		return invalid("item import source is invalid")
	end
	if options.requireSource and payload.source ~= options.requireSource then
		return invalid("item import source is not allowed")
	end
	if payload.catalogId ~= nil and (type(payload.catalogId) ~= "string" or #payload.catalogId == 0 or #payload.catalogId > 256) then
		return invalid("catalogId is invalid")
	end
	if payload.price ~= nil then
		if type(payload.price) ~= "table" then return invalid("price must be an object") end
		if type(payload.price.amount) ~= "number" or payload.price.amount <= 0 or payload.price.amount ~= payload.price.amount then
			return invalid("price amount is invalid")
		end
		if type(payload.price.currency) ~= "string" or payload.price.currency == "" or #payload.price.currency > 32 then
			return invalid("price currency is invalid")
		end
		if type(payload.price.divineEquivalent) ~= "number"
			or payload.price.divineEquivalent < 0
			or payload.price.divineEquivalent ~= payload.price.divineEquivalent
		then
			return invalid("price divineEquivalent is invalid")
		end
	end
	return true
end

local function findExistingItem(itemsTab, itemHash)
	for id, item in pairs(itemsTab.items or { }) do
		if type(item) == "table" and type(item.raw) == "string" and ItemImport.Hash(item.raw):lower() == itemHash:lower() then
			return id, item
		end
	end
end

function ItemImport.FindByHash(itemsTab, itemHash)
	if type(itemsTab) ~= "table" or not isValidHash(itemHash) then return nil end
	return findExistingItem(itemsTab, itemHash)
end

local function removeInsertedItem(itemsTab, item)
	if not item or not item.id then return end
	if itemsTab.items and itemsTab.items[item.id] == item then itemsTab.items[item.id] = nil end
	for index = #(itemsTab.itemOrderList or { }), 1, -1 do
		if itemsTab.itemOrderList[index] == item.id then
			table.remove(itemsTab.itemOrderList, index)
			break
		end
	end
end

local function setSelected(slot, itemId)
	if type(slot.SetSelItemId) == "function" then
		slot:SetSelItemId(itemId)
	else
		slot.selItemId = itemId
	end
end

--- Import raw PoB item text, then equip it in an exact slot/item set.
--- Returns a result table or nil,error. No UI display item or undo state is touched.
function ItemImport.ImportAndEquip(itemsTab, payload, options)
	options = options or { }
	if type(itemsTab) ~= "table" then return invalid("items tab is required") end
	local valid, validationErr = ItemImport.Validate(payload, options)
	if not valid then return nil, validationErr end
	if type(itemsTab.items) ~= "table" or type(itemsTab.itemSets) ~= "table" then
		return invalid("items tab does not support item sets")
	end

	local itemSetId = payload.itemSetId or itemsTab.activeItemSetId
	local itemSet = itemsTab.itemSets[itemSetId]
	if not itemSet then return invalid("item set does not exist: " .. tostring(itemSetId)) end
	local slot = itemsTab.slots and itemsTab.slots[payload.slot]
	if not slot then return invalid("item slot does not exist: " .. tostring(payload.slot)) end
	if itemSetId ~= itemsTab.activeItemSetId and not itemSet[payload.slot] then
		return invalid("slot is not available in item set")
	end

	local itemRaw = rawText(payload)
	local item = new("Item"):Item(itemRaw)
	if not item or not item.base then return invalid("itemRaw could not be parsed by PoB") end
	if type(itemsTab.IsItemValidForSlot) == "function" and not itemsTab:IsItemValidForSlot(item, payload.slot, itemSet) then
		return invalid("item is invalid for slot: " .. payload.slot)
	end

	-- Re-applying an action after a retry should equip the already imported item,
	-- rather than append a duplicate with a new ID.
	local existingId, existing = findExistingItem(itemsTab, payload.itemHash)
	if existingId then
		if type(itemsTab.IsItemValidForSlot) == "function" and not itemsTab:IsItemValidForSlot(existing, payload.slot, itemSet) then
			return invalid("existing item is invalid for slot: " .. payload.slot)
		end
		local previousActive = slot.selItemId
		local previousSet = itemSet[payload.slot] and itemSet[payload.slot].selItemId
		local ok, err = pcall(function()
			if itemSetId == itemsTab.activeItemSetId then setSelected(slot, existingId)
			else itemSet[payload.slot].selItemId = existingId end
			if type(itemsTab.PopulateSlots) == "function" then itemsTab:PopulateSlots() end
			itemsTab.build.buildFlag = true
		end)
		if not ok then
			if itemSetId == itemsTab.activeItemSetId then slot.selItemId = previousActive
			elseif itemSet[payload.slot] then itemSet[payload.slot].selItemId = previousSet end
			return invalid("item equip failed: " .. tostring(err))
		end
		return { item = existing, itemId = existingId, itemSetId = itemSetId, slot = payload.slot, reused = true }
	end

	-- Force allocator path. A parsed item must never overwrite an existing item ID.
	item.id = nil
	local oldBuildFlag = itemsTab.build and itemsTab.build.buildFlag
	local previousActive = slot.selItemId
	local previousSet = itemSet[payload.slot] and itemSet[payload.slot].selItemId
	local added = false
	local ok, err = pcall(function()
		if type(itemsTab.AddItem) ~= "function" then error("items tab cannot add items") end
		-- AddItem can assign an ID before BuildModList raises.  Mark the attempt
		-- before calling it so cleanup removes any partially inserted item.
		added = true
		itemsTab:AddItem(item, true)
		if not item.id then error("item ID allocation failed") end
		if itemSetId == itemsTab.activeItemSetId then setSelected(slot, item.id)
		else itemSet[payload.slot].selItemId = item.id end
		if type(itemsTab.PopulateSlots) == "function" then itemsTab:PopulateSlots() end
		itemsTab.build.buildFlag = true
	end)
	if not ok then
		if itemSetId == itemsTab.activeItemSetId then slot.selItemId = previousActive
		elseif itemSet[payload.slot] then itemSet[payload.slot].selItemId = previousSet end
		if added then removeInsertedItem(itemsTab, item) end
		if itemsTab.build then itemsTab.build.buildFlag = oldBuildFlag end
		return invalid("item import/equip failed: " .. tostring(err))
	end
	return { item = item, itemId = item.id, itemSetId = itemSetId, slot = payload.slot, reused = false }
end

return ItemImport
