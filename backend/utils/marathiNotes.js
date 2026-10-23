// Cook-facing Marathi rendering for free-text booking notes.
//
// Customers type notes in English ("less spicy", "no onion garlic"), often on
// a phone keyboard. A transliteration alone ("लेसस स्पिसय") is unreadable, so
// known cooking instructions are translated; anything else falls back to
// Devanagari transliteration rather than being dropped.
//
// Rules are applied longest-first. The result is always a single-language
// string for the cook (Marathi words + transliterated names/ingredients).

const { toDevanagari } = require("./marathiText");

const NOTE_RULES = [
  // Onion / garlic combinations (both orders, with or without "no"/"without").
  [/\b(?:no|without)\s+onion\s*(?:,|and|&)?\s*(?:(?:no|without)\s+)?garlic\b/gi, "कांदा-लसूण नको"],
  [/\b(?:no|without)\s+garlic\s*(?:,|and|&)?\s*(?:(?:no|without)\s+)?onion\b/gi, "कांदा-लसूण नको"],
  [/\b(?:no|without)\s+onion\b/gi, "कांदा नको"],
  [/\b(?:no|without)\s+garlic\b/gi, "लसूण नको"],

  // Heat level
  [/\b(?:extra|very|more|high)\s+(?:spicy|spice)\b/gi, "जास्त तिखट"],
  [/\bmedium\s+(?:spicy|spice)\b/gi, "मध्यम तिखट"],
  [/\b(?:less|low|mild|not\s+too|slightly)\s+(?:spicy|spice)\b/gi, "कमी तिखट"],
  [/\b(?:no|without|zero)\s+(?:spicy|spice)\b/gi, "तिखट नको"],
  [/\bmild\b/gi, "कमी तिखट"],
  [/\bspicy\b/gi, "तिखट"],

  // Egg / oil / salt / sugar
  [/\b(?:no|without)\s+(?:eggs?|anda)\b/gi, "अंडे नको"],
  [/\beggless\b/gi, "अंडे नको"],
  [/\buse\s+(?:less|low|reduced?)\s+oil\b/gi, "कमी तेल वापरा"],
  [/\b(?:less|low|reduced?)\s+oil\b/gi, "कमी तेल"],
  [/\buse\s+(?:less|low)\s+salt\b/gi, "कमी मीठ वापरा"],
  [/\buse\s+(?:less|low)\s+sugar\b/gi, "कमी साखर वापरा"],
  [/\b(?:no|without)\s+oil\b/gi, "तेल नको"],
  [/\boil\s+free\b/gi, "तेल नको"],
  [/\b(?:less|low)\s+salt\b/gi, "कमी मीठ"],
  [/\b(?:no|without)\s+salt\b/gi, "मीठ नको"],
  [/\bsalt\s+free\b/gi, "मीठ नको"],
  [/\b(?:less|low)\s+sugar\b/gi, "कमी साखर"],
  [/\b(?:no|without)\s+sugar\b/gi, "साखर नको"],
  [/\bsugar\s+free\b/gi, "साखर नको"],
  [/\bsweet\b/gi, "गोड"],

  // Diet / allergies
  [/\bnon[\s-]?veg(?:etarian)?\b/gi, "मांसाहारी"],
  [/\bvegan\b/gi, "व्हीगन"],
  [/\bpure\s+veg(?:etarian)?\b/gi, "शुद्ध शाकाहारी"],
  [/\bveg(?:etarian)?\b/gi, "शाकाहारी"],
  [/\begg(?:etarian)\b/gi, "अंडाहारी"],
  [/\bgluten[\s-]?free\b/gi, "ग्लूटेन-मुक्त"],
  [/\bdiabetic\b/gi, "मधुमेही"],
  [/\bpeanut\s+allergy\b/gi, "शेंगदाणा अ‍ॅलर्जी"],
  [/\b(?:no|without)\s+peanuts?\b/gi, "शेंगदाणे नको"],
  [/\b(?:no|without)\s+(?:dairy|milk)\b/gi, "दूध नको"],
  [/\bdairy[\s-]?free\b/gi, "दूध नको"],
  [/\b(?:no|without)\s+coriander\b/gi, "कोथिंबीर नको"],
  [/\b(?:no|without)\s+coconut\b/gi, "खोबरे नको"],
  [/\b(?:no|without)\s+(?:chilli|chili)\b/gi, "मिरची नको"],
  [/\b(?:no|without)\s+masala\b/gi, "मसाला नको"],
  [/\bjain\b/gi, "जैन"],

  // Practical instructions
  [/\b(?:please\s+)?come\s+early\b/gi, "कृपया लवकर या"],
  [/\bcall\s+before(?:\s+coming)?\b/gi, "येण्यापूर्वी कॉल करा"],
  [/\bring\s+the\s+bell\b/gi, "बेल वाजवा"],
  [/\bground\s+floor\b/gi, "तळमजला"],
  [/\b(?:1st|first)\s+floor\b/gi, "पहिला मजला"],
  [/\b(?:2nd|second)\s+floor\b/gi, "दुसरा मजला"],
  [/\b(?:3rd|third)\s+floor\b/gi, "तिसरा मजला"],
  [/\b(?:4th|fourth)\s+floor\b/gi, "चौथा मजला"],
  [/\bcook\s+for\s+(\d+)\s+people\b/gi, "$1 लोकांसाठी स्वयंपाक"],
  [/\bfor\s+(\d+)\s+people\b/gi, "$1 लोकांसाठी"],
  [/\b(\d+)\s+people\b/gi, "$1 लोक"],
];

// Generic "no <ingredient>" for ingredients outside the phrase list. Only
// matches when the ingredient ends a clause, so "no tomato sauce" is not
// reordered into "tomato नको sauce".
const INGREDIENTS = {
  tomato: "टोमॅटो",
  potato: "बटाटा",
  brinjal: "वांगे",
  cabbage: "कोबी",
  cauliflower: "फुलकोबी",
  peas: "वाटाणा",
  carrot: "गाजर",
  beetroot: "बीट",
  spinach: "पालक",
  mushroom: "मशरूम",
  soya: "सोया",
  paneer: "पनीर",
  butter: "लोणी",
  ghee: "तूप",
  curd: "दही",
  yogurt: "दही",
  cheese: "चीज",
  cream: "क्रीम",
  cashew: "काजू",
  almond: "बदाम",
  raisins: "मनुका",
  nuts: "सुकामेवा",
  sesame: "तीळ",
  mustard: "मोहरी",
  cumin: "जिरे",
  turmeric: "हळद",
  ginger: "आले",
  mint: "पुदिना",
  lemon: "लिंबू",
  tamarind: "चिंच",
  jaggery: "गूळ",
  besan: "बेसन",
  maida: "मैदा",
  rice: "भात",
  wheat: "गहू",
  onion: "कांदा",
  garlic: "लसूण",
  egg: "अंडे",
  milk: "दूध",
  chilli: "मिरची",
  chili: "मिरची",
  coriander: "कोथिंबीर",
  coconut: "खोबरे",
};

const toMarathiNote = (value) => {
  let out = String(value ?? "").trim();
  if (!out) return "";
  for (const [pattern, replacement] of NOTE_RULES) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(
    /\b(?:no|without)\s+([A-Za-z]+)\b(?=\s*(?:[,.;!]|$))/gi,
    (match, word) => {
      const marathi = INGREDIENTS[word.toLowerCase()];
      return marathi ? `${marathi} नको` : match;
    }
  );
  out = out
    .replace(/\band\b/gi, "आणि")
    .replace(/\bwith\b/gi, "सोबत")
    .replace(/\bwithout\b/gi, "शिवाय")
    .replace(/\bplease\b/gi, "कृपया")
    .replace(/\bonly\b/gi, "फक्त");
  // Anything still in Latin is a dish/brand/name: transliterate, do not drop.
  return toDevanagari(out, { useWordMap: false });
};

module.exports = { toMarathiNote };
