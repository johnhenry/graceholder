// Finance pack: account and transaction vocabulary, currencies, and identifiers whose check
// digits are valid: IBAN (ISO 13616 mod-97), payment card numbers (Luhn) and US ABA routing
// numbers (3-7-1 weights). The digits themselves are random: the IBAN's national bank code and
// national check part are NOT validated by the country's own scheme (FR RIB key, IT CIN, ES DC), and a
// card or account number may coincide with a real one by chance. Never use these to test payments
// against real systems. FROZEN at 1.0.0.

const freeze = (o) => {
  if (o !== null && typeof o === "object") for (const v of Object.values(o)) freeze(v);
  return Object.freeze(o);
};

// [code, name, symbol, minor units]
const financeCurrencies = [
  ["USD", "US Dollar", "$", 2], ["EUR", "Euro", "€", 2], ["GBP", "Pound Sterling", "£", 2], ["CHF", "Swiss Franc", "CHF", 2],
  ["SEK", "Swedish Krona", "kr", 2], ["NOK", "Norwegian Krone", "kr", 2], ["PLN", "Polish Zloty", "zł", 2], ["JPY", "Japanese Yen", "¥", 0],
  ["CAD", "Canadian Dollar", "$", 2], ["AUD", "Australian Dollar", "$", 2], ["NZD", "New Zealand Dollar", "$", 2], ["BRL", "Brazilian Real", "R$", 2],
  ["MXN", "Mexican Peso", "$", 2], ["INR", "Indian Rupee", "\u20b9", 2], ["NGN", "Nigerian Naira", "\u20a6", 2], ["ZAR", "South African Rand", "R", 2],
];

// currency by country code, for the countries of the geo pack (used when the geo pack is also enabled)
const financeCountryCurrency = [
  ["US", "USD"], ["CA", "CAD"], ["GB", "GBP"], ["DE", "EUR"], ["FR", "EUR"], ["ES", "EUR"], ["IT", "EUR"], ["NL", "EUR"], ["SE", "SEK"],
  ["CH", "CHF"], ["AU", "AUD"], ["NZ", "NZD"], ["JP", "JPY"], ["BR", "BRL"], ["MX", "MXN"], ["IN", "INR"], ["NG", "NGN"], ["ZA", "ZAR"],
];

// IBAN countries: [country code, currency, BBAN layout]; layout "8n,10n" = 8 digits then 10 digits,
// "4a" = 4 letters, "11c" = 11 letters or digits. Lengths follow ISO 13616 / the SWIFT registry.
const financeIbanCountries = [
  ["DE", "EUR", "8n,10n"], ["GB", "GBP", "4a,6n,8n"], ["FR", "EUR", "5n,5n,11c,2n"], ["ES", "EUR", "4n,4n,2n,10n"],
  ["IT", "EUR", "1a,5n,5n,12c"], ["NL", "EUR", "4a,10n"], ["BE", "EUR", "3n,7n,2n"], ["CH", "CHF", "5n,12c"],
  ["SE", "SEK", "20n"], ["AT", "EUR", "5n,11n"], ["IE", "EUR", "4a,6n,8n"], ["PL", "PLN", "8n,16n"],
  ["PT", "EUR", "4n,4n,11n,2n"], ["NO", "NOK", "4n,6n,1n"],
];

const financeAccountTypes = ["Checking", "Savings", "Money Market", "Credit Card", "Line of Credit", "Certificate of Deposit", "Business Checking", "Joint Account"];

// [transaction type, direction] where direction is -1 for money out and 1 for money in
const financeTransactionTypes = [
  ["Card Purchase", -1], ["ATM Withdrawal", -1], ["Direct Deposit", 1], ["Wire Transfer", -1], ["Wire Transfer Received", 1], ["Standing Order", -1],
  ["Direct Debit", -1], ["Refund", 1], ["Interest Payment", 1], ["Account Fee", -1], ["Cheque Deposit", 1], ["Peer Transfer", -1],
];

const financeMerchants = [
  "Marlow Grocers", "Pinecrest Fuel", "Lanternside Cafe", "Harborline Transit", "Westgate Pharmacy", "Brightwater Utilities", "Corner Bakehouse",
  "Summit Hardware", "Riverbend Books", "Oakmont Cinema", "Greenleaf Market", "Foxglove Florist", "Ironclad Gym", "Seabright Laundry",
  "Millstone Pizza", "Lakeview Parking", "Tallow & Wick", "Dovetail Furniture", "Crescent Cleaners", "Pennant Sports",
  "Meadowbank Dental", "Larder & Lime", "Kestrel Telecom", "Bluepine Insurance", "Anchor Hardware", "Birchline Optics",
  "Copperkettle Diner", "Sundial Travel", "Halfmoon Records", "Wickerwood Gifts",
];

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const ALNUM = UPPER + "0123456789";

/** Random characters for a layout like "5n,5n,11c,2n". */
function bban(layout, s) {
  let out = "";
  for (const part of layout.split(",")) {
    const n = Number.parseInt(part, 10);
    const kind = part[part.length - 1];
    for (let i = 0; i < n; i++) out += kind === "n" ? s.int(0, 9) : kind === "a" ? UPPER[s.int(0, 25)] : ALNUM[s.int(0, ALNUM.length - 1)];
  }
  return out;
}

/** ISO 7064 mod 97-10 over a string of digits and letters (A=10 ... Z=35), without big integers. */
export function mod97(text) {
  let rem = 0;
  for (const ch of text) {
    const v = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97;
  }
  return rem;
}

/** A structurally valid IBAN: country, two check digits so that mod97(rearranged) is 1, then the BBAN. */
export function makeIban(country, body) {
  const check = 98 - mod97(`${body}${country}00`);
  return `${country}${String(check).padStart(2, "0")}${body}`;
}

/** Luhn check digit for a string of digits. */
export function luhnDigit(partial) {
  let sum = 0;
  for (let i = partial.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = partial.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

// [network, prefixes, length]
const CARDS = [["visa", ["4"], 16], ["mastercard", ["51", "52", "53", "54", "55"], 16], ["amex", ["34", "37"], 15]];

export const finance = freeze({
  name: "finance",
  version: 1,
  vocab: { financeCountryCurrency, financeCurrencies, financeIbanCountries, financeAccountTypes, financeTransactionTypes, financeMerchants },
  rules({ tokens, last }) {
    const key = tokens.join(" ");
    if (last === "iban") return { sdl: "String", gen: "finance.iban" };
    if (last === "bic" || last === "swift") return { sdl: "String", gen: "finance.bic" };
    if (key === "card number" || key === "credit card" || key === "credit card number" || key === "cc number" || key === "pan") return { sdl: "String", gen: "finance.cardNumber" };
    if (key === "routing number" || key === "aba" || key === "routing") return { sdl: "String", gen: "finance.routingNumber" };
    if (key === "account number" || key === "account no") return { sdl: "String", gen: "finance.accountNumber" };
    if (key === "account type") return { sdl: "String", gen: "finance.accountType" };
    if (key === "transaction type" || key === "txn type") return { sdl: "String", gen: "finance.transactionType" };
    if (last === "merchant" || key === "merchant name" || key === "payee") return { sdl: "String", gen: "finance.merchant" };
    if (key === "currency" || key === "currency code") return { sdl: "String", gen: "finance.currency" };
    if (key === "currency name") return { sdl: "String", gen: "finance.currencyName" };
    if (key === "currency symbol") return { sdl: "String", gen: "finance.currencySymbol" };
    return null;
  },
  generators(V, base) {
    const ccy = new Map(V.financeCurrencies.map((c) => [c[0], c]));
    const byCountry = new Map(V.financeCountryCurrency);
    // With the geo pack enabled, the entity's country is its place's country (a persona slot shared
    // with every place field), so its IBAN country and currency agree with its address. Otherwise one
    // "fcountry" slot per entity keeps the IBAN country and the currency consistent with each other.
    const geoCountry = (ctx) => base["geo.countryCode"]?.(ctx);
    const home = (ctx) => {
      const cc = geoCountry(ctx);
      return (cc && V.financeIbanCountries.find((r) => r[0] === cc)) || ctx.slot("fcountry").pick(V.financeIbanCountries);
    };
    const currencyCode = (ctx) => {
      const cc = geoCountry(ctx);
      return (cc && byCountry.get(cc)) || home(ctx)[1];
    };
    return {
      "finance.iban": (ctx) => {
        const [cc, , layout] = home(ctx);
        return makeIban(cc, bban(layout, ctx.slot("ibanDigits")));
      },
      "finance.bic": (ctx) => {
        const s = ctx.slot("bic");
        const [cc] = home(ctx);
        let bank = "";
        for (let i = 0; i < 4; i++) bank += UPPER[s.int(0, 25)];
        return `${bank}${cc}${ALNUM[s.int(0, 35)]}${ALNUM[s.int(0, 35)]}`;
      },
      "finance.cardNumber": (ctx) => {
        const s = ctx.slot("card");
        const [, prefixes, len] = s.pick(CARDS);
        let digits = s.pick(prefixes);
        while (digits.length < len - 1) digits += s.int(0, 9);
        return digits + luhnDigit(digits);
      },
      "finance.routingNumber": (ctx) => {
        const s = ctx.slot("routing");
        // first two digits: Federal Reserve routing symbols 01-12 (the range of ordinary banks)
        let d = String(s.int(1, 12)).padStart(2, "0");
        while (d.length < 8) d += s.int(0, 9);
        const w = [3, 7, 1, 3, 7, 1, 3, 7];
        let sum = 0;
        for (let i = 0; i < 8; i++) sum += (d.charCodeAt(i) - 48) * w[i];
        return d + ((10 - (sum % 10)) % 10);
      },
      "finance.accountNumber": (ctx) => {
        const s = ctx.slot("acct");
        let out = "";
        const n = s.int(8, 12);
        for (let i = 0; i < n; i++) out += s.int(0, 9);
        return out;
      },
      "finance.accountType": (ctx) => ctx.slot("accountType").pick(V.financeAccountTypes),
      "finance.transactionType": (ctx) => ctx.slot("txnType").pick(V.financeTransactionTypes)[0],
      "finance.merchant": (ctx) => ctx.slot("merchant").pick(V.financeMerchants),
      "finance.currency": (ctx) => currencyCode(ctx),
      "finance.currencyName": (ctx) => ccy.get(currencyCode(ctx))[1],
      "finance.currencySymbol": (ctx) => ccy.get(currencyCode(ctx))[2],
    };
  },
});

export default finance;
