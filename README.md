# OCYRA first-party plugins

This repository owns the v3 first-party plugin packages. SubRip now uses the sole API-v1
ES-module entry and explicit results. The synthetic foundation audit package also uses API v1,
including the structured host.data.read response. A development-only builder now produces signed fixture catalogs/archives; the app proof installs
those in a temporary profile. Product broker/host and release publication remain open.

Format packages: SubRip, WebVTT, ASS/SSA, SBV, SAMI, XLIFF, CSV and i18n JSON; see docs/briefs/88-format-packages.md.

Run npm run verify, then npm run test:reference -- --reference <app GP02 directory>.
Also npm run test:reference:gp03 -- --reference <app GP03 directory>. The reference path is an explicit checkout argument; no app source is copied here.

Historical Q1.5 evidence uses commit 0856ba3, not the current package tree. Supply a detached
checkout of that commit to the historical spike; there is no runtime compatibility adapter.
The app brief 38 owns end-to-end acceptance and the pinned product-package revision.


Build a development fixture (Git and Node built-ins only):

~~~sh
npm run build:development -- --out <new-directory> --base-url <https-artifact-base/> --sequence 1 --issued-at 2026-10-23T00:00:00Z --expires-at 2026-10-24T00:00:00Z
~~~

Commit package changes first. The builder reads exact HEAD blobs, defaults to internal,
requires an unused output path, and returns the source commit/catalog digest. Choose explicit
fixture times and sequence; no current date, timestamped filename or live fetch affects bytes.
The built-in signing seed is PUBLIC RFC test data, never an operational publisher identity;
release admission refuses it. No catalog URL is changed or artifact automatically published.
