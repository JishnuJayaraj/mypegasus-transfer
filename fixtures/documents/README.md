# Synthetic document fixtures

Everything here is **synthetic**: no real person, employer or document (CLAUDE.md rule 1). They are
the files of the Slice 4b Playwright happy path (`apps/web/e2e/documents.spec.ts`).

| File | Content |
|---|---|
| `lebenslauf-beispiel.pdf` | a one-page PDF 1.4 with two lines of sample text ("Lebenslauf - Beispiel", the seed's sample name and address) |
| `zeugnis-unscharf-beispiel.png` | a 64 × 40 greyscale PNG, a soft gradient: the "blurred certificate" a consultant rejects as unreadable |

No malware test file is committed: the spec assembles the EICAR test string at run time (inside a
PDF header, so the type check passes and the mock scanner answers `infected`), and a virus scanner
on a developer machine never sees one in the repository.
