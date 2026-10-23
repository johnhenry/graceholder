# Pack vocabulary provenance

Everything in `geo.js`, `commerce.js`, `finance.js` and `health.js` was written by hand for this
project and is contributed under the repository's MIT licence. No file was copied from, or generated
from, a third-party dataset (in particular not from faker, whose data files are not used).

- **geo.** City, region, country, time zone, postal-code and area-code facts are public, uncopyrightable
  facts typed in by hand; coordinates are approximate city centres rounded to 0.01 degree and are
  placeholders, not for navigation. Time zones are IANA names. Phone templates use each country's calling
  code; the US and Canada use the fictional `555-01xx` block, the United Kingdom the Ofcom drama ranges
  (`020 7946 0xxx`, `0161 496 0xxx`, ...) and Australia the ACMA `5550 xxxx` block. Paris uses `01 99 00 xx xx`, which is believed to be France's reserved fiction range but was not checked against a source.
  Other countries' templates are well-formed but not guaranteed unassigned. Cities are real, so use them
  as place names only.
- **commerce.** Categories, product nouns and adjectives are ordinary English words. Brand names are
  invented; any resemblance to a trademark is coincidental.
- **finance.** Currency codes, names, symbols and minor units follow ISO 4217. IBAN lengths and layouts
  follow ISO 13616 / the SWIFT IBAN registry; the check digits are computed (ISO 7064 mod 97-10) and
  verified in tests against published example IBANs. Card number prefixes (4, 51-55, 34/37) and the Luhn
  check are the public conventions; the ABA 3-7-1 weights are the published routing-number checksum.
  Merchants are invented.
- **health.** Every condition and medication name is invented and obviously whimsical; none is a real
  diagnosis or drug. Specialty names are ordinary category words. Nothing is medical information. A test
  rejects a deny list of real diagnoses and drug-name endings.

All tables are order-frozen (values are chosen by index), so any edit, reorder or append is an output
change. `test/packs.test.js` asserts a SHA-256 checksum of every table.
