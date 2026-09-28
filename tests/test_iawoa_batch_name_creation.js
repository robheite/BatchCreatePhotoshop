const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scriptPath = path.resolve(__dirname, "..", "IAWOA Batch Name Creation.jsx");
const source = fs.readFileSync(scriptPath, "utf8").replace(/^#target photoshop\s*$/m, "");

const storedFiles = new Map();
const existingFiles = new Set();

function TestFile(filePath) {
  this.fsName = filePath;
  this.name = filePath.replace(/^.*[\\/]/, "");
  this.mode = "";
  this.buffer = "";
}
Object.defineProperty(TestFile.prototype, "exists", {
  get() { return existingFiles.has(this.fsName) || storedFiles.has(this.fsName); },
});
TestFile.prototype.open = function open(mode) {
  this.mode = mode;
  this.buffer = mode === "r" ? (storedFiles.get(this.fsName) || "") : "";
  return mode !== "r" || this.exists;
};
TestFile.prototype.read = function read() { return this.buffer; };
TestFile.prototype.write = function write(value) {
  if (this.failWrite) {
    this.error = "simulated write failure";
    return false;
  }
  this.buffer += value;
  storedFiles.set(this.fsName, this.buffer);
  return true;
};
TestFile.prototype.close = function close() {
  if (this.failClose) {
    this.error = "simulated close failure";
    return false;
  }
  return true;
};

function TestFolder(folderPath) {
  this.fsName = folderPath;
  this.exists = true;
}
TestFolder.prototype.create = function create() { this.exists = true; return true; };
TestFolder.userData = { fsName: "C:/user-data" };

const invalidWatermarks = new Set();
const fakeDocuments = [];
function makeFakeDocument(filePath) {
  const document = {
    fullName: { fsName: filePath },
    layers: [{ visible: true, typename: "ArtLayer" }],
    closed: false,
    duplicate() {
      return makeFakeDocument(filePath + "#working-copy");
    },
    close() {
      document.closed = true;
      const index = fakeDocuments.indexOf(document);
      if (index >= 0) fakeDocuments.splice(index, 1);
      if (fakeApp.activeDocument === document) fakeApp.activeDocument = null;
      return true;
    },
  };
  fakeDocuments.push(document);
  fakeApp.activeDocument = document;
  return document;
}
const fakeApp = {
  documents: fakeDocuments,
  activeDocument: null,
  bringToFront() {},
  open(file) {
    if (invalidWatermarks.has(file.fsName)) {
      throw new Error("Photoshop could not open the test file");
    }
    return makeFakeDocument(file.fsName);
  },
};

const context = {
  IAWOA_TEST_MODE: true,
  File: TestFile,
  Folder: TestFolder,
  SaveOptions: { DONOTSAVECHANGES: 0 },
  app: fakeApp,
  alert() {},
};
vm.createContext(context);
vm.runInContext(source, context, { filename: scriptPath });

const parsed = context.parseCSV(
  '\uFEFFName,Charge,Visible\r\n"Doe, Jane","Said ""hello""",yes\r\nSmith,,no\r\n'
);
assert.deepStrictEqual(Array.from(parsed.headers), ["Name", "Charge", "Visible"]);
assert.deepStrictEqual(Array.from(parsed.rows[0]), ["Doe, Jane", 'Said "hello"', "yes"]);
assert.deepStrictEqual(Array.from(parsed.rows[1]), ["Smith", "", "no"]);
assert.throws(
  () => context.parseCSV("Name,Charge\nJane,Unquoted, comma\n"),
  /has 3 fields; the header has 2/
);

assert.strictEqual(context.isTruthy("YES"), true);
assert.strictEqual(context.isTruthy("visible"), true);
assert.strictEqual(context.isTruthy("0"), false);
assert.strictEqual(context.equalityValue(" A-B "), "a-b");
assert.notStrictEqual(context.equalityValue("A-B"), context.equalityValue("AB"));

assert.strictEqual(context.calculateFittedFontSize(100, 20, 500, 400, 0.98), 100);
assert.strictEqual(context.calculateFittedFontSize(100, 20, 500, 1000, 0.98), 49);
assert.strictEqual(context.calculateFittedFontSize(100, 60, 500, 1000, 0.98), 60);

const immediateFitRule = { enabled: false, minimumSize: 6, maximumSize: 212 };
assert.strictEqual(context.updateTextFitRule(immediateFitRule, true, true, "6"), "");
assert.deepStrictEqual(immediateFitRule, { enabled: true, minimumSize: 6, maximumSize: 212 });
assert.match(context.updateTextFitRule(immediateFitRule, true, true, "0"), /greater than 0/);
assert.match(context.updateTextFitRule(immediateFitRule, false, true, "6"), /paragraph text layer/);

assert.strictEqual(
  context.makeBaseName("{Name}_{row}", ["Name"], ["DURHAM / TEST"], 1),
  "DURHAM _ TEST_002"
);
assert.strictEqual(context.sanitizeFileName('  A:B*  '), "A_B_");
assert.strictEqual(context.sanitizeFileName("CON"), "_CON");
assert.doesNotThrow(() => context.validateFilenamePattern("{Name}_{row}", ["Name"]));
assert.throws(() => context.validateFilenamePattern("{Missing}", ["Name"]), /unknown CSV tokens/);
assert.strictEqual(context.ensureMappingExtension("Fronts"), "Fronts.mapping.json");
assert.strictEqual(context.ensureMappingExtension("Fronts.json"), "Fronts.mapping.json");
assert.strictEqual(context.ensureMappingExtension("Fronts.mapping.json"), "Fronts.mapping.json");

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(context.parseShowDirective("[show:Record Type=Player] PLAYER"))),
  { header: "Record Type", value: "Player", hasValue: true }
);
assert.strictEqual(context.stripDirective("[fit] NAME"), "NAME");

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(context.parseStrictJSON('{"name":"A\\nB","items":[1,true,null]}'))),
  { name: "A\nB", items: [1, true, null] }
);
assert.throws(() => context.parseStrictJSON('{"x":1}; alert("bad")'), /trailing content/);

const failedWrite = new TestFile("C:/user-data/failed-write.json");
failedWrite.failWrite = true;
assert.throws(() => context.writeJSONFile(failedWrite, { value: 1 }), /Could not write/);
const failedClose = new TestFile("C:/user-data/failed-close.json");
failedClose.failClose = true;
assert.throws(() => context.writeJSONFile(failedClose, { value: 1 }), /Could not finish writing/);

assert.throws(
  () => context.preflightBatch(
    { headers: ["Export Name"], rows: [["Alice"], ["Alice_trimmed"]] },
    {
      filePattern: "{Export Name}",
      outputFolder: { fsName: "C:/out" },
      fullPNG: true,
      trimmedPNG: true,
      pdf: false,
      proofJPG: false,
      conflictMode: 0,
    }
  ),
  /same output file/
);

existingFiles.add("D:/shared/watermark.psd");
TestFile.openDialog = () => new TestFile("D:/shared/watermark.psd");
const selectedWatermark = context.resolveWatermarkFile();
assert.strictEqual(selectedWatermark.fsName, "D:/shared/watermark.psd");
const settingsPath = "C:/user-data/IAWOA Batch Name Creation/settings.json";
assert.match(
  storedFiles.get(settingsPath),
  /D:\/shared\/watermark\.psd/
);

storedFiles.set(settingsPath, '{"version":1,"watermarkPath":"D:/missing/watermark.psd"}');
existingFiles.add("E:/new/watermark.png");
TestFile.openDialog = () => new TestFile("E:/new/watermark.png");
assert.strictEqual(context.resolveWatermarkFile().fsName, "E:/new/watermark.png");
assert.match(storedFiles.get(settingsPath), /E:\/new\/watermark\.png/);

TestFile.openDialog = () => { throw new Error("saved watermark should avoid a second prompt"); };
assert.strictEqual(context.resolveWatermarkFile().fsName, "E:/new/watermark.png");

const alreadyOpenWatermark = fakeApp.open(new TestFile("E:/new/watermark.png"));
const watermarkWorkingCopy = context.openWatermarkWorkingDocument(new TestFile("E:/new/watermark.png"));
assert.notStrictEqual(watermarkWorkingCopy, alreadyOpenWatermark);
assert.strictEqual(alreadyOpenWatermark.closed, false);
assert.strictEqual(fakeDocuments.includes(alreadyOpenWatermark), true);
watermarkWorkingCopy.close();
alreadyOpenWatermark.close();

storedFiles.set(settingsPath, '{"version":1,"watermarkPath":"G:/corrupt/watermark.psd"}');
existingFiles.add("G:/corrupt/watermark.psd");
invalidWatermarks.add("G:/corrupt/watermark.psd");
existingFiles.add("G:/valid/watermark.psd");
TestFile.openDialog = () => new TestFile("G:/valid/watermark.psd");
assert.strictEqual(context.resolveWatermarkFile().fsName, "G:/valid/watermark.psd");
assert.match(storedFiles.get(settingsPath), /G:\/valid\/watermark\.psd/);

storedFiles.delete(settingsPath);
existingFiles.add("H:/corrupt/watermark.png");
invalidWatermarks.add("H:/corrupt/watermark.png");
existingFiles.add("H:/valid/watermark.png");
const watermarkChoices = [
  new TestFile("H:/corrupt/watermark.png"),
  new TestFile("H:/valid/watermark.png"),
];
TestFile.openDialog = () => watermarkChoices.shift();
assert.strictEqual(context.resolveWatermarkFile().fsName, "H:/valid/watermark.png");
assert.match(storedFiles.get(settingsPath), /H:\/valid\/watermark\.png/);

storedFiles.set(settingsPath, '{"version":1,"watermarkPath":"F:/gone/watermark.psd"}');
TestFile.openDialog = () => null;
assert.strictEqual(context.resolveWatermarkFile(), null);
assert.match(storedFiles.get(settingsPath), /F:\/gone\/watermark\.psd/);

console.log("IAWOA batch helper tests passed.");
