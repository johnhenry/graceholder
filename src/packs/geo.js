// Geo pack: coherent place data. One persona slot ("place") selects a real city; the city's
// region, country, coordinates, time zone, postal prefix and area code all come from that row, so
// every field of an entity agrees. Hand-entered facts (see src/packs/PROVENANCE.md). FROZEN at 1.0.0.
//
// Coordinates are approximate city centres (about 0.01 degree); they are placeholders, not for navigation.
// Phone numbers use the right country code and shape. Reserved fictional ranges are used for the
// US and Canada (555-01xx), the United Kingdom (Ofcom drama ranges) and Australia (5550 xxxx); for
// every other country the numbers are well-formed but NOT guaranteed to be unassigned.

const freeze = (o) => {
  if (o !== null && typeof o === "object") for (const v of Object.values(o)) freeze(v);
  return Object.freeze(o);
};

// [code, name, calling code, postal suffix pattern, phone template ({ac} = the city's area code), address style]
// postal = the city's prefix + the suffix pattern ("#" digit, "A" letter, anything else literal).
// address style "us": street, city, REGION postal. "eu": street, postal city.
const geoCountries = [
  ["US", "United States", "1", "##", "+1 {ac}-555-01##", "us"],
  ["CA", "Canada", "1", " #A#", "+1 {ac}-555-01##", "us"],
  ["GB", "United Kingdom", "44", " #AA", "+44 20 7946 0###", "eu"],
  ["DE", "Germany", "49", "###", "+49 {ac} ######", "eu"],
  ["FR", "France", "33", "##", "+33 {ac} ## ## ## ##", "eu"],
  ["ES", "Spain", "34", "###", "+34 {ac}# ### ###", "eu"],
  ["IT", "Italy", "39", "###", "+39 {ac} ### ####", "eu"],
  ["NL", "Netherlands", "31", "## AA", "+31 {ac} ### ####", "eu"],
  ["SE", "Sweden", "46", "# ##", "+46 {ac} ### ## ##", "eu"],
  ["CH", "Switzerland", "41", "##", "+41 {ac} ### ## ##", "eu"],
  ["AU", "Australia", "61", "##", "+61 {ac} 5550 ####", "us"],
  ["NZ", "New Zealand", "64", "##", "+64 {ac} ### ####", "us"],
  ["JP", "Japan", "81", "-####", "+81 {ac}-####-####", "eu"],
  ["BR", "Brazil", "55", "###-###", "+55 {ac} ####-####", "eu"],
  ["MX", "Mexico", "52", "###", "+52 {ac} #### ####", "eu"],
  ["IN", "India", "91", "###", "+91 {ac} #### ####", "eu"],
  ["NG", "Nigeria", "234", "###", "+234 {ac} ### ####", "eu"],
  ["ZA", "South Africa", "27", "##", "+27 {ac} ### ####", "eu"],
];

// [city, region, region code, country code, latitude, longitude, IANA time zone, postal prefix, area code, phone template override?]
const geoCities = [
  ["New York", "New York", "NY", "US", 40.71, -74.01, "America/New_York", "100", "212"],
  ["Los Angeles", "California", "CA", "US", 34.05, -118.24, "America/Los_Angeles", "900", "213"],
  ["Chicago", "Illinois", "IL", "US", 41.88, -87.63, "America/Chicago", "606", "312"],
  ["Houston", "Texas", "TX", "US", 29.76, -95.37, "America/Chicago", "770", "713"],
  ["Phoenix", "Arizona", "AZ", "US", 33.45, -112.07, "America/Phoenix", "850", "602"],
  ["Philadelphia", "Pennsylvania", "PA", "US", 39.95, -75.17, "America/New_York", "191", "215"],
  ["San Antonio", "Texas", "TX", "US", 29.42, -98.49, "America/Chicago", "782", "210"],
  ["San Diego", "California", "CA", "US", 32.72, -117.16, "America/Los_Angeles", "921", "619"],
  ["Dallas", "Texas", "TX", "US", 32.78, -96.8, "America/Chicago", "752", "214"],
  ["San Jose", "California", "CA", "US", 37.34, -121.89, "America/Los_Angeles", "951", "408"],
  ["Austin", "Texas", "TX", "US", 30.27, -97.74, "America/Chicago", "787", "512"],
  ["Seattle", "Washington", "WA", "US", 47.61, -122.33, "America/Los_Angeles", "981", "206"],
  ["Denver", "Colorado", "CO", "US", 39.74, -104.99, "America/Denver", "802", "303"],
  ["Boston", "Massachusetts", "MA", "US", 42.36, -71.06, "America/New_York", "021", "617"],
  ["Atlanta", "Georgia", "GA", "US", 33.75, -84.39, "America/New_York", "303", "404"],
  ["Miami", "Florida", "FL", "US", 25.76, -80.19, "America/New_York", "331", "305"],
  ["Portland", "Oregon", "OR", "US", 45.52, -122.68, "America/Los_Angeles", "972", "503"],
  ["Minneapolis", "Minnesota", "MN", "US", 44.98, -93.27, "America/Chicago", "554", "612"],
  ["Nashville", "Tennessee", "TN", "US", 36.16, -86.78, "America/Chicago", "372", "615"],
  ["Anchorage", "Alaska", "AK", "US", 61.22, -149.9, "America/Anchorage", "995", "907"],
  ["Honolulu", "Hawaii", "HI", "US", 21.31, -157.86, "Pacific/Honolulu", "968", "808"],
  ["Salt Lake City", "Utah", "UT", "US", 40.76, -111.89, "America/Denver", "841", "801"],
  ["Detroit", "Michigan", "MI", "US", 42.33, -83.05, "America/Detroit", "482", "313"],
  ["New Orleans", "Louisiana", "LA", "US", 29.95, -90.07, "America/Chicago", "701", "504"],
  ["Toronto", "Ontario", "ON", "CA", 43.65, -79.38, "America/Toronto", "M5V", "416"],
  ["Vancouver", "British Columbia", "BC", "CA", 49.28, -123.12, "America/Vancouver", "V6B", "604"],
  ["Montreal", "Quebec", "QC", "CA", 45.5, -73.57, "America/Toronto", "H2Y", "514"],
  ["Calgary", "Alberta", "AB", "CA", 51.05, -114.07, "America/Edmonton", "T2P", "403"],
  ["Ottawa", "Ontario", "ON", "CA", 45.42, -75.7, "America/Toronto", "K1P", "613"],
  ["Winnipeg", "Manitoba", "MB", "CA", 49.9, -97.14, "America/Winnipeg", "R3C", "204"],
  ["Halifax", "Nova Scotia", "NS", "CA", 44.65, -63.58, "America/Halifax", "B3J", "902"],
  ["London", "England", "ENG", "GB", 51.51, -0.13, "Europe/London", "EC1A", "20"],
  ["Manchester", "England", "ENG", "GB", 53.48, -2.24, "Europe/London", "M1", "161", "+44 161 496 0###"],
  ["Birmingham", "England", "ENG", "GB", 52.49, -1.89, "Europe/London", "B1", "121", "+44 121 496 0###"],
  ["Leeds", "England", "ENG", "GB", 53.8, -1.55, "Europe/London", "LS1", "113", "+44 113 496 0###"],
  ["Liverpool", "England", "ENG", "GB", 53.41, -2.98, "Europe/London", "L1", "151", "+44 151 496 0###"],
  ["Bristol", "England", "ENG", "GB", 51.45, -2.59, "Europe/London", "BS1", "117", "+44 117 496 0###"],
  ["Edinburgh", "Scotland", "SCT", "GB", 55.95, -3.19, "Europe/London", "EH1", "131", "+44 131 496 0###"],
  ["Glasgow", "Scotland", "SCT", "GB", 55.86, -4.25, "Europe/London", "G1", "141", "+44 141 496 0###"],
  ["Cardiff", "Wales", "WLS", "GB", 51.48, -3.18, "Europe/London", "CF10", "29", "+44 29 2018 0###"],
  ["Belfast", "Northern Ireland", "NIR", "GB", 54.6, -5.93, "Europe/London", "BT1", "28", "+44 28 9649 6###"],
  ["Berlin", "Berlin", "BE", "DE", 52.52, 13.41, "Europe/Berlin", "10", "30"],
  ["Hamburg", "Hamburg", "HH", "DE", 53.55, 9.99, "Europe/Berlin", "20", "40"],
  ["Munich", "Bavaria", "BY", "DE", 48.14, 11.58, "Europe/Berlin", "80", "89"],
  ["Cologne", "North Rhine-Westphalia", "NW", "DE", 50.94, 6.96, "Europe/Berlin", "50", "221"],
  ["Frankfurt", "Hesse", "HE", "DE", 50.11, 8.68, "Europe/Berlin", "60", "69"],
  ["Stuttgart", "Baden-Württemberg", "BW", "DE", 48.78, 9.18, "Europe/Berlin", "70", "711"],
  ["Dresden", "Saxony", "SN", "DE", 51.05, 13.74, "Europe/Berlin", "01", "351"],
  ["Leipzig", "Saxony", "SN", "DE", 51.34, 12.37, "Europe/Berlin", "04", "341"],
  ["Paris", "Île-de-France", "IDF", "FR", 48.86, 2.35, "Europe/Paris", "750", "1", "+33 1 99 00 ## ##"],
  ["Lyon", "Auvergne-Rhône-Alpes", "ARA", "FR", 45.76, 4.84, "Europe/Paris", "690", "4"],
  ["Marseille", "Provence-Alpes-Côte d'Azur", "PAC", "FR", 43.3, 5.37, "Europe/Paris", "130", "4"],
  ["Toulouse", "Occitanie", "OCC", "FR", 43.6, 1.44, "Europe/Paris", "310", "5"],
  ["Nice", "Provence-Alpes-Côte d'Azur", "PAC", "FR", 43.7, 7.27, "Europe/Paris", "060", "4"],
  ["Bordeaux", "Nouvelle-Aquitaine", "NAQ", "FR", 44.84, -0.58, "Europe/Paris", "330", "5"],
  ["Nantes", "Pays de la Loire", "PDL", "FR", 47.22, -1.55, "Europe/Paris", "440", "2"],
  ["Strasbourg", "Grand Est", "GES", "FR", 48.57, 7.75, "Europe/Paris", "670", "3"],
  ["Madrid", "Community of Madrid", "MD", "ES", 40.42, -3.7, "Europe/Madrid", "28", "91"],
  ["Barcelona", "Catalonia", "CT", "ES", 41.39, 2.17, "Europe/Madrid", "08", "93"],
  ["Valencia", "Valencian Community", "VC", "ES", 39.47, -0.38, "Europe/Madrid", "46", "96"],
  ["Seville", "Andalusia", "AN", "ES", 37.39, -5.98, "Europe/Madrid", "41", "95"],
  ["Bilbao", "Basque Country", "PV", "ES", 43.26, -2.93, "Europe/Madrid", "48", "94"],
  ["Zaragoza", "Aragon", "AR", "ES", 41.65, -0.89, "Europe/Madrid", "50", "97"],
  ["Rome", "Lazio", "62", "IT", 41.9, 12.5, "Europe/Rome", "00", "06"],
  ["Milan", "Lombardy", "25", "IT", 45.46, 9.19, "Europe/Rome", "20", "02"],
  ["Naples", "Campania", "72", "IT", 40.85, 14.27, "Europe/Rome", "80", "081"],
  ["Turin", "Piedmont", "21", "IT", 45.07, 7.69, "Europe/Rome", "10", "011"],
  ["Florence", "Tuscany", "52", "IT", 43.77, 11.26, "Europe/Rome", "50", "055"],
  ["Palermo", "Sicily", "82", "IT", 38.12, 13.36, "Europe/Rome", "90", "091"],
  ["Amsterdam", "North Holland", "NH", "NL", 52.37, 4.9, "Europe/Amsterdam", "10", "20"],
  ["Rotterdam", "South Holland", "ZH", "NL", 51.92, 4.48, "Europe/Amsterdam", "30", "10"],
  ["Utrecht", "Utrecht", "UT", "NL", 52.09, 5.12, "Europe/Amsterdam", "35", "30"],
  ["Eindhoven", "North Brabant", "NB", "NL", 51.44, 5.48, "Europe/Amsterdam", "56", "40"],
  ["Stockholm", "Stockholm County", "AB", "SE", 59.33, 18.07, "Europe/Stockholm", "11", "8"],
  ["Gothenburg", "Västra Götaland", "O", "SE", 57.71, 11.97, "Europe/Stockholm", "41", "31"],
  ["Malmö", "Skåne", "M", "SE", 55.6, 13.0, "Europe/Stockholm", "21", "40"],
  ["Zurich", "Zurich", "ZH", "CH", 47.38, 8.54, "Europe/Zurich", "80", "44"],
  ["Geneva", "Geneva", "GE", "CH", 46.2, 6.14, "Europe/Zurich", "12", "22"],
  ["Bern", "Bern", "BE", "CH", 46.95, 7.45, "Europe/Zurich", "30", "31"],
  ["Sydney", "New South Wales", "NSW", "AU", -33.87, 151.21, "Australia/Sydney", "20", "2"],
  ["Melbourne", "Victoria", "VIC", "AU", -37.81, 144.96, "Australia/Melbourne", "30", "3"],
  ["Brisbane", "Queensland", "QLD", "AU", -27.47, 153.03, "Australia/Brisbane", "40", "7"],
  ["Perth", "Western Australia", "WA", "AU", -31.95, 115.86, "Australia/Perth", "60", "8"],
  ["Adelaide", "South Australia", "SA", "AU", -34.93, 138.6, "Australia/Adelaide", "50", "8"],
  ["Auckland", "Auckland", "AUK", "NZ", -36.85, 174.76, "Pacific/Auckland", "10", "9"],
  ["Wellington", "Wellington", "WGN", "NZ", -41.29, 174.78, "Pacific/Auckland", "61", "4"],
  ["Christchurch", "Canterbury", "CAN", "NZ", -43.53, 172.64, "Pacific/Auckland", "80", "3"],
  ["Tokyo", "Tokyo", "13", "JP", 35.68, 139.69, "Asia/Tokyo", "100", "3"],
  ["Osaka", "Osaka", "27", "JP", 34.69, 135.5, "Asia/Tokyo", "530", "6"],
  ["Kyoto", "Kyoto", "26", "JP", 35.01, 135.77, "Asia/Tokyo", "600", "75"],
  ["Sapporo", "Hokkaido", "01", "JP", 43.06, 141.35, "Asia/Tokyo", "060", "11"],
  ["Fukuoka", "Fukuoka", "40", "JP", 33.59, 130.4, "Asia/Tokyo", "810", "92"],
  ["Nagoya", "Aichi", "23", "JP", 35.18, 136.91, "Asia/Tokyo", "460", "52"],
  ["São Paulo", "São Paulo", "SP", "BR", -23.55, -46.63, "America/Sao_Paulo", "01", "11"],
  ["Rio de Janeiro", "Rio de Janeiro", "RJ", "BR", -22.91, -43.17, "America/Sao_Paulo", "20", "21"],
  ["Brasília", "Federal District", "DF", "BR", -15.79, -47.88, "America/Sao_Paulo", "70", "61"],
  ["Salvador", "Bahia", "BA", "BR", -12.97, -38.5, "America/Bahia", "40", "71"],
  ["Manaus", "Amazonas", "AM", "BR", -3.12, -60.02, "America/Manaus", "69", "92"],
  ["Mexico City", "Mexico City", "CMX", "MX", 19.43, -99.13, "America/Mexico_City", "06", "55"],
  ["Guadalajara", "Jalisco", "JAL", "MX", 20.67, -103.35, "America/Mexico_City", "44", "33"],
  ["Monterrey", "Nuevo León", "NLE", "MX", 25.69, -100.32, "America/Monterrey", "64", "81"],
  ["Mérida", "Yucatán", "YUC", "MX", 20.97, -89.62, "America/Merida", "97", "999"],
  ["Mumbai", "Maharashtra", "MH", "IN", 19.08, 72.88, "Asia/Kolkata", "400", "22"],
  ["Delhi", "Delhi", "DL", "IN", 28.61, 77.21, "Asia/Kolkata", "110", "11"],
  ["Bengaluru", "Karnataka", "KA", "IN", 12.97, 77.59, "Asia/Kolkata", "560", "80"],
  ["Chennai", "Tamil Nadu", "TN", "IN", 13.08, 80.27, "Asia/Kolkata", "600", "44"],
  ["Kolkata", "West Bengal", "WB", "IN", 22.57, 88.36, "Asia/Kolkata", "700", "33"],
  ["Hyderabad", "Telangana", "TS", "IN", 17.39, 78.49, "Asia/Kolkata", "500", "40"],
  ["Lagos", "Lagos", "LA", "NG", 6.52, 3.38, "Africa/Lagos", "100", "1"],
  ["Abuja", "Federal Capital Territory", "FC", "NG", 9.08, 7.4, "Africa/Lagos", "900", "9"],
  ["Kano", "Kano", "KN", "NG", 12.0, 8.52, "Africa/Lagos", "700", "64"],
  ["Johannesburg", "Gauteng", "GP", "ZA", -26.2, 28.05, "Africa/Johannesburg", "20", "11"],
  ["Cape Town", "Western Cape", "WC", "ZA", -33.92, 18.42, "Africa/Johannesburg", "80", "21"],
  ["Durban", "KwaZulu-Natal", "KZN", "ZA", -29.86, 31.02, "Africa/Johannesburg", "40", "31"],
];

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const round4 = (x) => Math.round(x * 10000) / 10000;

/** Fill a pattern: "#" digit, "A" letter, anything else literal. */
function fill(pattern, s) {
  let out = "";
  for (const c of pattern) out += c === "#" ? s.int(0, 9) : c === "A" ? UPPER[s.int(0, 25)] : c;
  return out;
}

const INHERIT = new Set(["address", "location", "coordinates", "coords", "geo", "geolocation", "position", "place", "residence"]);

export const geo = freeze({
  name: "geo",
  version: 1,
  vocab: { geoCountries, geoCities },
  types: { "place.lat": "Float", "place.lng": "Float" },
  // a type called `address`, `location`, ... shares the persona of the entity that holds it
  inherit: (typeName) => INHERIT.has(typeName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).pop().toLowerCase()),
  rules({ tokens, last }) {
    const key = tokens.join(" ");
    if (last === "timezone" || last === "tz" || key.endsWith("time zone")) return { sdl: "String", gen: "geo.timezone" };
    if (last === "latitude" || last === "lat") return { sdl: "Float", gen: "place.lat" };
    if (last === "longitude" || last === "lng" || last === "lon" || last === "long") return { sdl: "Float", gen: "place.lng" };
    if (last === "region" || last === "province") return { sdl: "String", gen: "geo.region" };
    if (key.endsWith("country code")) return { sdl: "String", gen: "geo.countryCode" };
    if (key.endsWith("region code") || key.endsWith("state code") || key.endsWith("province code")) return { sdl: "String", gen: "geo.regionCode" };
    if (key.endsWith("calling code") || key.endsWith("dial code")) return { sdl: "String", gen: "geo.callingCode" };
    if (last === "postcode") return { sdl: "String", gen: "place.zip" };
    return null;
  },
  generators(V) {
    const countries = new Map(V.geoCountries.map((c) => [c[0], { code: c[0], name: c[1], dial: c[2], pf: c[3], ph: c[4], style: c[5] }]));
    const cities = V.geoCities.map((c) => ({
      city: c[0], region: c[1], regionCode: c[2], country: countries.get(c[3]), lat: c[4], lng: c[5], tz: c[6], pc: c[7], ac: c[8], ph: c[9],
    }));
    const place = (ctx) => ctx.slot("place").pick(cities);
    const postal = (ctx, row) => row.pc + fill(row.country.pf, ctx.slot("zip"));
    const street = (ctx) => {
      const s = ctx.slot("street");
      return `${s.int(1, 999)} ${s.pick(V.streets)} ${s.pick(V.streetSuffixes)}`;
    };
    return {
      "place.city": (ctx) => place(ctx).city,
      "place.state": (ctx) => place(ctx).region,
      "place.country": (ctx) => place(ctx).country.name,
      "place.zip": (ctx) => postal(ctx, place(ctx)),
      "place.street": (ctx) => street(ctx),
      "place.address": (ctx) => {
        const row = place(ctx);
        const p = postal(ctx, row);
        return row.country.style === "us" ? `${street(ctx)}, ${row.city}, ${row.regionCode} ${p}` : `${street(ctx)}, ${p} ${row.city}`;
      },
      // within about 0.1 degree (roughly 10 km) of the city centre
      "place.lat": (ctx) => round4(place(ctx).lat + (ctx.slot("latJitter").float() - 0.5) * 0.2),
      "place.lng": (ctx) => round4(place(ctx).lng + (ctx.slot("lngJitter").float() - 0.5) * 0.2),
      "person.phone": (ctx) => {
        const row = place(ctx);
        return fill((row.ph ?? row.country.ph).replace("{ac}", row.ac), ctx.slot("phoneLine"));
      },
      "geo.region": (ctx) => place(ctx).region,
      "geo.regionCode": (ctx) => place(ctx).regionCode,
      "geo.countryCode": (ctx) => place(ctx).country.code,
      "geo.callingCode": (ctx) => `+${place(ctx).country.dial}`,
      "geo.timezone": (ctx) => place(ctx).tz,
    };
  },
});

export default geo;
