# Vocabulary provenance

`en.js` is hand-written for this project. Names are common given names and surnames of
mixed origin; none is a list copied from a third-party dataset. Places are real, generic
town names with state/province, ISO-style code and a three-character postal prefix; they
are not addresses. Lorem words are the classical public-domain ipsum list. Domains use the
reserved `example.*` names. Everything here is contributed under the repository's MIT
licence and is original or public domain.

The tables are order-frozen: values are selected by index, so any edit, reorder or
append is an output change (see docs/design.md sections 7.1 and 11). `test/vocab.test.js`
asserts a SHA-256 checksum of every table.
