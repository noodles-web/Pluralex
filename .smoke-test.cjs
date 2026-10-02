const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");
const js = html.match(/^  <script>$(.*?)^  <\/script>$/ms)[1];

if (js.includes("i2(")) {
  console.error("FAIL: leftover i2 helper");
  process.exit(1);
}

const parts = js.split("/* ==========================================================");
function sec(n) {
  const p = parts.find((s) => s.trimStart().startsWith(n + "."));
  if (!p) throw new Error("section " + n + " not found");
  return "/*" + p;
}
const code = [sec(2), sec(4), sec(5)].join("\n");

const document = { getElementById: () => null, querySelector: () => null };
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.log("FAIL " + name + (extra !== undefined ? " -> " + extra : ""));
  }
}

const load = new Function("document", "window", code + "\nreturn {norm, titleFromFilename, fmt, fallbackCover, scoreMatch, readID3, decodeText};");
const api = load(document, { console });
const { norm, titleFromFilename, fmt, fallbackCover, scoreMatch, readID3, decodeText } = api;

check("norm accents", norm("Désenchantée") === "desenchantee", norm("Désenchantée"));
check("norm punctuation", norm("Do I Wanna Know?") === "doiwannaknow", norm("Do I Wanna Know?"));
check("filename cleanup", titleFromFilename("01 - Blinding Lights.mp3") === "Blinding Lights", titleFromFilename("01 - Blinding Lights.mp3"));
check("filename underscores", titleFromFilename("get_lucky.mp3") === "get lucky", titleFromFilename("get_lucky.mp3"));
check("fmt", fmt(203) === "3:23" && fmt(0) === "0:00", fmt(203));
check("fallback cover", fallbackCover({ title: "Bad Guy", artist: "Billie Eilish" }).startsWith("data:image/svg+xml"), "no");

const t = { title: "Blinding Lights", artist: "The Weeknd", album: "After Hours" };
check("match exact", scoreMatch({ title: "Blinding Lights", artist: "The Weeknd", filename: "a.mp3" }, t) === 3, scoreMatch({ title: "Blinding Lights", artist: "The Weeknd", filename: "a.mp3" }, t));
check("match case/space", scoreMatch({ title: "blinding  lights", artist: "", filename: "a.mp3" }, t) >= 3, scoreMatch({ title: "blinding  lights", artist: "", filename: "a.mp3" }, t));
check("match via filename", scoreMatch({ title: null, artist: null, filename: "The Weeknd - Blinding Lights.mp3" }, t) >= 2, scoreMatch({ title: null, artist: null, filename: "The Weeknd - Blinding Lights.mp3" }, t));
check("other song = 0", scoreMatch({ title: "Kids", artist: "MGMT", filename: "kids.mp3" }, t) === 0, scoreMatch({ title: "Kids", artist: "MGMT", filename: "kids.mp3" }, t));
check(
  "soft artist (feat.)",
  scoreMatch({ title: "Uptown Funk", artist: "Bruno Mars", filename: "x.mp3" }, { title: "Uptown Funk", artist: "Mark Ronson feat. Bruno Mars" }) >= 3,
  scoreMatch({ title: "Uptown Funk", artist: "Bruno Mars", filename: "x.mp3" }, { title: "Uptown Funk", artist: "Mark Ronson feat. Bruno Mars" })
);

// UTF-16 decoding path (encoding byte 1 + BOM)
const utf16 = Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), Buffer.from("Mylène Farmer", "utf16le")]);
check("utf16 text", decodeText(utf16) === "Mylène Farmer", JSON.stringify(decodeText(utf16)));

// --- synthetic ID3v2.3 tag ---
function frame(id, payload) {
  const hdr = Buffer.alloc(10);
  hdr.write(id, 0, "latin1");
  hdr.writeUInt32BE(payload.length, 4);
  return Buffer.concat([hdr, payload]);
}
function syncsafe(n) {
  const b = Buffer.alloc(4);
  b[0] = (n >> 21) & 0x7f;
  b[1] = (n >> 14) & 0x7f;
  b[2] = (n >> 7) & 0x7f;
  b[3] = n & 0x7f;
  return b;
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const apic = Buffer.concat([
  Buffer.from([0x00]),
  Buffer.from("image/jpeg\u0000", "latin1"),
  Buffer.from([0x03]),
  Buffer.from("cover\u0000", "latin1"),
  jpeg,
]);
const body = Buffer.concat([
  frame("TIT2", Buffer.concat([Buffer.from([0x00]), Buffer.from("Blinding Lights", "latin1")])),
  frame("TPE1", Buffer.concat([Buffer.from([0x00]), Buffer.from("The Weeknd", "latin1")])),
  frame("TALB", Buffer.concat([Buffer.from([0x00]), Buffer.from("After Hours", "latin1")])),
  frame("APIC", apic),
]);
const head = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), syncsafe(body.length)]);
const tagged = Buffer.concat([head, body, Buffer.alloc(2000, 7)]);
const fakeTagged = {
  name: "01 - Blinding Lights.mp3",
  size: tagged.length,
  slice: (a, b) => ({ arrayBuffer: () => Promise.resolve(tagged.buffer.slice(tagged.byteOffset + a, tagged.byteOffset + (b === undefined ? tagged.length : b))) }),
};

const plain = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(4000)]);
const fakePlain = {
  name: "02_kids - MGMT.mp3",
  size: plain.length,
  slice: (a, b) => ({ arrayBuffer: () => Promise.resolve(plain.buffer.slice(plain.byteOffset + a, plain.byteOffset + b)) }),
};

readID3(fakeTagged)
  .then((r) => {
    check("ID3 title", r.title === "Blinding Lights", JSON.stringify(r.title));
    check("ID3 artist", r.artist === "The Weeknd", JSON.stringify(r.artist));
    check("ID3 album", r.album === "After Hours", JSON.stringify(r.album));
    check("ID3 cover present", !!r.cover, "cover=" + !!r.cover);
    return r.cover ? r.cover.arrayBuffer() : Promise.resolve(null);
  })
  .then((buf) => {
    if (buf) check("ID3 cover bytes", Buffer.from(buf).equals(jpeg), "len=" + buf.byteLength);
    return readID3(fakePlain);
  })
  .then((r2) => {
    check("no-tag fallback title", r2.title === "kids - MGMT", JSON.stringify(r2.title));
    check("no-tag artist null", r2.artist === null, JSON.stringify(r2.artist));
    console.log(failures ? "\n" + failures + " FAILURES" : "\nALL TESTS PASSED");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error("THREW:", e);
    process.exit(1);
  });
