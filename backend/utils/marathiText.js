// Latin → Devanagari rendering for Marathi cook-facing messages.
//
// Customers type addresses, society names and landmarks in whichever script
// their keyboard offers — usually Latin. Cooks read Devanagari, so the Marathi
// WhatsApp copy renders those values in Devanagari. This is a *display*
// transliteration: identifiers, phone numbers and Google Maps links always
// keep the original value (a Latin map query resolves more reliably).
//
// Already-Devanagari text passes through untouched. Mixed text (e.g. a
// Marathi address containing "Near") only transliterates the Latin runs.
// Digits are deliberately left as ASCII: flat numbers, pincodes and booking
// references must stay unambiguous.

// Common address vocabulary + Pune-region place names. Exact-word matches
// beat phonetic rules, so the words cooks see most often are spelled the way
// Marathi readers expect (सोसायटी, पुणे, जवळ …).
const WORD_MAP = {
  // Address vocabulary
  flat: "फ्लॅट",
  no: "क्र",
  house: "हाऊस",
  home: "होम",
  plot: "प्लॉट",
  room: "खोली",
  floor: "मजला",
  building: "बिल्डिंग",
  bldg: "बिल्डिंग",
  apartment: "अपार्टमेंट",
  apartments: "अपार्टमेंट्स",
  society: "सोसायटी",
  soc: "सोसायटी",
  complex: "कॉम्प्लेक्स",
  colony: "कॉलनी",
  col: "कॉलनी",
  nagar: "नगर",
  park: "पार्क",
  chowk: "चौक",
  naka: "नाका",
  road: "रोड",
  street: "स्ट्रीट",
  lane: "लेन",
  path: "पथ",
  marg: "मार्ग",
  near: "जवळ",
  behind: "मागे",
  opposite: "समोर",
  beside: "शेजारी",
  village: "गाव",
  area: "परिसर",
  phase: "फेज",
  sector: "सेक्टर",
  block: "ब्लॉक",
  wing: "विंग",
  shop: "दुकान",
  temple: "मंदिर",
  school: "शाळा",
  college: "कॉलेज",
  hospital: "रुग्णालय",
  market: "बाजार",
  station: "स्टेशन",
  garden: "गार्डन",
  ground: "मैदान",
  gate: "गेट",
  tower: "टॉवर",
  heights: "हाइट्स",
  residency: "रेसिडेन्सी",
  enclave: "एन्क्लेव्ह",
  plaza: "प्लाझा",
  arcade: "आर्केड",
  corner: "कोपरा",
  main: "मुख्य",
  new: "नवीन",
  old: "जुने",
  sai: "साई",
  om: "ॐ",
  shanti: "शांती",
  sukh: "सुख",
  sagar: "सागर",
  vasant: "वसंत",
  vishal: "विशाल",
  prashant: "प्रशांत",
  nirmal: "निर्मल",
  krishna: "कृष्ण",
  ram: "राम",
  laxmi: "लक्ष्मी",
  laxman: "लक्ष्मण",
  ganesh: "गणेश",
  vitthal: "विठ्ठल",
  rao: "राव",
  shivaji: "शिवाजी",
  gandhi: "गांधी",
  nehru: "नेहरू",
  subhash: "सुभाष",
  savarkar: "सावरकर",
  tilak: "टिळक",
  ambedkar: "आंबेडकर",
  phule: "फुले",
  shahu: "शाहू",
  rajaram: "राजाराम",
  jijamata: "जिजामाता",
  sahyadri: "सह्याद्री",
  sunshine: "सनशाईन",
  blossom: "ब्लॉसम",
  green: "ग्रीन",
  valley: "व्हॅली",
  view: "व्ह्यू",
  mart: "मार्ट",
  city: "सिटी",
  pride: "प्राइड",
  paradise: "पॅराडाइज",
  palace: "पॅलेस",
  royal: "रॉयल",
  star: "स्टार",
  golden: "गोल्डन",
  silver: "सिल्व्हर",
  diamond: "डायमंड",
  // Cities / well-known localities
  pune: "पुणे",
  mumbai: "मुंबई",
  thane: "ठाणे",
  nashik: "नाशिक",
  nagpur: "नागपूर",
  maharashtra: "महाराष्ट्र",
  pimpri: "पिंपरी",
  chinchwad: "चिंचवड",
  sangvi: "सांगवी",
  kothrud: "कोथरूड",
  hadapsar: "हडपसर",
  wakad: "वाकड",
  hinjewadi: "हिंजवडी",
  baner: "बाणेर",
  aundh: "औंध",
  kharadi: "खराडी",
  magarpatta: "मगरपट्टा",
  kalyani: "कल्याणी",
  bhosari: "भोसरी",
  nigdi: "निगडी",
  akurdi: "आकुर्डी",
  deccan: "डेक्कन",
  koregaon: "कोरेगाव",
  yerwada: "येरवडा",
  kondhwa: "कोंढवा",
  katraj: "कात्रज",
  warje: "वारजे",
  karve: "कर्वे",
  dhanori: "धानोरी",
  lohegaon: "लोहेगाव",
  wagholi: "वाघोली",
  undri: "उंड्री",
  pisoli: "पिसोळी",
  handewadi: "हांडेवाडी",
  ambegaon: "आंबेगाव",
  narhe: "नऱ्हे",
  dhankawadi: "धनकवडी",
  bibwewadi: "बिबवेवाडी",
  swargate: "स्वारगेट",
  shivajinagar: "शिवाजीनगर",
  viman: "विमान",
  camp: "कॅम्प",
  ghorpadi: "घोरपडी",
  mundhwa: "मुंढवा",
  keshav: "केशव",
  vishrantwadi: "विश्रांतवाडी",
  bopodi: "बोपोडी",
  bavdhan: "बावधन",
  pashan: "पाषाण",
  sus: "सूस",
  balewadi: "बालेवाडी",
  tathawade: "ताथवडे",
  punawale: "पुनावळे",
  ravet: "रावेत",
  kiwi: "किवळे",
  talegaon: "तळेगाव",
  lonavala: "लोणावळा",
  satara: "सातारा",
  kolhapur: "कोल्हापूर",
  solapur: "सोलापूर",
  ahmednagar: "अहमदनगर",
  aurangabad: "औरंगाबाद",
  jalgaon: "जळगाव",
  amravati: "अमरावती",
  kalyan: "कल्याण",
  dombivli: "डोंबिवली",
  panvel: "पनवेल",
  navi: "नवी",
};

// Spoken letter names (used for initials: "B-402" → "बी-402").
const LETTER_NAMES = {
  a: "ए",
  b: "बी",
  c: "सी",
  d: "डी",
  e: "ई",
  f: "एफ",
  g: "जी",
  h: "एच",
  i: "आय",
  j: "जे",
  k: "के",
  l: "एल",
  m: "एम",
  n: "एन",
  o: "ओ",
  p: "पी",
  q: "क्यू",
  r: "आर",
  s: "एस",
  t: "टी",
  u: "यू",
  v: "वी",
  w: "डब्ल्यू",
  x: "एक्स",
  y: "वाय",
  z: "झेड",
};

// Longest match wins — clusters before their component letters.
const CONSONANTS = [
  ["sch", "श"],
  ["ksh", "क्ष"],
  ["dny", "ज्ञ"],
  ["chh", "छ"],
  ["shr", "श्र"],
  ["sh", "श"],
  ["ch", "च"],
  ["kh", "ख"],
  ["gh", "घ"],
  ["th", "थ"],
  ["dh", "ध"],
  ["ph", "फ"],
  ["bh", "भ"],
  ["jh", "झ"],
  ["zh", "झ"],
  ["str", "स्ट्र"],
  ["spr", "स्प्र"],
  ["tr", "त्र"],
  ["dr", "द्र"],
  ["pr", "प्र"],
  ["br", "ब्र"],
  ["kr", "क्र"],
  ["gr", "ग्र"],
  ["fr", "फ्र"],
  ["vr", "व्र"],
  ["kl", "क्ल"],
  ["pl", "प्ल"],
  ["bl", "ब्ल"],
  ["gl", "ग्ल"],
  ["sl", "स्ल"],
  ["st", "स्ट"],
  ["sp", "स्प"],
  ["sk", "स्क"],
  ["sm", "स्म"],
  ["sn", "स्न"],
  ["sw", "स्व"],
  ["tw", "ट्व"],
  ["dw", "ड्व"],
  ["gw", "ग्व"],
  ["kw", "क्व"],
  ["b", "ब"],
  ["c", "क"],
  ["d", "ड"],
  ["f", "फ"],
  ["g", "ग"],
  ["h", "ह"],
  ["j", "ज"],
  ["k", "क"],
  ["l", "ल"],
  ["m", "म"],
  ["n", "न"],
  ["p", "प"],
  ["q", "क"],
  ["r", "र"],
  ["s", "स"],
  ["t", "ट"],
  ["v", "व"],
  ["w", "व"],
  ["x", "क्स"],
  ["y", "य"],
  ["z", "झ"],
];

// [latin, independent form, matra form]
const VOWELS = [
  ["aa", "आ", "ा"],
  ["ai", "ऐ", "ै"],
  ["au", "औ", "ौ"],
  ["ee", "ई", "ी"],
  ["oo", "ऊ", "ू"],
  ["ou", "औ", "ौ"],
  ["ea", "ई", "ी"],
  ["ie", "ई", "ी"],
  ["a", "अ", ""],
  ["e", "ए", "े"],
  ["i", "इ", "ि"],
  ["o", "ओ", "ो"],
  ["u", "उ", "ु"],
];

// Names use dental t/d (Aditi → अदिती, Deepak → दीपक). Addresses keep the
// retroflex forms above (street/plot names read better that way).
const NAME_CONSONANTS = CONSONANTS.map(([latin, deva]) =>
  latin === "t" ? [latin, "त"] : latin === "d" ? [latin, "द"] : [latin, deva]
);

const matchConsonant = (rest, table = CONSONANTS) => {
  for (const [latin, deva] of table) {
    if (!rest.startsWith(latin)) continue;
    // English soft c/g before e, i, y: "society" → सोसायटी, "page" → पेज.
    if (latin === "c" && /^[eiy]/.test(rest.slice(1))) return { len: 1, deva: "स" };
    if (latin === "g" && /^[eiy]/.test(rest.slice(1))) return { len: 1, deva: "ज" };
    return { len: latin.length, deva };
  }
  return null;
};

const matchVowel = (rest) => {
  for (const [latin, indep, matra] of VOWELS) {
    if (rest.startsWith(latin)) return { len: latin.length, indep, matra };
  }
  return null;
};

const transliterateWord = (word, { name = false, useWordMap = true } = {}) => {
  const lower = word.toLowerCase().replace(/['’]/g, "");
  if (useWordMap && WORD_MAP[lower]) return WORD_MAP[lower];
  // Short all-caps runs are initials/abbreviations, not words: "MH", "B".
  if (/^[A-Z]{1,4}$/.test(word)) {
    return [...word].map((ch) => LETTER_NAMES[ch.toLowerCase()] || ch).join("");
  }
  const table = name ? NAME_CONSONANTS : CONSONANTS;
  let out = "";
  let i = 0;
  let prevWasConsonant = false;
  while (i < lower.length) {
    const rest = lower.slice(i);
    const consonant = matchConsonant(rest, table);
    if (consonant) {
      out += consonant.deva;
      i += consonant.len;
      prevWasConsonant = true;
      continue;
    }
    const vowel = matchVowel(rest);
    if (vowel) {
      out += prevWasConsonant ? vowel.matra : vowel.indep;
      i += vowel.len;
      prevWasConsonant = false;
      continue;
    }
    // Unknown character (hyphen, apostrophe, …): keep it as a separator.
    if (!/\s/.test(rest[0])) out += rest[0];
    else out += " ";
    i += 1;
    prevWasConsonant = false;
  }
  // Names in Latin script almost always end in a pronounced vowel:
  // Neha → नेहा, Aditi → अदिती, Guru → गुरू. Address mode leaves them as-is.
  if (name) {
    if (/a$/.test(lower) && /[\u0915-\u0939\u0958-\u095F\u0979-\u097F]$/.test(out)) out += "ा";
    if (/i$/.test(lower)) out = out.replace(/ि$/, "ी");
    if (/u$/.test(lower)) out = out.replace(/ु$/, "ू");
  }
  return out;
};

// Transliterate every Latin run; preserve Devanagari, digits and punctuation.
// `useWordMap: false` skips the address vocabulary (used for notes/names,
// where a word like "no" must not become the address abbreviation "क्र").
const toDevanagari = (value, { useWordMap = true } = {}) => {
  const text = String(value ?? "");
  if (!text) return text;
  return text.replace(/[A-Za-z]+|[^A-Za-z]+/g, (chunk) => {
    if (!/^[A-Za-z]+$/.test(chunk)) return chunk.replace(/&/g, "आणि");
    return transliterateWord(chunk, { useWordMap });
  });
};

// Name fallback: name-tuned consonants, final-vowel lengthening, no address
// vocabulary. Callers try a name dictionary first (see marathiNames.js).
const transliterateNameWord = (word) =>
  transliterateWord(word, { name: true, useWordMap: false });

module.exports = { toDevanagari, transliterateNameWord };
