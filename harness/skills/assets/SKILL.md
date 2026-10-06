---
name: assets
description: Finding and downloading stock assets (footage, images, illustrations, 3D models, sound effects, fonts) from the asset sites the owner uses, in the owner's own Chrome with browser-harness. Use whenever a video would be better with a real asset than one you'd make, and the owner has listed a site for it.
---

# Assets from the owner's sites

The owner listed the sites they use for assets (in this project's CLAUDE.md, "This studio"). Their Chrome is signed in to
them; you work in it through **browser-harness** (read its skill first). Only those sites: never search the open web
for assets to download, and never use a site the owner didn't list.

## How

1. **Decide what you need first**, from the approved script and style frames: what it shows, the style, the shape
   (16:9 footage, a transparent PNG, an isolated object), and how it will be recoloured or composited. One clear
   search beats ten vague ones.
2. **Downloads land in this project.** Before the first download in a session, point Chrome's downloads at
   `input/downloads/` in this folder (CDP `Browser.setDownloadBehavior` with `behavior: "allow"` and the absolute
   path). Never leave a file in the owner's own Downloads folder.
3. **Search and pick** on the site, like a designer would: look at the previews (screenshots), prefer assets that
   match the look, check the resolution and format before downloading.
4. **Only what the owner's account already covers.** Never sign up, start a trial, accept new terms, enter payment
   details, or buy anything. If a download needs any of that, or a login has expired, stop and `mfx needs-you`
   with the item's link and what it's for.
5. **Record every asset** in `assets/SOURCES.md`: the site, the item's page URL, its title and author, the licence
   or terms as the site states them, the file you used and where it appears in the video. Licences are the owner's
   agreements with the site; you report what the site says, you don't judge them.
6. **Unpack and adapt** inside the project (`assets/found/…`): unzip, recolour to the palette, crop, key. Keep the
   original file untouched next to your version.

## When there's no listed site, or it has nothing that fits

Make it yourself (shapes, type, 3D, generated textures), or say in the submission note what a stock asset would add
and let the owner decide. Don't substitute an unlisted site.
