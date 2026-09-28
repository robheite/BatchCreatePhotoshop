#target photoshop

/*
 * IAWOA Batch Name Creation
 * Reusable CSV-to-layer batch export for Adobe Photoshop.
 *
 * Layer conventions (all can be overridden in the mapping dialog):
 *   - Name a text layer exactly like a CSV header to auto-map its contents.
 *   - Prefix any layer/group with [show:Header] to show it for truthy values.
 *   - Prefix any layer/group with [show:Header=Value] to show it on an exact match.
 *
 * Export settings intentionally match IAWOA Batch Export.jsx:
 *   full PNG, trimmed PNG, flattened PDF, and optional tiled-watermark JPG proof.
 */

if (typeof app !== "undefined") {
    app.bringToFront();
}

var IAWOA_VERSION = "2.2.1";
var IAWOA_SETTINGS_FOLDER_NAME = "IAWOA Batch Name Creation";
var IAWOA_SETTINGS_FILE_NAME = "settings.json";
var IAWOA_JPG_QUALITY = 3;
var IAWOA_JPG_RESIZE_PERCENT = 30;

function main() {
    if (app.documents.length === 0) {
        alert("Open the Photoshop template you want to batch before running this script.");
        return;
    }

    var doc = app.activeDocument;
    var csvFile = File.openDialog("Select a CSV file with a header row", "CSV files:*.csv;All files:*.*");
    if (!csvFile) {
        return;
    }

    var parsed;
    try {
        parsed = readCSVFile(csvFile);
        validateCSV(parsed);
    } catch (e) {
        alert("The CSV could not be used.\n\n" + formatError(e));
        return;
    }

    var inventory = scanDocument(doc);
    if (inventory.textLayers.length === 0) {
        alert("The active document does not contain any editable text layers.");
        return;
    }

    var textMappings = createAutomaticTextMappings(inventory.textLayers, parsed.headers);
    var textFitRules = createDefaultTextFitRules(inventory.textLayers);
    var visibilityRules = createAutomaticVisibilityRules(inventory.allLayers, parsed.headers);
    var options = showMappingDialog(doc, csvFile, parsed, inventory, textMappings, textFitRules, visibilityRules);
    if (!options) {
        return;
    }

    if (options.proofJPG) {
        try {
            options.watermarkFile = resolveWatermarkFile();
        } catch (watermarkError) {
            alert("The watermark setting could not be saved.\n\n" + formatError(watermarkError));
            return;
        }
        if (!options.watermarkFile) {
            alert("No watermark was selected. Nothing was exported.");
            return;
        }
    }

    try {
        preflightBatch(parsed, options);
    } catch (e2) {
        alert("Nothing was exported.\n\n" + formatError(e2));
        return;
    }

    var originalDocument = app.activeDocument;
    var workingDocument = null;
    var result;

    try {
        workingDocument = doc.duplicate();
        app.activeDocument = workingDocument;
        var workingInventory = scanDocument(workingDocument);
        if (workingInventory.textLayers.length !== inventory.textLayers.length ||
                workingInventory.allLayers.length !== inventory.allLayers.length) {
            throw new Error("The working document layer inventory does not match the master template.");
        }
        result = processBatch(workingDocument, parsed, workingInventory, options);
    } catch (e3) {
        result = {
            completed: 0,
            skipped: 0,
            errors: ["Batch stopped: " + formatError(e3)]
        };
    } finally {
        if (workingDocument) {
            try { workingDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (ignored1) {}
        }
        try { app.activeDocument = originalDocument; } catch (ignored2) {}
        app.refresh();
    }

    showCompletionReport(result, options.outputFolder);
}

function readCSVFile(file) {
    file.encoding = "UTF8";
    if (!file.open("r")) {
        throw new Error("Could not open " + file.fsName);
    }

    var contents;
    try {
        contents = file.read();
    } finally {
        file.close();
    }

    if (contents.length > 0 && contents.charCodeAt(0) === 0xFEFF) {
        contents = contents.substring(1);
    }
    return parseCSV(contents);
}

function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    var i;

    for (i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (quoted) {
            if (ch === '"') {
                if (i + 1 < text.length && text.charAt(i + 1) === '"') {
                    field += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\r" || ch === "\n") {
            if (ch === "\r" && i + 1 < text.length && text.charAt(i + 1) === "\n") {
                i++;
            }
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }

    if (quoted) {
        throw new Error("The CSV ends inside a quoted field.");
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    while (rows.length > 0 && rowIsEmpty(rows[rows.length - 1])) {
        rows.pop();
    }
    if (rows.length === 0) {
        return { headers: [], rows: [] };
    }

    var headers = [];
    for (i = 0; i < rows[0].length; i++) {
        headers.push(trim(rows[0][i]));
    }

    var records = [];
    for (i = 1; i < rows.length; i++) {
        if (rowIsEmpty(rows[i])) {
            continue;
        }
        if (rows[i].length !== headers.length) {
            throw new Error("CSV record " + (i + 1) + " has " + rows[i].length +
                " fields; the header has " + headers.length +
                ". Check for a missing quote or an unquoted comma.");
        }
        var values = [];
        var c;
        for (c = 0; c < headers.length; c++) {
            values.push(c < rows[i].length ? rows[i][c] : "");
        }
        records.push(values);
    }
    return { headers: headers, rows: records };
}

function validateCSV(parsed) {
    if (parsed.headers.length === 0) {
        throw new Error("The CSV is empty.");
    }
    if (parsed.rows.length === 0) {
        throw new Error("The CSV has a header row but no data rows.");
    }

    var seen = {};
    var i;
    for (i = 0; i < parsed.headers.length; i++) {
        var header = parsed.headers[i];
        if (!header) {
            throw new Error("Header column " + (i + 1) + " is blank.");
        }
        var key = canonical(header);
        if (seen[key]) {
            throw new Error("Duplicate header: " + header);
        }
        seen[key] = true;
    }
}

function scanDocument(doc) {
    var result = { textLayers: [], allLayers: [] };

    function visit(parent, prefix, keyPrefix) {
        var i;
        for (i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i];
            var ordinal = siblingNameOrdinal(parent, i, layer.name);
            var duplicateCount = siblingNameCount(parent, layer.name);
            var displayName = layer.name + (duplicateCount > 1 ? " [" + ordinal + "]" : "");
            var path = prefix ? prefix + " > " + displayName : displayName;
            var key = keyPrefix + "/" + encodeLayerKeyPart(layer.name) + "#" + ordinal;
            var descriptor = {
                layer: layer,
                path: path,
                key: key,
                name: layer.name,
                isGroup: layer.typename === "LayerSet"
            };
            result.allLayers.push(descriptor);
            if (layer.typename === "ArtLayer" && layer.kind === LayerKind.TEXT) {
                result.textLayers.push(descriptor);
            }
            if (layer.typename === "LayerSet") {
                visit(layer, path, key);
            }
        }
    }

    visit(doc, "", "");
    return result;
}

function siblingNameOrdinal(parent, index, name) {
    var ordinal = 1;
    var i;
    for (i = 0; i < index; i++) {
        if (parent.layers[i].name === name) {
            ordinal++;
        }
    }
    return ordinal;
}

function siblingNameCount(parent, name) {
    var count = 0;
    var i;
    for (i = 0; i < parent.layers.length; i++) {
        if (parent.layers[i].name === name) {
            count++;
        }
    }
    return count;
}

function encodeLayerKeyPart(value) {
    return String(value).replace(/%/g, "%25").replace(/\//g, "%2F").replace(/#/g, "%23");
}

function createAutomaticTextMappings(textLayers, headers) {
    var mappings = [];
    var i;
    for (i = 0; i < textLayers.length; i++) {
        mappings.push(findHeaderIndex(headers, stripDirective(textLayers[i].name)));
    }
    return mappings;
}

function createDefaultTextFitRules(textLayers) {
    var rules = [];
    var i;
    for (i = 0; i < textLayers.length; i++) {
        rules.push({
            enabled: /^\s*\[fit\]/i.test(textLayers[i].name) &&
                isParagraphTextLayer(textLayers[i].layer),
            minimumSize: 6,
            maximumSize: textLayerFontSize(textLayers[i].layer)
        });
    }
    return rules;
}

function updateTextFitRule(rule, paragraph, enabled, minimumText) {
    if (!paragraph) {
        return "Auto-fit requires a regular paragraph text layer with a bounding box.";
    }
    var parsedMinimum = parseFloat(minimumText);
    if (isNaN(parsedMinimum) || parsedMinimum <= 0 || parsedMinimum > rule.maximumSize) {
        return "Enter a minimum font size greater than 0 and no larger than the template size (" +
            formatDecimal(rule.maximumSize) + " pt).";
    }
    rule.enabled = enabled;
    rule.minimumSize = parsedMinimum;
    return "";
}

function createAutomaticVisibilityRules(allLayers, headers) {
    var rules = [];
    var i;
    for (i = 0; i < allLayers.length; i++) {
        var rule = { mode: "keep", headerIndex: -1, value: "" };
        var parsed = parseShowDirective(allLayers[i].name);
        if (parsed) {
            var headerIndex = findHeaderIndex(headers, parsed.header);
            if (headerIndex >= 0) {
                rule.mode = parsed.hasValue ? "equals" : "truthy";
                rule.headerIndex = headerIndex;
                rule.value = parsed.value;
            }
        }
        rules.push(rule);
    }
    return rules;
}

function parseShowDirective(name) {
    var match = /^\s*\[show:([^=\]]+)(?:=([^\]]+))?\]/i.exec(name);
    if (!match) {
        return null;
    }
    return {
        header: trim(match[1]),
        value: typeof match[2] === "undefined" ? "" : trim(match[2]),
        hasValue: typeof match[2] !== "undefined"
    };
}

function stripDirective(name) {
    var stripped = name.replace(/^\s*\[show:[^\]]+\]\s*/i, "");
    stripped = stripped.replace(/^\s*\[fit\]\s*/i, "");
    return trim(stripped);
}

function showMappingDialog(doc, csvFile, parsed, inventory, textMappings, textFitRules, visibilityRules) {
    var dialog = new Window("dialog", "IAWOA CSV Batch Export " + IAWOA_VERSION);
    dialog.orientation = "column";
    dialog.alignChildren = ["fill", "top"];
    dialog.preferredSize = [820, 680];

    var summary = dialog.add("statictext", undefined,
        parsed.rows.length + " CSV rows | " + parsed.headers.length + " columns | " +
        inventory.textLayers.length + " text layers | " + inventory.allLayers.length + " total layers");

    var tabs = dialog.add("tabbedpanel");
    tabs.alignChildren = ["fill", "fill"];
    tabs.preferredSize = [800, 570];

    var textTab = tabs.add("tab", undefined, "Text mapping");
    buildTextMappingTab(textTab, parsed, inventory, textMappings, textFitRules);

    var visibilityTab = tabs.add("tab", undefined, "Visibility");
    buildVisibilityTab(visibilityTab, parsed, inventory, visibilityRules);

    var exportTab = tabs.add("tab", undefined, "Export");
    var exportControls = buildExportTab(exportTab, doc, csvFile, parsed);

    tabs.selection = textTab;

    var actions = dialog.add("group");
    actions.alignment = ["fill", "bottom"];
    var loadButton = actions.add("button", undefined, "Load mapping...");
    var saveButton = actions.add("button", undefined, "Save mapping...");
    actions.add("statictext", undefined, "").alignment = ["fill", "fill"];
    var cancelButton = actions.add("button", undefined, "Cancel", { name: "cancel" });
    var runButton = actions.add("button", undefined, "Run batch", { name: "ok" });

    loadButton.onClick = function () {
        var file = File.openDialog("Load an IAWOA mapping", "JSON files:*.json;All files:*.*");
        if (!file) {
            return;
        }
        try {
            var config = readJSONFile(file);
            applyConfiguration(config, parsed, inventory, textMappings, textFitRules, visibilityRules, exportControls);
            refreshTextMappingList(textTab._mappingList, parsed, inventory, textMappings, textFitRules);
            refreshVisibilityList(visibilityTab._visibilityList, parsed, inventory, visibilityRules);
            if (textTab._mappingList.onChange) { textTab._mappingList.onChange(); }
            if (visibilityTab._visibilityList.onChange) { visibilityTab._visibilityList.onChange(); }
            alert("Mapping loaded.");
        } catch (e) {
            alert("Could not load the mapping.\n\n" + formatError(e));
        }
    };

    saveButton.onClick = function () {
        if (textTab._commitFitEditor && !textTab._commitFitEditor(true)) {
            tabs.selection = textTab;
            return;
        }
        var file = File.saveDialog("Save this IAWOA mapping", "IAWOA mapping files:*.mapping.json");
        if (!file) {
            return;
        }
        file = new File(ensureMappingExtension(file.fsName));
        try {
            writeJSONFile(file, buildConfiguration(parsed, inventory, textMappings, textFitRules, visibilityRules, exportControls));
            alert("Mapping saved to:\n" + file.fsName);
        } catch (e2) {
            alert("Could not save the mapping.\n\n" + formatError(e2));
        }
    };

    runButton.onClick = function () {
        if (textTab._commitFitEditor && !textTab._commitFitEditor(true)) {
            tabs.selection = textTab;
            return;
        }
        if (!exportControls.outputFolder.text) {
            alert("Choose an output folder on the Export tab.");
            tabs.selection = exportTab;
            return;
        }
        var folder = new Folder(exportControls.outputFolder.text);
        if (!folder.exists) {
            alert("The selected output folder does not exist.");
            tabs.selection = exportTab;
            return;
        }
        if (!exportControls.fullPNG.value && !exportControls.trimmedPNG.value &&
                !exportControls.pdf.value && !exportControls.proofJPG.value) {
            alert("Select at least one export format.");
            tabs.selection = exportTab;
            return;
        }
        if (!trim(exportControls.filePattern.text)) {
            alert("Enter a filename pattern.");
            tabs.selection = exportTab;
            return;
        }
        dialog.close(1);
    };

    cancelButton.onClick = function () { dialog.close(0); };

    if (dialog.show() !== 1) {
        return null;
    }

    return {
        textMappings: textMappings,
        textFitRules: textFitRules,
        visibilityRules: visibilityRules,
        outputFolder: new Folder(exportControls.outputFolder.text),
        filePattern: exportControls.filePattern.text,
        fullPNG: exportControls.fullPNG.value,
        trimmedPNG: exportControls.trimmedPNG.value,
        pdf: exportControls.pdf.value,
        proofJPG: exportControls.proofJPG.value,
        conflictMode: exportControls.conflict.selection.index
    };
}

function ensureMappingExtension(path) {
    if (/\.mapping\.json$/i.test(path)) {
        return path;
    }
    return /\.json$/i.test(path) ?
        path.replace(/\.json$/i, ".mapping.json") : path + ".mapping.json";
}

function buildTextMappingTab(tab, parsed, inventory, textMappings, textFitRules) {
    tab.orientation = "column";
    tab.alignChildren = ["fill", "top"];
    tab.add("statictext", undefined,
        "Text layers with names matching CSV headers are mapped automatically. Select a row to change it.");

    var list = tab.add("listbox", undefined, [], {
        numberOfColumns: 3,
        showHeaders: true,
        columnTitles: ["Text layer", "CSV column", "Auto-fit"],
        columnWidths: [390, 210, 130]
    });
    list.preferredSize = [760, 420];
    tab._mappingList = list;
    refreshTextMappingList(list, parsed, inventory, textMappings, textFitRules);

    var editor = tab.add("group");
    editor.add("statictext", undefined, "Selected layer gets text from:");
    var dropdown = editor.add("dropdownlist", undefined, ["<leave unchanged>"].concat(parsed.headers));
    dropdown.preferredSize.width = 330;
    dropdown.selection = 0;

    var fitEditor = tab.add("panel", undefined, "Paragraph text auto-fit");
    fitEditor.orientation = "row";
    fitEditor.alignChildren = ["left", "center"];
    var autoFit = fitEditor.add("checkbox", undefined, "Shrink text to stay inside its paragraph box");
    fitEditor.add("statictext", undefined, "Minimum font size:");
    var minimumSize = fitEditor.add("edittext", undefined, "6");
    minimumSize.characters = 5;
    fitEditor.add("statictext", undefined, "pt");
    fitEditor.add("statictext", undefined, "Changes apply immediately.");
    tab.add("statictext", undefined,
        "Auto-fit is for straight horizontal paragraph text; Dynamic Text, rotated, skewed, warped, or vertical text is unsupported.",
        { multiline: true });

    list.onChange = function () {
        if (list.selection) {
            dropdown.selection = textMappings[list.selection.index] + 1;
            var rule = textFitRules[list.selection.index];
            var paragraph = isParagraphTextLayer(inventory.textLayers[list.selection.index].layer);
            autoFit.value = rule.enabled;
            autoFit.enabled = paragraph;
            minimumSize.text = formatDecimal(rule.minimumSize);
            minimumSize.enabled = paragraph;
        }
    };
    dropdown.onChange = function () {
        if (list.selection && dropdown.selection) {
            textMappings[list.selection.index] = dropdown.selection.index - 1;
            refreshTextMappingList(list, parsed, inventory, textMappings, textFitRules, list.selection.index);
        }
    };

    function commitFitEditor(showError) {
        if (!list.selection) {
            return true;
        }
        var index = list.selection.index;
        var message = updateTextFitRule(
            textFitRules[index],
            isParagraphTextLayer(inventory.textLayers[index].layer),
            autoFit.value,
            minimumSize.text
        );
        if (message) {
            if (showError) {
                alert(message);
            }
            return false;
        }
        refreshTextMappingList(list, parsed, inventory, textMappings, textFitRules, index);
        return true;
    }
    tab._commitFitEditor = commitFitEditor;
    autoFit.onClick = function () { commitFitEditor(true); };
    minimumSize.onChange = function () { commitFitEditor(true); };
    if (list.items.length > 0) {
        list.selection = 0;
        list.onChange();
    }
}

function refreshTextMappingList(list, parsed, inventory, textMappings, textFitRules, selectedIndex) {
    var keep = typeof selectedIndex === "number" ? selectedIndex : (list.selection ? list.selection.index : 0);
    list.removeAll();
    var i;
    for (i = 0; i < inventory.textLayers.length; i++) {
        var item = list.add("item", inventory.textLayers[i].path);
        item.subItems[0].text = textMappings[i] >= 0 ? parsed.headers[textMappings[i]] : "<unchanged>";
        item.subItems[1].text = textFitRules[i].enabled ?
            "Yes (min " + formatDecimal(textFitRules[i].minimumSize) + " pt)" : "No";
    }
    if (list.items.length > 0) {
        list.selection = Math.min(keep, list.items.length - 1);
    }
}

function buildVisibilityTab(tab, parsed, inventory, visibilityRules) {
    tab.orientation = "column";
    tab.alignChildren = ["fill", "top"];
    tab.add("statictext", undefined,
        "Control any layer or group. [show:Header] and [show:Header=Value] names are recognized automatically.");

    var list = tab.add("listbox", undefined, [], {
        numberOfColumns: 4,
        showHeaders: true,
        columnTitles: ["Layer / group", "Rule", "CSV column", "Match value"],
        columnWidths: [360, 145, 145, 100]
    });
    list.preferredSize = [760, 390];
    tab._visibilityList = list;
    refreshVisibilityList(list, parsed, inventory, visibilityRules);

    var editor = tab.add("panel", undefined, "Selected layer rule");
    editor.orientation = "row";
    editor.alignChildren = ["left", "center"];
    var mode = editor.add("dropdownlist", undefined, [
        "Keep template state", "Always show", "Always hide", "Show when truthy", "Show when equal"
    ]);
    mode.selection = 0;
    mode.preferredSize.width = 155;
    var header = editor.add("dropdownlist", undefined, parsed.headers);
    header.selection = 0;
    header.preferredSize.width = 180;
    var value = editor.add("edittext", undefined, "");
    value.characters = 18;
    var apply = editor.add("button", undefined, "Apply rule");

    function updateEnabled() {
        var index = mode.selection ? mode.selection.index : 0;
        header.enabled = index === 3 || index === 4;
        value.enabled = index === 4;
    }

    list.onChange = function () {
        if (!list.selection) {
            return;
        }
        var rule = visibilityRules[list.selection.index];
        mode.selection = visibilityModeIndex(rule.mode);
        header.selection = Math.max(0, rule.headerIndex);
        value.text = rule.value;
        updateEnabled();
    };
    mode.onChange = updateEnabled;
    apply.onClick = function () {
        if (!list.selection) {
            return;
        }
        var modeName = visibilityModeName(mode.selection.index);
        var needsHeader = modeName === "truthy" || modeName === "equals";
        if (needsHeader && !header.selection) {
            alert("Choose a CSV column for this rule.");
            return;
        }
        visibilityRules[list.selection.index] = {
            mode: modeName,
            headerIndex: needsHeader ? header.selection.index : -1,
            value: modeName === "equals" ? value.text : ""
        };
        refreshVisibilityList(list, parsed, inventory, visibilityRules, list.selection.index);
    };
    updateEnabled();
}

function refreshVisibilityList(list, parsed, inventory, rules, selectedIndex) {
    var keep = typeof selectedIndex === "number" ? selectedIndex : (list.selection ? list.selection.index : 0);
    list.removeAll();
    var i;
    for (i = 0; i < inventory.allLayers.length; i++) {
        var rule = rules[i];
        var item = list.add("item", inventory.allLayers[i].path);
        item.subItems[0].text = visibilityModeLabel(rule.mode);
        item.subItems[1].text = rule.headerIndex >= 0 ? parsed.headers[rule.headerIndex] : "";
        item.subItems[2].text = rule.value;
    }
    if (list.items.length > 0) {
        list.selection = Math.min(keep, list.items.length - 1);
    }
}

function buildExportTab(tab, doc, csvFile, parsed) {
    tab.orientation = "column";
    tab.alignChildren = ["fill", "top"];

    var destination = tab.add("panel", undefined, "Destination");
    destination.orientation = "row";
    destination.alignChildren = ["fill", "center"];
    var outputFolder = destination.add("edittext", undefined, csvFile.parent.fsName);
    outputFolder.characters = 65;
    var browse = destination.add("button", undefined, "Browse...");
    browse.onClick = function () {
        var selected = Folder.selectDialog("Select the batch output folder", new Folder(outputFolder.text));
        if (selected) {
            outputFolder.text = selected.fsName;
        }
    };

    var naming = tab.add("panel", undefined, "File naming");
    naming.orientation = "column";
    naming.alignChildren = ["fill", "top"];
    var defaultPattern = findHeaderIndex(parsed.headers, "Export Name") >= 0 ?
        "{Export Name}" : documentBaseName(doc) + "_{row}";
    var filePattern = naming.add("edittext", undefined, defaultPattern);
    naming.add("statictext", undefined,
        "Use {Header Name} tokens or {row}. Example: {Last Name}_{Jersey Number}", { multiline: true });

    var formats = tab.add("panel", undefined, "IAWOA export formats");
    formats.orientation = "column";
    formats.alignChildren = "left";
    var fullPNG = formats.add("checkbox", undefined, "Full canvas PNG");
    var trimmedPNG = formats.add("checkbox", undefined, "Trimmed transparent PNG (_trimmed)");
    var pdf = formats.add("checkbox", undefined, "Flattened PDF (maximum JPEG quality, PDF 1.6)");
    var proofJPG = formats.add("checkbox", undefined, "Watermarked JPG proof (_proof, 30% size / quality 3)");
    fullPNG.value = true;
    trimmedPNG.value = true;
    pdf.value = true;
    proofJPG.value = false;

    var existing = tab.add("panel", undefined, "If an output file already exists");
    existing.orientation = "row";
    var conflict = existing.add("dropdownlist", undefined, [
        "Stop before exporting", "Skip that CSV row", "Overwrite"
    ]);
    conflict.selection = 0;

    return {
        outputFolder: outputFolder,
        filePattern: filePattern,
        fullPNG: fullPNG,
        trimmedPNG: trimmedPNG,
        pdf: pdf,
        proofJPG: proofJPG,
        conflict: conflict
    };
}

function preflightBatch(parsed, options) {
    validateFilenamePattern(options.filePattern, parsed.headers);
    var names = {};
    var collisions = [];
    var outputPaths = {};
    var outputCollisions = [];
    var existing = [];
    var i;

    for (i = 0; i < parsed.rows.length; i++) {
        var base = makeBaseName(options.filePattern, parsed.headers, parsed.rows[i], i);
        var key = base.toLowerCase();
        if (names[key]) {
            collisions.push(base + " (rows " + names[key] + " and " + (i + 2) + ")");
        } else {
            names[key] = i + 2;
        }

        var files = expectedOutputFiles(options.outputFolder, base, options);
        var f;
        for (f = 0; f < files.length; f++) {
            var pathKey = files[f].fsName.toLowerCase();
            if (outputPaths[pathKey]) {
                outputCollisions.push(files[f].name + " (CSV rows " + outputPaths[pathKey] +
                    " and " + (i + 2) + ")");
            } else {
                outputPaths[pathKey] = i + 2;
            }
            if (options.conflictMode === 0) {
                if (files[f].exists) {
                    existing.push(files[f].name);
                }
            }
        }
    }

    if (collisions.length > 0) {
        throw new Error("The filename pattern creates duplicate names:\n" + collisions.slice(0, 10).join("\n"));
    }
    if (outputCollisions.length > 0) {
        throw new Error("Different rows would create the same output file:\n" +
            outputCollisions.slice(0, 10).join("\n"));
    }
    if (existing.length > 0) {
        throw new Error("Existing output files were found. Choose Skip or Overwrite to continue.\n\n" +
            existing.slice(0, 10).join("\n"));
    }
    if (options.proofJPG && (!options.watermarkFile || !options.watermarkFile.exists)) {
        throw new Error("The selected proof watermark is no longer available.");
    }
}

function resolveWatermarkFile() {
    var settingsFile = getSettingsFile();
    var savedPath = "";

    if (settingsFile.exists) {
        try {
            var settings = readJSONFile(settingsFile);
            if (settings && typeof settings.watermarkPath === "string") {
                savedPath = settings.watermarkPath;
                var savedFile = new File(savedPath);
                if (savedFile.exists && validateWatermarkFile(savedFile)) {
                    return savedFile;
                }
            }
        } catch (ignored) {
            savedPath = "";
        }
    }

    var message = savedPath ?
        "The saved watermark image could not be found or opened. Select its new location." :
        "Select the watermark image used for JPG proofs.";
    while (true) {
        var selected = File.openDialog(message,
            "Watermark images:*.psd;*.psb;*.png;*.jpg;*.jpeg");
        if (!selected) {
            return null;
        }
        if (validateWatermarkFile(selected)) {
            saveWatermarkPath(settingsFile, selected.fsName);
            return selected;
        }
        alert("Photoshop could not open that watermark image. Select a valid PSD, PSB, PNG, or JPEG file.");
        message = "Select a different watermark image.";
    }
}

function validateWatermarkFile(file) {
    var priorDocument = app.documents.length > 0 ? app.activeDocument : null;
    var existingDocument = findOpenDocumentForFile(file);
    var openedDocument = existingDocument;
    var openedForValidation = false;
    try {
        if (!openedDocument) {
            openedDocument = app.open(file);
            openedForValidation = true;
        }
        return countVisibleArtLayers(openedDocument) > 0;
    } catch (ignored) {
        return false;
    } finally {
        if (openedForValidation && openedDocument) {
            try { openedDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (ignored1) {}
        }
        if (priorDocument) {
            try { app.activeDocument = priorDocument; } catch (ignored2) {}
        }
    }
}

function findOpenDocumentForFile(file) {
    var target = file.fsName.toLowerCase();
    var i;
    for (i = 0; i < app.documents.length; i++) {
        try {
            if (app.documents[i].fullName.fsName.toLowerCase() === target) {
                return app.documents[i];
            }
        } catch (ignored) {}
    }
    return null;
}

function getSettingsFile() {
    var folder = new Folder(Folder.userData.fsName + "/" + IAWOA_SETTINGS_FOLDER_NAME);
    if (!folder.exists && !folder.create()) {
        throw new Error("Could not create the settings folder:\n" + folder.fsName);
    }
    return new File(folder.fsName + "/" + IAWOA_SETTINGS_FILE_NAME);
}

function saveWatermarkPath(settingsFile, path) {
    writeJSONFile(settingsFile, {
        version: 1,
        watermarkPath: path
    });
}

function validateFilenamePattern(pattern, headers) {
    var unknown = [];
    pattern.replace(/\{([^{}]+)\}/g, function (whole, token) {
        if (canonical(token) !== "row" && findHeaderIndex(headers, token) < 0) {
            unknown.push(token);
        }
        return whole;
    });
    if (unknown.length > 0) {
        throw new Error("The filename pattern contains unknown CSV tokens: " + unknown.join(", "));
    }
}

function processBatch(doc, parsed, inventory, options) {
    var result = { completed: 0, skipped: 0, errors: [] };
    var progress = new Window("palette", "IAWOA Batch Export");
    progress.orientation = "column";
    progress.alignChildren = ["fill", "top"];
    var label = progress.add("statictext", undefined, "Preparing...");
    var bar = progress.add("progressbar", undefined, 0, parsed.rows.length);
    bar.preferredSize.width = 420;
    progress.show();

    try {
        var i;
        for (i = 0; i < parsed.rows.length; i++) {
            var base = makeBaseName(options.filePattern, parsed.headers, parsed.rows[i], i);
            label.text = "Row " + (i + 1) + " of " + parsed.rows.length + ": " + base;
            bar.value = i;
            progress.update();

            var expected = expectedOutputFiles(options.outputFolder, base, options);
            if (options.conflictMode === 1 && anyFileExists(expected)) {
                result.skipped++;
                continue;
            }

            try {
                applyRow(parsed.rows[i], inventory, options);
                app.refresh();
                exportRow(doc, options.outputFolder, base, options);
                result.completed++;
            } catch (e) {
                result.errors.push("CSV row " + (i + 2) + " (" + base + "): " + formatError(e));
            }
        }
        bar.value = parsed.rows.length;
        progress.update();
    } finally {
        try { progress.close(); } catch (ignored) {}
    }
    return result;
}

function applyRow(row, inventory, options) {
    var i;
    for (i = 0; i < inventory.textLayers.length; i++) {
        var headerIndex = options.textMappings[i];
        if (headerIndex >= 0) {
            inventory.textLayers[i].layer.textItem.contents = normalizeTextValue(row[headerIndex]);
        }
    }

    for (i = 0; i < inventory.textLayers.length; i++) {
        if (options.textMappings[i] >= 0 && options.textFitRules[i].enabled) {
            fitTextLayerToParagraphBox(inventory.textLayers[i].layer, options.textFitRules[i]);
        }
    }

    for (i = 0; i < inventory.allLayers.length; i++) {
        var rule = options.visibilityRules[i];
        if (rule.mode === "show") {
            inventory.allLayers[i].layer.visible = true;
        } else if (rule.mode === "hide") {
            inventory.allLayers[i].layer.visible = false;
        } else if (rule.mode === "truthy") {
            inventory.allLayers[i].layer.visible = isTruthy(row[rule.headerIndex]);
        } else if (rule.mode === "equals") {
            inventory.allLayers[i].layer.visible = equalityValue(row[rule.headerIndex]) === equalityValue(rule.value);
        }
    }
}

function fitTextLayerToParagraphBox(layer, rule) {
    if (!isParagraphTextLayer(layer)) {
        throw new Error("Auto-fit layer '" + layer.name + "' is not regular paragraph text.");
    }

    var maximumSize = rule.maximumSize;
    var minimumSize = rule.minimumSize;
    var textItem = layer.textItem;
    textItem.size = UnitValue(maximumSize, "pt");
    if (!trim(textItem.contents)) {
        return;
    }

    var doc = layer.parent.typename === "Document" ? layer.parent : app.activeDocument;
    var previousActiveLayer = doc.activeLayer;
    var measurementLayer = layer.duplicate();
    var boxWidth = 0;
    var measuredWidth = 0;
    try {
        measurementLayer.name = "IAWOA Auto-fit Measurement";
        try { measurementLayer.allLocked = false; } catch (ignored1) {}
        measurementLayer.visible = true;

        // Measure the transformed paragraph box in document pixels. A long run
        // of tiny glyphs fills the box closely without relying on TextItem.width,
        // whose units do not include document resolution or layer transforms.
        measurementLayer.textItem.size = UnitValue(1, "pt");
        measurementLayer.textItem.contents = repeatString("M ", 2048);
        doc.activeLayer = measurementLayer;
        app.refresh();
        boxWidth = layerBoundsWidth(measurementLayer);

        measurementLayer.textItem.contents = textItem.contents;
        measurementLayer.textItem.kind = TextType.POINTTEXT;
        measurementLayer.textItem.size = UnitValue(maximumSize, "pt");
        app.refresh();
        measuredWidth = layerBoundsWidth(measurementLayer);
    } finally {
        try { measurementLayer.remove(); } catch (ignored2) {}
        try { doc.activeLayer = previousActiveLayer; } catch (ignored3) {}
    }

    if (boxWidth <= 0) {
        throw new Error("Auto-fit layer '" + layer.name + "' has an invalid paragraph box width.");
    }
    if (measuredWidth <= 0) {
        return;
    }

    var fittedSize = calculateFittedFontSize(maximumSize, minimumSize, boxWidth, measuredWidth, 0.98);
    if (measuredWidth * (fittedSize / maximumSize) > boxWidth * 0.98 + 0.5) {
        throw new Error("Text '" + textItem.contents + "' will not fit layer '" + layer.name +
            "' at the minimum size of " + formatDecimal(minimumSize) + " pt.");
    }
    textItem.size = UnitValue(fittedSize, "pt");
}

function layerBoundsWidth(layer) {
    var bounds;
    try {
        bounds = layer.boundsNoEffects;
    } catch (ignored) {
        bounds = layer.bounds;
    }
    return bounds[2].as("px") - bounds[0].as("px");
}

function calculateFittedFontSize(maximumSize, minimumSize, boxWidth, measuredWidth, paddingRatio) {
    if (measuredWidth <= 0 || boxWidth <= 0 || maximumSize <= 0) {
        return maximumSize;
    }
    var availableWidth = boxWidth * paddingRatio;
    var fitted = measuredWidth <= availableWidth ? maximumSize : maximumSize * availableWidth / measuredWidth;
    fitted = Math.max(minimumSize, Math.min(maximumSize, fitted));
    return Math.floor(fitted * 10) / 10;
}

function isParagraphTextLayer(layer) {
    try {
        return layer.typename === "ArtLayer" && layer.kind === LayerKind.TEXT &&
            layer.textItem.kind === TextType.PARAGRAPHTEXT;
    } catch (ignored) {
        return false;
    }
}

function textLayerFontSize(layer) {
    try {
        return layer.textItem.size.as("pt");
    } catch (ignored) {
        return Number(layer.textItem.size);
    }
}

function formatDecimal(value) {
    var rounded = Math.round(Number(value) * 10) / 10;
    return String(rounded);
}

function exportRow(doc, folder, base, options) {
    if (options.fullPNG) {
        exportPNG(doc, new File(folder.fsName + "/" + base + ".png"), false);
    }
    if (options.trimmedPNG) {
        exportPNG(doc, new File(folder.fsName + "/" + base + "_trimmed.png"), true);
    }
    if (options.pdf) {
        exportPDF(doc, new File(folder.fsName + "/" + base + ".pdf"));
    }
    if (options.proofJPG) {
        exportWatermarkedJPG(doc, new File(folder.fsName + "/" + base + "_proof.jpg"), options.watermarkFile);
    }
}

function exportPNG(doc, file, trimmed) {
    var original = app.activeDocument;
    var copy = doc.duplicate();
    try {
        app.activeDocument = copy;
        mergeVisibleWithTransparency(copy);
        if (trimmed) {
            copy.trim(TrimType.TRANSPARENT, true, true, true, true);
        }
        var options = new PNGSaveOptions();
        options.compression = 9;
        options.interlaced = false;
        copy.saveAs(file, options, true, Extension.LOWERCASE);
    } finally {
        copy.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = original;
    }
}

function exportPDF(doc, file) {
    var original = app.activeDocument;
    var copy = doc.duplicate();
    try {
        app.activeDocument = copy;
        copy.flatten();
        var options = new PDFSaveOptions();
        options.preserveEditing = false;
        options.optimizeForWeb = false;
        options.embedColorProfile = true;
        options.pdfCompatibility = PDFCompatibility.PDF16;
        options.encoding = PDFEncoding.JPEG;
        options.jpegQuality = 12;
        copy.saveAs(file, options, true, Extension.LOWERCASE);
    } finally {
        copy.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = original;
    }
}

function exportWatermarkedJPG(doc, file, watermarkFile) {
    var original = app.activeDocument;
    var copy = doc.duplicate();
    try {
        app.activeDocument = copy;
        var watermarkDoc = openWatermarkWorkingDocument(watermarkFile);
        try {
            app.activeDocument = watermarkDoc;
            mergeVisibleWithTransparency(watermarkDoc);
            var sourceTile = watermarkDoc.activeLayer;
            var tileWidth = watermarkDoc.width.as("px");
            var tileHeight = watermarkDoc.height.as("px");
            var canvasWidth = copy.width.as("px");
            var canvasHeight = copy.height.as("px");
            var cols = Math.ceil(canvasWidth / tileWidth);
            var rows = Math.ceil(canvasHeight / tileHeight);
            var r;
            var c;
            for (r = 0; r < rows; r++) {
                for (c = 0; c < cols; c++) {
                    app.activeDocument = watermarkDoc;
                    var tile = sourceTile.duplicate(copy, ElementPlacement.PLACEATBEGINNING);
                    app.activeDocument = copy;
                    var bounds = tile.bounds;
                    tile.translate(
                        UnitValue(c * tileWidth - bounds[0].as("px"), "px"),
                        UnitValue(r * tileHeight - bounds[1].as("px"), "px")
                    );
                }
            }
        } finally {
            watermarkDoc.close(SaveOptions.DONOTSAVECHANGES);
        }

        app.activeDocument = copy;
        copy.flatten();
        copy.resizeImage(
            UnitValue(copy.width.as("px") * (IAWOA_JPG_RESIZE_PERCENT / 100), "px"),
            UnitValue(copy.height.as("px") * (IAWOA_JPG_RESIZE_PERCENT / 100), "px"),
            copy.resolution,
            ResampleMethod.BICUBIC
        );
        var options = new JPEGSaveOptions();
        options.quality = IAWOA_JPG_QUALITY;
        options.embedColorProfile = true;
        options.formatOptions = FormatOptions.STANDARDBASELINE;
        options.matte = MatteType.NONE;
        copy.saveAs(file, options, true, Extension.LOWERCASE);
    } finally {
        copy.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = original;
    }
}

function openWatermarkWorkingDocument(file) {
    var source = findOpenDocumentForFile(file);
    var openedSource = false;
    if (!source) {
        source = app.open(file);
        openedSource = true;
    }

    try {
        app.activeDocument = source;
        return source.duplicate();
    } finally {
        if (openedSource && source) {
            try { source.close(SaveOptions.DONOTSAVECHANGES); } catch (ignored) {}
        }
    }
}

function mergeVisibleWithTransparency(doc) {
    var visibleCount = countVisibleArtLayers(doc);
    if (visibleCount === 0) {
        throw new Error("The document has no visible artwork to export.");
    }
    if (visibleCount === 1) {
        var onlyVisibleLayer = findFirstVisibleArtLayer(doc);
        if (onlyVisibleLayer) {
            doc.activeLayer = onlyVisibleLayer;
        }
        return;
    }

    var visibleBackground = false;
    try {
        visibleBackground = doc.backgroundLayer && doc.backgroundLayer.visible;
    } catch (ignored) {
        visibleBackground = false;
    }

    if (visibleBackground) {
        doc.flatten();
    } else {
        var anchor = doc.artLayers.add();
        anchor.name = "IAWOA Transparent Merge Anchor";
        doc.mergeVisibleLayers();
    }
}

function findFirstVisibleArtLayer(parent) {
    var i;
    for (i = 0; i < parent.layers.length; i++) {
        var layer = parent.layers[i];
        if (!layer.visible) {
            continue;
        }
        if (layer.typename === "LayerSet") {
            var nested = findFirstVisibleArtLayer(layer);
            if (nested) {
                return nested;
            }
        } else {
            return layer;
        }
    }
    return null;
}

function countVisibleArtLayers(parent) {
    var count = 0;
    var i;
    for (i = 0; i < parent.layers.length; i++) {
        var layer = parent.layers[i];
        if (!layer.visible) {
            continue;
        }
        if (layer.typename === "LayerSet") {
            count += countVisibleArtLayers(layer);
        } else {
            count++;
        }
    }
    return count;
}

function expectedOutputFiles(folder, base, options) {
    var files = [];
    if (options.fullPNG) { files.push(new File(folder.fsName + "/" + base + ".png")); }
    if (options.trimmedPNG) { files.push(new File(folder.fsName + "/" + base + "_trimmed.png")); }
    if (options.pdf) { files.push(new File(folder.fsName + "/" + base + ".pdf")); }
    if (options.proofJPG) { files.push(new File(folder.fsName + "/" + base + "_proof.jpg")); }
    return files;
}

function anyFileExists(files) {
    var i;
    for (i = 0; i < files.length; i++) {
        if (files[i].exists) {
            return true;
        }
    }
    return false;
}

function makeBaseName(pattern, headers, row, rowIndex) {
    var rendered = pattern.replace(/\{([^{}]+)\}/g, function (whole, token) {
        if (canonical(token) === "row") {
            return padNumber(rowIndex + 1, 3);
        }
        var index = findHeaderIndex(headers, token);
        return index >= 0 ? row[index] : whole;
    });
    rendered = sanitizeFileName(rendered);
    if (!rendered) {
        rendered = "row_" + padNumber(rowIndex + 1, 3);
    }
    return rendered;
}

function sanitizeFileName(value) {
    var safe = String(value);
    safe = safe.replace(/[<>:"\/\\|?*\x00-\x1F]/g, "_");
    safe = safe.replace(/\s+/g, " ");
    safe = trim(safe);
    safe = safe.replace(/[\. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
        safe = "_" + safe;
    }
    return safe;
}

function normalizeTextValue(value) {
    return String(value).replace(/\\n/g, "\r").replace(/\r\n|\n|\r/g, "\r");
}

function isTruthy(value) {
    var normalized = canonical(value);
    return normalized === "1" || normalized === "true" || normalized === "yes" ||
        normalized === "y" || normalized === "on" || normalized === "show" ||
        normalized === "visible";
}

function findHeaderIndex(headers, name) {
    var wanted = canonical(name);
    var i;
    for (i = 0; i < headers.length; i++) {
        if (canonical(headers[i]) === wanted) {
            return i;
        }
    }
    return -1;
}

function canonical(value) {
    return trim(String(value)).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function equalityValue(value) {
    return trim(String(value)).toLowerCase();
}

function trim(value) {
    return String(value).replace(/^\s+|\s+$/g, "");
}

function rowIsEmpty(row) {
    var i;
    for (i = 0; i < row.length; i++) {
        if (trim(row[i]) !== "") {
            return false;
        }
    }
    return true;
}

function padNumber(value, width) {
    var result = String(value);
    while (result.length < width) {
        result = "0" + result;
    }
    return result;
}

function documentBaseName(doc) {
    return doc.name.replace(/\.[^.]+$/, "");
}

function visibilityModeIndex(mode) {
    if (mode === "show") { return 1; }
    if (mode === "hide") { return 2; }
    if (mode === "truthy") { return 3; }
    if (mode === "equals") { return 4; }
    return 0;
}

function visibilityModeName(index) {
    return ["keep", "show", "hide", "truthy", "equals"][index] || "keep";
}

function visibilityModeLabel(mode) {
    return {
        keep: "Keep template state",
        show: "Always show",
        hide: "Always hide",
        truthy: "Show when truthy",
        equals: "Show when equal"
    }[mode] || "Keep template state";
}

function buildConfiguration(parsed, inventory, textMappings, textFitRules, visibilityRules, controls) {
    var config = {
        version: IAWOA_VERSION,
        textMappings: [],
        visibilityRules: [],
        exportSettings: {
            filePattern: controls.filePattern.text,
            fullPNG: controls.fullPNG.value,
            trimmedPNG: controls.trimmedPNG.value,
            pdf: controls.pdf.value,
            proofJPG: controls.proofJPG.value,
            conflictMode: controls.conflict.selection.index
        }
    };
    var i;
    for (i = 0; i < inventory.textLayers.length; i++) {
        if (textMappings[i] >= 0) {
            config.textMappings.push({
                key: inventory.textLayers[i].key,
                path: inventory.textLayers[i].path,
                header: parsed.headers[textMappings[i]],
                autoFit: textFitRules[i].enabled,
                minimumSize: textFitRules[i].minimumSize
            });
        }
    }
    for (i = 0; i < inventory.allLayers.length; i++) {
        if (visibilityRules[i].mode !== "keep") {
            config.visibilityRules.push({
                key: inventory.allLayers[i].key,
                path: inventory.allLayers[i].path,
                mode: visibilityRules[i].mode,
                header: visibilityRules[i].headerIndex >= 0 ? parsed.headers[visibilityRules[i].headerIndex] : "",
                value: visibilityRules[i].value
            });
        }
    }
    return config;
}

function applyConfiguration(config, parsed, inventory, textMappings, textFitRules, visibilityRules, controls) {
    if (!config || typeof config !== "object" || config instanceof Array) {
        throw new Error("The mapping file must contain one JSON object.");
    }
    var i;
    for (i = 0; i < textMappings.length; i++) {
        textMappings[i] = -1;
        textFitRules[i].enabled = false;
    }
    for (i = 0; i < visibilityRules.length; i++) {
        visibilityRules[i] = { mode: "keep", headerIndex: -1, value: "" };
    }

    var entry;
    for (i = 0; config.textMappings && i < config.textMappings.length; i++) {
        entry = config.textMappings[i];
        var textIndex = entry.key ? findDescriptorByKey(inventory.textLayers, entry.key) :
            findDescriptorByPath(inventory.textLayers, entry.path);
        var headerIndex = findHeaderIndex(parsed.headers, entry.header);
        if (textIndex >= 0 && headerIndex >= 0) {
            textMappings[textIndex] = headerIndex;
            if (typeof entry.minimumSize === "number" && entry.minimumSize > 0 &&
                    entry.minimumSize <= textFitRules[textIndex].maximumSize) {
                textFitRules[textIndex].minimumSize = entry.minimumSize;
            }
            if (entry.autoFit === true && isParagraphTextLayer(inventory.textLayers[textIndex].layer)) {
                textFitRules[textIndex].enabled = true;
            }
        }
    }
    for (i = 0; config.visibilityRules && i < config.visibilityRules.length; i++) {
        entry = config.visibilityRules[i];
        if (!isVisibilityMode(entry.mode)) {
            continue;
        }
        var layerIndex = entry.key ? findDescriptorByKey(inventory.allLayers, entry.key) :
            findDescriptorByPath(inventory.allLayers, entry.path);
        var visibilityHeaderIndex = entry.header ? findHeaderIndex(parsed.headers, entry.header) : -1;
        var needsHeader = entry.mode === "truthy" || entry.mode === "equals";
        if (layerIndex >= 0 && (!needsHeader || visibilityHeaderIndex >= 0)) {
            visibilityRules[layerIndex] = {
                mode: entry.mode || "keep",
                headerIndex: visibilityHeaderIndex,
                value: entry.value || ""
            };
        }
    }
    if (config.exportSettings) {
        var settings = config.exportSettings;
        if (typeof settings.filePattern === "string") { controls.filePattern.text = settings.filePattern; }
        if (typeof settings.fullPNG === "boolean") { controls.fullPNG.value = settings.fullPNG; }
        if (typeof settings.trimmedPNG === "boolean") { controls.trimmedPNG.value = settings.trimmedPNG; }
        if (typeof settings.pdf === "boolean") { controls.pdf.value = settings.pdf; }
        if (typeof settings.proofJPG === "boolean") { controls.proofJPG.value = settings.proofJPG; }
        if (typeof settings.conflictMode === "number" && settings.conflictMode >= 0 &&
                settings.conflictMode <= 2 && Math.floor(settings.conflictMode) === settings.conflictMode) {
            controls.conflict.selection = settings.conflictMode;
        }
    }
}

function isVisibilityMode(mode) {
    return mode === "keep" || mode === "show" || mode === "hide" ||
        mode === "truthy" || mode === "equals";
}

function findDescriptorByKey(descriptors, key) {
    var i;
    for (i = 0; i < descriptors.length; i++) {
        if (descriptors[i].key === key) {
            return i;
        }
    }
    return -1;
}

function findDescriptorByPath(descriptors, path) {
    var i;
    for (i = 0; i < descriptors.length; i++) {
        if (descriptors[i].path === path) {
            return i;
        }
    }
    return -1;
}

function writeJSONFile(file, value) {
    file.encoding = "UTF8";
    if (!file.open("w")) {
        throw new Error("Could not open " + file.fsName + " for writing.");
    }
    var failure = null;
    try {
        if (file.write(stringifyJSON(value, 0)) === false) {
            failure = new Error("Could not write " + file.fsName +
                (file.error ? ".\n" + file.error : "."));
        }
    } catch (writeError) {
        failure = writeError;
    }
    try {
        if (file.close() === false && !failure) {
            failure = new Error("Could not finish writing " + file.fsName +
                (file.error ? ".\n" + file.error : "."));
        }
    } catch (closeError) {
        if (!failure) {
            failure = closeError;
        }
    }
    if (failure) {
        throw failure;
    }
}

function readJSONFile(file) {
    file.encoding = "UTF8";
    if (!file.open("r")) {
        throw new Error("Could not open " + file.fsName);
    }
    var text;
    try {
        text = file.read();
    } finally {
        file.close();
    }
    return parseStrictJSON(text);
}

function parseStrictJSON(text) {
    var index = 0;

    function fail(message) {
        throw new Error("Invalid JSON at character " + (index + 1) + ": " + message);
    }

    function skipWhitespace() {
        while (index < text.length && /\s/.test(text.charAt(index))) {
            index++;
        }
    }

    function parseValue() {
        skipWhitespace();
        var ch = text.charAt(index);
        if (ch === '"') { return parseString(); }
        if (ch === "{") { return parseObject(); }
        if (ch === "[") { return parseArray(); }
        if (ch === "t" && text.substr(index, 4) === "true") { index += 4; return true; }
        if (ch === "f" && text.substr(index, 5) === "false") { index += 5; return false; }
        if (ch === "n" && text.substr(index, 4) === "null") { index += 4; return null; }
        if (ch === "-" || /[0-9]/.test(ch)) { return parseNumber(); }
        fail("expected a JSON value");
    }

    function parseString() {
        var result = "";
        index++;
        while (index < text.length) {
            var ch = text.charAt(index++);
            if (ch === '"') { return result; }
            if (ch === "\\") {
                if (index >= text.length) { fail("unfinished escape sequence"); }
                var escaped = text.charAt(index++);
                if (escaped === '"' || escaped === "\\" || escaped === "/") { result += escaped; }
                else if (escaped === "b") { result += "\b"; }
                else if (escaped === "f") { result += "\f"; }
                else if (escaped === "n") { result += "\n"; }
                else if (escaped === "r") { result += "\r"; }
                else if (escaped === "t") { result += "\t"; }
                else if (escaped === "u") {
                    var hex = text.substr(index, 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) { fail("invalid Unicode escape"); }
                    result += String.fromCharCode(parseInt(hex, 16));
                    index += 4;
                } else {
                    fail("invalid escape sequence");
                }
            } else {
                if (ch.charCodeAt(0) < 32) { fail("control character in string"); }
                result += ch;
            }
        }
        fail("unterminated string");
    }

    function parseNumber() {
        var remaining = text.substring(index);
        var match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
        if (!match) { fail("invalid number"); }
        index += match[0].length;
        return Number(match[0]);
    }

    function parseArray() {
        var result = [];
        index++;
        skipWhitespace();
        if (text.charAt(index) === "]") { index++; return result; }
        while (true) {
            result.push(parseValue());
            skipWhitespace();
            var ch = text.charAt(index++);
            if (ch === "]") { return result; }
            if (ch !== ",") { fail("expected ',' or ']'"); }
        }
    }

    function parseObject() {
        var result = {};
        index++;
        skipWhitespace();
        if (text.charAt(index) === "}") { index++; return result; }
        while (true) {
            skipWhitespace();
            if (text.charAt(index) !== '"') { fail("expected a quoted property name"); }
            var key = parseString();
            skipWhitespace();
            if (text.charAt(index++) !== ":") { fail("expected ':'"); }
            result[key] = parseValue();
            skipWhitespace();
            var ch = text.charAt(index++);
            if (ch === "}") { return result; }
            if (ch !== ",") { fail("expected ',' or '}'"); }
        }
    }

    var value = parseValue();
    skipWhitespace();
    if (index !== text.length) {
        fail("unexpected trailing content");
    }
    return value;
}

function stringifyJSON(value, depth) {
    var indent = repeatString("  ", depth);
    var nextIndent = repeatString("  ", depth + 1);
    var i;
    if (value === null) { return "null"; }
    if (typeof value === "string") { return '"' + escapeJSONString(value) + '"'; }
    if (typeof value === "number" || typeof value === "boolean") { return String(value); }
    if (value instanceof Array) {
        if (value.length === 0) { return "[]"; }
        var arrayParts = [];
        for (i = 0; i < value.length; i++) {
            arrayParts.push(nextIndent + stringifyJSON(value[i], depth + 1));
        }
        return "[\n" + arrayParts.join(",\n") + "\n" + indent + "]";
    }
    var objectParts = [];
    for (var key in value) {
        if (value.hasOwnProperty(key)) {
            objectParts.push(nextIndent + '"' + escapeJSONString(key) + '": ' + stringifyJSON(value[key], depth + 1));
        }
    }
    if (objectParts.length === 0) { return "{}"; }
    return "{\n" + objectParts.join(",\n") + "\n" + indent + "}";
}

function escapeJSONString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function repeatString(value, count) {
    var result = "";
    while (count-- > 0) { result += value; }
    return result;
}

function showCompletionReport(result, folder) {
    var message = "Batch complete.\n\nExported rows: " + result.completed +
        "\nSkipped rows: " + result.skipped +
        "\nRows with errors: " + result.errors.length +
        "\n\nOutput: " + folder.fsName;
    if (result.errors.length > 0) {
        message += "\n\n" + result.errors.slice(0, 8).join("\n");
        if (result.errors.length > 8) {
            message += "\n...and " + (result.errors.length - 8) + " more.";
        }
    }
    alert(message);
}

function formatError(error) {
    var message = error && error.message ? error.message : String(error);
    if (error && error.line) {
        message += " (line " + error.line + ")";
    }
    return message;
}

if (typeof IAWOA_TEST_MODE === "undefined" || !IAWOA_TEST_MODE) {
    main();
}
