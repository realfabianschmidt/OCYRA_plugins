# 88 Format packages: representation and dropped data

App brief 88 owns this work. Packages: `webvtt`, `ass`, `sbv`, `sami`, `xliff`, `csv`, `i18n-json`
(next to `subrip`). Each is one `handler.js` with the sole ES-module default and no host
capability. A package cannot import a shared module, so the subtitle packages and the tabular
packages each carry a copy of one prelude; `tests/formats/packages.test.mjs` keeps the copies equal.

## Left out

- MicroDVD: needs the frame-rate field in `FormatImportRequest` first (app, brief 88 slice 4).
- XLSX (brief 75's writer path), TMX and glossary CSV (no typed terminology inputs yet).
- Binary subtitle input: the subtitle packages accept text only, like SubRip.

## Subtitle formats (exact ticks, whole units only)

An export refuses a tick that is not a whole number of the format's unit (ms; ASS centiseconds)
and a cue the format cannot express, with `invalid_input` and `{ item }`.

| Format | Kept | Dropped on import |
|---|---|---|
| WebVTT | start, end, text with its tags (`<v>`, `<i>`, `<c>`, ...) | header text, NOTE, STYLE, REGION, cue identifiers, cue settings |
| ASS/SSA | Start, End, Text with override tags (`{\an8}`, `{\i1}`) and `\N` as a line break | other Dialogue columns (layer, style, name, margins, effect), Comment lines, every section but [Events]; export writes one Default style |
| SBV | start, end, text | nothing (no style data) |
| SAMI | SYNC start, P text, `<br>` as line break, inline tags | STYLE block, P class, everything outside SYNC; a cue ends at the next SYNC; an unclosed last cue and several P per SYNC are refused; export refuses overlapping cues |

## XLIFF 1.2 and 2.0/2.1: closing GP03-D02 and D03

- `sourceMarkup` and a target's `markup` are token lists. Each inline element is a code whose `id`
  is the element in canonical form (`<x id="name"/>`, `<ph id="1">...</ph>`); containers (1.2 `g`,
  `mrk`; 2.x `pc`, `mrk`) are an opening code (`<g id="1">`) and a closing code (`</g>`) around their
  text. `label` is `{id}`, `<id>` and `</id>`. `source` is the text with labels. A target code that
  its source lacks is refused as `invalid_input`.
- Review states map one to one: 1.2 `new` (and read-only `needs-translation`), `translated`,
  `signed-off` = reviewed, `final`, `needs-review-translation` = rejected; 2.x `initial` = new,
  `translated`, `reviewed`, `final`. 2.x rejected is written as `state="translated"
  subState="ocyra:rejected"`; the 1.2 value `needs-review-translation` found in a 2.x file (as in
  the GP03 input) is read as rejected. A target without a state is translated in 1.2 and new in
  2.x. Any other state is `unsupported_input`. 2.x state is read from `segment` (the standard
  place) and, failing that, from `target` (as the GP03 input has it); it is written on `segment`.
- Export is rebuilt from the track alone (`roundtripFile` is null). Dropped: groups, `ignorable`,
  `seg-source`, `alt-trans`, `context-group`, `approved` and every attribute or extension element
  not named in `plugins/format/xliff/handler.js`. Export always writes `resname`/`name` and the
  XLIFF namespace. A code that did not come from XLIFF is written as its label text.
- Malformed XML, a second root, a bad entity, a duplicate attribute, a missing `source` or `id`, a
  target without a target language: `invalid_input` with `{ line, column }` (or `{ line }`).
  DOCTYPE and a non-UTF encoding declaration: `unsupported_input`. Other versions:
  `unsupported_version`.

## CSV and i18n JSON

- CSV: columns `key`, `source`, optional `context`, `notes`, and one column per target language
  tag. Delimiter `,` `;` or tab, read from the header (a tie is `unsupported_input`). Input is
  UTF-8 (BOM allowed) or UTF-16 with a BOM, from text or base64; other encodings are refused, not
  guessed. Export is UTF-8 without BOM, comma, CRLF, all target languages. No review state: a
  filled target is translated.
- i18n JSON: one language per file, nested or flat string values. The path is kept in
  `reference.unitId` so export rebuilds the nesting. Each brace group (ICU argument, plural block,
  `{{mustache}}`) is one opaque code. Non-string values are `unsupported_input`.
