// Vendored "en" vocabulary. FROZEN at 1.0.0: tables are indexed by position, so
// any edit, reorder or append changes generated output (docs/design.md 7.1, 11).
// All content is original or public domain; see PROVENANCE.md.

const freeze = (o) => {
  if (o !== null && typeof o === "object") for (const v of Object.values(o)) freeze(v);
  return Object.freeze(o);
};

export const en = freeze({
  firstNames: [
    "Ada", "Alan", "Amara", "Andre", "Anika", "Arjun", "Beatrix", "Bruno", "Camila", "Carlos",
    "Chiara", "Dana", "Darius", "Elena", "Emeka", "Farah", "Felix", "Fiona", "Gabriel", "Grace",
    "Hana", "Hector", "Ines", "Isaac", "Jamal", "Jasmine", "Joaquin", "Julia", "Kai", "Keiko",
    "Lena", "Leo", "Linnea", "Lucas", "Maya", "Mateo", "Mei", "Miles", "Nadia", "Noah",
    "Olga", "Omar", "Priya", "Quentin", "Rafael", "Rosa", "Sana", "Samuel", "Tessa", "Theo",
    "Uma", "Victor", "Wanda", "Wei", "Xavier", "Yara", "Yusuf", "Zara", "Zoe", "Ibrahim",
    "Harriet", "Ngozi", "Tomas", "Sofia",
    "Jos\u00e9", "Zo\u00eb", "S\u00f8ren", "Ren\u00e9e", "\u00c5sa", "Chlo\u00e9",
  ],
  lastNames: [
    "Abbott", "Adeyemi", "Alvarez", "Andersson", "Bauer", "Bennett", "Brooks", "Castillo", "Chen", "Cohen",
    "Dalton", "Dubois", "Eriksen", "Fischer", "Flores", "Garcia", "Gupta", "Hansen", "Haruna", "Hughes",
    "Ibarra", "Jensen", "Kapoor", "Keller", "Kim", "Larsen", "Lopez", "Marsh", "Mbeki", "Moreau",
    "Nakamura", "Novak", "Okafor", "Olsen", "Ortega", "Patel", "Petrov", "Quinn", "Ramos", "Reyes",
    "Rossi", "Saito", "Santos", "Schmidt", "Silva", "Singh", "Tanaka", "Torres", "Underwood", "Vega",
    "Wagner", "Whitfield", "Wright", "Xu", "Yamamoto", "Young", "Zhang", "Ziegler", "Hartley", "Lindqvist",
    "Okonkwo", "Marchetti", "Delacroix", "Barnes",
    "M\u00fcller", "\u00c7elik", "N\u00fa\u00f1ez", "\u00d8stergaard", "B\u00e9ranger", "\u0141ukasik",
  ],
  emailDomains: ["example.com", "example.org", "example.net", "mail.example.com", "inbox.example.org"],
  tlds: ["com", "org", "net", "io", "dev"],
  places: [
    { city: "Springfield", state: "Illinois", code: "IL", country: "United States", zip: "627" },
    { city: "Riverton", state: "Wyoming", code: "WY", country: "United States", zip: "825" },
    { city: "Lakeside", state: "California", code: "CA", country: "United States", zip: "920" },
    { city: "Fairview", state: "Oregon", code: "OR", country: "United States", zip: "970" },
    { city: "Georgetown", state: "Texas", code: "TX", country: "United States", zip: "786" },
    { city: "Clinton", state: "Iowa", code: "IA", country: "United States", zip: "527" },
    { city: "Madison", state: "Wisconsin", code: "WI", country: "United States", zip: "537" },
    { city: "Franklin", state: "Tennessee", code: "TN", country: "United States", zip: "370" },
    { city: "Salem", state: "Massachusetts", code: "MA", country: "United States", zip: "019" },
    { city: "Bristol", state: "Connecticut", code: "CT", country: "United States", zip: "060" },
    { city: "Oxford", state: "Ohio", code: "OH", country: "United States", zip: "450" },
    { city: "Ashland", state: "Kentucky", code: "KY", country: "United States", zip: "411" },
    { city: "Kingston", state: "New York", code: "NY", country: "United States", zip: "124" },
    { city: "Dover", state: "Delaware", code: "DE", country: "United States", zip: "199" },
    { city: "Burlington", state: "Vermont", code: "VT", country: "United States", zip: "054" },
    { city: "Milton", state: "Georgia", code: "GA", country: "United States", zip: "300" },
    { city: "Greenville", state: "South Carolina", code: "SC", country: "United States", zip: "296" },
    { city: "Auburn", state: "Alabama", code: "AL", country: "United States", zip: "368" },
    { city: "Centerville", state: "Utah", code: "UT", country: "United States", zip: "840" },
    { city: "Arlington", state: "Virginia", code: "VA", country: "United States", zip: "222" },
    { city: "Hamilton", state: "Ontario", code: "ON", country: "Canada", zip: "L8P" },
    { city: "Kelowna", state: "British Columbia", code: "BC", country: "Canada", zip: "V1Y" },
    { city: "Brandon", state: "Manitoba", code: "MB", country: "Canada", zip: "R7A" },
    { city: "Fredericton", state: "New Brunswick", code: "NB", country: "Canada", zip: "E3B" },
  ],
  streets: [
    "Main", "Oak", "Maple", "Cedar", "Elm", "Pine", "Washington", "Lake", "Hill", "Park",
    "Walnut", "Sunset", "Railroad", "Church", "Willow", "River", "Meadow", "Highland", "Spring", "Chestnut",
  ],
  streetSuffixes: ["St", "Ave", "Rd", "Ln", "Blvd", "Way", "Ct", "Dr"],
  jobTitles: [
    "Software Engineer", "Product Manager", "Data Analyst", "Designer", "Accountant", "Nurse", "Electrician",
    "Teacher", "Marketing Lead", "Operations Manager", "Support Specialist", "Chef", "Architect", "Librarian",
    "Mechanic", "Researcher", "Editor", "Pharmacist", "Logistics Coordinator", "Sales Representative",
  ],
  industries: [
    "Software", "Healthcare", "Logistics", "Education", "Retail", "Manufacturing", "Finance", "Energy",
    "Media", "Hospitality", "Agriculture", "Construction",
  ],
  companyHeads: [
    "Harbor", "Summit", "Juniper", "Northwind", "Bluebird", "Ironwood", "Lantern", "Meridian", "Cobalt", "Willow",
    "Granite", "Evergreen", "Beacon", "Foxglove", "Kestrel", "Pinnacle", "Redwood", "Silverline", "Tidewater", "Brightside",
  ],
  companySuffixes: ["Labs", "Industries", "Group", "Partners", "Systems", "Works", "Holdings", "Collective", "Co", "Studio"],
  productAdjectives: [
    "Compact", "Classic", "Deluxe", "Portable", "Rustic", "Smart", "Sturdy", "Sleek", "Organic", "Vintage",
    "Ergonomic", "Everyday", "Premium", "Lightweight", "Handmade", "Modular",
  ],
  productNouns: [
    "Lamp", "Backpack", "Kettle", "Notebook", "Chair", "Mug", "Speaker", "Blanket", "Planter", "Wallet",
    "Bottle", "Clock", "Toolkit", "Candle", "Headphones", "Keyboard", "Umbrella", "Tote",
  ],
  words: [
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do",
    "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua", "enim",
    "ad", "minim", "veniam", "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi", "aliquip",
    "ex", "ea", "commodo", "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate",
    "velit", "esse", "cillum", "eu", "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat",
    "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia", "deserunt", "mollit", "anim",
    "id", "est", "laborum", "at", "vero", "eos", "accusamus", "iusto", "odio", "dignissimos",
    "ducimus", "blanditiis", "praesentium", "voluptatum", "deleniti", "atque", "corrupti", "quos", "dolores", "quas",
    "molestias", "excepturi", "occaecati", "cupiditate", "provident", "similique", "mollitia", "animi", "perspiciatis", "unde",
    "omnis", "iste", "natus", "error", "voluptatem", "accusantium", "doloremque", "laudantium", "totam", "rem",
  ],
  status: ["draft", "pending", "active", "published", "archived", "closed", "open", "resolved"],
  role: ["admin", "editor", "member", "viewer", "owner", "moderator", "guest"],
  currency: ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK"],
  locale: ["en-US", "en-GB", "fr-FR", "de-DE", "es-ES", "pt-BR", "ja-JP", "sv-SE"],
  language: ["English", "French", "German", "Spanish", "Portuguese", "Japanese", "Swedish", "Italian"],
  colors: ["red", "orange", "yellow", "green", "teal", "blue", "indigo", "violet", "pink", "brown", "black", "white", "gray", "silver"],
});

export const LOCALES = Object.freeze({ en });
